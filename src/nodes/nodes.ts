/**
 * nodes.ts — WGSL node graph: type vocab, node classes, DSL constructors, helpers.
 *
 * Node<T> is a base class. Each node kind is a subclass carrying its own data fields.
 * The chaining API (add, mul, normalize, etc.) and all swizzle getters (x/y/z/w and
 * r/g/b/a sets) live directly on Node<T> as hardcoded TypeScript getters — no runtime
 * prototype mutation, no index signatures.
 *
 * Standalone DSL functions (konst, attr, uniform, ...) are thin subclass constructors
 * exported for convenience and for use without chaining.
 */

import { getChildren as _getChildren } from './collect';
import type { WgslBuilder } from './compile';
import { type WgslDesc, type StructSchema, type ArrayDesc, itemSizeOf, typedArrayCtorOf, isStructDef } from './schema';
export { array, isArrayDesc, isStructDef, type WgslDesc, type ArrayDesc, type StructSchema, itemSizeOf, typedArrayCtorOf } from './schema';


// ---------------------------------------------------------------------------
// StructDef / StructInstance — defined here so they can reference StructNode
// ---------------------------------------------------------------------------

export type StructInstance<S extends StructSchema> = {
    readonly $node: Node<WgslType>;
} & {
    readonly [K in keyof S]: Node<S[K]['wgslType'] & WgslType>;
};

export type StructDef<S extends StructSchema> = WgslDesc<string> & {
    readonly schema: S;
    readonly members: StructMember[];
    readonly node: StructNode;
    readonly nestedDefs: ReadonlyMap<string, StructDef<StructSchema>>;
    instantiate<N extends Node<WgslType>>(base: N): StructInstance<S>;
};


// ---------------------------------------------------------------------------
// Struct registry + struct() — live here to avoid circular imports
// (StructNode and FieldNode are defined later in this file)
// ---------------------------------------------------------------------------

const _structNodeRegistry: WeakMap<StructNode, StructDef<StructSchema>> = new WeakMap();
const _structNameRegistry: Map<string, StructDef<StructSchema>> = new Map();

export function lookupStructDef(node: StructNode): StructDef<StructSchema> | undefined {
    return _structNodeRegistry.get(node);
}

export function lookupStructDefByName(wgslType: string): StructDef<StructSchema> | undefined {
    return _structNameRegistry.get(wgslType);
}

export function struct<S extends StructSchema>(wgslType: string, schema: S): StructDef<S> {
    const members: StructMember[] = Object.entries(schema).map(([name, field]) => ({
        name,
        type: field.wgslType,
    }));
    const node = new StructNode(wgslType, members);

    const nestedDefs: Map<string, StructDef<StructSchema>> = new Map();
    for (const field of Object.values(schema)) {
        if (isStructDef(field)) {
            nestedDefs.set(field.wgslType, field as unknown as StructDef<StructSchema>);
        }
    }

    function instantiate<N extends Node<WgslType>>(base: N): StructInstance<S> {
        const result: Record<string, Node<WgslType>> = { $node: base };
        for (const [name, field] of Object.entries(schema)) {
            result[name] = new FieldNode(field.wgslType as WgslType, base, name);
        }
        return result as StructInstance<S>;
    }

    const def: StructDef<S> = { wgslType, schema, members, node, nestedDefs, instantiate };
    _structNodeRegistry.set(node, def);
    _structNameRegistry.set(wgslType, def);
    return def;
}


/* wgsl type vocabulary */

export type ScalarType = 'f32' | 'i32' | 'u32' | 'bool';

export type Vec2Type = 'vec2f' | 'vec2i' | 'vec2u' | 'vec2<bool>';
export type Vec3Type = 'vec3f' | 'vec3i' | 'vec3u' | 'vec3<bool>';
export type Vec4Type = 'vec4f' | 'vec4i' | 'vec4u' | 'vec4<bool>';
export type VecType = Vec2Type | Vec3Type | Vec4Type;

export type MatType = 'mat2x2f' | 'mat2x3f' | 'mat2x4f' | 'mat3x2f' | 'mat3x3f' | 'mat3x4f' | 'mat4x2f' | 'mat4x3f' | 'mat4x4f';

export type NumericType = ScalarType | VecType | MatType;
export type SamplerType = 'sampler' | 'sampler_comparison';
export type TextureType = string;
export type WgslType = NumericType | SamplerType | TextureType;

// ---------------------------------------------------------------------------
// Type-level helpers
// ---------------------------------------------------------------------------

export type VecElement<T extends VecType> = T extends 'vec2f' | 'vec3f' | 'vec4f'
    ? 'f32'
    : T extends 'vec2i' | 'vec3i' | 'vec4i'
      ? 'i32'
      : T extends 'vec2u' | 'vec3u' | 'vec4u'
        ? 'u32'
        : 'bool';

export type Vec2Of<E extends ScalarType> = E extends 'f32' ? 'vec2f' : E extends 'i32' ? 'vec2i' : E extends 'u32' ? 'vec2u' : 'vec2<bool>';
export type Vec3Of<E extends ScalarType> = E extends 'f32' ? 'vec3f' : E extends 'i32' ? 'vec3i' : E extends 'u32' ? 'vec3u' : 'vec3<bool>';
export type Vec4Of<E extends ScalarType> = E extends 'f32' ? 'vec4f' : E extends 'i32' ? 'vec4i' : E extends 'u32' ? 'vec4u' : 'vec4<bool>';

export type MulResult<A extends WgslType, B extends WgslType> = A extends MatType
    ? B extends VecType
        ? B
        : A
    : B extends ScalarType
      ? A
      : A extends ScalarType
        ? B
        : A;

// ---------------------------------------------------------------------------
// Node kinds
// ---------------------------------------------------------------------------

export type NodeKind =
    | 'const'
    | 'uniform'
    | 'attribute'
    | 'instanced_buffer_attribute'
    | 'storage'
    | 'texture'
    | 'sampler'
    | 'varying'
    | 'binop'
    | 'call'
    | 'raw'
    | 'assign'
    | 'construct'
    | 'struct'
    | 'field'
    | 'index'
    | 'builtin'
    | 'stack'
    | 'cond'
    | 'var'
    | 'if'
    | 'for'
    | 'while'
    | 'break'
    | 'continue'
    | 'fn'
    | 'param'
    | 'return';

export type StructMember = { readonly name: string; readonly type: WgslType };
export type BuiltinKind = 'camera' | 'instance_index' | 'instance_data' | 'mesh' | 'time' | 'vertex_index' | 'global_invocation_id' | 'local_invocation_id' | 'local_invocation_index' | 'workgroup_id' | 'num_workgroups';
export type BinopOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '>' | '<=' | '>=';

// ---------------------------------------------------------------------------
// Fn layout types
// ---------------------------------------------------------------------------

/**
 * A single named + typed parameter descriptor for Fn().
 * Mirrors WGSL syntax: `name: type` e.g. `{ name: 'uv', type: S.vec2f() }` → `uv: vec2f`
 */
export type ParamDesc<T extends WgslType = WgslType> = {
    readonly name: string;
    readonly type: WgslDesc<T>;
};

/**
 * Maps a tuple of ParamDesc to a tuple of correspondingly-typed Nodes.
 * e.g. [ParamDesc<'vec2f'>, ParamDesc<'f32'>] → [Node<'vec2f'>, Node<'f32'>]
 */
export type ParamDescsToNodes<P extends readonly ParamDesc[]> = {
    [K in keyof P]: P[K] extends ParamDesc<infer U> ? Node<U> : never;
};

/** Layout descriptor for a named, fully-typed Fn. */
export type FnLayout<P extends readonly ParamDesc[]> = {
    readonly name: string;
    readonly params: [...P];
};

// ---------------------------------------------------------------------------
// Node<T> — base class with chaining API
// ---------------------------------------------------------------------------

export class Node<T extends WgslType> {
    readonly id: string;
    readonly kind: NodeKind;
    readonly type: T;

    constructor(id: string, kind: NodeKind, type: T) {
        this.id = id;
        this.kind = kind;
        this.type = type;
    }

    // arithmetic
    add(b: Node<T>): Node<T> { return new BinopNode('+', this.type, this, b) as Node<T>; }
    sub(b: Node<T>): Node<T> { return new BinopNode('-', this.type, this, b) as Node<T>; }
    div(b: Node<T>): Node<T> { return new BinopNode('/', this.type, this, b) as Node<T>; }
    mul<B extends ScalarType>(b: Node<B>): Node<T>;
    mul<B extends VecType>(b: Node<B>): T extends ScalarType ? Node<B> : Node<T>;
    mul<B extends VecType>(b: Node<B>): T extends MatType ? Node<B> : Node<T>;
    mul<B extends WgslType>(b: Node<B>): Node<WgslType>;
    mul(b: Node<WgslType>): Node<WgslType> { return new BinopNode('*', mulResultType(this.type, b.type), this, b); }

    // math
    abs(): Node<T> { return new CallNode(this.type, 'abs', [this]) as Node<T>; }
    floor(): Node<T> { return new CallNode(this.type, 'floor', [this]) as Node<T>; }
    ceil(): Node<T> { return new CallNode(this.type, 'ceil', [this]) as Node<T>; }
    fract(): Node<T> { return new CallNode(this.type, 'fract', [this]) as Node<T>; }
    sqrt(): Node<T> { return new CallNode(this.type, 'sqrt', [this]) as Node<T>; }
    sin(): Node<T> { return new CallNode(this.type, 'sin', [this]) as Node<T>; }
    cos(): Node<T> { return new CallNode(this.type, 'cos', [this]) as Node<T>; }
    negate(): Node<T> { return new CallNode(this.type, 'negate', [this]) as Node<T>; }
    normalize(): Node<T> { return new CallNode(this.type, 'normalize', [this]) as Node<T>; }
    length(): Node<'f32'> { return new CallNode('f32', 'length', [this]); }
    dot(b: Node<T>): Node<T extends VecType ? VecElement<T> : 'f32'> { return new CallNode(vecElementType(this.type), 'dot', [this, b]) as unknown as Node<T extends VecType ? VecElement<T> : 'f32'>; }
    cross(b: Node<T>): Node<T> { return new CallNode(this.type, 'cross', [this, b]) as Node<T>; }
    clamp(lo: Node<T>, hi: Node<T>): Node<T> { return new CallNode(this.type, 'clamp', [this, lo, hi]) as Node<T>; }
    mix(b: Node<T>, t: Node<T>): Node<T> { return new CallNode(this.type, 'mix', [this, b, t]) as Node<T>; }
    max(b: Node<T>): Node<T> { return new CallNode(this.type, 'max', [this, b]) as Node<T>; }
    min(b: Node<T>): Node<T> { return new CallNode(this.type, 'min', [this, b]) as Node<T>; }
    pow(b: Node<T>): Node<T> { return new CallNode(this.type, 'pow', [this, b]) as Node<T>; }
    step(x: Node<T>): Node<T> { return new CallNode(this.type, 'step', [this, x]) as Node<T>; }
    smoothstep(lo: Node<T>, hi: Node<T>): Node<T> { return new CallNode(this.type, 'smoothstep', [lo, hi, this]) as Node<T>; }

