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

import type { NodeFrame } from '../renderer/node-frame';
import { InstancedBufferAttribute, StorageBufferAttribute } from 'src/geometry/attribute';
import { getChildren as _getChildren } from './collect';
import * as d from './schema';
import { type ArrayDesc, type DepthTextureDesc, isStructDef, itemSizeOf, type StructSchema, texture2d, type TextureDesc, typedArrayCtorOf, type WgslDesc } from './schema';
export { type UpdateRange } from '../geometry/attribute';
import type { IndirectStorageBufferAttribute } from 'src/geometry/attribute';
import { Texture } from '../texture/texture';
import { Color, type ColorInput } from '../utils/color';

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

export type ScalarType = 'f32' | 'i32' | 'u32' | 'bool' | 'f16';

export type Vec2Type = 'vec2f' | 'vec2i' | 'vec2u' | 'vec2<bool>' | 'vec2h';
export type Vec3Type = 'vec3f' | 'vec3i' | 'vec3u' | 'vec3<bool>' | 'vec3h';
export type Vec4Type = 'vec4f' | 'vec4i' | 'vec4u' | 'vec4<bool>' | 'vec4h';
export type VecType = Vec2Type | Vec3Type | Vec4Type;

export type MatType =
    | 'mat2x2f' | 'mat2x3f' | 'mat2x4f' | 'mat3x2f' | 'mat3x3f' | 'mat3x4f' | 'mat4x2f' | 'mat4x3f' | 'mat4x4f'
    | 'mat2x2h' | 'mat2x3h' | 'mat2x4h' | 'mat3x2h' | 'mat3x3h' | 'mat3x4h' | 'mat4x2h' | 'mat4x3h' | 'mat4x4h';

export type NumericType = ScalarType | VecType | MatType;
export type SamplerType = 'sampler' | 'sampler_comparison';
export type TextureType = string;
export type WgslType = NumericType | SamplerType | TextureType;

export type VecElement<T extends VecType> = T extends 'vec2f' | 'vec3f' | 'vec4f'
    ? 'f32'
    : T extends 'vec2i' | 'vec3i' | 'vec4i'
      ? 'i32'
      : T extends 'vec2u' | 'vec3u' | 'vec4u'
        ? 'u32'
        : T extends 'vec2h' | 'vec3h' | 'vec4h'
          ? 'f16'
          : 'bool';

export type Vec2Of<E extends ScalarType> = E extends 'f32' ? 'vec2f' : E extends 'i32' ? 'vec2i' : E extends 'u32' ? 'vec2u' : E extends 'f16' ? 'vec2h' : 'vec2<bool>';
export type Vec3Of<E extends ScalarType> = E extends 'f32' ? 'vec3f' : E extends 'i32' ? 'vec3i' : E extends 'u32' ? 'vec3u' : E extends 'f16' ? 'vec3h' : 'vec3<bool>';
export type Vec4Of<E extends ScalarType> = E extends 'f32' ? 'vec4f' : E extends 'i32' ? 'vec4i' : E extends 'u32' ? 'vec4u' : E extends 'f16' ? 'vec4h' : 'vec4<bool>';

/* swizzle type utilities */

// maps Node<T> swizzle width to the correct output type
// Rules:
//   VecType   → element scalar (for width 1), vec2/3/4 of same element (for width 2/3/4)
//   ScalarType → self (width 1 only; multi-component swizzles on scalars are invalid WGSL)
//   anything else (texture, sampler, …) → WgslType (widened, no useful info)

export type Swizzle1<T extends WgslType> =
    T extends VecType    ? VecElement<T> :
    T extends ScalarType ? T :
    WgslType;

export type Swizzle2<T extends WgslType> =
    T extends VecType ? Vec2Of<VecElement<T>> : WgslType;

export type Swizzle3<T extends WgslType> =
    T extends VecType ? Vec3Of<VecElement<T>> : WgslType;

export type Swizzle4<T extends WgslType> =
    T extends VecType ? Vec4Of<VecElement<T>> : WgslType;

export type MulResult<A extends WgslType, B extends WgslType> = A extends MatType
    ? B extends VecType
        ? B
        : A
    : B extends ScalarType
      ? A
      : A extends ScalarType
        ? B
        : A;

export type NodeKind =
    | 'const'
    | 'uniform'
    | 'attribute'
    | 'buffer_attribute'
    | 'storage'
    | 'texture'
    | 'sampler'
    | 'convert'
    | 'varying'
    | 'binop'
    | 'call'
    | 'wgsl'
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
    | 'wgsl_fn'
    | 'param'
    | 'return'
    | 'output_struct'
    | 'inspector';

export type StructMember = { readonly name: string; readonly type: WgslType };
export type BuiltinKind =
    | 'instance_index' | 'instance_data'
    | 'vertex_index' | 'global_invocation_id' | 'local_invocation_id'
    | 'local_invocation_index' | 'workgroup_id' | 'num_workgroups'
    | 'position';  // fragment position (@builtin(position) in fragment shader)
export type BinopOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '>' | '<=' | '>=';

/**
 * WGSL @interpolate interpolation type.
 *   - perspective  : values are interpolated in a perspective-correct manner (default for float types)
 *   - linear       : values are interpolated in a linear, non-perspective-correct manner
 *   - flat         : values are not interpolated; the value from the provoking vertex is used
 *                    (required for integer/unsigned-integer types)
 */
export type InterpolationType = 'perspective' | 'linear' | 'flat';

/**
 * WGSL @interpolate sampling mode (only valid when interpolation type is 'perspective' or 'linear').
 *   - center    : interpolation is performed at the center of the pixel (default)
 *   - centroid  : interpolation is performed at a point inside the primitive that is also
 *                 inside all samples covered by the fragment (avoids aliasing at primitive edges)
 *   - sample    : interpolation is performed per-sample; the fragment shader runs once per sample
 *   - either    : implementation may choose center or centroid (valid only with 'flat' in WGSL)
 */
export type InterpolationSampling = 'center' | 'centroid' | 'sample' | 'either';

/**
 * Update types for Node.update() callbacks.
 * Determines when the node's update callback is invoked.
 */
export const NodeUpdateType = {
    /** The update method is not executed. */
    NONE: 'none',
    /** The update method is executed once per frame. */
    FRAME: 'frame',
    /** The update method is executed per render() call. Multiple renders per frame for VR/shadows. */
    RENDER: 'render',
    /** The update method is executed per object/mesh that uses the node. */
    OBJECT: 'object',
} as const;

export type NodeUpdateType = typeof NodeUpdateType[keyof typeof NodeUpdateType];

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

export class Node<T extends WgslType> {
    readonly id: string;
    readonly kind: NodeKind;
    readonly type: T;

    /** Set by .inspect() — human-readable label shown in the Inspector UI. */
    _inspectorName: string | undefined = undefined;
    /** True when this node has been marked for inspector preview/tracking. */
    _isInspectable = false;

    /**
     * The update type for this node's update() method.
     * Determines when the update callback is invoked (none/frame/render/object).
     */
    updateType: NodeUpdateType = NodeUpdateType.NONE;

    /**
     * The update callback. Invoked based on updateType.
     * Set via onUpdate(), onRenderUpdate(), onObjectUpdate().
     */
    update?: (frame: NodeFrame) => unknown;

    constructor(id: string, kind: NodeKind, type: T) {
        this.id = id;
        this.kind = kind;
        this.type = type;
    }

    /**
     * Set an update callback that will be invoked based on updateType.
     * The callback receives a NodeFrame and can return a value to assign.
     *
     * @param callback - The update function. Receives NodeFrame, returns value.
     * @param updateType - When to invoke: 'frame', 'render', or 'object'.
     * @returns this for method chaining.
     */
    onUpdate(callback: (frame: NodeFrame) => unknown, updateType: NodeUpdateType): this {
        this.updateType = updateType;
        this.update = callback;
        return this;
    }

    /**
     * Set an update callback invoked once per render() call.
     * Used for camera uniforms, time, etc. that are shared across all objects in a render.
     *
     * @param callback - Receives NodeFrame. Access camera, time, deltaTime from frame.
     * @returns this for method chaining.
     *
     * @example
     * const cameraView = new UniformNode('mat4x4f', 'cameraViewMatrix', renderGroup)
     *     .onRenderUpdate((frame) => frame.camera!.matrixWorldInverse);
     */
    onRenderUpdate(callback: (frame: NodeFrame) => unknown): this {
        return this.onUpdate(callback, NodeUpdateType.RENDER);
    }

    /**
     * Set an update callback invoked once per object/mesh.
     * Used for model matrices, per-object material properties, etc.
     *
     * @param callback - Receives NodeFrame. Access object from frame.
     * @returns this for method chaining.
     *
     * @example
     * const modelMatrix = new UniformNode('mat4x4f', 'modelWorldMatrix', objectGroup)
     *     .onObjectUpdate((frame) => frame.object!.matrixWorld);
     */
    onObjectUpdate(callback: (frame: NodeFrame) => unknown): this {
        return this.onUpdate(callback, NodeUpdateType.OBJECT);
    }

    /**
     * Mark this node as inspectable, optionally with a display name.
     * Returns `this` for method chaining.
     *
     * @example
     * const albedo = texture('texture_2d<f32>', 'albedo').inspect('Albedo');
     */
    inspect(name?: string): this {
        this._isInspectable = true;
        if (name !== undefined) this._inspectorName = name;
        return this;
    }

    // arithmetic — delegate to the standalone functions (source of truth)
    add(b: Node<T>): Node<T> { return add(this, b); }
    sub(b: Node<T>): Node<T> { return sub(this, b); }
    div(b: Node<T>): Node<T> { return div(this, b); }
    mul<B extends ScalarType>(b: Node<B>): Node<T>;
    mul<B extends VecType>(b: Node<B>): T extends ScalarType ? Node<B> : Node<T>;
    mul<B extends VecType>(b: Node<B>): T extends MatType ? Node<B> : Node<T>;
    mul<B extends WgslType>(b: Node<B>): Node<WgslType>;
    mul(b: Node<WgslType>): Node<WgslType> { return mul(this, b); }

