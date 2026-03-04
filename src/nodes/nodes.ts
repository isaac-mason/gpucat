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

/* wgsl type vocabulary */

export type ScalarType = 'f32' | 'i32' | 'u32' | 'bool';

export type Vec2Type = 'vec2f' | 'vec2i' | 'vec2u' | 'vec2b';
export type Vec3Type = 'vec3f' | 'vec3i' | 'vec3u' | 'vec3b';
export type Vec4Type = 'vec4f' | 'vec4i' | 'vec4u' | 'vec4b';
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

export type Vec2Of<E extends ScalarType> = E extends 'f32' ? 'vec2f' : E extends 'i32' ? 'vec2i' : E extends 'u32' ? 'vec2u' : 'vec2b';
export type Vec3Of<E extends ScalarType> = E extends 'f32' ? 'vec3f' : E extends 'i32' ? 'vec3i' : E extends 'u32' ? 'vec3u' : 'vec3b';
export type Vec4Of<E extends ScalarType> = E extends 'f32' ? 'vec4f' : E extends 'i32' ? 'vec4i' : E extends 'u32' ? 'vec4u' : 'vec4b';

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
    | 'fn'
    | 'param'
    | 'return';

export type StructMember = { readonly name: string; readonly type: WgslType };
export type BuiltinKind = 'camera' | 'instance_index' | 'instance_data' | 'mesh' | 'time' | 'vertex_index';
export type BinopOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '>' | '<=' | '>=';

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