    // struct field access — typed via explicit resultType argument
    field<R extends WgslType>(name: string, resultType: R): Node<R> { return new FieldNode(resultType, this, name); }

    // comparison operators — return Node<'bool'>
    gt(b: Node<T>): Node<'bool'> { return new BinopNode('>', 'bool', this, b); }
    lt(b: Node<T>): Node<'bool'> { return new BinopNode('<', 'bool', this, b); }
    gte(b: Node<T>): Node<'bool'> { return new BinopNode('>=', 'bool', this, b); }
    lte(b: Node<T>): Node<'bool'> { return new BinopNode('<=', 'bool', this, b); }
    eq(b: Node<T>): Node<'bool'> { return new BinopNode('==', 'bool', this, b); }
    neq(b: Node<T>): Node<'bool'> { return new BinopNode('!=', 'bool', this, b); }

    // Type conversion
    toF32(): Node<'f32'> { return new CallNode('f32', 'f32', [this]); }

    /**
     * Assign a new value to this node (used on VarNodes).
     * Produces an AssignNode and pushes it onto the current stack.
     * Throws if called outside a Fn body.
     */
    assign(value: Node<T>): void { addToStack(new AssignNode(this, value)); }

    /**
     * Declare a mutable local variable initialised to this node's value.
     * Equivalent to the standalone `toVar(this, label)`.
     *
     * When called inside a `Fn` body, the `VarNode` is pushed onto the current
     * stack so it is declared at the point of use.
     *
     * When called **outside** any `Fn` body (e.g. at module scope to build a
     * shared sub-graph), the `VarNode` is created but not added to any stack.
     * It will be emitted inline into whichever shader-stage function body first
     * references it during the generate pass — mirroring three.js TSL behaviour.
     */
    toVar(label?: string): VarNode<T> {
        const varName = label ? `var_${_nodeCounter}_${label}` : `var_${_nodeCounter}`;
        const v = new VarNode(this.type as T, varName, this);
        if (currentStack !== null) {
            currentStack.push(v as Node<WgslType>);
        }
        return v;
    }