    // math — delegate to the standalone functions (source of truth)
    abs(): Node<T> { return abs(this); }
    floor(): Node<T> { return floor(this); }
    ceil(): Node<T> { return ceil(this); }
    fract(): Node<T> { return fract(this); }
    sqrt(): Node<T> { return sqrt(this); }
    sin(): Node<T> { return sin(this); }
    cos(): Node<T> { return cos(this); }
    negate(): Node<T> { return negate(this); }
    normalize(): Node<T> { return normalize(this); }
    length(): Node<'f32'> { return length(this); }
    dot(b: Node<T>): Node<T extends VecType ? VecElement<T> : 'f32'> { return dot(this, b) as unknown as Node<T extends VecType ? VecElement<T> : 'f32'>; }
    cross(b: Node<T>): Node<T> { return cross(this, b); }
    clamp(lo: Node<T>, hi: Node<T>): Node<T> { return clamp(this, lo, hi); }
    mix(b: Node<T>, t: Node<T>): Node<T> { return mix(this, b, t); }
    max(b: Node<T>): Node<T> { return max(this, b); }
    min(b: Node<T>): Node<T> { return min(this, b); }
    pow(b: Node<T>): Node<T> { return pow(this, b); }
    step(x: Node<T>): Node<T> { return step(this, x); }
    smoothstep(lo: Node<T>, hi: Node<T>): Node<T> { return smoothstep(lo, hi, this); }

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
    toF16(): Node<'f16'> { return new CallNode('f16', 'f16', [this]); }
    toU32(): Node<'u32'> { return new CallNode('u32', 'u32', [this]); }
    toI32(): Node<'i32'> { return new CallNode('i32', 'i32', [this]); }

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
    get x(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'x') as unknown as Node<Swizzle1<T>>; }
    get y(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'y') as unknown as Node<Swizzle1<T>>; }
    get z(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'z') as unknown as Node<Swizzle1<T>>; }
    get w(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'w') as unknown as Node<Swizzle1<T>>; }

    /* xyzw 2-component swizzles */
    get xx(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'xx') as unknown as Node<Swizzle2<T>>; }
    get xy(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'xy') as unknown as Node<Swizzle2<T>>; }
    get xz(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'xz') as unknown as Node<Swizzle2<T>>; }
    get xw(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'xw') as unknown as Node<Swizzle2<T>>; }
    get yx(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'yx') as unknown as Node<Swizzle2<T>>; }
    get yy(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'yy') as unknown as Node<Swizzle2<T>>; }
    get yz(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'yz') as unknown as Node<Swizzle2<T>>; }
    get yw(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'yw') as unknown as Node<Swizzle2<T>>; }
    get zx(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'zx') as unknown as Node<Swizzle2<T>>; }
    get zy(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'zy') as unknown as Node<Swizzle2<T>>; }
    get zz(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'zz') as unknown as Node<Swizzle2<T>>; }
    get zw(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'zw') as unknown as Node<Swizzle2<T>>; }
    get wx(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'wx') as unknown as Node<Swizzle2<T>>; }
    get wy(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'wy') as unknown as Node<Swizzle2<T>>; }
    get wz(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'wz') as unknown as Node<Swizzle2<T>>; }
    get ww(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'ww') as unknown as Node<Swizzle2<T>>; }

    /* xyzw 3-component swizzles */
    get xxx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xxx') as unknown as Node<Swizzle3<T>>; }
    get xxy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xxy') as unknown as Node<Swizzle3<T>>; }
    get xxz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xxz') as unknown as Node<Swizzle3<T>>; }
    get xxw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xxw') as unknown as Node<Swizzle3<T>>; }
    get xyx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xyx') as unknown as Node<Swizzle3<T>>; }
    get xyy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xyy') as unknown as Node<Swizzle3<T>>; }
    get xyz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xyz') as unknown as Node<Swizzle3<T>>; }
    get xyw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xyw') as unknown as Node<Swizzle3<T>>; }
    get xzx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xzx') as unknown as Node<Swizzle3<T>>; }
    get xzy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xzy') as unknown as Node<Swizzle3<T>>; }
    get xzz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xzz') as unknown as Node<Swizzle3<T>>; }
    get xzw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xzw') as unknown as Node<Swizzle3<T>>; }
    get xwx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xwx') as unknown as Node<Swizzle3<T>>; }
    get xwy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xwy') as unknown as Node<Swizzle3<T>>; }
    get xwz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xwz') as unknown as Node<Swizzle3<T>>; }
    get xww(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xww') as unknown as Node<Swizzle3<T>>; }
    get yxx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yxx') as unknown as Node<Swizzle3<T>>; }
    get yxy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yxy') as unknown as Node<Swizzle3<T>>; }
    get yxz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yxz') as unknown as Node<Swizzle3<T>>; }
    get yxw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yxw') as unknown as Node<Swizzle3<T>>; }
    get yyx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yyx') as unknown as Node<Swizzle3<T>>; }
    get yyy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yyy') as unknown as Node<Swizzle3<T>>; }
    get yyz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yyz') as unknown as Node<Swizzle3<T>>; }
    get yyw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yyw') as unknown as Node<Swizzle3<T>>; }
    get yzx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yzx') as unknown as Node<Swizzle3<T>>; }
    get yzy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yzy') as unknown as Node<Swizzle3<T>>; }
    get yzz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yzz') as unknown as Node<Swizzle3<T>>; }
    get yzw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yzw') as unknown as Node<Swizzle3<T>>; }
    get ywx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'ywx') as unknown as Node<Swizzle3<T>>; }
    get ywy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'ywy') as unknown as Node<Swizzle3<T>>; }
    get ywz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'ywz') as unknown as Node<Swizzle3<T>>; }
    get yww(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yww') as unknown as Node<Swizzle3<T>>; }
    get zxx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zxx') as unknown as Node<Swizzle3<T>>; }
    get zxy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zxy') as unknown as Node<Swizzle3<T>>; }
    get zxz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zxz') as unknown as Node<Swizzle3<T>>; }
    get zxw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zxw') as unknown as Node<Swizzle3<T>>; }
    get zyx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zyx') as unknown as Node<Swizzle3<T>>; }
    get zyy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zyy') as unknown as Node<Swizzle3<T>>; }
    get zyz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zyz') as unknown as Node<Swizzle3<T>>; }
    get zyw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zyw') as unknown as Node<Swizzle3<T>>; }
    get zzx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zzx') as unknown as Node<Swizzle3<T>>; }
    get zzy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zzy') as unknown as Node<Swizzle3<T>>; }
    get zzz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zzz') as unknown as Node<Swizzle3<T>>; }
    get zzw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zzw') as unknown as Node<Swizzle3<T>>; }
    get zwx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zwx') as unknown as Node<Swizzle3<T>>; }
    get zwy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zwy') as unknown as Node<Swizzle3<T>>; }
    get zwz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zwz') as unknown as Node<Swizzle3<T>>; }
    get zww(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zww') as unknown as Node<Swizzle3<T>>; }
    get wxx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wxx') as unknown as Node<Swizzle3<T>>; }
    get wxy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wxy') as unknown as Node<Swizzle3<T>>; }
    get wxz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wxz') as unknown as Node<Swizzle3<T>>; }
    get wxw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wxw') as unknown as Node<Swizzle3<T>>; }
    get wyx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wyx') as unknown as Node<Swizzle3<T>>; }
    get wyy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wyy') as unknown as Node<Swizzle3<T>>; }
    get wyz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wyz') as unknown as Node<Swizzle3<T>>; }
    get wyw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wyw') as unknown as Node<Swizzle3<T>>; }
    get wzx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wzx') as unknown as Node<Swizzle3<T>>; }
    get wzy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wzy') as unknown as Node<Swizzle3<T>>; }
    get wzz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wzz') as unknown as Node<Swizzle3<T>>; }
    get wzw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wzw') as unknown as Node<Swizzle3<T>>; }
    get wwx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wwx') as unknown as Node<Swizzle3<T>>; }
    get wwy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wwy') as unknown as Node<Swizzle3<T>>; }
    get wwz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wwz') as unknown as Node<Swizzle3<T>>; }
    get www(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'www') as unknown as Node<Swizzle3<T>>; }

    /* xyzw 4-component swizzles (24 unique permutations only) */
    get xyzw(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xyzw') as unknown as Node<Swizzle4<T>>; }
    get xywz(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xywz') as unknown as Node<Swizzle4<T>>; }
    get xzyw(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xzyw') as unknown as Node<Swizzle4<T>>; }
    get xzwy(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xzwy') as unknown as Node<Swizzle4<T>>; }
    get xwyz(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xwyz') as unknown as Node<Swizzle4<T>>; }
    get xwzy(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xwzy') as unknown as Node<Swizzle4<T>>; }
    get yxzw(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'yxzw') as unknown as Node<Swizzle4<T>>; }
    get yxwz(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'yxwz') as unknown as Node<Swizzle4<T>>; }
    get yzxw(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'yzxw') as unknown as Node<Swizzle4<T>>; }
    get yzwx(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'yzwx') as unknown as Node<Swizzle4<T>>; }
    get ywxz(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'ywxz') as unknown as Node<Swizzle4<T>>; }
    get ywzx(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'ywzx') as unknown as Node<Swizzle4<T>>; }
    get zxyw(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zxyw') as unknown as Node<Swizzle4<T>>; }
    get zxwy(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zxwy') as unknown as Node<Swizzle4<T>>; }
    get zyxw(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zyxw') as unknown as Node<Swizzle4<T>>; }
    get zywx(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zywx') as unknown as Node<Swizzle4<T>>; }
    get zwxy(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zwxy') as unknown as Node<Swizzle4<T>>; }
    get zwyx(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zwyx') as unknown as Node<Swizzle4<T>>; }
    get wxyz(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wxyz') as unknown as Node<Swizzle4<T>>; }
    get wxzy(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wxzy') as unknown as Node<Swizzle4<T>>; }
    get wyxz(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wyxz') as unknown as Node<Swizzle4<T>>; }
    get wyzx(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wyzx') as unknown as Node<Swizzle4<T>>; }
    get wzxy(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wzxy') as unknown as Node<Swizzle4<T>>; }
    get wzyx(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wzyx') as unknown as Node<Swizzle4<T>>; }

    /* rgba 1-component swizzles */
    get r(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'x') as unknown as Node<Swizzle1<T>>; }
    get g(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'y') as unknown as Node<Swizzle1<T>>; }
    get b(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'z') as unknown as Node<Swizzle1<T>>; }
    get a(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'w') as unknown as Node<Swizzle1<T>>; }

    /* rgba 2-component swizzles */
    get rr(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'xx') as unknown as Node<Swizzle2<T>>; }
    get rg(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'xy') as unknown as Node<Swizzle2<T>>; }
    get rb(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'xz') as unknown as Node<Swizzle2<T>>; }
    get ra(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'xw') as unknown as Node<Swizzle2<T>>; }
    get gr(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'yx') as unknown as Node<Swizzle2<T>>; }
    get gg(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'yy') as unknown as Node<Swizzle2<T>>; }
    get gb(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'yz') as unknown as Node<Swizzle2<T>>; }
    get ga(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'yw') as unknown as Node<Swizzle2<T>>; }
    get br(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'zx') as unknown as Node<Swizzle2<T>>; }
    get bg(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'zy') as unknown as Node<Swizzle2<T>>; }
    get bb(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'zz') as unknown as Node<Swizzle2<T>>; }
    get ba(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'zw') as unknown as Node<Swizzle2<T>>; }
    get ar(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'wx') as unknown as Node<Swizzle2<T>>; }
    get ag(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'wy') as unknown as Node<Swizzle2<T>>; }
    get ab(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'wz') as unknown as Node<Swizzle2<T>>; }
    get aa(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'ww') as unknown as Node<Swizzle2<T>>; }

    /* rgba 3-component swizzles */
    get rrr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xxx') as unknown as Node<Swizzle3<T>>; }
    get rrg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xxy') as unknown as Node<Swizzle3<T>>; }
    get rrb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xxz') as unknown as Node<Swizzle3<T>>; }
    get rra(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xxw') as unknown as Node<Swizzle3<T>>; }
    get rgr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xyx') as unknown as Node<Swizzle3<T>>; }
    get rgg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xyy') as unknown as Node<Swizzle3<T>>; }
    get rgb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xyz') as unknown as Node<Swizzle3<T>>; }
    get rga(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xyw') as unknown as Node<Swizzle3<T>>; }
    get rbr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xzx') as unknown as Node<Swizzle3<T>>; }
    get rbg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xzy') as unknown as Node<Swizzle3<T>>; }
    get rbb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xzz') as unknown as Node<Swizzle3<T>>; }
    get rba(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xzw') as unknown as Node<Swizzle3<T>>; }
    get rar(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xwx') as unknown as Node<Swizzle3<T>>; }
    get rag(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xwy') as unknown as Node<Swizzle3<T>>; }
    get rab(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xwz') as unknown as Node<Swizzle3<T>>; }
    get raa(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xww') as unknown as Node<Swizzle3<T>>; }
    get grr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yxx') as unknown as Node<Swizzle3<T>>; }
    get grg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yxy') as unknown as Node<Swizzle3<T>>; }
    get grb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yxz') as unknown as Node<Swizzle3<T>>; }
    get gra(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yxw') as unknown as Node<Swizzle3<T>>; }
    get ggr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yyx') as unknown as Node<Swizzle3<T>>; }
    get ggg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yyy') as unknown as Node<Swizzle3<T>>; }
    get ggb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yyz') as unknown as Node<Swizzle3<T>>; }
    get gga(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yyw') as unknown as Node<Swizzle3<T>>; }
    get gbr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yzx') as unknown as Node<Swizzle3<T>>; }
    get gbg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yzy') as unknown as Node<Swizzle3<T>>; }
    get gbb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yzz') as unknown as Node<Swizzle3<T>>; }
    get gba(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yzw') as unknown as Node<Swizzle3<T>>; }
    get gar(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'ywx') as unknown as Node<Swizzle3<T>>; }
    get gag(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'ywy') as unknown as Node<Swizzle3<T>>; }
    get gab(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'ywz') as unknown as Node<Swizzle3<T>>; }
    get gaa(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yww') as unknown as Node<Swizzle3<T>>; }
    get brr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zxx') as unknown as Node<Swizzle3<T>>; }
    get brg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zxy') as unknown as Node<Swizzle3<T>>; }
    get brb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zxz') as unknown as Node<Swizzle3<T>>; }
    get bra(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zxw') as unknown as Node<Swizzle3<T>>; }
    get bgr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zyx') as unknown as Node<Swizzle3<T>>; }
    get bgg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zyy') as unknown as Node<Swizzle3<T>>; }
    get bgb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zyz') as unknown as Node<Swizzle3<T>>; }
    get bga(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zyw') as unknown as Node<Swizzle3<T>>; }
    get bbr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zzx') as unknown as Node<Swizzle3<T>>; }
    get bbg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zzy') as unknown as Node<Swizzle3<T>>; }
    get bbb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zzz') as unknown as Node<Swizzle3<T>>; }
    get bba(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zzw') as unknown as Node<Swizzle3<T>>; }
    get bar(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zwx') as unknown as Node<Swizzle3<T>>; }
    get bag(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zwy') as unknown as Node<Swizzle3<T>>; }
    get bab(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zwz') as unknown as Node<Swizzle3<T>>; }
    get baa(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zww') as unknown as Node<Swizzle3<T>>; }
    get arr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wxx') as unknown as Node<Swizzle3<T>>; }
    get arg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wxy') as unknown as Node<Swizzle3<T>>; }
    get arb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wxz') as unknown as Node<Swizzle3<T>>; }
    get ara(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wxw') as unknown as Node<Swizzle3<T>>; }
    get agr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wyx') as unknown as Node<Swizzle3<T>>; }
    get agg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wyy') as unknown as Node<Swizzle3<T>>; }
    get agb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wyz') as unknown as Node<Swizzle3<T>>; }
    get aga(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wyw') as unknown as Node<Swizzle3<T>>; }
    get abr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wzx') as unknown as Node<Swizzle3<T>>; }
    get abg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wzy') as unknown as Node<Swizzle3<T>>; }
    get abb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wzz') as unknown as Node<Swizzle3<T>>; }
    get aba(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wzw') as unknown as Node<Swizzle3<T>>; }
    get aar(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wwx') as unknown as Node<Swizzle3<T>>; }
    get aag(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wwy') as unknown as Node<Swizzle3<T>>; }
    get aab(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wwz') as unknown as Node<Swizzle3<T>>; }
    get aaa(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'www') as unknown as Node<Swizzle3<T>>; }

    /* rgba 4-component swizzles (24 unique permutations only) */
    get rgba(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xyzw') as unknown as Node<Swizzle4<T>>; }
    get rgab(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xywz') as unknown as Node<Swizzle4<T>>; }
    get rbga(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xzyw') as unknown as Node<Swizzle4<T>>; }
    get rbag(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xzwy') as unknown as Node<Swizzle4<T>>; }
    get ragb(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xwyz') as unknown as Node<Swizzle4<T>>; }
    get rabg(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xwzy') as unknown as Node<Swizzle4<T>>; }
    get grba(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'yxzw') as unknown as Node<Swizzle4<T>>; }
    get grab(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'yxwz') as unknown as Node<Swizzle4<T>>; }
    get gbra(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'yzxw') as unknown as Node<Swizzle4<T>>; }
    get gbar(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'yzwx') as unknown as Node<Swizzle4<T>>; }
    get garb(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'ywxz') as unknown as Node<Swizzle4<T>>; }
    get gabr(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'ywzx') as unknown as Node<Swizzle4<T>>; }
    get brga(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zxyw') as unknown as Node<Swizzle4<T>>; }
    get brag(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zxwy') as unknown as Node<Swizzle4<T>>; }
    get bgra(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zyxw') as unknown as Node<Swizzle4<T>>; }
    get bgar(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zywx') as unknown as Node<Swizzle4<T>>; }
    get barg(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zwxy') as unknown as Node<Swizzle4<T>>; }
    get bagr(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zwyx') as unknown as Node<Swizzle4<T>>; }
    get argb(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wxyz') as unknown as Node<Swizzle4<T>>; }
    get arbg(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wxzy') as unknown as Node<Swizzle4<T>>; }
    get agrb(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wyxz') as unknown as Node<Swizzle4<T>>; }
    get agbr(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wyzx') as unknown as Node<Swizzle4<T>>; }
    get abrg(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wzxy') as unknown as Node<Swizzle4<T>>; }
    get abgr(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wzyx') as unknown as Node<Swizzle4<T>>; }

    /**
     * Returns the immediate child nodes of this node.
     * Delegates to the module-level getChildren() from collect.ts.
     */
    getChildren(): Node<WgslType>[] { return _getChildren(this); }
}

// Use .field() for typed struct member access.

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

}

/**
 * Descriptor for a uniform group — determines WGSL @group index and struct packing.
 *
 * Mirrors Three.js `nodes/core/UniformGroupNode.js` (as of PR #33047):
 * - `name`       — struct name and var name in WGSL (e.g. 'render', 'object')
 * - `shared`     — if true, one GPU buffer is shared across all materials/objects
 * - `order`      — determines @group(N) index; groups sorted by order ascending
 * - `updateType` — when this group should be re-uploaded (FRAME, RENDER, OBJECT)
 *
 * Key insight from Three.js PR #33047: instead of string-based checks like
 * `name === 'render'`, the group carries its updateType directly, enabling
 * event-driven dirty tracking via `needsUpdate` and `version`.
 */
export class UniformGroupNode {
    readonly name: string;
    readonly shared: boolean;
    readonly order: number;
    readonly updateType: NodeUpdateType | null;

    /** Dirty flag — set to true to trigger re-upload. Automatically cleared after upload. */
    needsUpdate: boolean = false;

    /** Version counter — incremented each time update() is called. */
    version: number = 0;

    /** Type-testing flag. */
    readonly isUniformGroup: boolean = true;

    constructor(name: string, shared: boolean, order: number, updateType: NodeUpdateType | null = null) {
        this.name = name;
        this.shared = shared;
        this.order = order;
        this.updateType = updateType;
    }

    /**
     * Mark this uniform group as needing an update.
     * This will trigger re-upload on the next render pass.
     */
    update(): void {
        this.needsUpdate = true;
        this.version++;
    }
}

/** Create a per-object (non-shared) uniform group with order=1. */
export const uniformGroup = (name: string, order = 1, updateType: NodeUpdateType | null = null) =>
    new UniformGroupNode(name, false, order, updateType);

/** Create a shared uniform group with configurable order (default 0). */
export const sharedUniformGroup = (name: string, order = 0, updateType: NodeUpdateType | null = null) =>
    new UniformGroupNode(name, true, order, updateType);

/**
 * frameGroup — shared uniforms updated once per frame.
 * Contains time uniforms (timeElapsed, timeDelta).
 * Maps to @group(0) with FRAME update type.
 *
 * Note: For simplicity, gpucat currently merges frame uniforms into renderGroup.
 * This is defined for Three.js API compatibility.
 */
export const frameGroup = /*@__PURE__*/ sharedUniformGroup('frame', 0, NodeUpdateType.FRAME);

/**
 * renderGroup — shared uniforms updated per render() call.
 * Contains camera uniforms (projection, view, position, near, far).
 * Maps to @group(0) with RENDER update type.
 *
 * Camera is in renderGroup (not frameGroup) because it can change between
 * render calls within the same frame (VR stereo, shadow maps, portals).
 */
export const renderGroup = /*@__PURE__*/ sharedUniformGroup('render', 0, NodeUpdateType.RENDER);

/**
 * objectGroup — per-object uniforms updated per draw call.
 * Contains mesh matrices (modelWorldMatrix, modelNormalMatrix) and user material uniforms.
 * Maps to @group(1) with OBJECT update type.
 */
export const objectGroup = /*@__PURE__*/ uniformGroup('object', 1, NodeUpdateType.OBJECT);

export class UniformNode<T extends WgslType> extends Node<T> {
    /**
     * Uniform group — determines @group index and struct packing.
     */
    readonly groupNode: UniformGroupNode;

    /**
     * Field name within the struct (e.g. 'cameraViewMatrix', 'roughness').
     */
    readonly name: string;

    /** CPU-side value. Set this to update the uniform on the GPU. */
    value: number | number[] | Float32Array | null = null;

    /** Monotonically incremented when value is set. Renderer re-uploads when stale. */
    version: number = 0;

    constructor(
        type: T,
        name: string,
        groupNode: UniformGroupNode = objectGroup,
    ) {
        super(computeId('uniform', { type, name, groupNode: groupNode.name }), 'uniform', type);
        this.name = name;
        this.groupNode = groupNode;
    }
}

export class AttributeNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly name: string,
    ) {
        super(computeId('attribute', { type, name }), 'attribute', type);
    }
}

/**
 * StorageNode — GPU storage buffer node.
 *
 * Holds a reference to a StorageBufferAttribute (the `value`), not a raw typed array.
 * Version and updateRanges are delegated to the attribute.
 */
export class StorageNode<T extends WgslType> extends Node<T> {
    /**
     * This flag can be used for type testing.
     */
    readonly isStorageBufferNode: true = true;

    /**
     * The buffer attribute holding the CPU-side data.
     * Mirrors Three.js StorageBufferNode.value.
     */
    readonly value: StorageBufferAttribute;

    /**
     * The buffer type (element type), e.g. 'vec4f', 'mat4x4f'.
     * Same as node.type — provided for Three.js API compatibility.
     */
    readonly bufferType: T;

    /**
     * The number of elements in the buffer.
     * Derived from value.count.
     */
    readonly bufferCount: number;

    /** The WGSL array type string, e.g. 'array<mat4x4f>'. Emitted verbatim. */
    readonly storageType: string;

    readonly access: 'read' | 'read_write';

    /**
     * Whether the node is atomic or not.
     * Mirrors Three.js StorageBufferNode.isAtomic.
     */
    isAtomic: boolean = false;

    /**
     * Uniform group — determines @group index. Defaults to objectGroup.
     */
    groupNode: UniformGroupNode;

    constructor(
        /** The buffer attribute holding the data. */
        value: StorageBufferAttribute,
        /** Element type (e.g. 'mat4x4f') — used as the node's type for downstream indexing. */
        bufferType: T,
        /** Full WGSL array type string (e.g. 'array<mat4x4f>'). */
        storageType: string,
        access: 'read' | 'read_write' = 'read',
        /** Uniform group — determines @group index. Defaults to objectGroup. */
        groupNode: UniformGroupNode = objectGroup,
    ) {
        super(nextId(), 'storage', bufferType);
        this.value = value;
        this.bufferType = bufferType;
        this.bufferCount = value.count;
        this.storageType = storageType;
        this.access = access;
        this.groupNode = groupNode;
    }

    /**
     * Check if this is an indirect storage buffer.
     */
    get isIndirectStorageBuffer(): boolean {
        return !!(this.value as IndirectStorageBufferAttribute).isIndirectStorageBufferAttribute;
    }

    /** defines whether the node is atomic or not */
    setAtomic(value: boolean): this {
        this.isAtomic = value;
        return this;
    }

    /**
     * Convenience method for making this node atomic.
     */
    toAtomic(): this {
        return this.setAtomic(true);
    }

    /** convenience method for configuring read-only access */
    toReadOnly(): StorageNode<T> {
        // Note: access is readonly after construction in gpucat.
        // This method is provided for API compatibility but requires
        // creating a new node if access needs to change.
        if (this.access === 'read') return this;
        return new StorageNode(this.value, this.bufferType, this.storageType, 'read');
    }
}

/**
 * TextureNode - represents a texture sample operation.
 * 
 * When used as a value, it samples the texture at the given UV coordinates.
 * The node type is 'vec4f' (the sampled color), not the texture type.
 */
export class TextureNode extends Node<'vec4f'> {
    /**
     * GPU texture resource. Set this before rendering.
     * This can be set directly, OR use `value` (a Texture object) which the renderer
     * will use to create/update the GPU texture.
     */
    resource: GPUTexture | GPUTextureView | null = null;

    /**
     * GPU sampler resource. Auto-created by the renderer based on the texture's
     * sampling properties (wrap, filter, etc.).
     */
    gpuSampler: GPUSampler | null = null;

    /**
     * High-level Texture wrapper.
     * If set, the renderer will use this to create/update the GPU texture.
     * 
     * Can be:
     * - Texture (scene texture with image data)
     * - Texture with isRenderTargetTexture = true (render target color attachment)
     * - DepthTexture (render target depth attachment, extends Texture)
     */
    value: Texture | null = null;

    /**
     * The UV node for texture coordinates.
     * Defaults to uv() if not specified.
     */
    uvNode: Node<'vec2f'> | null = null;

    /**
     * The reference node
     * When sampling with different UVs, this points to the base texture node.
     */
    referenceNode: TextureNode | null = null;

    /**
     * The WGSL texture type (e.g., 'texture_2d<f32>').
     * Used for binding declarations.
     */
    readonly textureType: TextureType;

    /**
     * This flag can be used for type testing.
     */
    readonly isTextureNode = true;

    /**
     * Uniform group — determines @group index.
     * Defaults to objectGroup.
     */
    groupNode: UniformGroupNode;

    textureId: string;

    constructor(
        textureType: TextureType,
        textureId: string,
        uvNode: Node<'vec2f'> | null = null,
        /** Uniform group — determines @group index. Defaults to objectGroup. */
        groupNode: UniformGroupNode = objectGroup,
    ) {
        // Node type is vec4f (the sampled color)
        super(computeId('texture', { type: textureType, textureId, uvNode: uvNode?.id }), 'texture', 'vec4f');
        this.textureType = textureType;
        this.textureId = textureId;
        this.uvNode = uvNode;
        this.groupNode = groupNode;
    }

    /**
     * Get the base texture node (follows referenceNode chain).
     */
    getBase(): TextureNode {
        return this.referenceNode ? this.referenceNode.getBase() : this;
    }

    /**
     * Convert this texture node to another type.
     */
    convert(type: 'sampler' | 'sampler_comparison'): ConvertNode {
        return new ConvertNode(this, type);
    }

    /**
     * Clone this texture node.
     */
    clone(): TextureNode {
        const cloned = new TextureNode(this.textureType, this.textureId, this.uvNode, this.groupNode);
        cloned.value = this.value;
        cloned.resource = this.resource;
        cloned.gpuSampler = this.gpuSampler;
        cloned.referenceNode = this.referenceNode;
        return cloned;
    }

    /**
     * Sample the texture at the given UV coordinates.
     * Returns a new TextureNode with the UV set.
     */
    sample(uvNode: Node<'vec2f'>): TextureNode {
        const textureNode = this.clone();
        textureNode.uvNode = uvNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
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
}

export class VaryingNode<T extends WgslType> extends Node<T> {
    interpolationType: InterpolationType | null = null;
    interpolationSampling: InterpolationSampling | null = null;

    constructor(
        type: T,
        readonly name: string,
        readonly source: Node<WgslType>,
    ) {
        super(computeId('varying', { type, name, source: source.id }), 'varying', type);
    }

    /**
     * Set the WGSL @interpolate qualifier for this varying.
     *
     * @param type     - The interpolation type ('perspective' | 'linear' | 'flat').
     * @param sampling - Optional sampling mode ('center' | 'centroid' | 'sample' | 'either').
     *                   Only valid when type is 'perspective' or 'linear'.
     *                   Omit to use the WGSL default for the given type.
     */
    setInterpolation(type: InterpolationType, sampling?: InterpolationSampling): this {
        this.interpolationType = type;
        this.interpolationSampling = sampling ?? null;
        return this;
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
}

export class CallNode<T extends WgslType> extends Node<T> {
    readonly fnNode?: FnNode<WgslType> | WgslFnNode<WgslType>;
    constructor(
        type: T,
        readonly fn: string,
        readonly args: Node<WgslType>[],
        fnNode?: FnNode<WgslType> | WgslFnNode<WgslType>,
    ) {
        super(computeId('call', { type, fn, args: args.map((n) => n.id) }), 'call', type);
        this.fnNode = fnNode;
    }
}

export class WgslNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly wgsl: string,
        readonly deps: Node<WgslType>[],
    ) {
        super(computeId('wgsl', { type, wgsl, deps: deps.map((n) => n.id) }), 'wgsl', type);
    }

    /**
     * Returns a new WgslNode with additional unreferenced deps appended.
     * Useful for pulling nodes into the graph (e.g. varyings) without
     * emitting them in the WGSL expression string.
     */
    with(...extra: Node<WgslType>[]): WgslNode<T> {
        return new WgslNode<T>(this.type as T, this.wgsl, [...this.deps, ...extra]);
    }
}

export class ConvertNode extends Node<WgslType> {
    constructor(
        readonly node: Node<WgslType>,
        readonly convertTo: string,
    ) {
        super(computeId('convert', { node: node.id, convertTo }), 'convert', convertTo as WgslType);
    }
}

export class AssignNode extends Node<'void'> {
    constructor(
        readonly target: Node<WgslType>,
        readonly value: Node<WgslType>,
    ) {
        super(computeId('assign', { target: target.id, value: value.id }), 'assign', 'void');
    }
}

export class ConstructNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly args: Node<WgslType>[],
    ) {
        super(computeId('construct', { type, args: args.map((n) => n.id) }), 'construct', type);
    }
}

export class StructNode extends Node<string> {
    constructor(
        typeName: string,
        readonly members: StructMember[],
    ) {
        super(computeId('struct', { type: typeName, members }), 'struct', typeName);
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
}

export class IndexNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly array: Node<WgslType>,
        readonly index: Node<WgslType>,
    ) {
        super(computeId('index', { type, array: array.id, index: index.id }), 'index', type);
    }
}

export const index = <T extends WgslType>(array: Node<T>, idx: Node<WgslType>) => new IndexNode(array.type, array, idx);

export class BuiltinNode<T extends WgslType> extends Node<T> {
    constructor(
        readonly builtinKind: BuiltinKind,
        type: T,
    ) {
        super(computeId('builtin', { builtinKind, type }), 'builtin', type);
    }
}

export const builtin = <T extends WgslType>(builtinKind: BuiltinKind, type: T) => new BuiltinNode(builtinKind, type);

/* counter used by StackNode and all statement-level nodes (VarNode, IfNode) to ensure unique IDs */

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
 * BufferAttributeNode — a vertex attribute backed by a BufferAttribute or raw TypedArray.
 *
 * Mirrors Three.js BufferAttributeNode. Can be used for both regular vertex attributes
 * and per-instance attributes (stepMode: 'instance') by setting `instanced = true`.
 *
 * When passed an InstancedBufferAttribute, `instanced` is auto-set to true.
 *
 * @example
 * // Instanced attribute with InstancedBufferAttribute:
 * const attr = new InstancedBufferAttribute(new Float32Array([...]), 3);
 * const offsets = bufferAttribute(attr, S.vec3f());  // instanced = true auto
 *
 * // Instanced attribute with raw TypedArray:
 * const offsets = instancedBufferAttribute(new Float32Array([...]), S.vec3f());
 *
 * // Regular attribute:
 * const colors = bufferAttribute(new Float32Array([...]), S.vec3f());
 */
export class BufferAttributeNode<T extends WgslType> extends Node<T> {
    /** The underlying BufferAttribute (StorageBufferAttribute/InstancedBufferAttribute). */
    readonly attribute: StorageBufferAttribute | InstancedBufferAttribute;
    /** Byte stride between consecutive elements. */
    readonly stride: number;
    /** Byte offset of this attribute within each element. */
    readonly offset: number;
    /** Whether this attribute is instanced (stepMode: 'instance'). */
    instanced: boolean;

    constructor(
        type: T,
        value: StorageBufferAttribute | InstancedBufferAttribute | GpuTypedArray,
        stride: number,
        offset: number,
        itemSize: number,
    ) {
        // ID is NOT content-addressed on data (too expensive to hash large arrays).
        // Use a monotonic id so two separate bufferAttribute() calls are always distinct.
        super(nextId(), 'buffer_attribute', type);

        // If passed a raw TypedArray, wrap it in a StorageBufferAttribute
        if (ArrayBuffer.isView(value)) {
            this.attribute = new StorageBufferAttribute(value as GpuTypedArray, itemSize);
            this.instanced = false;
        } else {
            this.attribute = value;
            // Auto-detect instanced from attribute type
            this.instanced = 'isInstancedBufferAttribute' in value && value.isInstancedBufferAttribute === true;
        }

        this.stride = stride;
        this.offset = offset;
    }

    /** Set instanced flag (chainable). */
    setInstanced(value: boolean): this {
        this.instanced = value;
        return this;
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
}

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
}

export class ReturnNode<T extends WgslType> extends Node<T> {
    constructor(readonly value: Node<T>) {
        super(nextId(), 'return', value.type);
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
     * Create a ComputeNode from this FnNode.
     *
     * @example
     * const kernel = Fn(() => {
     *     const idx = globalId.x;
     *     // ...
     * }).compute({ dispatch: [Math.ceil(N / 64)] });
     */
    compute(opts: ComputeOptions): ComputeNode { 
        return new ComputeNode({ fn: this, ...opts });
     }
    

    /**
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
}

/**
 * Parsed parameter from WGSL function signature.
 */
export type WgslFnParam = {
    name: string;
    type: WgslType;
};

/**
 * WgslFnNode — holds raw WGSL function code parsed from a string.
 * Unlike FnNode which traces a JS function, this emits the WGSL directly.
 *
 * Created via wgslFn() helper.
 *
 * kind: 'wgsl_fn'
 */
export class WgslFnNode<T extends WgslType> extends Node<T> {
    /** WGSL function name parsed from source. */
    readonly fnName: string;
    /** Parameter list parsed from source. */
    readonly params: WgslFnParam[];
    /** The complete raw WGSL function source. */
    readonly wgslSource: string;
    /** Other WgslFnNodes this function depends on (includes). */
    readonly includes: WgslFnNode<WgslType>[];

    /** Type flag for runtime checking. */
    readonly isWgslFnNode = true;

    constructor(
        fnName: string,
        returnType: T,
        params: WgslFnParam[],
        wgslSource: string,
        includes: WgslFnNode<WgslType>[] = [],
    ) {
        super(`wgslfn_${fnName}`, 'wgsl_fn', returnType);
        this.fnName = fnName;
        this.params = params;
        this.wgslSource = wgslSource;
        this.includes = includes;
    }
}

// WGSL function signature regex:
// fn name(param1: type1, param2: type2, ...) -> returnType { ... }
const WGSL_FN_REGEX = /^\s*fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*([\s\S]*?)\s*\)\s*(?:->\s*([a-zA-Z_][a-zA-Z0-9_<>]*))?\s*\{/;
const WGSL_PARAM_REGEX = /([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([a-zA-Z_][a-zA-Z0-9_<>]*)/g;

/**
 * Parse a WGSL function signature from source code.
 * Returns { name, returnType, params } or throws if parsing fails.
 */
function parseWgslFnSignature(source: string): {
    name: string;
    returnType: WgslType;
    params: WgslFnParam[];
} {
    const match = source.match(WGSL_FN_REGEX);
    if (!match) {
        throw new Error(
            `[gpucat] wgslFn: Could not parse WGSL function signature. ` +
            `Expected: fn name(params) -> returnType { ... }\n` +
            `Got: ${source.slice(0, 100)}...`
        );
    }

    const name = match[1];
    const paramsStr = match[2];
    const returnType = (match[3] ?? 'void') as WgslType;

    const params: WgslFnParam[] = [];
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = WGSL_PARAM_REGEX.exec(paramsStr)) !== null) {
        params.push({
            name: paramMatch[1],
            type: paramMatch[2] as WgslType,
        });
    }

    return { name, returnType, params };
}

/**
 * Create a WGSL function from raw WGSL source code.
 *
 * The source must be a complete WGSL function definition:
 * ```wgsl
 * fn myFunc(a: f32, b: vec3f) -> vec4f {
 *     return vec4f(b * a, 1.0);
 * }
 * ```
 *
 * Returns a callable that creates CallNodes when invoked with arguments.
 * Arguments can be passed as:
 * - Positional: `myFunc(aNode, bNode)`
 * - Named object: `myFunc({ a: aNode, b: bNode })`
 *
 * @param source - Complete WGSL function source code
 * @param includes - Other wgslFn functions this function depends on
 *
 * @example
 * const aces = wgslFn(`
 *     fn acesToneMapping(color: vec3f) -> vec3f {
 *         let c = color;
 *         return clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
 *     }
 * `);
 *
 * // Use in node graph:
 * const tonemapped = aces(linearColor);
 * // Or with named params:
 * const tonemapped = aces({ color: linearColor });
 */
export function wgslFn<T extends WgslType = WgslType>(
    source: string,
    includes: ((...args: Node<WgslType>[]) => CallNode<WgslType>)[] = [],
): (...args: Node<WgslType>[] | [Record<string, Node<WgslType>>]) => CallNode<T> {
    const { name, returnType, params } = parseWgslFnSignature(source);

    // Extract WgslFnNode from callable includes
    const includeFnNodes: WgslFnNode<WgslType>[] = [];
    for (const inc of includes) {
        const fnNode = (inc as { fnNode?: WgslFnNode<WgslType> }).fnNode;
        if (fnNode && fnNode.isWgslFnNode) {
            includeFnNodes.push(fnNode);
        }
    }

    const fnNode = new WgslFnNode<T>(
        name,
        returnType as T,
        params,
        source.trim(),
        includeFnNodes,
    );

    // Return a callable that creates CallNodes
    const callable = (...args: Node<WgslType>[] | [Record<string, Node<WgslType>>]): CallNode<T> => {
        let resolvedArgs: Node<WgslType>[];

        // Check if called with named object { paramName: node }
        if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !('type' in args[0])) {
            const namedArgs = args[0] as Record<string, Node<WgslType>>;
            resolvedArgs = params.map((p) => {
                const arg = namedArgs[p.name];
                if (!arg) {
                    throw new Error(
                        `[gpucat] wgslFn '${name}': Missing argument '${p.name}'. ` +
                        `Expected params: ${params.map(p => p.name).join(', ')}`
                    );
                }
                return arg;
            });
        } else {
            // Positional args
            resolvedArgs = args as Node<WgslType>[];
            if (resolvedArgs.length !== params.length) {
                throw new Error(
                    `[gpucat] wgslFn '${name}': Expected ${params.length} arguments, got ${resolvedArgs.length}. ` +
                    `Params: ${params.map(p => `${p.name}: ${p.type}`).join(', ')}`
                );
            }
        }

        return new CallNode<T>(returnType as T, name, resolvedArgs, fnNode);
    };

    // Attach fnNode for include resolution
    (callable as unknown as { fnNode: WgslFnNode<T> }).fnNode = fnNode;

    return callable;
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
export function uniform<T extends WgslType>(init: ConstructNode<T>, name?: string): UniformNode<T>;
export function uniform<T extends WgslType>(init: ConstNode<T>, name?: string): UniformNode<T>;
export function uniform<T extends WgslType, S extends StructSchema>(
    init: ConstNode<T> | ConstructNode<T> | StructDef<S>,
    name?: string,
): UniformNode<T> | StructInstance<S> {
    if ('schema' in init) {
        // Struct form: init is a StructDef
        const def = init as StructDef<S>;
        const uniformId = name ?? def.wgslType;
        const node = new UniformNode<string>(def.wgslType, uniformId);
        return def.instantiate(node);
    }
    // Scalar / vector / matrix form: init is a ConstNode or ConstructNode.
    // ConstNode carries a .value; ConstructNode carries .args — we only seed
    // the initial CPU-side value for ConstNodes (scalars / literal vectors).
    const initNode = init as ConstNode<T> | ConstructNode<T>;
    const uniformId = name ?? initNode.type;
    const node = new UniformNode(initNode.type, uniformId);
    if (node.value === null && 'value' in initNode && initNode.value !== null) {
        node.value = initNode.value as number | number[];
    }
    return node;
}
export const attribute = <T extends WgslType>(type: WgslDesc<T>, name: string) => new AttributeNode<T>(type.wgslType as T, name);

/**
 * UV attribute node for texture coordinate access.
 * 
 * Returns an AttributeNode that reads the 'uv' vertex attribute (or 'uv1', 'uv2', etc.
 * for additional UV channels).
 * 
 * This mirrors Three.js `uv()` from `UV.js`:
 *   `export const uv = (index = 0) => attribute('uv' + (index > 0 ? index : ''), 'vec2');`
 * 
 * @param index - The UV channel index. Defaults to 0 (reads 'uv'). 
 *                Index 1 reads 'uv1', index 2 reads 'uv2', etc.
 * @returns An AttributeNode<'vec2f'> representing the UV coordinates.
 * 
 * @example
 * // Default UV channel
 * const texCoord = uv();
 * 
 * // Second UV channel (e.g., for lightmaps)
 * const lightmapUV = uv(1);
 * 
 * // Sample a texture with UVs
 * const color = myTexture.sample(uv());
 */
export const uv = (index = 0): AttributeNode<'vec2f'> => 
    new AttributeNode<'vec2f'>('vec2f', 'uv' + (index > 0 ? index : ''));

/**
 * Create a `StorageNode` backed by a `StorageBufferAttribute` (or subclass).
 *
 * The preferred form — mirrors Three's `storage(bufferAttr, schema, access)`.
 * Accepts either an `ArrayDesc` (e.g. `S.array(S.vec4f())`) or a `StructDef`
 * (from `struct(...)`) as the schema argument.
 *
 * When a `StructDef` is passed the node's element type and storage type are
 * both set to the struct name (e.g. `'DrawBuffer'`), matching how Three.js
 * emits `var<storage> x : DrawBuffer`.
 *
 * If `attr` is an `IndirectStorageBufferAttribute`, `_indirectOwner` is wired
 * automatically so the renderer reuses the same `STORAGE | INDIRECT | COPY_DST`
 * GPUBuffer for both the compute binding and the `drawIndirect` call.
 *
 * @example — array schema
 * const posAttr = new StorageBufferAttribute(posData, 4);
 * const positions = storage(posAttr, S.array(S.vec4f()));
 *
 * @example — struct schema (mirrors Three.js)
 * const DrawBuffer = struct('DrawBuffer', { vertexCount: S.u32(), instanceCount: S.u32(), ... });
 * const drawAttr = new IndirectStorageBufferAttribute(false, 1);
 * const drawStorage = storage(drawAttr, DrawBuffer, 'read_write');
 */
export function storage<E extends WgslType>(
    attr: StorageBufferAttribute,
    schema: ArrayDesc<E>,
    access?: 'read' | 'read_write',
): StorageNode<E>;
export function storage<S extends StructSchema>(
    attr: StorageBufferAttribute,
    schema: StructDef<S>,
    access?: 'read' | 'read_write',
): StructInstance<S>;
export function storage(
    attr: StorageBufferAttribute,
    schema: ArrayDesc<WgslType> | StructDef<StructSchema>,
    access: 'read' | 'read_write' = 'read',
): StorageNode<WgslType> | StructInstance<StructSchema> {
    let elementType: WgslType;
    let storageType: string;
    if (isStructDef(schema)) {
        elementType = schema.wgslType;
        storageType = schema.wgslType;
    } else {
        const arrayDesc = schema as ArrayDesc<WgslType>;
        elementType = arrayDesc.elementDesc.wgslType;
        storageType = arrayDesc.wgslType;
    }

    const node = new StorageNode(attr, elementType, storageType, access);

    // When given a StructDef, instantiate a StructInstance so callers can do
    // drawStorage.instanceCount.assign(...) — mirrors Three.js TSL pattern.
    if (isStructDef(schema)) {
        return schema.instantiate(node);
    }

    return node;
}

/**
 * Create a `StorageNode` with a zero-initialised typed array allocated internally.
 *
 * The element type and TypedArray kind are derived from `arrayDesc`:
 * - `S.array(S.vec4f())`   → `Float32Array` of length `count * 4`
 * - `S.array(S.u32())`     → `Uint32Array`  of length `count * 1`
 * - `S.array(S.mat4x4f())` → `Float32Array` of length `count * 16`
 *
 * @example
 * import * as S from './schema'
 * const colors = storageArray(N, S.array(S.vec4f()), 'read_write')
 * // Modify colors.value.array, then: colors.value.needsUpdate = true
 */
export const storageArray = <E extends WgslType>(
    count: number,
    arrayDesc: ArrayDesc<E>,
    access: 'read' | 'read_write' = 'read',
): StorageNode<E> => {
    const itemSize = itemSizeOf(arrayDesc.elementDesc);
    const Ctor = typedArrayCtorOf(arrayDesc.elementDesc);
    const data = new Ctor(count * itemSize);
    const attr = new StorageBufferAttribute(data, itemSize);
    return new StorageNode(attr, arrayDesc.elementDesc.wgslType as E, arrayDesc.wgslType, access);
};

/**
 * Create a texture node from a Texture object.
 *
 * @param tex - The Texture object containing image data
 * @param textureDesc - Optional texture type descriptor (default: texture2d())
 *
 * @example
 * const albedo = texture(myTexture);
 * const cubeMap = texture(myCubeTexture, S.textureCube());
 */
export const texture = (
    tex: Texture,
    textureDesc: TextureDesc | DepthTextureDesc = texture2d(),
): TextureNode => {
    // Prefix with 't' to ensure valid WGSL identifier (can't start with a number)
    const node = new TextureNode(textureDesc.wgslType as TextureType, `t${tex.id}`);
    node.value = tex;
    return node;
};

/**
 * Wraps a value into a node if needed.
 * Converts raw values (textures, numbers, etc.) to nodes.
 */
export function nodeObject<T extends WgslType>(val: T | Node<T> | unknown): Node<WgslType> {
    if (val && typeof val === 'object' && 'isNode' in (val as Record<string, unknown>)) {
        return val as Node<WgslType>;
    }
    // For now, only handle Texture objects - others can be added later
    if (val && typeof val === 'object' && 'isTexture' in (val as Record<string, unknown>)) {
        return texture(val as Texture);
    }
    throw new Error(`[gpucat] nodeObject: cannot convert ${typeof val} to Node`);
}

/**
 * Converts a node to a different type (e.g., texture to sampler).
 */
export const convert = (node: Node<WgslType> | unknown, types: string): ConvertNode => {
    return new ConvertNode(nodeObject(node), types);
};

/**
 * Converts a texture node to a sampler reference.
 * Returns a RawNode that emits `${textureId}_samp`.
 */
export const sampler = (value: TextureNode): ConvertNode => value.convert('sampler');

/**
 * Converts a texture to a sampler comparison reference for depth comparison.
 */
export const samplerComparison = (value: TextureNode): ConvertNode => value.convert('sampler_comparison');

export const varying = <T extends WgslType>(type: WgslDesc<T>, name: string, source: Node<WgslType>) => new VaryingNode<T>(type.wgslType as T, name, source);
export const wgsl = <T extends WgslType>(type: WgslDesc<T>) =>
    (strings: TemplateStringsArray, ...deps: Node<WgslType>[]): WgslNode<T> => {
        const wgslStr = String.raw({ raw: strings }, ...deps.map((_, i) => `$${i}`));
        return new WgslNode(type.wgslType as T, wgslStr, deps);
    };
export const stack = (...body: Node<WgslType>[]) => new StackNode(body);
export const cond = <T extends WgslType>(condition: Node<WgslType>, ifTrue: Node<T>, ifFalse?: Node<T>) =>
    new CondNode(condition, ifTrue, ifFalse);


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

/** Type predicate: returns true if v is a Node<WgslType>. Use instead of instanceof Node. */
export function isNode(v: unknown): v is Node<WgslType> {
    return v instanceof Node;
}

type Scalar = Node<WgslType> | number | boolean;

/** Wrap a scalar JS value as the appropriate ConstNode for the given vec element type. */
function wrapScalar(v: Scalar, elemType: 'f32' | 'f16' | 'i32' | 'u32' | 'bool'): Node<WgslType> {
    if (isNode(v)) return v;
    if (elemType === 'bool') return new ConstNode('bool', (v as boolean | number) ? 1 : 0);
    if (elemType === 'i32')  return new ConstNode('i32',  Math.trunc(v as number));
    if (elemType === 'u32')  return new ConstNode('u32',  Math.trunc(v as number));
    if (elemType === 'f16')  return new ConstNode('f16',  v as number);
    return new ConstNode('f32', v as number);
}

function elemOf(type: Vec2Type | Vec3Type | Vec4Type): 'f32' | 'f16' | 'i32' | 'u32' | 'bool' {
    if (type.endsWith('h')) return 'f16';
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
// Type constructors — WGSL-style naming with flexible component packing.
//
// These accept nodes, numbers, or component packing (e.g., vec3f(vec2, f32))
// ---------------------------------------------------------------------------

// Convenience aliases — vec2/vec3/vec4 default to float (f32)
export const vec2  = makeVec2('vec2f');
export const vec3  = makeVec3('vec3f');
export const vec4  = makeVec4('vec4f');

export const mat4 = (c0: Node<'vec4f'>, c1: Node<'vec4f'>, c2: Node<'vec4f'>, c3: Node<'vec4f'>) =>
    new ConstructNode('mat4x4f', [c0, c1, c2, c3]);

// Standalone math — source of truth; chaining methods on Node<T> delegate to these.
export const add = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<T> => new BinopNode('+', a.type, a, b) as Node<T>;
export const sub = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<T> => new BinopNode('-', a.type, a, b) as Node<T>;
export const div = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<T> => new BinopNode('/', a.type, a, b) as Node<T>;
export const mul = <A extends WgslType, B extends WgslType>(a: Node<A>, b: Node<B>) => new BinopNode('*', mulResultType(a.type, b.type), a, b) as Node<WgslType>;
export const dot = (a: Node<WgslType>, b: Node<WgslType>) => new CallNode('f32', 'dot', [a, b]);
export const cross = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<T> => new CallNode(a.type, 'cross', [a, b]) as Node<T>;
export const normalize = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'normalize', [a]) as Node<T>;
export const length = (a: Node<WgslType>): Node<'f32'> => new CallNode('f32', 'length', [a]);
export const abs = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'abs', [a]) as Node<T>;
export const floor = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'floor', [a]) as Node<T>;
export const ceil = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'ceil', [a]) as Node<T>;
export const fract = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'fract', [a]) as Node<T>;
export const sqrt = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'sqrt', [a]) as Node<T>;
export const sin = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'sin', [a]) as Node<T>;
export const cos = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'cos', [a]) as Node<T>;
export const negate = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'negate', [a]) as Node<T>;
export const pow = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<T> => new CallNode(a.type, 'pow', [a, b]) as Node<T>;
export const max = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<T> => new CallNode(a.type, 'max', [a, b]) as Node<T>;
export const min = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<T> => new CallNode(a.type, 'min', [a, b]) as Node<T>;
export const clamp = <T extends WgslType>(a: Node<T>, lo: Node<T>, hi: Node<T>): Node<T> => new CallNode(a.type, 'clamp', [a, lo, hi]) as Node<T>;
export const mix = <T extends WgslType>(a: Node<T>, b: Node<T>, t: Node<T>): Node<T> => new CallNode(a.type, 'mix', [a, b, t]) as Node<T>;
export const step = <T extends WgslType>(edge: Node<T>, x: Node<T>): Node<T> => new CallNode(x.type, 'step', [edge, x]) as Node<T>;
export const smoothstep = <T extends WgslType>(lo: Node<T>, hi: Node<T>, x: Node<T>): Node<T> => new CallNode(x.type, 'smoothstep', [lo, hi, x]) as Node<T>;

export const textureSample = (t: Node<WgslType>, s: Node<WgslType>, uv: Node<WgslType>) =>
    new CallNode('vec4f', 'textureSample', [t, s, uv]);
export const textureLoad = (t: Node<WgslType>, coord: Node<WgslType>, level: Node<WgslType>) =>
    new CallNode('vec4f', 'textureLoad', [t, coord, level]);
export const textureSampleLevel = (t: Node<WgslType>, s: Node<WgslType>, uv: Node<WgslType>, level: Node<WgslType>) =>
    new CallNode('vec4f', 'textureSampleLevel', [t, s, uv, level]);

/**
 * Internal helper for creating buffer attribute nodes.
 * @param value     A BufferAttribute, InstancedBufferAttribute, or raw TypedArray.
 * @param desc      WgslDesc for the attribute element type.
 * @param stride    Byte stride between consecutive elements
 * @param offset    Byte offset within each element
 * @param instanced Whether this is an instanced attribute.
 */
function createBufferAttribute<T extends WgslType>(
    value: StorageBufferAttribute | InstancedBufferAttribute | GpuTypedArray,
    desc: WgslDesc<T>,
    stride: number,
    offset: number,
    instanced: boolean,
): BufferAttributeNode<T> {
    const node = new BufferAttributeNode(desc.wgslType as T, value, stride, offset, itemSizeOf(desc));
    if (instanced) node.setInstanced(true);
    return node;
}

/**
 * Create a BufferAttributeNode — a vertex attribute backed by a BufferAttribute or TypedArray.
 *
 * @param value   A BufferAttribute, InstancedBufferAttribute, or raw TypedArray.
 * @param desc    WgslDesc for the attribute element type (e.g. `S.vec3f()`, `S.f32()`).
 * @param stride  Byte stride between consecutive elements (default: 0 = tightly packed).
 * @param offset  Byte offset within each element (default: 0).
 *
 * @example
 * const colors = bufferAttribute(new Float32Array([1,0,0, 0,1,0]), S.vec3f());
 */
export const bufferAttribute = <T extends WgslType>(
    value: StorageBufferAttribute | InstancedBufferAttribute | GpuTypedArray,
    desc: WgslDesc<T>,
    stride = 0,
    offset = 0,
) => createBufferAttribute(value, desc, stride, offset, false);

/**
 * Create an instanced BufferAttributeNode — a per-instance vertex attribute
 * uploaded by the renderer as a vertex buffer with stepMode: 'instance'.
 *
 * Mirrors Three.js TSL's instancedBufferAttribute() pattern.
 *
 * @param value   An InstancedBufferAttribute, or a raw TypedArray.
 * @param desc    WgslDesc for the attribute element type (e.g. `S.vec3f()`, `S.f32()`).
 * @param stride  Byte stride between consecutive instance records (default: 0 = tightly packed).
 * @param offset  Byte offset within each instance record (default: 0).
 *
 * @example
 * // With InstancedBufferAttribute:
 * const attr = new InstancedBufferAttribute(new Float32Array([1,0,0, 0,1,0]), 3);
 * const colors = instancedBufferAttribute(attr, S.vec3f());
 *
 * // With raw TypedArray:
 * const colors = instancedBufferAttribute(new Float32Array([1,0,0, 0,1,0]), S.vec3f());
 */
export const instancedBufferAttribute = <T extends WgslType>(
    value: InstancedBufferAttribute | GpuTypedArray,
    desc: WgslDesc<T>,
    stride = 0,
    offset = 0,
) => createBufferAttribute(value, desc, stride, offset, true);

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
export function Var<T extends WgslType>(init: Node<T>, label?: string): VarNode<T> {
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

export function Return<T extends WgslType>(value: Node<T>): void {
    addToStack(new ReturnNode(value) as Node<WgslType>);
}

export function Break(): void {
    addToStack(new BreakNode());
}

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
// Overload 2 — no-params void body: returns the FnNode for use with .compute()
export function Fn(
    jsFunc: () => void,
): FnNode<'void'>;
// Overload 3 — no layout: params are Node<WgslType>, user annotates manually
export function Fn<T extends WgslType>(
    jsFunc: (...args: Node<WgslType>[]) => Node<T>,
): (...args: Node<WgslType>[]) => CallNode<T>;
// Implementation
export function Fn<T extends WgslType>(
    jsFunc: ((...args: Node<WgslType>[]) => Node<T>) | (() => void),
    layout?: FnLayout<readonly ParamDesc[]>,
): ((...args: Node<WgslType>[]) => CallNode<T>) | FnNode<'void'> {
    // Build dummy ParamNodes for the dry-run trace that infers the return type.
    const paramDescs: (ParamDesc | WgslDesc<WgslType>)[] = layout?.params ?? [];
    const dummyParams = paramDescs.map((d, i) => {
        const paramName = 'name' in d ? (d as ParamDesc).name : undefined;
        const wgslType = 'name' in d ? (d as ParamDesc).type.wgslType : (d as WgslDesc<WgslType>).wgslType;
        return new ParamNode(wgslType, i, paramName);
    });

    const traceStack = new StackNode();
    const prev = pushStack(traceStack);
    let returnType: T | 'void';
    try {
        const output = (jsFunc as (...args: Node<WgslType>[]) => Node<T> | undefined)(...dummyParams);
        returnType = output != null ? (output.type as T) : 'void';
    } finally {
        popStack(prev);
    }

    // No-params void-body case — return the FnNode directly for .compute() chaining.
    if (returnType === 'void' && paramDescs.length === 0 && !layout) {
        return new FnNode<'void'>(
            'void',
            [],
            jsFunc as (...args: Node<WgslType>[]) => Node<'void'>,
            undefined,
        );
    }

    const fnNode = new FnNode<T>(returnType as T, paramDescs, jsFunc as (...args: Node<WgslType>[]) => Node<T>, layout?.name);

    return (...args: Node<WgslType>[]): CallNode<T> => {
        return new CallNode<T>(returnType as T, fnNode.fnName, args, fnNode);
    };
}

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
    vec2h: 'f16',
    vec3h: 'f16',
    vec4h: 'f16',
};
const VEC2_OF: Record<string, string> = { f32: 'vec2f', i32: 'vec2i', u32: 'vec2u', f16: 'vec2h' };
const VEC3_OF: Record<string, string> = { f32: 'vec3f', i32: 'vec3i', u32: 'vec3u', f16: 'vec3h' };
const VEC4_OF: Record<string, string> = { f32: 'vec4f', i32: 'vec4i', u32: 'vec4u', f16: 'vec4h' };
const MAT_TYPES = new Set([
    'mat2x2f', 'mat2x3f', 'mat2x4f', 'mat3x2f', 'mat3x3f', 'mat3x4f', 'mat4x2f', 'mat4x3f', 'mat4x4f',
    'mat2x2h', 'mat2x3h', 'mat2x4h', 'mat3x2h', 'mat3x3h', 'mat3x4h', 'mat4x2h', 'mat4x3h', 'mat4x4h',
]);
const VEC_TYPES = new Set(Object.keys(VEC_ELEMENT));
const SCALAR_TYPES = new Set(['f32', 'i32', 'u32', 'bool', 'f16']);

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

export const f32    = (v = 0):                       ConstNode<'f32'>    => new ConstNode('f32',    v);
export const f16    = (v = 0):                       ConstNode<'f16'>    => new ConstNode('f16',    v);
export const i32    = (v = 0):                       ConstNode<'i32'>    => new ConstNode('i32',    v);
export const u32    = (v = 0):                       ConstNode<'u32'>    => new ConstNode('u32',    v);
export const bool   = (v: boolean):                  ConstNode<'bool'>   => new ConstNode('bool',   v ? 1 : 0);

export const vec2f  = makeVec2('vec2f');
export const vec3f  = makeVec3('vec3f');
export const vec4f  = makeVec4('vec4f');
export const vec2i  = makeVec2('vec2i');
export const vec3i  = makeVec3('vec3i');
export const vec4i  = makeVec4('vec4i');
export const vec2u  = makeVec2('vec2u');
export const vec3u  = makeVec3('vec3u');
export const vec4u  = makeVec4('vec4u');
export const vec2h  = makeVec2('vec2h');
export const vec3h  = makeVec3('vec3h');
export const vec4h  = makeVec4('vec4h');

export const vec2b  = makeVec2('vec2<bool>');
export const vec3b  = makeVec3('vec3<bool>');
export const vec4b  = makeVec4('vec4<bool>');

export const mat2x2f = (...v: number[]): ConstNode<'mat2x2f'> => new ConstNode('mat2x2f', v.length ? v : []);
export const mat2x3f = (...v: number[]): ConstNode<'mat2x3f'> => new ConstNode('mat2x3f', v.length ? v : []);
export const mat2x4f = (...v: number[]): ConstNode<'mat2x4f'> => new ConstNode('mat2x4f', v.length ? v : []);
export const mat3x2f = (...v: number[]): ConstNode<'mat3x2f'> => new ConstNode('mat3x2f', v.length ? v : []);
export const mat3x3f = (...v: number[]): ConstNode<'mat3x3f'> => new ConstNode('mat3x3f', v.length ? v : []);
export const mat3x4f = (...v: number[]): ConstNode<'mat3x4f'> => new ConstNode('mat3x4f', v.length ? v : []);
export const mat4x2f = (...v: number[]): ConstNode<'mat4x2f'> => new ConstNode('mat4x2f', v.length ? v : []);
export const mat4x3f = (...v: number[]): ConstNode<'mat4x3f'> => new ConstNode('mat4x3f', v.length ? v : []);
export const mat4x4f = (...v: number[]): ConstNode<'mat4x4f'> => new ConstNode('mat4x4f', v.length ? v : []);
export const mat2x2h = (...v: number[]): ConstNode<'mat2x2h'> => new ConstNode('mat2x2h', v.length ? v : []);
export const mat2x3h = (...v: number[]): ConstNode<'mat2x3h'> => new ConstNode('mat2x3h', v.length ? v : []);
export const mat2x4h = (...v: number[]): ConstNode<'mat2x4h'> => new ConstNode('mat2x4h', v.length ? v : []);
export const mat3x2h = (...v: number[]): ConstNode<'mat3x2h'> => new ConstNode('mat3x2h', v.length ? v : []);
export const mat3x3h = (...v: number[]): ConstNode<'mat3x3h'> => new ConstNode('mat3x3h', v.length ? v : []);
export const mat3x4h = (...v: number[]): ConstNode<'mat3x4h'> => new ConstNode('mat3x4h', v.length ? v : []);
export const mat4x2h = (...v: number[]): ConstNode<'mat4x2h'> => new ConstNode('mat4x2h', v.length ? v : []);
export const mat4x3h = (...v: number[]): ConstNode<'mat4x3h'> => new ConstNode('mat4x3h', v.length ? v : []);
export const mat4x4h = (...v: number[]): ConstNode<'mat4x4h'> => new ConstNode('mat4x4h', v.length ? v : []);

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

/** Projection matrix of the scene camera. In renderGroup. */
export const cameraProjectionMatrix = /*@__PURE__*/ new UniformNode('mat4x4f', 'cameraProjectionMatrix', renderGroup)
    .onRenderUpdate((frame) => frame.camera!.projectionMatrix);

/** View (world-to-camera) matrix. In renderGroup. */
export const cameraViewMatrix = /*@__PURE__*/ new UniformNode('mat4x4f', 'cameraViewMatrix', renderGroup)
    .onRenderUpdate((frame) => frame.camera!.matrixWorldInverse);

/** Camera world-space position. In renderGroup. */
export const cameraPosition = /*@__PURE__*/ new UniformNode('vec3f', 'cameraPosition', renderGroup)
    .onRenderUpdate((frame) => frame.camera!.position);

/** Camera near plane distance. In renderGroup. */
export const cameraNear = /*@__PURE__*/ new UniformNode('f32', 'cameraNear', renderGroup)
    .onRenderUpdate((frame) => frame.camera!.near);

/** Camera far plane distance. In renderGroup. */
export const cameraFar = /*@__PURE__*/ new UniformNode('f32', 'cameraFar', renderGroup)
    .onRenderUpdate((frame) => frame.camera!.far);

/** Elapsed time in seconds. In renderGroup. */
export const timeElapsed = /*@__PURE__*/ new UniformNode('f32', 'timeElapsed', renderGroup)
    .onRenderUpdate((frame) => frame.time);

/** Frame delta time in seconds. In renderGroup. */
export const timeDelta = /*@__PURE__*/ new UniformNode('f32', 'timeDelta', renderGroup)
    .onRenderUpdate((frame) => frame.deltaTime);

/** Model-to-world transform matrix. In objectGroup. Three.js name: modelWorldMatrix. */
export const modelWorldMatrix = /*@__PURE__*/ new UniformNode('mat4x4f', 'modelWorldMatrix', objectGroup)
    .onObjectUpdate((frame) => frame.object!.matrixWorld);

/** Normal matrix (inverse-transpose of upper-left 3x3 of model matrix). In objectGroup. */
export const modelNormalMatrix = /*@__PURE__*/ new UniformNode('mat3x3f', 'modelNormalMatrix', objectGroup)
    .onObjectUpdate((frame) => frame.object!.normalMatrix);

/** @builtin(instance_index) — the instance index for instanced draw calls. */
export const instanceIndex: BuiltinNode<'u32'> = /*@__PURE__*/ builtin('instance_index', 'u32');

/** @builtin(vertex_index) — the vertex index in the current draw call. */
export const vertexIndex: BuiltinNode<'u32'> = /*@__PURE__*/ builtin('vertex_index', 'u32');

/** @builtin(global_invocation_id) — unique thread ID across the entire dispatch. */
export const globalId: BuiltinNode<'vec3u'> = /*@__PURE__*/ builtin('global_invocation_id', 'vec3u');

/** @builtin(local_invocation_id) — thread ID within its workgroup. */
export const localId: BuiltinNode<'vec3u'> = /*@__PURE__*/ builtin('local_invocation_id', 'vec3u');

/** @builtin(local_invocation_index) — flat 1-D index within the workgroup. */
export const localIndex: BuiltinNode<'u32'> = /*@__PURE__*/ builtin('local_invocation_index', 'u32');

/** @builtin(workgroup_id) — workgroup coordinate in the dispatch grid. */
export const workgroupId: BuiltinNode<'vec3u'> = /*@__PURE__*/ builtin('workgroup_id', 'vec3u');

/** @builtin(num_workgroups) — total number of workgroups dispatched. */
export const numWorkgroups: BuiltinNode<'vec3u'> = /*@__PURE__*/ builtin('num_workgroups', 'vec3u');

/**
 * Fragment position in window/pixel coordinates.
 * @builtin(position) in the fragment shader — vec4f where xy are pixel coordinates.
 *
 * This is the raw fragment coordinate from the rasterizer.
 * Use screenCoordinate.xy for 2D pixel position.
 */
export const fragCoord: BuiltinNode<'vec4f'> = /*@__PURE__*/ builtin('position', 'vec4f');

/**
 * Screen coordinate — the current fragment's xy position in pixels.
 * Equivalent to @builtin(position).xy in WGSL.
 *
 * @example
 * // Get pixel position
 * const pixelPos = screenCoordinate;
 */
export const screenCoordinate = fragCoord.xy;

/**
 * Screen/viewport size in pixels. Updated per render by the renderer.
 * In renderGroup so it's shared across all objects in a frame.
 *
 * @example
 * // Get screen dimensions
 * const size = screenSize; // vec2f(width, height)
 */
export const screenSize: UniformNode<'vec2f'> = /*@__PURE__*/ new UniformNode('vec2f', 'screenSize', renderGroup)
    .onRenderUpdate(({ width, height }) => [width, height]);

/**
 * Normalized screen UV coordinates in [0, 1] range.
 * Computed as screenCoordinate / screenSize.
 *
 * (0, 0) is top-left, (1, 1) is bottom-right (following WebGPU conventions).
 *
 * @example
 * // Sample a texture using screen UV
 * const color = texture.sample(screenUV);
 *
 * // Use x component for horizontal effects
 * const x = screenUV.x;
 */
export const screenUV: Node<'vec2f'> = /*@__PURE__*/ (() => {
    return div(screenCoordinate, screenSize) as Node<'vec2f'>;
})();

/** helper for vertex shader: compute clip-space position from vertex position attribute and camera matrices. */
export const positionClip: Node<'vec4f'> = (() => {
    const pos = attribute(d.vec3f, 'position');
    const localPos = vec4f(pos, f32(1.0));

    const worldPos = mul(modelWorldMatrix, localPos);

    const viewPos = mul(cameraViewMatrix, worldPos);
    const clipPos = mul(cameraProjectionMatrix, viewPos);

    return clipPos as unknown as Node<'vec4f'>;
})();

let _outputStructCounter = 0;

/**
 * Represents a fragment shader output struct with multiple @location outputs.
 * Used for MRT (Multiple Render Targets).
 *
 * Each member in the `members` array corresponds to a @location(N) output.
 * The index in the array determines the @location index.
 *
 * @example
 * // Direct usage (rare):
 * const outputs = new OutputStructNode([colorNode, normalNode, velocityNode]);
 *
 * // Typically created via mrt() helper instead.
 */
export class OutputStructNode extends Node<'vec4f'> {
    /**
     * Array of output nodes. Each node maps to @location(index).
     * All nodes should produce vec4f values.
     */
    members: Node<WgslType>[];

    /** Type flag for runtime checking. */
    readonly isOutputStructNode = true;

    constructor(members: Node<WgslType>[] = [], id?: string) {
        super(id ?? `_output_struct_${_outputStructCounter++}`, 'output_struct', 'vec4f');
        this.members = members;
    }

    override getChildren(): Node<WgslType>[] {
        return this.members;
    }
}

let _mrtCounter = 0;

/**
 * MRT (Multiple Render Targets) node.
 *
 * Takes a dictionary of named outputs. At setup time, the names are resolved
 * to @location(N) indices based on the current render target's texture names.
 *
 * @example
 * // Set up render target with named textures:
 * const rt = new RenderTarget(device, w, h, { count: 3 });
 * rt.textures[0].name = 'color';
 * rt.textures[1].name = 'normal';
 * rt.textures[2].name = 'velocity';
 *
 * // Create MRT node:
 * const mrtNode = mrt({
 *     color: outputColor,      // -> @location(0)
 *     normal: viewNormal,      // -> @location(1)
 *     velocity: motionVector,  // -> @location(2)
 * });
 *
 * // Use in material:
 * const mat = new Material({
 *     vertex: clipPos,
 *     fragment: mrtNode,
 * });
 */
export class MRTNode extends OutputStructNode {
    /**
     * Dictionary of named outputs. Keys are texture names,
     * values are nodes producing vec4f values.
     */
    outputNodes: Record<string, Node<WgslType>>;

    /** Type flag for runtime checking. */
    readonly isMRTNode = true;

    /**
     * Resolved output names in order. Populated during setup() when
     * render target is known. Used by the compiler to emit correct
     * @location indices.
     */
    _resolvedNames: string[] = [];

    constructor(outputNodes: Record<string, Node<WgslType>>) {
        super([], `_mrt_${_mrtCounter++}`);
        this.outputNodes = outputNodes;
    }

    /**
     * Returns true if this MRT node has an output with the given name.
     */
    has(name: string): boolean {
        return this.outputNodes[name] !== undefined;
    }

    /**
     * Returns the output node for the given name.
     */
    get(name: string): Node<WgslType> | undefined {
        return this.outputNodes[name];
    }

    /**
     * Merge another MRTNode's outputs into this one.
     * Returns a new MRTNode with combined outputs (other's outputs override this's).
     */
    merge(other: MRTNode): MRTNode {
        return new MRTNode({ ...this.outputNodes, ...other.outputNodes });
    }

    /**
     * Resolve output names to @location indices based on render target textures.
     * Called by the compiler when the render target is known.
     *
     * @param getTextureIndex - Function that maps texture name to index (from RenderTarget)
     */
    setup(getTextureIndex: (name: string) => number): void {
        const members: Node<WgslType>[] = [];
        const names: string[] = [];

        for (const name in this.outputNodes) {
            const index = getTextureIndex(name);
            if (index === -1) {
                console.warn(`[MRTNode] Output '${name}' not found in render target textures. Skipping.`);
                continue;
            }
            // Ensure the node outputs vec4f (wrap if needed)
            let node = this.outputNodes[name];
            if (node.type !== 'vec4f') {
                node = vec4f(node as Node<'vec3f'>, new ConstNode('f32', 1));
            }
            members[index] = node;
            names[index] = name;
        }

        this.members = members;
        this._resolvedNames = names;
    }

    override getChildren(): Node<WgslType>[] {
        // Before setup, return outputNodes values; after setup, use members
        if (this.members.length > 0) {
            return this.members.filter(Boolean);
        }
        return Object.values(this.outputNodes);
    }
}

/**
 * Create an MRT (Multiple Render Targets) node from a dictionary of outputs.
 *
 * Output names must match the `.name` property of textures in the render target.
 * The compiler maps each output to the corresponding @location(N) based on
 * texture array indices.
 *
 * @example
 * const mrtOutput = mrt({
 *     color: finalColor,
 *     normal: viewSpaceNormal,
 *     velocity: motionVector,
 * });
 *
 * const material = new Material({
 *     vertex: clipPosition,
 *     fragment: mrtOutput,
 * });
 */
export function mrt(outputNodes: Record<string, Node<WgslType>>): MRTNode {
    return new MRTNode(outputNodes);
}

let _computeCounter = 0;

export type ComputeOptions = {
    /**
     * Dispatch dimensions [x, y, z] — number of workgroups to dispatch.
     * Trailing 1s may be omitted: [N] = [N, 1, 1], [N, M] = [N, M, 1].
     */
    dispatch: [x: number, y: number, z: number] | [x: number, y: number] | [x: number];
    /**
     * Workgroup size tuple [x, y, z].
     * Defaults to [64, 1, 1].
     */
    workgroupSize?: [x: number, y: number, z: number];
};

export type ComputeNodeOptions = ComputeOptions & {
    /** The FnNode whose body becomes the @compute entry point. */
    fn: FnNode<WgslType>;
};

/**
 * A plain object representing a single WebGPU compute dispatch.
 *
 * Storage buffers are inferred automatically by walking the traced Fn body
 * for StorageNode children. Binding order = encounter order (depth-first).
 *
 * Use `renderer.compile(node)` to pre-warm, then `renderer.compute(node)` each frame.
 */
export class ComputeNode {
    readonly id: string;
    readonly fn: FnNode<WgslType>;
    readonly workgroupSize: [number, number, number];
    readonly dispatch: [number, number, number];

    constructor(opts: ComputeNodeOptions) {
        this.id = `_compute_${_computeCounter++}`;
        this.fn = opts.fn;
        this.workgroupSize = opts.workgroupSize ?? [64, 1, 1];
        const d = opts.dispatch;
        this.dispatch = [d[0], d[1] ?? 1, d[2] ?? 1];
    }

    /**
     * Trace the Fn body and infer storage buffers from the graph.
     * Returns { body, storage } — called once by compileCompute().
     */
    trace(): { body: StackNode; storage: StorageNode<WgslType>[] } {
        const { body } = this.fn.trace();

        const storage: StorageNode<WgslType>[] = [];
        const seen = new Set<string>();
        const queue: Node<WgslType>[] = [body];
        const visited = new Set<string>();

        while (queue.length > 0) {
            const node = queue.pop()!;
            if (visited.has(node.id)) continue;
            visited.add(node.id);
            if (node.kind === 'storage') {
                if (!seen.has(node.id)) {
                    seen.add(node.id);
                    storage.push(node as StorageNode<WgslType>);
                }
            }
            for (const child of node.getChildren()) {
                queue.push(child);
            }
        }

        return { body, storage };
    }
}

/**
 * Create a ComputeNode from a FnNode.
 *
 * @example
 * const kernel = compute(
 *     Fn(() => { ... }),
 *     { dispatch: [Math.ceil(N / 64)] },
 * );
 */
export function compute(fn: FnNode<WgslType>, opts: ComputeOptions): ComputeNode {
    return new ComputeNode({ fn, ...opts });
}

/**
 * Struct descriptor for a non-indexed indirect draw call (`drawIndirect`).
 * Memory layout (4 × u32, 16 bytes):
 *   vertexCount, instanceCount, firstVertex, firstInstance
 */
export const DrawIndirect = struct('DrawIndirect', {
    vertexCount:   d.u32,
    instanceCount: d.u32,
    firstVertex:   d.u32,
    firstInstance: d.u32,
});

/**
 * Struct descriptor for an indexed indirect draw call (`drawIndexedIndirect`).
 * Memory layout (5 × u32, 20 bytes):
 *   indexCount, instanceCount, firstIndex, baseVertex, firstInstance
 */
export const DrawIndexedIndirect = struct('DrawIndexedIndirect', {
    indexCount:    d.u32,
    instanceCount: d.u32,
    firstIndex:    d.u32,
    baseVertex:    d.u32,
    firstInstance: d.u32,
});