export class UniformNode<T extends WgslType> extends Node<T> {
    readonly group: 'material' | 'frame';
    constructor(
        type: T,
        readonly uniformId: string,
        group: 'material' | 'frame' = 'material',
    ) {
        super(computeId('uniform', { type, uniformId, group }), 'uniform', type);
        this.group = group;
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
    constructor(
        type: TextureType,
        readonly textureId: string,
    ) {
        super(computeId('texture', { type, textureId }), 'texture', type);
    }
}

export class SamplerNode extends Node<SamplerType> {
    constructor(
        type: SamplerType,
        readonly samplerId: string,
    ) {
        super(computeId('sampler', { type, samplerId }), 'sampler', type);
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
}

export class RawNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly wgsl: string,
        readonly deps: Node<WgslType>[],
    ) {
        super(computeId('raw', { type, wgsl, deps: deps.map((n) => n.id) }), 'raw', type);
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
}

export class BuiltinNode<T extends WgslType> extends Node<T> {
    constructor(
        readonly builtinKind: BuiltinKind,
        type: T,
    ) {
        super(computeId('builtin', { builtinKind, type }), 'builtin', type);
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
 * ForNode — statement-form counted loop.
 * Created by `For({ count }, ({ i }) => { ... })`.
 * `count` is a u32 node giving the iteration count; `i` is a ParamNode<'u32'>.
 *
 * kind: 'for'
 */
export class ForNode extends Node<'void'> {
    constructor(
        readonly count: Node<WgslType>,
        readonly indexVar: ParamNode<'u32'>,
        readonly body: StackNode,
    ) {
        super(nextId(), 'for', 'void');
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
    ) {
        super(nextId(), 'param', type);
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
}

/**
 * FnNode — a named WGSL function defined via `Fn(params, jsFunc)`.
 * Holds the parameter descriptors and a JS function that, when called with
 * ParamNodes, performs eager tracing to produce the body StackNode + outputNode.
 *
 * The compiler calls `trace()` once to materialise the body.
 *
 * kind: 'fn'
 */
export class FnNode<T extends WgslType> extends Node<T> {
    readonly fnName: string;
    readonly paramDescs: WgslDesc<WgslType>[];
    /** The JS function passed to Fn(). The compiler calls this with ParamNodes. */
    readonly jsFunc: (...args: Node<WgslType>[]) => Node<T>;

    constructor(returnType: T, paramDescs: WgslDesc<WgslType>[], jsFunc: (...args: Node<WgslType>[]) => Node<T>) {
        super(nextId(), 'fn', returnType);
        this.fnName = `fn_${this.id}`;
        this.paramDescs = paramDescs;
        this.jsFunc = jsFunc;
    }

    /**
     * Execute the JS callback with fresh ParamNodes, capturing the resulting
     * StackNode body and the output expression node.
     * Returns { params, body, output } for use by the compiler.
     */
    trace(): { params: ParamNode<WgslType>[]; body: StackNode; output: Node<T> } {
        const params = this.paramDescs.map((d, i) => new ParamNode(d.wgslType, i));
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
export const uniform = <T extends WgslType>(type: T, uniformId: string, opts?: { group?: 'material' | 'frame' }) =>
    new UniformNode(type, uniformId, opts?.group);
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
export const struct = (typeName: string, members: StructMember[]) => new StructNode(typeName, members);
export const builtin = <T extends WgslType>(builtinKind: BuiltinKind, type: T) => new BuiltinNode(builtinKind, type);
export const raw = <T extends WgslType>(type: T, wgsl: string, ...deps: Node<WgslType>[]) => new RawNode(type, wgsl, deps);
export const stack = (...body: Node<WgslType>[]) => new StackNode(body);
export const cond = <T extends WgslType>(condition: Node<WgslType>, ifTrue: Node<T>, ifFalse?: Node<T>) =>
    new CondNode(condition, ifTrue, ifFalse);

/** Array element access: array[index]. Element type T must be specified explicitly. */
export const index = <T extends WgslType>(type: T, array: Node<WgslType>, idx: Node<WgslType>) => new IndexNode(type, array, idx);

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

// bool variants — bvec2 / bvec3 / bvec4
export const bvec2 = makeVec2('vec2b');
export const bvec3 = makeVec3('vec3b');
export const bvec4 = makeVec4('vec4b');

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
 * Declare a mutable local variable inside a Fn body.
 * @param init    Initial value node.
 * @param label   Optional debug label — appended to the generated var name (e.g. 'color' → 'var_42_color').
 * @returns       A VarNode you can later call `.assign()` on.
 *
 * @example
 * const acc = toVar('f32', konst('f32', 0.0), 'acc')
 * acc.assign(acc.add(konst('f32', 1.0)))
 */
export function toVar<T extends WgslType>(type: T, init: Node<T>, label?: string): VarNode<T> {
    const varName = label ? `var_${_nodeCounter}_${label}` : `var_${_nodeCounter}`;
    const v = new VarNode(type, varName, init);
    addToStack(v as Node<WgslType>);
    return v;
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
 * Statement-form counted loop inside a Fn body.
 *
 * @param opts    `{ count }` — a Node<u32> giving the iteration count.
 * @param body    Callback receiving `{ i }` — the loop index as a Node<'u32'>.
 *
 * @example
 * For({ count: n }, ({ i }) => {
 *     acc.assign(acc.add(i.toF32()))
 * })
 */
export function For(opts: { count: Node<WgslType> }, body: (args: { i: ParamNode<'u32'> }) => void): void {
    const indexVar = new ParamNode<'u32'>('u32', 0);
    const loopStack = new StackNode();
    const prev = pushStack(loopStack);
    try {
        body({ i: indexVar });
    } finally {
        popStack(prev);
    }
    addToStack(new ForNode(opts.count, indexVar, loopStack));
}

/**
 * Define a reusable WGSL function.
 *
 * `params` is an array of WgslDesc descriptors (e.g. `[vec2f(), f32()]`) giving
 * the WGSL parameter types. The JS callback receives typed Node handles and should
 * return a Node for the function's output (JS `return` = WGSL function return value).
 *
 * Returns a callable: when invoked with Node arguments it produces a CallNode
 * that calls the WGSL function.
 *
 * @example
 * const heatmap = Fn([vec2f()], (uv: Node<'vec2f'>): Node<'vec3f'> => {
 *     const result = toVar('vec3f', konst('vec3f', [0, 0, 0]))
 *     If(uv.x.gt(konst('f32', 0.5)), () => {
 *         result.assign(konst('vec3f', [1, 0, 0]))
 *     }).Else(() => {
 *         result.assign(konst('vec3f', [0, 0, 1]))
 *     })
 *     return result
 * })
 *
 * // Use it in a graph:
 * const color = heatmap(someUvNode)  // → CallNode<'vec3f'>
 */
export function Fn<T extends WgslType>(
    params: WgslDesc<WgslType>[],
    jsFunc: (...args: Node<WgslType>[]) => Node<T>,
): (...args: Node<WgslType>[]) => CallNode<T> {
    // Determine return type by doing a quick dry-run with dummy params to get the type.
    // We create the FnNode eagerly; the compiler will call trace() later for codegen.
    const dummyParams = params.map((d, i) => new ParamNode(d.wgslType, i));
    // We need the return type now. Trace once to get it.
    const traceStack = new StackNode();
    const prev = pushStack(traceStack);
    let returnType: T;
    try {
        const output = jsFunc(...dummyParams);
        returnType = output.type as T;
    } finally {
        popStack(prev);
    }

    const fnNode = new FnNode<T>(returnType, params, jsFunc);

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

export const vec2b  = (x = false, y = false):                    ConstNode<'vec2b'>  => new ConstNode('vec2b',  [x ? 1 : 0, y ? 1 : 0]);
export const vec3b  = (x = false, y = false, z = false):         ConstNode<'vec3b'>  => new ConstNode('vec3b',  [x ? 1 : 0, y ? 1 : 0, z ? 1 : 0]);
export const vec4b  = (x = false, y = false, z = false, w = false): ConstNode<'vec4b'>  => new ConstNode('vec4b',  [x ? 1 : 0, y ? 1 : 0, z ? 1 : 0, w ? 1 : 0]);

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
import { ArrayDesc, itemSizeOf, typedArrayCtorOf, WgslDesc } from './schema.js';

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