    /* xyzw 1-component swizzles */
    get x(): Node<WgslType> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'x'); }
    get y(): Node<WgslType> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'y'); }
    get z(): Node<WgslType> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'z'); }
    get w(): Node<WgslType> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'w'); }

    /* xyzw 2-component swizzles */
    get xx(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'xx'); }
    get xy(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'xy'); }
    get xz(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'xz'); }
    get xw(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'xw'); }
    get yx(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'yx'); }
    get yy(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'yy'); }
    get yz(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'yz'); }
    get yw(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'yw'); }
    get zx(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'zx'); }
    get zy(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'zy'); }
    get zz(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'zz'); }
    get zw(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'zw'); }
    get wx(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'wx'); }
    get wy(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'wy'); }
    get wz(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'wz'); }
    get ww(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'ww'); }

    /* xyzw 3-component swizzles */
    get xxx(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xxx'); }
    get xxy(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xxy'); }
    get xxz(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xxz'); }
    get xxw(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xxw'); }
    get xyx(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xyx'); }
    get xyy(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xyy'); }
    get xyz(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xyz'); }
    get xyw(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xyw'); }
    get xzx(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xzx'); }
    get xzy(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xzy'); }
    get xzz(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xzz'); }
    get xzw(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xzw'); }
    get xwx(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xwx'); }
    get xwy(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xwy'); }
    get xwz(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xwz'); }
    get xww(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xww'); }
    get yxx(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yxx'); }
    get yxy(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yxy'); }
    get yxz(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yxz'); }
    get yxw(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yxw'); }
    get yyx(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yyx'); }
    get yyy(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yyy'); }
    get yyz(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yyz'); }
    get yyw(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yyw'); }
    get yzx(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yzx'); }
    get yzy(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yzy'); }
    get yzz(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yzz'); }
    get yzw(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yzw'); }
    get ywx(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'ywx'); }
    get ywy(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'ywy'); }
    get ywz(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'ywz'); }
    get yww(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yww'); }
    get zxx(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zxx'); }
    get zxy(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zxy'); }
    get zxz(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zxz'); }
    get zxw(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zxw'); }
    get zyx(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zyx'); }
    get zyy(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zyy'); }
    get zyz(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zyz'); }
    get zyw(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zyw'); }
    get zzx(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zzx'); }
    get zzy(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zzy'); }
    get zzz(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zzz'); }
    get zzw(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zzw'); }
    get zwx(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zwx'); }
    get zwy(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zwy'); }
    get zwz(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zwz'); }
    get zww(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zww'); }
    get wxx(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wxx'); }
    get wxy(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wxy'); }
    get wxz(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wxz'); }
    get wxw(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wxw'); }
    get wyx(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wyx'); }
    get wyy(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wyy'); }
    get wyz(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wyz'); }
    get wyw(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wyw'); }
    get wzx(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wzx'); }
    get wzy(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wzy'); }
    get wzz(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wzz'); }
    get wzw(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wzw'); }
    get wwx(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wwx'); }
    get wwy(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wwy'); }
    get wwz(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wwz'); }
    get www(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'www'); }

    /* xyzw 4-component swizzles (24 unique permutations only) */
    get xyzw(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'xyzw'); }
    get xywz(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'xywz'); }
    get xzyw(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'xzyw'); }
    get xzwy(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'xzwy'); }
    get xwyz(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'xwyz'); }
    get xwzy(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'xwzy'); }
    get yxzw(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'yxzw'); }
    get yxwz(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'yxwz'); }
    get yzxw(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'yzxw'); }
    get yzwx(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'yzwx'); }
    get ywxz(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'ywxz'); }
    get ywzx(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'ywzx'); }
    get zxyw(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'zxyw'); }
    get zxwy(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'zxwy'); }
    get zyxw(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'zyxw'); }
    get zywx(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'zywx'); }
    get zwxy(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'zwxy'); }
    get zwyx(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'zwyx'); }
    get wxyz(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'wxyz'); }
    get wxzy(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'wxzy'); }
    get wyxz(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'wyxz'); }
    get wyzx(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'wyzx'); }
    get wzxy(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'wzxy'); }
    get wzyx(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'wzyx'); }

    /* rgba 1-component swizzles */
    get r(): Node<WgslType> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'x'); }
    get g(): Node<WgslType> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'y'); }
    get b(): Node<WgslType> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'z'); }
    get a(): Node<WgslType> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'w'); }

    /* rgba 2-component swizzles */
    get rr(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'xx'); }
    get rg(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'xy'); }
    get rb(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'xz'); }
    get ra(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'xw'); }
    get gr(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'yx'); }
    get gg(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'yy'); }
    get gb(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'yz'); }
    get ga(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'yw'); }
    get br(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'zx'); }
    get bg(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'zy'); }
    get bb(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'zz'); }
    get ba(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'zw'); }
    get ar(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'wx'); }
    get ag(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'wy'); }
    get ab(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'wz'); }
    get aa(): Node<WgslType> { return new FieldNode(vec2TypeOf(this.type), this, 'ww'); }

    /* rgba 3-component swizzles */
    get rrr(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xxx'); }
    get rrg(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xxy'); }
    get rrb(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xxz'); }
    get rra(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xxw'); }
    get rgr(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xyx'); }
    get rgg(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xyy'); }
    get rgb(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xyz'); }
    get rga(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xyw'); }
    get rbr(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xzx'); }
    get rbg(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xzy'); }
    get rbb(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xzz'); }
    get rba(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xzw'); }
    get rar(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xwx'); }
    get rag(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xwy'); }
    get rab(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xwz'); }
    get raa(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'xww'); }
    get grr(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yxx'); }
    get grg(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yxy'); }
    get grb(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yxz'); }
    get gra(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yxw'); }
    get ggr(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yyx'); }
    get ggg(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yyy'); }
    get ggb(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yyz'); }
    get gga(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yyw'); }
    get gbr(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yzx'); }
    get gbg(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yzy'); }
    get gbb(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yzz'); }
    get gba(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yzw'); }
    get gar(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'ywx'); }
    get gag(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'ywy'); }
    get gab(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'ywz'); }
    get gaa(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'yww'); }
    get brr(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zxx'); }
    get brg(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zxy'); }
    get brb(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zxz'); }
    get bra(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zxw'); }
    get bgr(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zyx'); }
    get bgg(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zyy'); }
    get bgb(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zyz'); }
    get bga(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zyw'); }
    get bbr(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zzx'); }
    get bbg(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zzy'); }
    get bbb(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zzz'); }
    get bba(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zzw'); }
    get bar(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zwx'); }
    get bag(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zwy'); }
    get bab(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zwz'); }
    get baa(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'zww'); }
    get arr(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wxx'); }
    get arg(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wxy'); }
    get arb(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wxz'); }
    get ara(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wxw'); }
    get agr(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wyx'); }
    get agg(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wyy'); }
    get agb(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wyz'); }
    get aga(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wyw'); }
    get abr(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wzx'); }
    get abg(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wzy'); }
    get abb(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wzz'); }
    get aba(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wzw'); }
    get aar(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wwx'); }
    get aag(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wwy'); }
    get aab(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'wwz'); }
    get aaa(): Node<WgslType> { return new FieldNode(vec3TypeOf(this.type), this, 'www'); }

    /* rgba 4-component swizzles (24 unique permutations only) */
    get rgba(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'xyzw'); }
    get rgab(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'xywz'); }
    get rbga(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'xzyw'); }
    get rbag(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'xzwy'); }
    get ragb(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'xwyz'); }
    get rabg(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'xwzy'); }
    get grba(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'yxzw'); }
    get grab(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'yxwz'); }
    get gbra(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'yzxw'); }
    get gbar(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'yzwx'); }
    get garb(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'ywxz'); }
    get gabr(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'ywzx'); }
    get brga(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'zxyw'); }
    get brag(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'zxwy'); }
    get bgra(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'zyxw'); }
    get bgar(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'zywx'); }
    get barg(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'zwxy'); }
    get bagr(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'zwyx'); }
    get argb(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'wxyz'); }
    get arbg(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'wxzy'); }
    get agrb(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'wyxz'); }
    get agbr(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'wyzx'); }
    get abrg(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'wzxy'); }
    get abgr(): Node<WgslType> { return new FieldNode(vec4TypeOf(this.type), this, 'wzyx'); }

    /**
     * Returns the immediate child nodes of this node.
     * Delegates to the module-level getChildren() from collect.ts.
     */
    getChildren(): Node<WgslType>[] { return _getChildren(this); }

    /**
     * Setup pass: register any resources this node owns into the builder.
     * Base implementation is a no-op; resource-owning nodes override this.
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    setup(_builder: WgslBuilder): void { /* no-op */ }

    /**
     * Generate pass: return the WGSL expression string for this node,
     * or null for statement nodes (side-effect: emits into builder.flow).
     * Base implementation returns a comment indicating a missing override.
     */
    generate(_builder: WgslBuilder): string | null {
        return `/* unimplemented generate for kind:${this.kind} */`;
    }
}

// Use .field() for typed struct member access.

// ---------------------------------------------------------------------------
// Code-generation helpers — used only within nodes.ts
// ---------------------------------------------------------------------------

function constLiteral(type: string, value: number | number[] | string): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') {
        switch (type) {
            case 'f32': return Number.isInteger(value) ? `${value}.0` : `${value}`;
            case 'i32': return `${Math.trunc(value)}i`;
            case 'u32': return `${Math.trunc(value)}u`;
            case 'bool': return value !== 0 ? 'true' : 'false';
            default: return `${value}`;
        }
    }
    const components = (value as number[]).map((v) => {
        if (type.startsWith('vec') && type.endsWith('f')) return Number.isInteger(v) ? `${v}.0` : `${v}`;
        if (type.startsWith('vec') && type.endsWith('i')) return `${Math.trunc(v)}i`;
        if (type.startsWith('vec') && type.endsWith('u')) return `${Math.trunc(v)}u`;
        if (type === 'vec2<bool>' || type === 'vec3<bool>' || type === 'vec4<bool>') return v !== 0 ? 'true' : 'false';
        if (type.startsWith('mat')) return Number.isInteger(v) ? `${v}.0` : `${v}`;
        return `${v}`;
    });
    if (components.length === 0) return `${type}()`;
    return `${type}(${components.join(', ')})`;
}

function buildUpdateSnippet(
    update: ForRange['update'],
    iName: string,
    type: ScalarType,
    defaultOp: '++' | '--',
): string {
    if (update === undefined || update === null) return `${iName}${defaultOp}`;
    if (typeof update === 'number') {
        const delta = constLiteral(type, Math.abs(update));
        const op = defaultOp.includes('+') ? '+=' : '-=';
        return `${iName} ${op} ${delta}`;
    }
    return `${iName}${defaultOp}`;
}

function buildForHeader(
    range: ForRange,
    iName: string,
    getScalarExpr: (v: Node<WgslType> | number, type: ScalarType) => string,
): string {
    const type: ScalarType = range.type ?? 'u32';

    const rawStart = range.start !== undefined
        ? (typeof range.start === 'number' ? constLiteral(type, range.start) : getScalarExpr(range.start, type))
        : undefined;
    const rawEnd = range.end !== undefined
        ? (typeof range.end === 'number' ? constLiteral(type, range.end) : getScalarExpr(range.end, type))
        : undefined;

    let startSnippet: string;
    let endSnippet: string;
    let condition: string;
    let updateSnippet: string;

    if (rawStart !== undefined && rawEnd === undefined) {
        startSnippet = `${rawStart} - ${constLiteral(type, 1)}`;
        endSnippet = constLiteral(type, 0);
        condition = range.condition ?? '>=';
        const defaultUpdate = condition.includes('<') ? '++' : '--';
        updateSnippet = buildUpdateSnippet(range.update, iName, type, defaultUpdate);
    } else {
        startSnippet = rawStart ?? constLiteral(type, 0);
        endSnippet = rawEnd ?? constLiteral(type, 0);

        if (range.condition !== undefined) {
            condition = range.condition;
        } else {
            const numStart = typeof range.start === 'number' ? range.start : 0;
            const numEnd = typeof range.end === 'number' ? range.end : undefined;
            condition = (numEnd !== undefined && numStart > numEnd) ? '>=' : '<';
        }

        const defaultUpdate = condition.includes('<') ? '++' : '--';
        updateSnippet = buildUpdateSnippet(range.update, iName, type, defaultUpdate);
    }

    return `for (var ${iName} : ${type} = ${startSnippet}; ${iName} ${condition} ${endSnippet}; ${updateSnippet})`;
}

// ---------------------------------------------------------------------------
// Subclasses — one per node kind
// ---------------------------------------------------------------------------

export class ConstNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly value: number | number[] | string,
    ) {
        super(computeId('const', { type, value }), 'const', type);
    }

    override generate(_builder: WgslBuilder): string {
        return constLiteral(this.type, this.value);
    }
}

export class UniformNode<T extends WgslType> extends Node<T> {
    readonly group: 'material' | 'frame';

    /** CPU-side value. Set this to update the uniform on the GPU. */
    value: number | number[] | Float32Array | null = null;

    /** Monotonically incremented when value is set. Renderer re-uploads when stale. */
    version: number = 0;

    constructor(
        type: T,
        readonly uniformId: string,
        group: 'material' | 'frame' = 'material',
    ) {
        super(computeId('uniform', { type, uniformId, group }), 'uniform', type);
        this.group = group;
    }

    override setup(builder: WgslBuilder): void {
        if (this.group === 'material' && !builder.uniformNodes.has(this.uniformId)) {
            builder.uniformNodes.set(this.uniformId, this as unknown as UniformNode<WgslType>);
        }
        const uniformDef = lookupStructDefByName(this.type);
        if (uniformDef) builder._registerStructDef(uniformDef);
    }

    override generate(_builder: WgslBuilder): string {
        if (this.group === 'material') return `materialUniforms.${this.uniformId}`;
        return this.uniformId;
    }
}

export class AttributeNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly name: string,
    ) {
        super(computeId('attribute', { type, name }), 'attribute', type);
    }

    override setup(builder: WgslBuilder): void {
        if (!builder.attributes.has(this.name)) {
            const totalLoc = builder.attributes.size + builder.instancedAttrs.length;
            builder.attributes.set(this.name, { kind: 'geometry', name: this.name, type: this.type, location: totalLoc });
        }
    }

    override generate(_builder: WgslBuilder): string {
        return `in.${this.name}`;
    }
}

/**
 * A dirty range for partial re-upload of a StorageNode's CPU data.
 * Units: flat component indices (same convention as three.js BufferAttribute.updateRanges).
 */
export type UpdateRange = { start: number; count: number };

export class StorageNode<T extends WgslType> extends Node<T> {
    /**
     * CPU-side typed array. Null after release() — the GPU buffer lives on in
     * BufferCache but CPU memory is freed.
     */
    data: GpuTypedArray | null;

    /** The WGSL array type string, e.g. 'array<mat4x4f>'. Emitted verbatim. */
    readonly storageType: string;

    readonly access: 'read' | 'read_write';

    /** Monotonically-incremented upload version. Renderer re-uploads when its
     *  stored version lags behind this. */
    version: number = 0;

    /** Pending partial-upload ranges. Units: flat component indices (same as three.js). */
    readonly updateRanges: UpdateRange[] = [];

    constructor(
        /** Element type (e.g. 'mat4x4f') — used as the node's type for downstream indexing. */
        type: T,
        /** Full WGSL array type string (e.g. 'array<mat4x4f>'). */
        storageType: string,
        data: GpuTypedArray | null,
        access: 'read' | 'read_write' = 'read',
    ) {
        super(nextId(), 'storage', type);
        this.storageType = storageType;
        this.data = data;
        this.access = access;
    }

    override setup(builder: WgslBuilder): void {
        if (!builder.storageNodes.has(this.id)) {
            if (builder.input.kind === 'compute') {
                const idx = builder.input.node.storage.findIndex((s) => s.id === this.id);
                const name = idx >= 0 ? `_cs${idx}` : `_cs${builder.storageNodes.size}`;
                builder.storageNodes.set(this.id, this as unknown as StorageNode<WgslType>);
                builder.storageNames.set(this.id, name);
            } else {
                const name = `_stor${builder.storageNodes.size}`;
                builder.storageNodes.set(this.id, this as unknown as StorageNode<WgslType>);
                builder.storageNames.set(this.id, name);
            }
        }
        const storageDef = lookupStructDefByName(this.type);
        if (storageDef) builder._registerStructDef(storageDef);
    }

    override generate(builder: WgslBuilder): string {
        return builder.storageNames.get(this.id) ?? this.id;
    }

    /** Mark data as needing re-upload on the next draw. Increments version. */
    set needsUpdate(_value: true) {
        if (this.data === null) {
            throw new Error('[gpucat] StorageNode.needsUpdate: node has been released — CPU data is no longer available.');
        }
        this.version++;
    }

    /**
     * Register a dirty range for partial re-upload.
     * @param start  First flat component index to re-upload.
     * @param count  Number of components to re-upload.
     */
    addUpdateRange(start: number, count: number): void {
        if (this.data === null) {
            throw new Error('[gpucat] StorageNode.addUpdateRange: node has been released — CPU data is no longer available.');
        }
        this.updateRanges.push({ start, count });
    }

    /** Clear all pending update ranges. Called automatically by the renderer after a partial upload. */
    clearUpdateRanges(): void {
        this.updateRanges.length = 0;
    }

    /**
     * Drop the CPU-side typed array reference. The GPU buffer in BufferCache
     * remains alive and bound — only the JS heap allocation is freed.
     * After calling release(), needsUpdate and addUpdateRange will throw.
     */
    release(): void {
        this.data = null;
    }
}

export class TextureNode extends Node<TextureType> {
    /** GPU texture resource. Set this before rendering. */
    resource: GPUTexture | GPUTextureView | null = null;

    constructor(
        type: TextureType,
        readonly textureId: string,
    ) {
        super(computeId('texture', { type, textureId }), 'texture', type);
    }

    override setup(builder: WgslBuilder): void {
        if (!builder.textureNodes.has(this.textureId)) {
            builder.textureNodes.set(this.textureId, this);
        }
    }

    override generate(_builder: WgslBuilder): string {
        return `${this.textureId}_tex`;
    }
}

export class SamplerNode extends Node<SamplerType> {
    /** GPU sampler resource. Set this before rendering. */
    resource: GPUSampler | null = null;

    constructor(
        type: SamplerType,
        readonly samplerId: string,
    ) {
        super(computeId('sampler', { type, samplerId }), 'sampler', type);
    }

    override setup(builder: WgslBuilder): void {
        if (!builder.samplerNodes.has(this.samplerId)) {
            builder.samplerNodes.set(this.samplerId, this);
        }
    }

    override generate(_builder: WgslBuilder): string {
        return `${this.samplerId}_samp`;
    }
}

export class VaryingNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly name: string,
        readonly source: Node<WgslType>,
    ) {
        super(computeId('varying', { type, name, source: source.id }), 'varying', type);
    }

    override setup(builder: WgslBuilder): void {
        if (!builder.varyings.has(this.name)) {
            builder.varyings.set(this.name, { name: this.name, type: this.type, location: builder.varyings.size });
        }
        // Walk the varying's source in setup so its resources are registered.
        builder._setupNode(this.source);
    }

    override generate(builder: WgslBuilder): string {
        if (builder.shaderStage === 'fragment') {
            const varyingData = builder.getDataFromNode(this as unknown as Node<WgslType>, 'fragment');
            if (varyingData.propertyName === undefined) {
                builder.flowNodeFromShaderStage('vertex', this.source);
                varyingData.propertyName = `in.${this.name}`;
            }
            return `in.${this.name}`;
        }
        return `in.${this.name}`;
    }
}

export class BinopNode<T extends WgslType> extends Node<T> {
    constructor(
        readonly op: BinopOp,
        type: T,
        readonly left: Node<WgslType>,
        readonly right: Node<WgslType>,
    ) {
        super(computeId('binop', { type, op, a: left.id, b: right.id }), 'binop', type);
    }

    override generate(builder: WgslBuilder): string {
        const l = builder._generateNode(this.left) ?? '/* missing */';
        const r = builder._generateNode(this.right) ?? '/* missing */';
        return `(${l} ${this.op} ${r})`;
    }
}

export class CallNode<T extends WgslType> extends Node<T> {
    /** For user-defined Fn calls, this references the FnNode for codegen traversal. */
    readonly fnNode?: FnNode<WgslType>;
    constructor(
        type: T,
        readonly fn: string,
        readonly args: Node<WgslType>[],
        fnNode?: FnNode<WgslType>,
    ) {
        super(computeId('call', { type, fn, args: args.map((n) => n.id) }), 'call', type);
        this.fnNode = fnNode;
    }

    override setup(builder: WgslBuilder): void {
        if (this.fnNode && !builder.fnNodes.has(this.fnNode.id)) {
            builder._setupFnNode(this.fnNode);
        }
    }

    override generate(builder: WgslBuilder): string {
        const argExprs = this.args.map((a) => builder._generateNode(a) ?? '/* missing */');
        if (this.fn === 'negate' && argExprs.length === 1) return `(-${argExprs[0]})`;
        if ((this.fn === 'f32' || this.fn === 'i32' || this.fn === 'u32') && argExprs.length === 1) {
            return `${this.fn}(${argExprs[0]})`;
        }
        return `${this.fn}(${argExprs.join(', ')})`;
    }
}

export class RawNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly wgsl: string,
        readonly deps: Node<WgslType>[],
    ) {
        super(computeId('raw', { type, wgsl, deps: deps.map((n) => n.id) }), 'raw', type);
    }

    override generate(builder: WgslBuilder): string {
        const depExprs = this.deps.map((d) => builder._generateNode(d) ?? '/* missing */');
        return this.wgsl.replace(/\$(\d+)/g, (_, i) => depExprs[parseInt(i, 10)] ?? `/* dep${i} */`);
    }
}

export class AssignNode extends Node<'void'> {
    constructor(
        readonly target: Node<WgslType>,
        readonly value: Node<WgslType>,
    ) {
        super(computeId('assign', { target: target.id, value: value.id }), 'assign', 'void');
    }

    override generate(builder: WgslBuilder): null {
        const tgt = builder._generateNode(this.target) ?? '/* missing */';
        const val = builder._generateNode(this.value) ?? '/* missing */';
        builder.addLineFlowCode(`${tgt} = ${val}`);
        return null;
    }
}

export class ConstructNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly args: Node<WgslType>[],
    ) {
        super(computeId('construct', { type, args: args.map((n) => n.id) }), 'construct', type);
    }

    override generate(builder: WgslBuilder): string {
        const argExprs = this.args.map((a) => builder._generateNode(a) ?? '/* missing */');
        return `${this.type}(${argExprs.join(', ')})`;
    }
}

export class StructNode extends Node<string> {
    constructor(
        typeName: string,
        readonly members: StructMember[],
    ) {
        super(computeId('struct', { type: typeName, members }), 'struct', typeName);
    }

    override setup(builder: WgslBuilder): void {
        const def = lookupStructDef(this);
        if (def) {
            builder._registerStructDef(def);
        } else if (!builder.structNodes.has(this.type)) {
            builder.structNodes.set(this.type, this);
        }
    }

    override generate(_builder: WgslBuilder): string {
        return `/* struct ${this.type} */`;
    }
}

export class FieldNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly object: Node<WgslType>,
        readonly fieldName: string,
    ) {
        super(computeId('field', { type, object: object.id, field: fieldName }), 'field', type);
    }

    override generate(builder: WgslBuilder): string {
        const objExpr = builder._generateNode(this.object) ?? '/* missing */';
        return `${objExpr}.${this.fieldName}`;
    }
}

/**
 * IndexNode — array element access: array[indexExpr].
 *
 * Used to index into storage buffers (e.g. instanceMatrices[instance_index]).
 * The element type T is the type of each array element.
 *
 * @example
 * const modelMat = new IndexNode('mat4x4f', instanceMatricesNode, instanceIndexNode);
 * // compiles to: instanceMatrices[instance_index]
 */
export class IndexNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly array: Node<WgslType>,
        readonly index: Node<WgslType>,
    ) {
        super(computeId('index', { type, array: array.id, index: index.id }), 'index', type);
    }

    override generate(builder: WgslBuilder): string {
        const arrExpr = builder._generateNode(this.array) ?? '/* missing */';
        const idxExpr = builder._generateNode(this.index) ?? '/* missing */';
        return `${arrExpr}[${idxExpr}]`;
    }
}

export class BuiltinNode<T extends WgslType> extends Node<T> {
    constructor(
        readonly builtinKind: BuiltinKind,
        type: T,
    ) {
        super(computeId('builtin', { builtinKind, type }), 'builtin', type);
    }

    override setup(builder: WgslBuilder): void {
        builder.builtinsUsed.add(this.builtinKind);
        if (this.builtinKind === 'camera' && !builder.structNodes.has('Camera')) {
            builder.structNodes.set('Camera', CameraStruct.node);
        }
        if (this.builtinKind === 'time' && !builder.structNodes.has('Time')) {
            builder.structNodes.set('Time', TimeStruct.node);
        }
        if (this.builtinKind === 'mesh' && !builder.structNodes.has('Mesh')) {
            builder.structNodes.set('Mesh', MeshStruct.node);
        }
    }

    override generate(builder: WgslBuilder): string {
        const BUILTIN_VAR: Record<string, string> = {
            camera:         'camera',
            time:           'time',
            mesh:           'mesh',
            instance_index: 'instance_index',
            instance_data:  'instanceData',
            vertex_index:   'vertex_index',
        };
        const BUILTIN_VERTEX_INPUT = new Set(['instance_index', 'vertex_index']);
        if (builder.shaderStage === 'compute') {
            return this.builtinKind;
        }
        if (BUILTIN_VERTEX_INPUT.has(this.builtinKind)) {
            return `in.${BUILTIN_VAR[this.builtinKind] ?? this.builtinKind}`;
        }
        return BUILTIN_VAR[this.builtinKind] ?? this.builtinKind;
    }
}

// ---------------------------------------------------------------------------
// Monotonic counter — used by StackNode and all statement-level nodes so that
// two identical-looking vars/stacks/ifs are never merged.
// ---------------------------------------------------------------------------

let _nodeCounter = 0;
const nextId = () => `s_${_nodeCounter++}`;

/**
 * Any typed array that WebGPU can upload as a vertex buffer.
 * Use this as the `data` type for instanced buffer attributes.
 */
export type GpuTypedArray =
    | Float32Array
    | Int32Array
    | Uint32Array
    | Int16Array
    | Uint16Array
    | Int8Array
    | Uint8Array;

/**
 * InstancedBufferAttributeNode — a per-instance vertex attribute whose data is
 * owned directly by the node (not looked up in geometry.attributes).
 *
 * Mirrors TSL's BufferAttributeNode with instanced: true.
 * The renderer uploads `data` as a vertex buffer with stepMode: 'instance'.
 *
 * @example
 * const offsets = instancedBufferAttribute(new Float32Array([...]), 'vec3f', 12, 0)
 */
export class InstancedBufferAttributeNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        /** Flat CPU-side data array. Lives here; renderer uploads from this. */
        readonly data: GpuTypedArray,
        /** Byte stride between consecutive instances. */
        readonly stride: number,
        /** Byte offset of this attribute within each instance record. */
        readonly offset: number,
    ) {
        // ID is NOT content-addressed on data (too expensive to hash large arrays).
        // Use a monotonic id so two separate instancedBufferAttribute() calls are always distinct.
        super(nextId(), 'instanced_buffer_attribute', type);
    }

    override setup(builder: WgslBuilder): void {
        if (!builder.instancedAttrNames.has(this.id)) {
            const totalLoc = builder.attributes.size + builder.instancedAttrs.length;
            const name = `_inst${builder.instancedAttrs.length}`;
            builder.instancedAttrNames.set(this.id, name);
            builder.instancedAttrs.push({ kind: 'instanced', node: this as unknown as InstancedBufferAttributeNode<WgslType>, name, type: this.type, location: totalLoc });
        }
    }

    override generate(builder: WgslBuilder): string {
        const name = builder.instancedAttrNames.get(this.id);
        return name ? `in.${name}` : `/* missing instanced attr ${this.id} */`;
    }
}

export class StackNode extends Node<'void'> {
    readonly body: Node<WgslType>[];
    constructor(initial?: Node<WgslType>[]) {
        // StackNode used during tracing starts empty; the `stack(...)` DSL helper
        // passes an initial array. ID is computed lazily after tracing is complete,
        // but for now we use a monotonic ID so two stacks are never deduplicated.
        super(nextId(), 'stack', 'void');
        this.body = initial ? [...initial] : [];
    }
    push(node: Node<WgslType>): void {
        this.body.push(node);
    }

    override generate(builder: WgslBuilder): null {
        for (const stmt of this.body) {
            builder._buildNode(stmt);
        }
        return null;
    }
}

export class CondNode<T extends WgslType> extends Node<T> {
    readonly ifFalse?: Node<WgslType>;
    constructor(
        readonly condition: Node<WgslType>,
        readonly ifTrue: Node<T>,
        ifFalse?: Node<T>,
    ) {
        super(computeId('cond', { condition: condition.id, ifTrue: ifTrue.id, ifFalse: ifFalse?.id }), 'cond', ifTrue.type);
        this.ifFalse = ifFalse;
    }

    override generate(builder: WgslBuilder): string {
        const condExpr = builder._generateNode(this.condition) ?? '/* missing */';
        const trueExpr = builder._generateNode(this.ifTrue) ?? '/* missing */';
        const falseExpr = this.ifFalse
            ? builder._generateNode(this.ifFalse) ?? '/* missing */'
            : `${this.type}()`;
        return `select(${falseExpr}, ${trueExpr}, ${condExpr})`;
    }
}

// ---------------------------------------------------------------------------
// Fn / control-flow node classes (statement-level, monotonic IDs)
// ---------------------------------------------------------------------------

/**
 * VarNode — a mutable local variable declared inside a Fn body.
 * Created by `toVar()`. The JS handle is returned so the caller can call
 * `.assign()` later. The node is also pushed onto the current StackNode.
 *
 * kind: 'var'
 */
export class VarNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly varName: string,
        readonly init: Node<T>,
    ) {
        super(nextId(), 'var', type);
    }

    override generate(builder: WgslBuilder): string {
        // Register the declaration into the per-stage vars preamble (deduplicates automatically).
        // Parallel to three.js VarNode.generate calling builder.getVarFromNode().
        const name = builder.getVarFromNode(this as unknown as Node<WgslType>, this.varName, this.type);
        // Emit only the assignment into the flow code (no `var` keyword here).
        const initExpr = builder._generateNode(this.init) ?? '/* missing */';
        builder.addLineFlowCode(`${name} = ${initExpr}`);
        // Cache the name for subsequent references (CSE hit path).
        const data = builder.getDataFromNode(this as unknown as Node<WgslType>);
        data.propertyName = name;
        return name;
    }
}

/**
 * IfNode — statement-form conditional (compiles to `if (cond) { ... } else { ... }`).
 * Distinct from CondNode which is the expression form (`select(a,b,cond)`).
 * Created by `If()`. The `.Else()` chain sets elseBody on the same IfNode.
 *
 * kind: 'if'
 */
export class IfNode extends Node<'void'> {
    elseBody: StackNode | null = null;
    constructor(
        readonly condition: Node<WgslType>,
        readonly thenBody: StackNode,
    ) {
        super(nextId(), 'if', 'void');
    }

    override generate(builder: WgslBuilder): null {
        const condExpr = builder._generateNode(this.condition) ?? '/* missing */';
        builder.addFlowCode(`    if (${condExpr}) {\n`);
        builder._emitStackIntoFlow(this.thenBody, '        ');
        if (this.elseBody) {
            builder.addFlowCode(`    } else {\n`);
            builder._emitStackIntoFlow(this.elseBody, '        ');
        }
        builder.addFlowCode(`    }\n`);
        return null;
    }
}

/**
 * ForRange — describes the iteration space for a ForNode.
 *
 * - `start`     — initial value (default: `0u` for u32, `0i` for i32, etc.)
 * - `end`       — exclusive/inclusive upper/lower bound depending on `condition`
 * - `type`      — WGSL scalar type of the index variable (default: `'u32'`)
 * - `condition` — comparison operator (auto-inferred when omitted)
 * - `update`    — step per iteration as a node or number (default: `++` / `--`)
 *
 * Auto-inference rules (mirroring Three.js TSL LoopNode):
 *   - `end` given, no `start`  → forward:   `start=0`, `condition='<'`,  `update=1`
 *   - `start` given, no `end`  → backwards: `end=0`,   `condition='>='`, `update=-1`
 *   - both given               → compare numerically to pick direction when `condition` omitted
 */
export type ForRange = {
    /** Inclusive start value. Node<WgslType> or plain number. Default: 0. */
    start?: Node<WgslType> | number;
    /** End bound. Node<WgslType> or plain number. Required unless `start` is given alone (backwards). */
    end?: Node<WgslType> | number;
    /** WGSL scalar type for the index variable. Default: `'u32'`. */
    type?: ScalarType;
    /** Comparison operator. Auto-inferred when omitted. */
    condition?: '<' | '<=' | '>' | '>=';
    /** Per-iteration step as a Node or number. Auto-inferred when omitted. */
    update?: Node<WgslType> | number;
};

/**
 * ForNode — statement-form counted loop with a configurable range.
 * Created by `For({ end: n }, ({ i }) => { ... })`.
 *
 * The `range` descriptor drives WGSL codegen. See `ForRange` for full options.
 *
 * kind: 'for'
 */
export class ForNode extends Node<'void'> {
    constructor(
        readonly range: ForRange,
        readonly indexVar: ParamNode<WgslType>,
        readonly body: StackNode,
    ) {
        super(nextId(), 'for', 'void');
    }

    override generate(builder: WgslBuilder): null {
        const iName = `i_${builder.forCounter++}`;
        const idxData = builder.getDataFromNode(this.indexVar);
        idxData.propertyName = iName;
        const getScalarExpr = (v: Node<WgslType> | number, _type: ScalarType) =>
            typeof v === 'number'
                ? constLiteral(_type, v)
                : builder._generateNode(v as Node<WgslType>) ?? '/* missing */';
        const header = buildForHeader(this.range, iName, getScalarExpr);
        builder.addFlowCode(`    ${header} {\n`);
        builder._emitStackIntoFlow(this.body, '        ');
        builder.addFlowCode(`    }\n`);
        return null;
    }
}

/**
 * WhileNode — statement-form while loop driven by a boolean expression.
 * Created by `While(conditionNode, () => { ... })`.
 *
 * kind: 'while'
 */
export class WhileNode extends Node<'void'> {
    constructor(
        readonly condition: Node<WgslType>,
        readonly body: StackNode,
    ) {
        super(nextId(), 'while', 'void');
    }

    override generate(builder: WgslBuilder): null {
        const condExpr = builder._generateNode(this.condition) ?? '/* missing */';
        builder.addFlowCode(`    while (${condExpr}) {\n`);
        builder._emitStackIntoFlow(this.body, '        ');
        builder.addFlowCode(`    }\n`);
        return null;
    }
}

/**
 * BreakNode — a `break` statement inside a loop body.
 * Created by `Break()`.
 *
 * kind: 'break'
 */
export class BreakNode extends Node<'void'> {
    constructor() {
        super(nextId(), 'break', 'void');
    }

    override generate(builder: WgslBuilder): null {
        builder.addLineFlowCode('break');
        return null;
    }
}

/**
 * ContinueNode — a `continue` statement inside a loop body.
 * Created by `Continue()`.
 *
 * kind: 'continue'
 */
export class ContinueNode extends Node<'void'> {
    constructor() {
        super(nextId(), 'continue', 'void');
    }

    override generate(builder: WgslBuilder): null {
        builder.addLineFlowCode('continue');
        return null;
    }
}

/**
 * ParamNode — a typed function parameter placeholder.
 * Created by `Fn()` when it builds the FnNode. Also used as the loop index in ForNode.
 *
 * kind: 'param'
 */
export class ParamNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly paramIndex: number,
        /** The declared name from FnLayout.params[i].name, if a layout was provided. */
        readonly paramName?: string,
    ) {
        super(nextId(), 'param', type);
    }

    override generate(_builder: WgslBuilder): string {
        return this.paramName ?? `p${this.paramIndex}`;
    }
}

/**
 * ReturnNode — an explicit early `return` statement inside a Fn body.
 * Created by `Return(node)`. Compiles to `return <expr>;`.
 *
 * kind: 'return'
 */
export class ReturnNode<T extends WgslType> extends Node<T> {
    constructor(readonly value: Node<T>) {
        super(nextId(), 'return', value.type);
    }

    override generate(builder: WgslBuilder): null {
        const valExpr = builder._generateNode(this.value) ?? '/* missing */';
        builder.addLineFlowCode(`return ${valExpr}`);
        return null;
    }
}

/**
 * FnNode — a named WGSL function defined via `Fn(jsFunc)` or `Fn(jsFunc, layout)`.
 * Holds the parameter descriptors and a JS function that, when called with
 * ParamNodes, performs eager tracing to produce the body StackNode + outputNode.
 *
 * The compiler calls `trace()` once to materialise the body.
 *
 * kind: 'fn'
 */
export class FnNode<T extends WgslType> extends Node<T> {
    /** WGSL function name. From layout.name if provided, otherwise auto-generated `fn_<id>`. */
    readonly fnName: string;
    /**
     * Parameter descriptors. ParamDesc[] when a layout was provided (carries name + type),
     * WgslDesc[] when no layout was given (type only, name will be auto `p0`, `p1`, …).
     */
    readonly paramDescs: (ParamDesc | WgslDesc<WgslType>)[];
    /** The JS function passed to Fn(). The compiler calls this with ParamNodes. */
    readonly jsFunc: (...args: Node<WgslType>[]) => Node<T>;

    constructor(
        returnType: T,
        paramDescs: (ParamDesc | WgslDesc<WgslType>)[],
        jsFunc: (...args: Node<WgslType>[]) => Node<T>,
        fnName?: string,
    ) {
        super(nextId(), 'fn', returnType);
        this.fnName = fnName ?? `fn_${this.id}`;
        this.paramDescs = paramDescs;
        this.jsFunc = jsFunc;
    }

    /**
     * Execute the JS callback with fresh ParamNodes, capturing the resulting
     * StackNode body and the output expression node.
     * Returns { params, body, output } for use by the compiler.
     */
    trace(): { params: ParamNode<WgslType>[]; body: StackNode; output: Node<T> } {
        const params = this.paramDescs.map((d, i) => {
            const paramName = 'name' in d ? (d as ParamDesc).name : undefined;
            const wgslType = 'name' in d ? (d as ParamDesc).type.wgslType : (d as WgslDesc<WgslType>).wgslType;
            return new ParamNode(wgslType, i, paramName);
        });
        const stack = new StackNode();
        const prev = pushStack(stack);
        let output: Node<T>;
        try {
            output = this.jsFunc(...params);
        } finally {
            popStack(prev);
        }
        return { params, body: stack, output };
    }

    override generate(_builder: WgslBuilder): string {
        return `/* fn ${this.type} */`;
    }
}

// ---------------------------------------------------------------------------
// currentStack — module-level tracing context
// ---------------------------------------------------------------------------

let currentStack: StackNode | null = null;

function pushStack(stack: StackNode): StackNode | null {
    const prev = currentStack;
    currentStack = stack;
    return prev;
}

function popStack(prev: StackNode | null): void {
    currentStack = prev;
}

function addToStack(node: Node<WgslType>): void {
    if (currentStack === null) {
        throw new Error(
            `[gpucat] Control flow (toVar, If, For, Return) must be called inside a Fn body. ` +
                `You are calling it outside of any Fn — wrap your code in Fn([...], () => { ... }).`,
        );
    }
    currentStack.push(node);
}

// ---------------------------------------------------------------------------
// Content-addressed ID
// ---------------------------------------------------------------------------

function computeId(kind: string, fields: Record<string, unknown>): string {
    return 'n_' + djb2(stableStringify({ kind, ...fields })).toString(36);
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const keys = Object.keys(value as object).sort();
    return (
        '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') + '}'
    );
}

function djb2(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
        hash = hash >>> 0;
    }
    return hash;
}

// ---------------------------------------------------------------------------
// DSL constructor functions
// ---------------------------------------------------------------------------

export const konst = <T extends WgslType>(type: T, value: number | number[] | string) => new ConstNode(type, value);
/**
 * Declare a material uniform.
 *
 * **Scalar / vector / matrix form** — pass a typed ConstNode as the initialiser:
 *   uniform(f32(0.5))               // anonymous — uniformId derived from type
 *   uniform(f32(0.5), 'roughness')  // explicit name used as the WGSL field name
 *   uniform(vec4f(1, 0, 0, 1), 'baseColor')
 *
 * **Struct form** — pass a StructDef directly; returns a typed StructInstance
 * whose keys are FieldNodes and whose `.$node` is the underlying UniformNode:
 *   const MyStruct = struct('MyStruct', { x: S.f32(), y: S.f32() })
 *   const myVal = uniform(MyStruct, 'myVal')
 *   myVal.x      // → FieldNode<'f32'>
 *   myVal.$node  // → UniformNode<'MyStruct'>
 *
 * The underlying UniformNode is content-addressed on (type, uniformId) so two
 * calls with the same arguments return the same node object.
 */
export function uniform<S extends StructSchema>(def: StructDef<S>, name: string): StructInstance<S>;
export function uniform<T extends WgslType>(init: ConstNode<T>, name?: string): UniformNode<T>;
export function uniform<T extends WgslType, S extends StructSchema>(
    init: ConstNode<T> | StructDef<S>,
    name?: string,
): UniformNode<T> | StructInstance<S> {
    if ('schema' in init) {
        // Struct form: init is a StructDef
        const def = init as StructDef<S>;
        const uniformId = name ?? def.wgslType;
        const node = new UniformNode<string>(def.wgslType, uniformId);
        return def.instantiate(node);
    }
    // Scalar / vector / matrix form: init is a ConstNode
    const constNode = init as ConstNode<T>;
    const uniformId = name ?? constNode.type;
    const node = new UniformNode(constNode.type, uniformId);
    if (node.value === null && constNode.value !== null) {
        node.value = constNode.value as number | number[];
    }
    return node;
}
export const attribute = <T extends WgslType>(type: T, name: string) => new AttributeNode(type, name);

/**
 * Create a `StorageNode` backed by an existing typed array.
 *
 * The array descriptor's element type becomes the node's TypeScript type, and
 * its `.wgslType` (e.g. `'array<mat4x4f>'`) is stored as `node.storageType` for
 * WGSL emission.  The renderer uploads `data` automatically; call
 * `node.needsUpdate = true` to trigger a re-upload.
 *
 * @example
 * import * as S from './schema.js'
 * const matrices = storage(matrixData, S.array(S.mat4x4f()))
 * // later: matrices.needsUpdate = true
 */
export const storage = <E extends WgslType>(
    data: GpuTypedArray,
    arrayDesc: ArrayDesc<E>,
    access: 'read' | 'read_write' = 'read',
): StorageNode<E> =>
    new StorageNode(arrayDesc.elementDesc.wgslType, arrayDesc.wgslType, data, access);

/**
 * Create a `StorageNode` with a zero-initialised typed array allocated internally.
 *
 * The element type and TypedArray kind are derived from `arrayDesc`:
 * - `S.array(S.vec4f())`   → `Float32Array` of length `count * 4`
 * - `S.array(S.u32())`     → `Uint32Array`  of length `count * 1`
 * - `S.array(S.mat4x4f())` → `Float32Array` of length `count * 16`
 *
 * @example
 * import * as S from './schema.js'
 * const colors = storageArray(N, S.array(S.vec4f()), 'read_write')
 * // Modify colors.data, then: colors.needsUpdate = true
 */
export const storageArray = <E extends WgslType>(
    count: number,
    arrayDesc: ArrayDesc<E>,
    access: 'read' | 'read_write' = 'read',
): StorageNode<E> => {
    const itemSize = itemSizeOf(arrayDesc.elementDesc);
    const Ctor = typedArrayCtorOf(arrayDesc.elementDesc);
    const data = new Ctor(count * itemSize);
    return new StorageNode(arrayDesc.elementDesc.wgslType, arrayDesc.wgslType, data, access);
};

export const texture = (textureType: string, textureId: string) => new TextureNode(textureType, textureId);
export const sampler = (samplerId: string, opts?: { comparison?: boolean }) =>
    new SamplerNode(opts?.comparison ? 'sampler_comparison' : 'sampler', samplerId);
export const varying = <T extends WgslType>(type: T, name: string, source: Node<WgslType>) => new VaryingNode(type, name, source);
export const builtin = <T extends WgslType>(builtinKind: BuiltinKind, type: T) => new BuiltinNode(builtinKind, type);
export const raw = <T extends WgslType>(type: T, wgsl: string, ...deps: Node<WgslType>[]) => new RawNode(type, wgsl, deps);
export const stack = (...body: Node<WgslType>[]) => new StackNode(body);
export const cond = <T extends WgslType>(condition: Node<WgslType>, ifTrue: Node<T>, ifFalse?: Node<T>) =>
    new CondNode(condition, ifTrue, ifFalse);

/** Array element access: array[index]. Element type T is inferred from the array node. */
export const index = <T extends WgslType>(array: Node<T>, idx: Node<WgslType>) => new IndexNode(array.type, array, idx);

// ---------------------------------------------------------------------------
// Vec constructor helpers
//
// makeVec2 / makeVec3 / makeVec4 are internal factories that produce typed
// constructor functions for any vec2/vec3/vec4 WGSL type.
//
// For each component:
//   - If a raw number is passed, it is wrapped in a ConstNode of the element
//     scalar type (f32 for *f, i32 for *i, u32 for *u, bool for *b).
//   - Node values pass through unchanged.
//   - If ALL arguments are raw numbers the result is still a ConstructNode
//     (WGSL handles the constant folding at compile time; the graph stays
//     uniform). This matches Three.js ConvertType behaviour closely enough
//     for our purposes — we don't need the ConstNode short-circuit path
//     because our ConstNode factories (vec3f, vec3i, …) already cover that.
// ---------------------------------------------------------------------------

type Scalar = Node<WgslType> | number | boolean;

/** Wrap a scalar JS value as the appropriate ConstNode for the given vec element type. */
function wrapScalar(v: Scalar, elemType: 'f32' | 'i32' | 'u32' | 'bool'): Node<WgslType> {
    if (v instanceof Node) return v;
    if (elemType === 'bool') return new ConstNode('bool', (v as boolean | number) ? 1 : 0);
    if (elemType === 'i32')  return new ConstNode('i32',  Math.trunc(v as number));
    if (elemType === 'u32')  return new ConstNode('u32',  Math.trunc(v as number));
    return new ConstNode('f32', v as number);
}

function elemOf(type: Vec2Type | Vec3Type | Vec4Type): 'f32' | 'i32' | 'u32' | 'bool' {
    if (type.endsWith('f')) return 'f32';
    if (type.endsWith('i')) return 'i32';
    if (type.endsWith('u')) return 'u32';
    return 'bool';
}

function makeVec2<T extends Vec2Type>(type: T) {
    return (x: Scalar, y: Scalar): ConstructNode<T> => {
        const e = elemOf(type);
        return new ConstructNode(type, [wrapScalar(x, e), wrapScalar(y, e)]);
    };
}

function makeVec3<T extends Vec3Type>(type: T) {
    function ctor(xy: Node<WgslType>, z: Scalar): ConstructNode<T>;
    function ctor(x: Scalar, y: Scalar, z: Scalar): ConstructNode<T>;
    function ctor(a: Scalar, b: Scalar, c?: Scalar): ConstructNode<T> {
        const e = elemOf(type);
        if (c === undefined) return new ConstructNode(type, [wrapScalar(a, e), wrapScalar(b, e)]);
        return new ConstructNode(type, [wrapScalar(a, e), wrapScalar(b, e), wrapScalar(c, e)]);
    }
    return ctor;
}

function makeVec4<T extends Vec4Type>(type: T) {
    function ctor(xy: Node<WgslType>, zw: Node<WgslType>): ConstructNode<T>;
    function ctor(xy: Node<WgslType>, z: Scalar, w: Scalar): ConstructNode<T>;
    function ctor(xyz: Node<WgslType>, w: Scalar): ConstructNode<T>;
    function ctor(x: Scalar, y: Scalar, z: Scalar, w: Scalar): ConstructNode<T>;
    function ctor(a: Scalar, b: Scalar, c?: Scalar, d?: Scalar): ConstructNode<T> {
        const e = elemOf(type);
        if (c === undefined) return new ConstructNode(type, [wrapScalar(a, e), wrapScalar(b, e)]);
        if (d === undefined) return new ConstructNode(type, [wrapScalar(a, e), wrapScalar(b, e), wrapScalar(c, e)]);
        return new ConstructNode(type, [wrapScalar(a, e), wrapScalar(b, e), wrapScalar(c, e), wrapScalar(d, e)]);
    }
    return ctor;
}

// ---------------------------------------------------------------------------
// Type constructors — all WGSL component-packing forms, Three.js naming.
//
// float (f32) variants — vec2 / vec3 / vec4
// ---------------------------------------------------------------------------

/** vec2<f32> constructor: vec2(x, y) */
export const vec2  = makeVec2('vec2f');
/** vec3<f32> constructor: vec3(x, y, z) or vec3(xy, z) */
export const vec3  = makeVec3('vec3f');
/**
 * vec4<f32> constructor — all WGSL component-packing forms:
 *   vec4(x, y, z, w)  |  vec4(xyz, w)  |  vec4(xy, z, w)  |  vec4(xy, zw)
 */
export const vec4  = makeVec4('vec4f');

// int (i32) variants — ivec2 / ivec3 / ivec4
export const ivec2 = makeVec2('vec2i');
export const ivec3 = makeVec3('vec3i');
export const ivec4 = makeVec4('vec4i');

// uint (u32) variants — uvec2 / uvec3 / uvec4
export const uvec2 = makeVec2('vec2u');
export const uvec3 = makeVec3('vec3u');
export const uvec4 = makeVec4('vec4u');



export const mat4 = (c0: Node<'vec4f'>, c1: Node<'vec4f'>, c2: Node<'vec4f'>, c3: Node<'vec4f'>) =>
    new ConstructNode('mat4x4f', [c0, c1, c2, c3]);

// Standalone math (mirrors chaining API)
export const add = <T extends WgslType>(a: Node<T>, b: Node<T>) => a.add(b);
export const sub = <T extends WgslType>(a: Node<T>, b: Node<T>) => a.sub(b);
export const div = <T extends WgslType>(a: Node<T>, b: Node<T>) => a.div(b);
export const mul = <A extends WgslType, B extends WgslType>(a: Node<A>, b: Node<B>) => a.mul(b);
export const dot = (a: Node<WgslType>, b: Node<WgslType>) => new CallNode('f32', 'dot', [a, b]);
export const cross = <T extends WgslType>(a: Node<T>, b: Node<T>) => a.cross(b);
export const normalize = <T extends WgslType>(a: Node<T>) => a.normalize();
export const length = (a: Node<WgslType>) => a.length();
export const abs = <T extends WgslType>(a: Node<T>) => a.abs();
export const floor = <T extends WgslType>(a: Node<T>) => a.floor();
export const ceil = <T extends WgslType>(a: Node<T>) => a.ceil();
export const fract = <T extends WgslType>(a: Node<T>) => a.fract();
export const sqrt = <T extends WgslType>(a: Node<T>) => a.sqrt();
export const sin = <T extends WgslType>(a: Node<T>) => a.sin();
export const cos = <T extends WgslType>(a: Node<T>) => a.cos();
export const pow = <T extends WgslType>(a: Node<T>, b: Node<T>) => a.pow(b);
export const max = <T extends WgslType>(a: Node<T>, b: Node<T>) => a.max(b);
export const min = <T extends WgslType>(a: Node<T>, b: Node<T>) => a.min(b);
export const clamp = <T extends WgslType>(a: Node<T>, lo: Node<T>, hi: Node<T>) => a.clamp(lo, hi);
export const mix = <T extends WgslType>(a: Node<T>, b: Node<T>, t: Node<T>) => a.mix(b, t);
export const step = <T extends WgslType>(edge: Node<T>, x: Node<T>) => x.step(edge);
export const smoothstep = <T extends WgslType>(lo: Node<T>, hi: Node<T>, x: Node<T>) => x.smoothstep(lo, hi);

// Texture helpers
export const textureSample = (t: Node<WgslType>, s: Node<WgslType>, uv: Node<WgslType>) =>
    new CallNode('vec4f', 'textureSample', [t, s, uv]);
export const textureLoad = (t: Node<WgslType>, coord: Node<WgslType>, level: Node<WgslType>) =>
    new CallNode('vec4f', 'textureLoad', [t, coord, level]);
export const textureSampleLevel = (t: Node<WgslType>, s: Node<WgslType>, uv: Node<WgslType>, level: Node<WgslType>) =>
    new CallNode('vec4f', 'textureSampleLevel', [t, s, uv, level]);

export function tex(
    id: string,
    textureType = 'texture_2d<f32>',
): { node: TextureNode; samp: SamplerNode; sample(uv: Node<WgslType>): CallNode<'vec4f'> } {
    const node = new TextureNode(textureType, id);
    const samp = new SamplerNode('sampler', id);
    return { node, samp, sample: (uv) => new CallNode('vec4f', 'textureSample', [node, samp, uv]) };
}

// ---------------------------------------------------------------------------
// Instanced buffer attribute DSL helpers
// ---------------------------------------------------------------------------

/**
 * Create an InstancedBufferAttributeNode — a per-instance vertex attribute
 * whose data lives on the node and is uploaded by the renderer as a vertex
 * buffer with stepMode: 'instance'.
 *
 * @param data    Flat typed array — one record per instance. Any GPU-compatible
 *                typed array is accepted: Float32Array, Int32Array, Uint32Array,
 *                Int16Array, Uint16Array, Int8Array, Uint8Array.
 * @param type    WGSL type of the attribute (e.g. 'vec3f', 'vec4f').
 * @param stride  Byte stride between consecutive instance records.
 * @param offset  Byte offset of this attribute within each instance record.
 *
 * @example
 * const colors = instancedBufferAttribute(new Float32Array([1,0,0, 0,1,0, 0,0,1]), 'vec3f', 12, 0)
 * const flags  = instancedBufferAttribute(new Uint8Array([1, 0, 1, 1]), 'u32', 1, 0)
 */
export const instancedBufferAttribute = <T extends WgslType>(
    data: GpuTypedArray,
    type: T,
    stride: number,
    offset: number,
) => new InstancedBufferAttributeNode(type, data, stride, offset);

// ---------------------------------------------------------------------------
// Control-flow DSL — must be called inside a Fn body
// ---------------------------------------------------------------------------

/**
 * Declare a mutable variable initialised to `init`.
 *
 * @param init    Initial value node — element type T is inferred from this.
 * @param label   Optional debug label — appended to the generated var name (e.g. 'color' → 'var_42_color').
 * @returns       A VarNode you can later call `.assign()` on.
 *
 * **Inside a `Fn` body** — the declaration is emitted at the call site (function-scope `var`).
 *
 * **Outside any `Fn` body** — the VarNode is created but not pushed onto a stack.
 * It is emitted inline into whatever shader-stage function body first references it
 * during the generate pass, mirroring three.js TSL behaviour.
 *
 * @example
 * const acc = toVar(f32(0.0), 'acc')
 * acc.assign(acc.add(f32(1.0)))
 */
export function toVar<T extends WgslType>(init: Node<T>, label?: string): VarNode<T> {
    return init.toVar(label);
}

/** Chainable object returned by `If()` so `.Else()` can be chained. */
export type IfChain = { Else(body: () => void): IfChain };

/**
 * Statement-form conditional inside a Fn body.
 *
 * The `thenBody` callback is called immediately during tracing (side-effects only,
 * no return value). Use `Return(node)` inside for early exits.
 *
 * @returns An object with `.Else(body)` for chaining else branches.
 *
 * @example
 * If(x.gt(konst('f32', 0.5)), () => {
 *     result.assign(konst('vec3f', [1, 0, 0]))
 * }).Else(() => {
 *     result.assign(konst('vec3f', [0, 0, 1]))
 * })
 */
export function If(condition: Node<WgslType>, thenBody: () => void): IfChain {
    const thenStack = new StackNode();
    const prev = pushStack(thenStack);
    try {
        thenBody();
    } finally {
        popStack(prev);
    }
    const ifNode = new IfNode(condition, thenStack);
    addToStack(ifNode);

    const chain: IfChain = {
        Else(elseBody: () => void): IfChain {
            const elseStack = new StackNode();
            const elseFrame = pushStack(elseStack);
            try {
                elseBody();
            } finally {
                popStack(elseFrame);
            }
            ifNode.elseBody = elseStack;
            return chain; // return same chain to allow further Else() calls if needed
        },
    };
    return chain;
}

/**
 * Statement-form loop with a configurable range, inside a Fn body.
 *
 * **Simple forward loop** (0 to `end`, exclusive):
 * ```ts
 * For({ end: n }, ({ i }) => { ... })
 * ```
 *
 * **Custom range and step**:
 * ```ts
 * For({ start: u32(4), end: u32(16), condition: '<', update: 2 }, ({ i }) => { ... })
 * ```
 *
 * **Backwards** (start only — counts down to 0):
 * ```ts
 * For({ start: u32(10) }, ({ i }) => { ... })
 * // → for (var i : u32 = 10u - 1u; i >= 0u; i--)
 * ```
 *
 * **Signed integer index**:
 * ```ts
 * For({ start: i32(-4), end: i32(4), type: 'i32' }, ({ i }) => { ... })
 * ```
 *
 * Use `Break()` and `Continue()` inside the body for early exit / skip.
 */
export function For(range: ForRange, body: (args: { i: ParamNode<WgslType> }) => void): void {
    const idxType: ScalarType = range.type ?? 'u32';
    const indexVar = new ParamNode<WgslType>(idxType, 0);
    const loopStack = new StackNode();
    const prev = pushStack(loopStack);
    try {
        body({ i: indexVar });
    } finally {
        popStack(prev);
    }
    addToStack(new ForNode(range, indexVar, loopStack));
}

/**
 * Statement-form while loop, inside a Fn body.
 *
 * Runs as long as `condition` evaluates to `true`.
 *
 * ```ts
 * const counter = toVar(u32(0));
 * While(counter.lt(u32(10)), () => {
 *     counter.assign(counter.add(u32(1)));
 * });
 * ```
 *
 * Use `Break()` and `Continue()` inside the body for early exit / skip.
 */
export function While(condition: Node<WgslType>, body: () => void): void {
    const loopStack = new StackNode();
    const prev = pushStack(loopStack);
    try {
        body();
    } finally {
        popStack(prev);
    }
    addToStack(new WhileNode(condition, loopStack));
}

/**
 * Emits a `break;` statement inside a loop body.
 * Must be called inside a `For(...)` or `While(...)` body.
 */
export function Break(): void {
    addToStack(new BreakNode());
}

/**
 * Emits a `continue;` statement inside a loop body.
 * Must be called inside a `For(...)` or `While(...)` body.
 */
export function Continue(): void {
    addToStack(new ContinueNode());
}

/**
 * Define a reusable WGSL function.
 *
 * ### No-layout form (anonymous, params must be manually annotated)
 * ```ts
 * const double = Fn((x: Node<'f32'>) => x.mul(f32(2)))
 * ```
 * Emits: `fn fn_<id>(p0: f32) -> f32`
 *
 * ### Layout form (named, param types fully inferred from layout)
 * ```ts
 * const heatmap = Fn((uv, roughness) => {
 *     return vec3f(uv.x, uv.y, 0)
 * }, {
 *     name: 'heatmap',
 *     params: [
 *         { name: 'uv',        type: S.vec2f() },
 *         { name: 'roughness', type: S.f32()   },
 *     ],
 * })
 * ```
 * Emits: `fn heatmap(uv: vec2f, roughness: f32) -> vec3f`
 *
 * Call both forms the same way:
 * ```ts
 * const result = heatmap(uvNode, roughnessNode)  // → CallNode<'vec3f'>
 * ```
 */
// Overload 1 — with layout: param types inferred from layout.params
export function Fn<T extends WgslType, P extends readonly ParamDesc[]>(
    jsFunc: (...args: ParamDescsToNodes<P>) => Node<T>,
    layout: FnLayout<P>,
): (...args: ParamDescsToNodes<P>) => CallNode<T>;
// Overload 2 — no layout: params are Node<WgslType>, user annotates manually
export function Fn<T extends WgslType>(
    jsFunc: (...args: Node<WgslType>[]) => Node<T>,
): (...args: Node<WgslType>[]) => CallNode<T>;
// Implementation
export function Fn<T extends WgslType>(
    jsFunc: (...args: Node<WgslType>[]) => Node<T>,
    layout?: FnLayout<readonly ParamDesc[]>,
): (...args: Node<WgslType>[]) => CallNode<T> {
    // Build dummy ParamNodes for the dry-run trace that infers the return type.
    const paramDescs: (ParamDesc | WgslDesc<WgslType>)[] = layout?.params ?? [];
    const dummyParams = paramDescs.map((d, i) => {
        const paramName = 'name' in d ? (d as ParamDesc).name : undefined;
        const wgslType = 'name' in d ? (d as ParamDesc).type.wgslType : (d as WgslDesc<WgslType>).wgslType;
        return new ParamNode(wgslType, i, paramName);
    });

    const traceStack = new StackNode();
    const prev = pushStack(traceStack);
    let returnType: T;
    try {
        const output = jsFunc(...dummyParams);
        returnType = output.type as T;
    } finally {
        popStack(prev);
    }

    const fnNode = new FnNode<T>(returnType, paramDescs, jsFunc, layout?.name);

    return (...args: Node<WgslType>[]): CallNode<T> => {
        return new CallNode<T>(returnType, fnNode.fnName, args, fnNode);
    };
}

/**
 * Explicit early return inside a Fn body.
 * Compiles to `return <value>;`.
 *
 * @example
 * If(x.lt(konst('f32', 0.0)), () => {
 *     Return(konst('f32', 0.0))
 * })
 */
export function Return<T extends WgslType>(value: Node<T>): void {
    addToStack(new ReturnNode(value) as Node<WgslType>);
}

// ---------------------------------------------------------------------------
// Runtime type helpers
// ---------------------------------------------------------------------------

const VEC_ELEMENT: Record<string, ScalarType> = {
    vec2f: 'f32',
    vec3f: 'f32',
    vec4f: 'f32',
    vec2i: 'i32',
    vec3i: 'i32',
    vec4i: 'i32',
    vec2u: 'u32',
    vec3u: 'u32',
    vec4u: 'u32',
};
const VEC2_OF: Record<string, string> = { f32: 'vec2f', i32: 'vec2i', u32: 'vec2u' };
const VEC3_OF: Record<string, string> = { f32: 'vec3f', i32: 'vec3i', u32: 'vec3u' };
const VEC4_OF: Record<string, string> = { f32: 'vec4f', i32: 'vec4i', u32: 'vec4u' };
const MAT_TYPES = new Set(['mat2x2f', 'mat2x3f', 'mat2x4f', 'mat3x2f', 'mat3x3f', 'mat3x4f', 'mat4x2f', 'mat4x3f', 'mat4x4f']);
const VEC_TYPES = new Set(Object.keys(VEC_ELEMENT));
const SCALAR_TYPES = new Set(['f32', 'i32', 'u32', 'bool']);

export const isVecType = (t: string) => VEC_TYPES.has(t);
export const isMatType = (t: string) => MAT_TYPES.has(t);
export const isScalarType = (t: string) => SCALAR_TYPES.has(t);

export function vecElementType(t: string): WgslType {
    return (VEC_ELEMENT[t] ?? 'f32') as WgslType;
}
export function vecElementTypeOrSelf(t: string): WgslType {
    return (VEC_ELEMENT[t] ?? t) as WgslType;
}

export function vec2TypeOf(t: string): WgslType {
    const e = VEC_ELEMENT[t] ?? (SCALAR_TYPES.has(t) ? t : 'f32');
    return (VEC2_OF[e] ?? 'vec2f') as WgslType;
}
export function vec3TypeOf(t: string): WgslType {
    const e = VEC_ELEMENT[t] ?? (SCALAR_TYPES.has(t) ? t : 'f32');
    return (VEC3_OF[e] ?? 'vec3f') as WgslType;
}
export function vec4TypeOf(t: string): WgslType {
    const e = VEC_ELEMENT[t] ?? (SCALAR_TYPES.has(t) ? t : 'f32');
    return (VEC4_OF[e] ?? 'vec4f') as WgslType;
}
export function mulResultType(a: string, b: string): WgslType {
    if (MAT_TYPES.has(a)) return (VEC_TYPES.has(b) ? b : a) as WgslType;
    if (SCALAR_TYPES.has(b)) return a as WgslType;
    if (SCALAR_TYPES.has(a)) return b as WgslType;
    return a as WgslType;
}
// ---------------------------------------------------------------------------
// ConstNode factories — f32(0.5), vec3f(1, 0, 0), mat4x4f() etc.
//
// Called with no args: returns a zero/identity ConstNode.
// Called with args: packs them into a ConstNode of the matching type.
// ---------------------------------------------------------------------------

export const f32    = (v = 0):                       ConstNode<'f32'>    => new ConstNode('f32',    v);
export const i32    = (v = 0):                       ConstNode<'i32'>    => new ConstNode('i32',    v);
export const u32    = (v = 0):                       ConstNode<'u32'>    => new ConstNode('u32',    v);
export const bool   = (v: boolean):                  ConstNode<'bool'>   => new ConstNode('bool',   v ? 1 : 0);

export const vec2f  = (x = 0, y = 0):               ConstNode<'vec2f'>  => new ConstNode('vec2f',  [x, y]);
export const vec3f  = (x = 0, y = 0, z = 0):        ConstNode<'vec3f'>  => new ConstNode('vec3f',  [x, y, z]);
export const vec4f  = (x = 0, y = 0, z = 0, w = 0): ConstNode<'vec4f'>  => new ConstNode('vec4f',  [x, y, z, w]);
export const vec2i  = (x = 0, y = 0):               ConstNode<'vec2i'>  => new ConstNode('vec2i',  [x, y]);
export const vec3i  = (x = 0, y = 0, z = 0):        ConstNode<'vec3i'>  => new ConstNode('vec3i',  [x, y, z]);
export const vec4i  = (x = 0, y = 0, z = 0, w = 0): ConstNode<'vec4i'>  => new ConstNode('vec4i',  [x, y, z, w]);
export const vec2u  = (x = 0, y = 0):               ConstNode<'vec2u'>  => new ConstNode('vec2u',  [x, y]);
export const vec3u  = (x = 0, y = 0, z = 0):        ConstNode<'vec3u'>  => new ConstNode('vec3u',  [x, y, z]);
export const vec4u  = (x = 0, y = 0, z = 0, w = 0): ConstNode<'vec4u'>  => new ConstNode('vec4u',  [x, y, z, w]);

export const vec2b  = (x = false, y = false):                    ConstNode<'vec2<bool>'>  => new ConstNode('vec2<bool>',  [x ? 1 : 0, y ? 1 : 0]);
export const vec3b  = (x = false, y = false, z = false):         ConstNode<'vec3<bool>'>  => new ConstNode('vec3<bool>',  [x ? 1 : 0, y ? 1 : 0, z ? 1 : 0]);
export const vec4b  = (x = false, y = false, z = false, w = false): ConstNode<'vec4<bool>'>  => new ConstNode('vec4<bool>',  [x ? 1 : 0, y ? 1 : 0, z ? 1 : 0, w ? 1 : 0]);

export const mat2x2f = (...v: number[]): ConstNode<'mat2x2f'> => new ConstNode('mat2x2f', v.length ? v : []);
export const mat2x3f = (...v: number[]): ConstNode<'mat2x3f'> => new ConstNode('mat2x3f', v.length ? v : []);
export const mat2x4f = (...v: number[]): ConstNode<'mat2x4f'> => new ConstNode('mat2x4f', v.length ? v : []);
export const mat3x2f = (...v: number[]): ConstNode<'mat3x2f'> => new ConstNode('mat3x2f', v.length ? v : []);
export const mat3x3f = (...v: number[]): ConstNode<'mat3x3f'> => new ConstNode('mat3x3f', v.length ? v : []);
export const mat3x4f = (...v: number[]): ConstNode<'mat3x4f'> => new ConstNode('mat3x4f', v.length ? v : []);
export const mat4x2f = (...v: number[]): ConstNode<'mat4x2f'> => new ConstNode('mat4x2f', v.length ? v : []);
export const mat4x3f = (...v: number[]): ConstNode<'mat4x3f'> => new ConstNode('mat4x3f', v.length ? v : []);
export const mat4x4f = (...v: number[]): ConstNode<'mat4x4f'> => new ConstNode('mat4x4f', v.length ? v : []);

// ---------------------------------------------------------------------------
// color() — DSL function: ColorInput → ConstNode<'vec3f'>
// ---------------------------------------------------------------------------

import { Color, type ColorInput } from '../utils/color.js';

/**
 * Convert any color input to a `ConstNode<'vec3f'>` (linear RGB).
 *
 * This is the primary way to introduce a color into the node graph.
 * The resulting node has type `vec3f` so it can be used anywhere a `vec3f`
 * is expected — including as the first argument to `vec4(xyz, w)`.
 *
 * @example
 * import { color, vec4, f32 } from 'gpucat';
 *
 * // Build an opaque red vec4f for use as a fragment color
 * const fragColor = vec4(color('#f00'), f32(1));
 *
 * // Other accepted forms:
 * color('hsl(200, 80%, 50%)');
 * color('deepskyblue');
 * color(0xff8800);
 * color([1, 0.5, 0]);
 * color(new Color('red'));
 */
export function color(input: ColorInput): ConstNode<'vec3f'> {
    const c = input instanceof Color ? input : new Color(input);
    return new ConstNode('vec3f', [c.r, c.g, c.b]);
}

// ---------------------------------------------------------------------------
// Builtin structs + std scene nodes (formerly std-nodes.ts)
// ---------------------------------------------------------------------------

import * as S from './schema.js';

export const CameraStruct = struct('Camera', {
    projectionMatrix: S.mat4x4f(),
    viewMatrix: S.mat4x4f(),
    position: S.vec3f(),
    near: S.f32(),
    far: S.f32(),
});

export type CameraInstance = StructInstance<typeof CameraStruct.schema>;

export function camera(): CameraInstance {
    return CameraStruct.instantiate(builtin('camera', 'Camera'));
}

export const TimeStruct = struct('Time', {
    elapsed: S.f32(),
    delta: S.f32(),
});

export type TimeInstance = StructInstance<typeof TimeStruct.schema>;

export function time(): TimeInstance {
    return TimeStruct.instantiate(builtin('time', 'Time'));
}

export const MeshStruct = struct('Mesh', {
    modelMatrix: S.mat4x4f(),
    normalMatrix: S.mat3x3f(),
});

export type MeshInstance = StructInstance<typeof MeshStruct.schema>;

export function mesh(): MeshInstance {
    return MeshStruct.instantiate(builtin('mesh', 'Mesh'));
}

export const instanceIndex = (): BuiltinNode<'u32'> => builtin('instance_index', 'u32');

export const positionClip: Node<'vec4f'> = (() => {
    const pos = attribute('vec3f', 'position');
    const localPos = vec4(pos, konst('f32', 1.0));

    const m = mesh();
    const worldPos = mul(m.modelMatrix, localPos);

    const cam = camera();
    const viewPos = mul(cam.viewMatrix, worldPos);
    const clipPos = mul(cam.projectionMatrix, viewPos);

    return clipPos as unknown as Node<'vec4f'>;
})();

/** @builtin(global_invocation_id) — unique thread ID across the entire dispatch. */
export const globalId     = (): BuiltinNode<'vec3u'> => builtin('global_invocation_id',   'vec3u');

/** @builtin(local_invocation_id) — thread ID within its workgroup. */
export const localId      = (): BuiltinNode<'vec3u'> => builtin('local_invocation_id',    'vec3u');

/** @builtin(local_invocation_index) — flat 1-D index within the workgroup. */
export const localIndex   = (): BuiltinNode<'u32'>   => builtin('local_invocation_index', 'u32');

/** @builtin(workgroup_id) — workgroup coordinate in the dispatch grid. */
export const workgroupId  = (): BuiltinNode<'vec3u'> => builtin('workgroup_id',           'vec3u');

/** @builtin(num_workgroups) — total number of workgroups dispatched. */
export const numWorkgroups = (): BuiltinNode<'vec3u'> => builtin('num_workgroups',        'vec3u');
