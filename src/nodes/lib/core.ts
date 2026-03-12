import type { NodeFrame } from '../../renderer/node-frame';
import type { Any, WgslType, MulResultDesc, ArithResultDesc, CompareResultDesc, StructField, StructKeys, VecElementDesc, Vec2DescOf, Vec3DescOf, Vec4DescOf } from '../schema';
import { isStructDef } from '../schema';
import * as d from '../schema';

// ─── Types ────────────────────────────────────────────────────────────────────

// Re-export WgslType from schema for backwards compat in external files
export type { WgslType } from '../schema';

export type ScalarType = 'f32' | 'i32' | 'u32' | 'bool' | 'f16';
export type AtomicType = 'atomic<i32>' | 'atomic<u32>';

export type Vec2Type = 'vec2f' | 'vec2i' | 'vec2u' | 'vec2<bool>' | 'vec2h';
export type Vec3Type = 'vec3f' | 'vec3i' | 'vec3u' | 'vec3<bool>' | 'vec3h';
export type Vec4Type = 'vec4f' | 'vec4i' | 'vec4u' | 'vec4<bool>' | 'vec4h';
export type VecType = Vec2Type | Vec3Type | Vec4Type;

export type MatType = 'mat2x2f' | 'mat2x3f' | 'mat2x4f' | 'mat3x2f' | 'mat3x3f' | 'mat3x4f' | 'mat4x2f' | 'mat4x3f' | 'mat4x4f' |
    'mat2x2h' | 'mat2x3h' | 'mat2x4h' | 'mat3x2h' | 'mat3x3h' | 'mat3x4h' | 'mat4x2h' | 'mat4x3h' | 'mat4x4h';

export type NumericType = ScalarType | VecType | MatType;
export type SamplerType = 'sampler' | 'sampler_comparison';
export type TextureType = string;

export type GpuTypedArray = Float32Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array;

// ─── Type-level helpers (for return type inference) ───────────────────────────

export type VecElement<T extends VecType> = T extends 'vec2f' | 'vec3f' | 'vec4f' ? 'f32' : T extends 'vec2i' | 'vec3i' | 'vec4i' ? 'i32' : T extends 'vec2u' | 'vec3u' | 'vec4u' ? 'u32' : T extends 'vec2h' | 'vec3h' | 'vec4h' ? 'f16' : 'bool';

export type Vec2Of<E extends ScalarType> = E extends 'f32' ? 'vec2f' : E extends 'i32' ? 'vec2i' : E extends 'u32' ? 'vec2u' : E extends 'f16' ? 'vec2h' : 'vec2<bool>';
export type Vec3Of<E extends ScalarType> = E extends 'f32' ? 'vec3f' : E extends 'i32' ? 'vec3i' : E extends 'u32' ? 'vec3u' : E extends 'f16' ? 'vec3h' : 'vec3<bool>';
export type Vec4Of<E extends ScalarType> = E extends 'f32' ? 'vec4f' : E extends 'i32' ? 'vec4i' : E extends 'u32' ? 'vec4u' : E extends 'f16' ? 'vec4h' : 'vec4<bool>';

export type Swizzle1<T extends WgslType> = T extends VecType ? VecElement<T> : T extends ScalarType ? T : WgslType;
export type Swizzle2<T extends WgslType> = T extends VecType ? Vec2Of<VecElement<T>> : WgslType;
export type Swizzle3<T extends WgslType> = T extends VecType ? Vec3Of<VecElement<T>> : WgslType;
export type Swizzle4<T extends WgslType> = T extends VecType ? Vec4Of<VecElement<T>> : WgslType;

// ─── Descriptor-based math result types ───────────────────────────────────────

export type BinopOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '>' | '<=' | '>=' | '||' | '&&';

// ─── Node id utilities ────────────────────────────────────────────────────────

export let _nodeId = 0;

// ─── Runtime type lookup tables ───────────────────────────────────────────────

const VEC_ELEMENT: Record<string, ScalarType> = {
    vec2f: 'f32', vec3f: 'f32', vec4f: 'f32',
    vec2i: 'i32', vec3i: 'i32', vec4i: 'i32',
    vec2u: 'u32', vec3u: 'u32', vec4u: 'u32',
    vec2h: 'f16', vec3h: 'f16', vec4h: 'f16',
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

export const isVecType    = (t: string) => VEC_TYPES.has(t);
export const isMatType    = (t: string) => MAT_TYPES.has(t);
export const isScalarType = (t: string) => SCALAR_TYPES.has(t);

export function vecElementType(t: string): WgslType       { return (VEC_ELEMENT[t] ?? 'f32') as WgslType; }
export function vecElementTypeOrSelf(t: string): WgslType { return (VEC_ELEMENT[t] ?? t) as WgslType; }
export function vec2TypeOf(t: string): WgslType { const e = VEC_ELEMENT[t] ?? (SCALAR_TYPES.has(t) ? t : 'f32'); return (VEC2_OF[e] ?? 'vec2f') as WgslType; }
export function vec3TypeOf(t: string): WgslType { const e = VEC_ELEMENT[t] ?? (SCALAR_TYPES.has(t) ? t : 'f32'); return (VEC3_OF[e] ?? 'vec3f') as WgslType; }
export function vec4TypeOf(t: string): WgslType { const e = VEC_ELEMENT[t] ?? (SCALAR_TYPES.has(t) ? t : 'f32'); return (VEC4_OF[e] ?? 'vec4f') as WgslType; }

export function mulResultType(a: string, b: string): WgslType {
    if (MAT_TYPES.has(a)) return (VEC_TYPES.has(b) ? b : a) as WgslType;
    if (SCALAR_TYPES.has(b)) return a as WgslType;
    if (SCALAR_TYPES.has(a)) return b as WgslType;
    return a as WgslType;
}
export function arithResultType(a: string, b: string): WgslType {
    if (SCALAR_TYPES.has(a)) return (SCALAR_TYPES.has(b) ? a : b) as WgslType;
    return a as WgslType;
}

// ─── Stack context ────────────────────────────────────────────────────────────

let currentStack: StackNode | null = null;

export function pushStack(stack: StackNode): StackNode | null {
    const prev = currentStack;
    currentStack = stack;
    return prev;
}
export function popStack(prev: StackNode | null): void { currentStack = prev; }
export function addToStack(node: Node<Any>): void {
    if (currentStack === null) throw new Error(
        `[gpucat] Control flow (toVar, If, For, Return, Discard) must be called inside a Fn body. ` +
        `You are calling it outside of any Fn — wrap your code in Fn([...], () => { ... }).`
    );
    currentStack.push(node);
}

// ─── Node base class ──────────────────────────────────────────────────────────

export const NodeUpdateType = {
    NONE:   'none',
    FRAME:  'frame',
    RENDER: 'render',
    OBJECT: 'object',
} as const;
export type NodeUpdateType = (typeof NodeUpdateType)[keyof typeof NodeUpdateType];

export class Node<D extends Any> {
    readonly id: number;
    readonly type: D;

    _beforeNodes: Node<Any>[] | null = null;
    updateType: NodeUpdateType = NodeUpdateType.NONE;
    updateBeforeType: NodeUpdateType = NodeUpdateType.NONE;
    updateAfterType: NodeUpdateType = NodeUpdateType.NONE;
    global: boolean = false;
    parents: boolean = false;
    readonly isNode: boolean = true;
    update?: (frame: NodeFrame) => unknown;

    constructor(type: D) {
        this.id = _nodeId++;
        this.type = type;
    }

    onUpdate(callback: (frame: NodeFrame) => unknown, updateType: NodeUpdateType): this {
        this.updateType = updateType;
        this.update = callback;
        return this;
    }
    onRenderUpdate(callback: (frame: NodeFrame) => unknown): this { return this.onUpdate(callback, NodeUpdateType.RENDER); }
    onObjectUpdate(callback: (frame: NodeFrame) => unknown): this { return this.onUpdate(callback, NodeUpdateType.OBJECT); }

    before(node: Node<Any>): this {
        if (this._beforeNodes === null) this._beforeNodes = [];
        this._beforeNodes.push(node);
        return this;
    }

    // ── Type conversions ──────────────────────────────────────────────────────
    toF32(): Node<d.f32>  { return new CallNode(d.f32, 'f32', [this]); }
    toF16(): Node<d.f16>  { return new CallNode(d.f16, 'f16', [this]); }
    toU32(): Node<d.u32>  { return new CallNode(d.u32, 'u32', [this]); }
    toI32(): Node<d.i32>  { return new CallNode(d.i32, 'i32', [this]); }

    // ── Field access ──────────────────────────────────────────────────────────
    field<K extends StructKeys<D>>(name: K): Node<StructField<D, K>> {
        return field(this, name);
    }

    fields(): Fields<d.StructSchemaOf<D>> {
        return fields(this as unknown as Node<d.StructDesc<d.StructSchemaOf<D>>>);
    }

    // ── Comparisons ───────────────────────────────────────────────────────────
    greaterThan(b: Node<D>): Node<CompareResultDesc<D>>      { return greaterThan(this, b); }
    lessThan(b: Node<D>): Node<CompareResultDesc<D>>         { return lessThan(this, b); }
    greaterThanEqual(b: Node<D>): Node<CompareResultDesc<D>> { return greaterThanEqual(this, b); }
    lessThanEqual(b: Node<D>): Node<CompareResultDesc<D>>    { return lessThanEqual(this, b); }
    equal(b: Node<D>): Node<CompareResultDesc<D>>            { return equal(this, b); }
    notEqual(b: Node<D>): Node<CompareResultDesc<D>>         { return notEqual(this, b); }

    /** `select(falseVal, trueVal, this)` — use `this` node as the condition. */
    select<T extends Any>(ifTrue: Node<T>, ifFalse: Node<T>): Node<T> { return new CondNode(this as Node<Any>, ifTrue, ifFalse); }

    any(): Node<d.bool> { return any(this); }
    all(): Node<d.bool> { return all(this); }

    // ── Math ──────────────────────────────────────────────────────────────────
    add<N extends Node<Any>>(b: N): Node<ArithResultDesc<D, N['type']>>  { return add(this, b) as Node<ArithResultDesc<D, N['type']>>; }
    sub<N extends Node<Any>>(b: N): Node<ArithResultDesc<D, N['type']>>  { return sub(this, b) as Node<ArithResultDesc<D, N['type']>>; }
    div<N extends Node<Any>>(b: N): Node<ArithResultDesc<D, N['type']>>  { return div(this, b) as Node<ArithResultDesc<D, N['type']>>; }
    mul<N extends Node<Any>>(b: N): Node<MulResultDesc<D, N['type']>>    { return mul(this, b) as Node<MulResultDesc<D, N['type']>>; }
    abs(): Node<D>                                           { return abs(this) as Node<D>; }
    floor(): Node<D>                                         { return floor(this) as Node<D>; }
    ceil(): Node<D>                                          { return ceil(this) as Node<D>; }
    fract(): Node<D>                                         { return fract(this) as Node<D>; }
    sqrt(): Node<D>                                          { return sqrt(this) as Node<D>; }
    sin(): Node<D>                                           { return sin(this) as Node<D>; }
    cos(): Node<D>                                           { return cos(this) as Node<D>; }
    negate(): Node<D>                                        { return negate(this) as Node<D>; }
    normalize(): Node<D>                                     { return normalize(this) as Node<D>; }
    length(): Node<d.f32>                                    { return length(this); }
    dot(b: Node<D>): Node<d.f32>                             { return dot(this, b); }
    cross(b: Node<D>): Node<D>                               { return cross(this, b) as Node<D>; }
    pow(b: Node<D>): Node<D>                                 { return pow(this, b) as Node<D>; }
    max(b: Node<D>): Node<D>                                 { return max(this, b) as Node<D>; }
    min(b: Node<D>): Node<D>                                 { return min(this, b) as Node<D>; }
    clamp(lo: Node<D>, hi: Node<D>): Node<D>                 { return clamp(this, lo, hi) as Node<D>; }
    mix(b: Node<D>, t: Node<Any>): Node<D>                   { return mix(this, b, t) as Node<D>; }
    step(x: Node<D>): Node<D>                                { return step(this, x) as Node<D>; }
    smoothstep(hi: Node<D>, x: Node<D>): Node<D>             { return smoothstep(this, hi, x) as Node<D>; }

    // ── Element access ────────────────────────────────────────────────────────
    element(idx: Node<Any>): Node<d.ElementOf<D>> {
        const t = this.type;
        if (t.type === 'array' || t.type === 'sized-array') {
            return new IndexNode(t.element, this, idx) as unknown as Node<d.ElementOf<D>>;
        }
        if (d.isMatDesc(t)) {
            return new IndexNode(d.matColumnDesc(t), this, idx) as unknown as Node<d.ElementOf<D>>;
        }
        if (d.isVecDesc(t)) {
            return new IndexNode(d.vecElementDescOrSelf(t), this, idx) as unknown as Node<d.ElementOf<D>>;
        }
        throw new Error(`[gpucat] Cannot index into type '${t.wgslType}' — only array, matrix, and vector types support .element().`);
    }

    // ── Lang ──────────────────────────────────────────────────────────────────
    assign(value: Node<D>): void           { addToStack(new AssignNode(this, value)); }
    toVar(label?: string): VarNode<D>      { return Var(this, label); }
    toConst(label?: string): VarNode<D>    { return Const(this, label); }

    addAssign<N extends Node<Any>>(v: N): void { addToStack(new AssignNode(this, add(this, v) as unknown as Node<D>)); }
    subAssign<N extends Node<Any>>(v: N): void { addToStack(new AssignNode(this, sub(this, v) as unknown as Node<D>)); }
    mulAssign<N extends Node<Any>>(v: N): void { addToStack(new AssignNode(this, mul(this, v) as unknown as Node<D>)); }
    divAssign<N extends Node<Any>>(v: N): void { addToStack(new AssignNode(this, div(this, v) as unknown as Node<D>)); }

    sign(): Node<D>          { return sign(this) as Node<D>; }
    mod(b: Node<D>): Node<D> { return mod(this, b) as Node<D>; }

    oneMinus(): Node<D> { return sub(f32(1), this) as unknown as Node<D>; }

    or(b: Node<d.bool>): Node<d.bool>  { return or(this as unknown as Node<d.bool>, b); }
    and(b: Node<d.bool>): Node<d.bool> { return and(this as unknown as Node<d.bool>, b); }

    transpose(): Node<D> { return new CallNode(this.type, 'transpose', [this]) as unknown as Node<D>; }

    // ── Swizzles ──────────────────────────────────────────────────────────────
    get x(): Node<VecElementDesc<D>> { return new FieldNode(d.vecElementDescOrSelf(this.type), this, 'x') as unknown as Node<VecElementDesc<D>>; }
    get y(): Node<VecElementDesc<D>> { return new FieldNode(d.vecElementDescOrSelf(this.type), this, 'y') as unknown as Node<VecElementDesc<D>>; }
    get z(): Node<VecElementDesc<D>> { return new FieldNode(d.vecElementDescOrSelf(this.type), this, 'z') as unknown as Node<VecElementDesc<D>>; }
    get w(): Node<VecElementDesc<D>> { return new FieldNode(d.vecElementDescOrSelf(this.type), this, 'w') as unknown as Node<VecElementDesc<D>>; }
    get r(): Node<VecElementDesc<D>> { return new FieldNode(d.vecElementDescOrSelf(this.type), this, 'x') as unknown as Node<VecElementDesc<D>>; }
    get g(): Node<VecElementDesc<D>> { return new FieldNode(d.vecElementDescOrSelf(this.type), this, 'y') as unknown as Node<VecElementDesc<D>>; }
    get b(): Node<VecElementDesc<D>> { return new FieldNode(d.vecElementDescOrSelf(this.type), this, 'z') as unknown as Node<VecElementDesc<D>>; }
    get a(): Node<VecElementDesc<D>> { return new FieldNode(d.vecElementDescOrSelf(this.type), this, 'w') as unknown as Node<VecElementDesc<D>>; }

    get xx(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'xx') as unknown as Node<Vec2DescOf<D>>; }
    get xy(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'xy') as unknown as Node<Vec2DescOf<D>>; }
    get xz(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'xz') as unknown as Node<Vec2DescOf<D>>; }
    get xw(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'xw') as unknown as Node<Vec2DescOf<D>>; }
    get yx(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'yx') as unknown as Node<Vec2DescOf<D>>; }
    get yy(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'yy') as unknown as Node<Vec2DescOf<D>>; }
    get yz(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'yz') as unknown as Node<Vec2DescOf<D>>; }
    get yw(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'yw') as unknown as Node<Vec2DescOf<D>>; }
    get zx(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'zx') as unknown as Node<Vec2DescOf<D>>; }
    get zy(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'zy') as unknown as Node<Vec2DescOf<D>>; }
    get zz(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'zz') as unknown as Node<Vec2DescOf<D>>; }
    get zw(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'zw') as unknown as Node<Vec2DescOf<D>>; }
    get wx(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'wx') as unknown as Node<Vec2DescOf<D>>; }
    get wy(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'wy') as unknown as Node<Vec2DescOf<D>>; }
    get wz(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'wz') as unknown as Node<Vec2DescOf<D>>; }
    get ww(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'ww') as unknown as Node<Vec2DescOf<D>>; }
    get rr(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'xx') as unknown as Node<Vec2DescOf<D>>; }
    get rg(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'xy') as unknown as Node<Vec2DescOf<D>>; }
    get rb(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'xz') as unknown as Node<Vec2DescOf<D>>; }
    get ra(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'xw') as unknown as Node<Vec2DescOf<D>>; }
    get gr(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'yx') as unknown as Node<Vec2DescOf<D>>; }
    get gg(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'yy') as unknown as Node<Vec2DescOf<D>>; }
    get gb(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'yz') as unknown as Node<Vec2DescOf<D>>; }
    get ga(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'yw') as unknown as Node<Vec2DescOf<D>>; }
    get br(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'zx') as unknown as Node<Vec2DescOf<D>>; }
    get bg(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'zy') as unknown as Node<Vec2DescOf<D>>; }
    get bb(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'zz') as unknown as Node<Vec2DescOf<D>>; }
    get ba(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'zw') as unknown as Node<Vec2DescOf<D>>; }
    get ar(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'wx') as unknown as Node<Vec2DescOf<D>>; }
    get ag(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'wy') as unknown as Node<Vec2DescOf<D>>; }
    get ab(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'wz') as unknown as Node<Vec2DescOf<D>>; }
    get aa(): Node<Vec2DescOf<D>> { return new FieldNode(d.vec2DescOf(this.type), this, 'ww') as unknown as Node<Vec2DescOf<D>>; }

    get xxx(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xxx') as unknown as Node<Vec3DescOf<D>>; }
    get xxy(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xxy') as unknown as Node<Vec3DescOf<D>>; }
    get xxz(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xxz') as unknown as Node<Vec3DescOf<D>>; }
    get xxw(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xxw') as unknown as Node<Vec3DescOf<D>>; }
    get xyx(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xyx') as unknown as Node<Vec3DescOf<D>>; }
    get xyy(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xyy') as unknown as Node<Vec3DescOf<D>>; }
    get xyz(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xyz') as unknown as Node<Vec3DescOf<D>>; }
    get xyw(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xyw') as unknown as Node<Vec3DescOf<D>>; }
    get xzx(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xzx') as unknown as Node<Vec3DescOf<D>>; }
    get xzy(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xzy') as unknown as Node<Vec3DescOf<D>>; }
    get xzz(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xzz') as unknown as Node<Vec3DescOf<D>>; }
    get xzw(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xzw') as unknown as Node<Vec3DescOf<D>>; }
    get xwx(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xwx') as unknown as Node<Vec3DescOf<D>>; }
    get xwy(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xwy') as unknown as Node<Vec3DescOf<D>>; }
    get xwz(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xwz') as unknown as Node<Vec3DescOf<D>>; }
    get xww(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xww') as unknown as Node<Vec3DescOf<D>>; }
    get yxx(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yxx') as unknown as Node<Vec3DescOf<D>>; }
    get yxy(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yxy') as unknown as Node<Vec3DescOf<D>>; }
    get yxz(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yxz') as unknown as Node<Vec3DescOf<D>>; }
    get yxw(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yxw') as unknown as Node<Vec3DescOf<D>>; }
    get yyx(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yyx') as unknown as Node<Vec3DescOf<D>>; }
    get yyy(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yyy') as unknown as Node<Vec3DescOf<D>>; }
    get yyz(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yyz') as unknown as Node<Vec3DescOf<D>>; }
    get yyw(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yyw') as unknown as Node<Vec3DescOf<D>>; }
    get yzx(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yzx') as unknown as Node<Vec3DescOf<D>>; }
    get yzy(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yzy') as unknown as Node<Vec3DescOf<D>>; }
    get yzz(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yzz') as unknown as Node<Vec3DescOf<D>>; }
    get yzw(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yzw') as unknown as Node<Vec3DescOf<D>>; }
    get ywx(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'ywx') as unknown as Node<Vec3DescOf<D>>; }
    get ywy(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'ywy') as unknown as Node<Vec3DescOf<D>>; }
    get ywz(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'ywz') as unknown as Node<Vec3DescOf<D>>; }
    get yww(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yww') as unknown as Node<Vec3DescOf<D>>; }
    get zxx(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zxx') as unknown as Node<Vec3DescOf<D>>; }
    get zxy(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zxy') as unknown as Node<Vec3DescOf<D>>; }
    get zxz(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zxz') as unknown as Node<Vec3DescOf<D>>; }
    get zxw(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zxw') as unknown as Node<Vec3DescOf<D>>; }
    get zyx(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zyx') as unknown as Node<Vec3DescOf<D>>; }
    get zyy(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zyy') as unknown as Node<Vec3DescOf<D>>; }
    get zyz(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zyz') as unknown as Node<Vec3DescOf<D>>; }
    get zyw(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zyw') as unknown as Node<Vec3DescOf<D>>; }
    get zzx(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zzx') as unknown as Node<Vec3DescOf<D>>; }
    get zzy(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zzy') as unknown as Node<Vec3DescOf<D>>; }
    get zzz(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zzz') as unknown as Node<Vec3DescOf<D>>; }
    get zzw(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zzw') as unknown as Node<Vec3DescOf<D>>; }
    get zwx(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zwx') as unknown as Node<Vec3DescOf<D>>; }
    get zwy(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zwy') as unknown as Node<Vec3DescOf<D>>; }
    get zwz(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zwz') as unknown as Node<Vec3DescOf<D>>; }
    get zww(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zww') as unknown as Node<Vec3DescOf<D>>; }
    get wxx(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wxx') as unknown as Node<Vec3DescOf<D>>; }
    get wxy(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wxy') as unknown as Node<Vec3DescOf<D>>; }
    get wxz(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wxz') as unknown as Node<Vec3DescOf<D>>; }
    get wxw(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wxw') as unknown as Node<Vec3DescOf<D>>; }
    get wyx(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wyx') as unknown as Node<Vec3DescOf<D>>; }
    get wyy(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wyy') as unknown as Node<Vec3DescOf<D>>; }
    get wyz(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wyz') as unknown as Node<Vec3DescOf<D>>; }
    get wyw(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wyw') as unknown as Node<Vec3DescOf<D>>; }
    get wzx(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wzx') as unknown as Node<Vec3DescOf<D>>; }
    get wzy(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wzy') as unknown as Node<Vec3DescOf<D>>; }
    get wzz(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wzz') as unknown as Node<Vec3DescOf<D>>; }
    get wzw(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wzw') as unknown as Node<Vec3DescOf<D>>; }
    get wwx(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wwx') as unknown as Node<Vec3DescOf<D>>; }
    get wwy(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wwy') as unknown as Node<Vec3DescOf<D>>; }
    get wwz(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wwz') as unknown as Node<Vec3DescOf<D>>; }
    get www(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'www') as unknown as Node<Vec3DescOf<D>>; }
    get rrr(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xxx') as unknown as Node<Vec3DescOf<D>>; }
    get rrg(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xxy') as unknown as Node<Vec3DescOf<D>>; }
    get rrb(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xxz') as unknown as Node<Vec3DescOf<D>>; }
    get rra(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xxw') as unknown as Node<Vec3DescOf<D>>; }
    get rgr(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xyx') as unknown as Node<Vec3DescOf<D>>; }
    get rgg(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xyy') as unknown as Node<Vec3DescOf<D>>; }
    get rgb(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xyz') as unknown as Node<Vec3DescOf<D>>; }
    get rga(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xyw') as unknown as Node<Vec3DescOf<D>>; }
    get rbr(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xzx') as unknown as Node<Vec3DescOf<D>>; }
    get rbg(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xzy') as unknown as Node<Vec3DescOf<D>>; }
    get rbb(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xzz') as unknown as Node<Vec3DescOf<D>>; }
    get rba(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xzw') as unknown as Node<Vec3DescOf<D>>; }
    get rar(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xwx') as unknown as Node<Vec3DescOf<D>>; }
    get rag(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xwy') as unknown as Node<Vec3DescOf<D>>; }
    get rab(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xwz') as unknown as Node<Vec3DescOf<D>>; }
    get raa(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'xww') as unknown as Node<Vec3DescOf<D>>; }
    get grr(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yxx') as unknown as Node<Vec3DescOf<D>>; }
    get grg(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yxy') as unknown as Node<Vec3DescOf<D>>; }
    get grb(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yxz') as unknown as Node<Vec3DescOf<D>>; }
    get gra(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yxw') as unknown as Node<Vec3DescOf<D>>; }
    get ggr(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yyx') as unknown as Node<Vec3DescOf<D>>; }
    get ggg(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yyy') as unknown as Node<Vec3DescOf<D>>; }
    get ggb(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yyz') as unknown as Node<Vec3DescOf<D>>; }
    get gga(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yyw') as unknown as Node<Vec3DescOf<D>>; }
    get gbr(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yzx') as unknown as Node<Vec3DescOf<D>>; }
    get gbg(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yzy') as unknown as Node<Vec3DescOf<D>>; }
    get gbb(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yzz') as unknown as Node<Vec3DescOf<D>>; }
    get gba(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yzw') as unknown as Node<Vec3DescOf<D>>; }
    get gar(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'ywx') as unknown as Node<Vec3DescOf<D>>; }
    get gag(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'ywy') as unknown as Node<Vec3DescOf<D>>; }
    get gab(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'ywz') as unknown as Node<Vec3DescOf<D>>; }
    get gaa(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'yww') as unknown as Node<Vec3DescOf<D>>; }
    get brr(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zxx') as unknown as Node<Vec3DescOf<D>>; }
    get brg(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zxy') as unknown as Node<Vec3DescOf<D>>; }
    get brb(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zxz') as unknown as Node<Vec3DescOf<D>>; }
    get bra(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zxw') as unknown as Node<Vec3DescOf<D>>; }
    get bgr(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zyx') as unknown as Node<Vec3DescOf<D>>; }
    get bgg(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zyy') as unknown as Node<Vec3DescOf<D>>; }
    get bgb(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zyz') as unknown as Node<Vec3DescOf<D>>; }
    get bga(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zyw') as unknown as Node<Vec3DescOf<D>>; }
    get bbr(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zzx') as unknown as Node<Vec3DescOf<D>>; }
    get bbg(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zzy') as unknown as Node<Vec3DescOf<D>>; }
    get bbb(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zzz') as unknown as Node<Vec3DescOf<D>>; }
    get bba(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zzw') as unknown as Node<Vec3DescOf<D>>; }
    get bar(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zwx') as unknown as Node<Vec3DescOf<D>>; }
    get bag(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zwy') as unknown as Node<Vec3DescOf<D>>; }
    get bab(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zwz') as unknown as Node<Vec3DescOf<D>>; }
    get baa(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'zww') as unknown as Node<Vec3DescOf<D>>; }
    get arr(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wxx') as unknown as Node<Vec3DescOf<D>>; }
    get arg(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wxy') as unknown as Node<Vec3DescOf<D>>; }
    get arb(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wxz') as unknown as Node<Vec3DescOf<D>>; }
    get ara(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wxw') as unknown as Node<Vec3DescOf<D>>; }
    get agr(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wyx') as unknown as Node<Vec3DescOf<D>>; }
    get agg(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wyy') as unknown as Node<Vec3DescOf<D>>; }
    get agb(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wyz') as unknown as Node<Vec3DescOf<D>>; }
    get aga(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wyw') as unknown as Node<Vec3DescOf<D>>; }
    get abr(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wzx') as unknown as Node<Vec3DescOf<D>>; }
    get abg(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wzy') as unknown as Node<Vec3DescOf<D>>; }
    get abb(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wzz') as unknown as Node<Vec3DescOf<D>>; }
    get aba(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wzw') as unknown as Node<Vec3DescOf<D>>; }
    get aar(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wwx') as unknown as Node<Vec3DescOf<D>>; }
    get aag(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wwy') as unknown as Node<Vec3DescOf<D>>; }
    get aab(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'wwz') as unknown as Node<Vec3DescOf<D>>; }
    get aaa(): Node<Vec3DescOf<D>> { return new FieldNode(d.vec3DescOf(this.type), this, 'www') as unknown as Node<Vec3DescOf<D>>; }

    get xyzw(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'xyzw') as unknown as Node<Vec4DescOf<D>>; }
    get xywz(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'xywz') as unknown as Node<Vec4DescOf<D>>; }
    get xzyw(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'xzyw') as unknown as Node<Vec4DescOf<D>>; }
    get xzwy(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'xzwy') as unknown as Node<Vec4DescOf<D>>; }
    get xwyz(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'xwyz') as unknown as Node<Vec4DescOf<D>>; }
    get xwzy(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'xwzy') as unknown as Node<Vec4DescOf<D>>; }
    get yxzw(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'yxzw') as unknown as Node<Vec4DescOf<D>>; }
    get yxwz(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'yxwz') as unknown as Node<Vec4DescOf<D>>; }
    get yzxw(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'yzxw') as unknown as Node<Vec4DescOf<D>>; }
    get yzwx(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'yzwx') as unknown as Node<Vec4DescOf<D>>; }
    get ywxz(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'ywxz') as unknown as Node<Vec4DescOf<D>>; }
    get ywzx(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'ywzx') as unknown as Node<Vec4DescOf<D>>; }
    get zxyw(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'zxyw') as unknown as Node<Vec4DescOf<D>>; }
    get zxwy(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'zxwy') as unknown as Node<Vec4DescOf<D>>; }
    get zyxw(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'zyxw') as unknown as Node<Vec4DescOf<D>>; }
    get zywx(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'zywx') as unknown as Node<Vec4DescOf<D>>; }
    get zwxy(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'zwxy') as unknown as Node<Vec4DescOf<D>>; }
    get zwyx(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'zwyx') as unknown as Node<Vec4DescOf<D>>; }
    get wxyz(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'wxyz') as unknown as Node<Vec4DescOf<D>>; }
    get wxzy(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'wxzy') as unknown as Node<Vec4DescOf<D>>; }
    get wyxz(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'wyxz') as unknown as Node<Vec4DescOf<D>>; }
    get wyzx(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'wyzx') as unknown as Node<Vec4DescOf<D>>; }
    get wzxy(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'wzxy') as unknown as Node<Vec4DescOf<D>>; }
    get wzyx(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'wzyx') as unknown as Node<Vec4DescOf<D>>; }
    get rgba(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'xyzw') as unknown as Node<Vec4DescOf<D>>; }
    get rgab(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'xywz') as unknown as Node<Vec4DescOf<D>>; }
    get rbga(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'xzyw') as unknown as Node<Vec4DescOf<D>>; }
    get rbag(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'xzwy') as unknown as Node<Vec4DescOf<D>>; }
    get ragb(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'xwyz') as unknown as Node<Vec4DescOf<D>>; }
    get rabg(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'xwzy') as unknown as Node<Vec4DescOf<D>>; }
    get grba(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'yxzw') as unknown as Node<Vec4DescOf<D>>; }
    get grab(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'yxwz') as unknown as Node<Vec4DescOf<D>>; }
    get gbra(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'yzxw') as unknown as Node<Vec4DescOf<D>>; }
    get gbar(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'yzwx') as unknown as Node<Vec4DescOf<D>>; }
    get garb(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'ywxz') as unknown as Node<Vec4DescOf<D>>; }
    get gabr(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'ywzx') as unknown as Node<Vec4DescOf<D>>; }
    get brga(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'zxyw') as unknown as Node<Vec4DescOf<D>>; }
    get brag(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'zxwy') as unknown as Node<Vec4DescOf<D>>; }
    get bgra(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'zyxw') as unknown as Node<Vec4DescOf<D>>; }
    get bgar(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'zywx') as unknown as Node<Vec4DescOf<D>>; }
    get barg(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'zwxy') as unknown as Node<Vec4DescOf<D>>; }
    get bagr(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'zwyx') as unknown as Node<Vec4DescOf<D>>; }
    get argb(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'wxyz') as unknown as Node<Vec4DescOf<D>>; }
    get arbg(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'wxzy') as unknown as Node<Vec4DescOf<D>>; }
    get agrb(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'wyxz') as unknown as Node<Vec4DescOf<D>>; }
    get agbr(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'wyzx') as unknown as Node<Vec4DescOf<D>>; }
    get abrg(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'wzxy') as unknown as Node<Vec4DescOf<D>>; }
    get abgr(): Node<Vec4DescOf<D>> { return new FieldNode(d.vec4DescOf(this.type), this, 'wzyx') as unknown as Node<Vec4DescOf<D>>; }

    // ── Inspector ─────────────────────────────────────────────────────────────
    inspect(name?: string): this {
        const inspector = new InspectorNode<Any>(this, name);
        this.before(inspector);
        return this;
    }
}

export function isNode(v: unknown): v is Node<Any> { return v instanceof Node; }

// ─── InspectorNode ────────────────────────────────────────────────────────────

/**
 * InspectorNode wraps a node and registers it with the inspector every frame.
 *
 * Instead of flagging nodes with _isInspectable and manually iterating in the renderer,
 * InspectorNode leverages the existing node update system (updateType = FRAME) to
 * automatically call inspector.inspect() every frame.
 *
 * Key properties:
 * - `wrappedNode`: The original node being inspected
 * - `inspectorName`: Display name for the inspector UI
 * - `updateType = FRAME`: Ensures update() is called once per frame
 *
 * Usage:
 *   const albedo = texture('texture_2d<f32>', 'albedo').inspect('Albedo');
 *
 * The .inspect() method on Node creates an InspectorNode wrapper and attaches it
 * via node.before(), so it gets built and updated alongside the original node.
 */
export class InspectorNode<D extends Any> extends Node<D> {
    /** The original node being inspected. */
    readonly wrappedNode: Node<D>;

    /** Display name for the inspector UI. */
    readonly inspectorName: string;

    /** Marker for type checking. */
    readonly isInspectorNode = true;

    constructor(node: Node<D>, name?: string) {
        super(node.type);

        this.wrappedNode = node;
        this.inspectorName = name ?? String(node.id);

        // Key: use the FRAME update type so update() is called every frame
        this.updateType = NodeUpdateType.FRAME;
    }

    /**
     * Called by the node update system every frame.
     * Registers this node with the renderer's inspector.
     */
    override update = (frame: NodeFrame): void => {
        frame.renderer!.inspector.inspect(this as unknown as InspectorNode<Any>);
    };

    /**
     * Returns the display name for the inspector.
     */
    getName(): string {
        return this.inspectorName;
    }
}

// ─── Expr nodes ───────────────────────────────────────────────────────────────

export class ConstNode<D extends Any> extends Node<D> {
    constructor(type: D, readonly value: number | number[] | string) {
        super(type);
    }
}

export class VarNode<D extends Any> extends Node<D> {
    constructor(
        type: D,
        readonly varName: string,
        readonly init: Node<D>,
        readonly isConst: boolean = false
    ) {
        super(type);
    }
}

export class AssignNode extends Node<d.VoidDesc> {
    constructor(readonly target: Node<Any>, readonly value: Node<Any>) {
        super(d.voidDesc);
    }
}

export class BinopNode<D extends Any> extends Node<D> {
    constructor(
        readonly op: BinopOp,
        type: D,
        readonly left: Node<Any>,
        readonly right: Node<Any>
    ) {
        super(type);
    }
}

/** Opaque reference to WgslFunctionNode to avoid circular import */
export interface WgslFunctionNodeRef {
    readonly code: string;
    readonly includes: WgslFunctionNodeRef[];
    getNodeFunction(): { outputType: string; name: string };
}

export class CallNode<D extends Any> extends Node<D> {
    readonly fnNode?: FnNode<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    readonly wgslFnNode?: WgslFunctionNodeRef;
    constructor(type: D, readonly fn: string, readonly args: Node<Any>[], fnNode?: FnNode<any>, wgslFnNode?: WgslFunctionNodeRef) {
        super(type);
        this.fnNode = fnNode;
        this.wgslFnNode = wgslFnNode;
    }
}

export class ConstructNode<D extends Any> extends Node<D> {
    constructor(type: D, readonly args: Node<Any>[]) {
        super(type);
    }
}

export class FieldNode<D extends Any> extends Node<D> {
    constructor(type: D, readonly object: Node<Any>, readonly fieldName: string) {
        super(type);
    }
}

/**
 * Represents an inline fixed-size array expression in WGSL.
 *
 * Use `array([e0, e1, e2])` to construct, then `.element(idx)` to index into it.
 * This corresponds to WGSL's array value constructor expression.
 */
export class ArrayNode<E extends Any> extends Node<{ readonly type: 'sized-array'; readonly wgslType: `array<${string}, ${number}>`; readonly element: E; readonly length: number }> {
    readonly elements: Node<E>[];
    constructor(elementType: E, elements: Node<E>[]) {
        const sizedArrayDesc = {
            type: 'sized-array' as const,
            wgslType: `array<${elementType.wgslType}, ${elements.length}>` as const,
            element: elementType,
            length: elements.length,
        };
        super(sizedArrayDesc);
        this.elements = elements;
    }
}

export class IndexNode<D extends Any> extends Node<D> {
    constructor(type: D, readonly array: Node<Any>, readonly index: Node<Any>) {
        super(type);
    }
}

// ── Standalone expr functions ─────────────────────────────────────────────────

/** Type-safe field access for structs - infers the field type from the struct descriptor */
export const field = <D extends Any, K extends StructKeys<D>>(node: Node<D>, name: K): Node<StructField<D, K>> => {
    const structDesc = node.type as d.StructDesc;
    const fieldType = structDesc.fields[name as string];
    return new FieldNode(fieldType, node, name as string) as unknown as Node<StructField<D, K>>;
};

export const index = <N extends Node<Any>>(
    array: N, idx: Node<Any>
): Node<d.ElementOf<N["type"]>> => {
    const t = array.type;
    let elementDesc: Any;
    if (t.type === 'array' || t.type === 'sized-array') {
        elementDesc = t.element;
    } else if (d.isMatDesc(t)) {
        elementDesc = d.matColumnDesc(t);
    } else if (d.isVecDesc(t)) {
        elementDesc = d.vecElementDescOrSelf(t);
    } else {
        throw new Error(`[gpucat] Cannot index into type '${t.wgslType}' — only array, matrix, and vector types support indexing.`);
    }
    return new IndexNode(elementDesc, array, idx) as unknown as Node<d.ElementOf<N["type"]>>;
};

/** Type for field accessor object returned by fields() */
export type Fields<S extends d.StructSchema> = { readonly [K in keyof S]: Node<S[K]> };

/**
 * Create field accessor object for a struct node.
 * Returns an object with typed Node properties for each field.
 * 
 * @example
 * const particle = index(particleBuffer, computeIndex);
 * const { position, velocity } = fields(particle);
 * position.assign(newPos);
 */
export function fields<S extends d.StructSchema>(node: Node<StructDef<S>>): Fields<S>;
export function fields<S extends d.StructSchema>(node: Node<d.StructDesc<S>>): Fields<S>;
export function fields(node: Node<Any>): Record<string, Node<Any>> {
    const desc = node.type;
    if (!desc || typeof desc !== 'object' || !('fields' in desc)) {
        throw new Error('[gpucat] fields() requires a struct-typed node');
    }
    const structFields = (desc as { fields: d.StructSchema }).fields;
    const result: Record<string, Node<Any>> = {};
    for (const [fieldName, fieldDesc] of Object.entries(structFields)) {
        result[fieldName] = new FieldNode(fieldDesc as Any, node, fieldName);
    }
    return result;
}

export const toF32  = <D extends Any>(node: Node<D>): Node<d.f32> => new CallNode(d.f32, 'f32', [node]);
export const toF16  = <D extends Any>(node: Node<D>): Node<d.f16> => new CallNode(d.f16, 'f16', [node]);
export const toU32  = <D extends Any>(node: Node<D>): Node<d.u32> => new CallNode(d.u32, 'u32', [node]);
export const toI32  = <D extends Any>(node: Node<D>): Node<d.i32> => new CallNode(d.i32, 'i32', [node]);

export const greaterThan      = <D extends Any>(a: Node<D>, b: Node<D>): Node<CompareResultDesc<D>> => new BinopNode('>', d.compareResultDesc(a.type), a, b) as unknown as Node<CompareResultDesc<D>>;
export const lessThan         = <D extends Any>(a: Node<D>, b: Node<D>): Node<CompareResultDesc<D>> => new BinopNode('<', d.compareResultDesc(a.type), a, b) as unknown as Node<CompareResultDesc<D>>;
export const greaterThanEqual = <D extends Any>(a: Node<D>, b: Node<D>): Node<CompareResultDesc<D>> => new BinopNode('>=', d.compareResultDesc(a.type), a, b) as unknown as Node<CompareResultDesc<D>>;
export const lessThanEqual    = <D extends Any>(a: Node<D>, b: Node<D>): Node<CompareResultDesc<D>> => new BinopNode('<=', d.compareResultDesc(a.type), a, b) as unknown as Node<CompareResultDesc<D>>;
export const equal            = <D extends Any>(a: Node<D>, b: Node<D>): Node<CompareResultDesc<D>> => new BinopNode('==', d.compareResultDesc(a.type), a, b) as unknown as Node<CompareResultDesc<D>>;
export const notEqual         = <D extends Any>(a: Node<D>, b: Node<D>): Node<CompareResultDesc<D>> => new BinopNode('!=', d.compareResultDesc(a.type), a, b) as unknown as Node<CompareResultDesc<D>>;

export const any = <D extends Any>(a: Node<D>): Node<d.bool> => new CallNode(d.bool, 'any', [a]);
export const all = <D extends Any>(a: Node<D>): Node<d.bool> => new CallNode(d.bool, 'all', [a]);

/**
 * Create an inline fixed-size array of nodes, emitted as `array<E, N>(e0, e1, ..., eN-1)`.
 * All elements must share the same WGSL type.
 * Use `.element(idx)` to index into the result.
 *
 * @example
 * const weights = array([w0, w1, w2]);
 * const w = weights.element(gx);
 */
export function array<E extends Any>(elements: [Node<E>, ...Node<E>[]]): Node<{ readonly type: 'sized-array'; readonly wgslType: `array<${string}, ${number}>`; readonly element: E; readonly length: number }> {
    return new ArrayNode(elements[0].type, elements) as unknown as Node<{ readonly type: 'sized-array'; readonly wgslType: `array<${string}, ${number}>`; readonly element: E; readonly length: number }>;
}

// ── Const constructors ────────────────────────────────────────────────────────

export function f32(v?: number): ConstNode<d.f32>;
export function f32(v: Node<Any>): Node<d.f32>;
export function f32(v: number | Node<Any> = 0): ConstNode<d.f32> | Node<d.f32> {
    if (isNode(v)) return new CallNode(d.f32, 'f32', [v]);
    return new ConstNode(d.f32, v);
}

export function f16(v?: number): ConstNode<d.f16>;
export function f16(v: Node<Any>): Node<d.f16>;
export function f16(v: number | Node<Any> = 0): ConstNode<d.f16> | Node<d.f16> {
    if (isNode(v)) return new CallNode(d.f16, 'f16', [v]);
    return new ConstNode(d.f16, v);
}

export function i32(v?: number): ConstNode<d.i32>;
export function i32(v: Node<Any>): Node<d.i32>;
export function i32(v: number | Node<Any> = 0): ConstNode<d.i32> | Node<d.i32> {
    if (isNode(v)) return new CallNode(d.i32, 'i32', [v]);
    return new ConstNode(d.i32, Math.trunc(v as number));
}

export function u32(v?: number): ConstNode<d.u32>;
export function u32(v: Node<Any>): Node<d.u32>;
export function u32(v: number | Node<Any> = 0): ConstNode<d.u32> | Node<d.u32> {
    if (isNode(v)) return new CallNode(d.u32, 'u32', [v]);
    return new ConstNode(d.u32, Math.trunc(v as number));
}

export const bool = (v: boolean): ConstNode<d.bool> => new ConstNode(d.bool, v ? 1 : 0);

type Scalar = Node<Any> | number | boolean;
type ScalarElemType = 'f32' | 'f16' | 'i32' | 'u32' | 'bool';

function wrapScalar(v: Scalar, elemType: ScalarElemType): Node<Any> {
    if (isNode(v)) return v;
    if (elemType === 'bool') return new ConstNode(d.bool, (v as boolean | number) ? 1 : 0);
    if (elemType === 'i32')  return new ConstNode(d.i32, Math.trunc(v as number));
    if (elemType === 'u32')  return new ConstNode(d.u32, Math.trunc(v as number));
    if (elemType === 'f16')  return new ConstNode(d.f16, v as number);
    return new ConstNode(d.f32, v as number);
}
function elemOf(type: Vec2Type | Vec3Type | Vec4Type): ScalarElemType {
    if (type.endsWith('h')) return 'f16';
    if (type.endsWith('f')) return 'f32';
    if (type.endsWith('i')) return 'i32';
    if (type.endsWith('u')) return 'u32';
    return 'bool';
}

export function makeVec2<D extends d.Vec2Desc>(desc: D) {
    const e = elemOf(desc.wgslType);
    function ctor(v: Scalar): ConstructNode<D>;
    function ctor(x: Scalar, y: Scalar): ConstructNode<D>;
    function ctor(a: Scalar, b?: Scalar): ConstructNode<D> {
        if (b === undefined) return new ConstructNode(desc, [wrapScalar(a, e)]);
        return new ConstructNode(desc, [wrapScalar(a, e), wrapScalar(b, e)]);
    }
    return ctor;
}
export function makeVec3<D extends d.Vec3Desc>(desc: D) {
    const e = elemOf(desc.wgslType);
    function ctor(v: Scalar): ConstructNode<D>;
    function ctor(xy: Node<Any>, z: Scalar): ConstructNode<D>;
    function ctor(x: Scalar, y: Scalar, z: Scalar): ConstructNode<D>;
    function ctor(a: Scalar, b?: Scalar, c?: Scalar): ConstructNode<D> {
        if (b === undefined) return new ConstructNode(desc, [wrapScalar(a, e)]);
        if (c === undefined) return new ConstructNode(desc, [wrapScalar(a, e), wrapScalar(b, e)]);
        return new ConstructNode(desc, [wrapScalar(a, e), wrapScalar(b, e), wrapScalar(c, e)]);
    }
    return ctor;
}
export function makeVec4<D extends d.Vec4Desc>(desc: D) {
    const e = elemOf(desc.wgslType);
    function ctor(v: Scalar): ConstructNode<D>;
    function ctor(xy: Node<Any>, zw: Node<Any>): ConstructNode<D>;
    function ctor(xy: Node<Any>, z: Scalar, w: Scalar): ConstructNode<D>;
    function ctor(xyz: Node<Any>, w: Scalar): ConstructNode<D>;
    function ctor(x: Scalar, y: Scalar, z: Scalar, w: Scalar): ConstructNode<D>;
    function ctor(a: Scalar, b?: Scalar, c?: Scalar, dVal?: Scalar): ConstructNode<D> {
        if (b === undefined) return new ConstructNode(desc, [wrapScalar(a, e)]);
        if (c === undefined) return new ConstructNode(desc, [wrapScalar(a, e), wrapScalar(b, e)]);
        if (dVal === undefined) return new ConstructNode(desc, [wrapScalar(a, e), wrapScalar(b, e), wrapScalar(c, e)]);
        return new ConstructNode(desc, [wrapScalar(a, e), wrapScalar(b, e), wrapScalar(c, e), wrapScalar(dVal, e)]);
    }
    return ctor;
}

export const vec2  = makeVec2(d.vec2f);
export const vec3  = makeVec3(d.vec3f);
export const vec4  = makeVec4(d.vec4f);
export const vec2f = makeVec2(d.vec2f);
export const vec3f = makeVec3(d.vec3f);
export const vec4f = makeVec4(d.vec4f);
export const vec2i = makeVec2(d.vec2i);
export const vec3i = makeVec3(d.vec3i);
export const vec4i = makeVec4(d.vec4i);
export const vec2u = makeVec2(d.vec2u);
export const vec3u = makeVec3(d.vec3u);
export const vec4u = makeVec4(d.vec4u);
export const vec2h = makeVec2(d.vec2h);
export const vec3h = makeVec3(d.vec3h);
export const vec4h = makeVec4(d.vec4h);
export const vec2b = makeVec2(d.vec2bool);
export const vec3b = makeVec3(d.vec3bool);
export const vec4b = makeVec4(d.vec4bool);

export const mat2x2f = (...v: number[]): ConstNode<d.mat2x2f> => new ConstNode(d.mat2x2f, v.length ? v : []);
export const mat2x3f = (...v: number[]): ConstNode<d.mat2x3f> => new ConstNode(d.mat2x3f, v.length ? v : []);
export const mat2x4f = (...v: number[]): ConstNode<d.mat2x4f> => new ConstNode(d.mat2x4f, v.length ? v : []);
export const mat3x2f = (...v: number[]): ConstNode<d.mat3x2f> => new ConstNode(d.mat3x2f, v.length ? v : []);
export const mat3x3f = (...v: number[]): ConstNode<d.mat3x3f> => new ConstNode(d.mat3x3f, v.length ? v : []);
export const mat3x4f = (...v: number[]): ConstNode<d.mat3x4f> => new ConstNode(d.mat3x4f, v.length ? v : []);
export const mat4x2f = (...v: number[]): ConstNode<d.mat4x2f> => new ConstNode(d.mat4x2f, v.length ? v : []);
export const mat4x3f = (...v: number[]): ConstNode<d.mat4x3f> => new ConstNode(d.mat4x3f, v.length ? v : []);
export const mat4x4f = (...v: number[]): ConstNode<d.mat4x4f> => new ConstNode(d.mat4x4f, v.length ? v : []);
export const mat2x2h = (...v: number[]): ConstNode<d.mat2x2h> => new ConstNode(d.mat2x2h, v.length ? v : []);
export const mat2x3h = (...v: number[]): ConstNode<d.mat2x3h> => new ConstNode(d.mat2x3h, v.length ? v : []);
export const mat2x4h = (...v: number[]): ConstNode<d.mat2x4h> => new ConstNode(d.mat2x4h, v.length ? v : []);
export const mat3x2h = (...v: number[]): ConstNode<d.mat3x2h> => new ConstNode(d.mat3x2h, v.length ? v : []);
export const mat3x3h = (...v: number[]): ConstNode<d.mat3x3h> => new ConstNode(d.mat3x3h, v.length ? v : []);
export const mat3x4h = (...v: number[]): ConstNode<d.mat3x4h> => new ConstNode(d.mat3x4h, v.length ? v : []);
export const mat4x2h = (...v: number[]): ConstNode<d.mat4x2h> => new ConstNode(d.mat4x2h, v.length ? v : []);
export const mat4x3h = (...v: number[]): ConstNode<d.mat4x3h> => new ConstNode(d.mat4x3h, v.length ? v : []);
export const mat4x4h = (...v: number[]): ConstNode<d.mat4x4h> => new ConstNode(d.mat4x4h, v.length ? v : []);

export const mat4 = (c0: Node<d.Vec4Desc>, c1: Node<d.Vec4Desc>, c2: Node<d.Vec4Desc>, c3: Node<d.Vec4Desc>) => new ConstructNode(d.mat4x4f, [c0, c1, c2, c3]);
export function mat3(c0: Node<d.Vec3Desc>, c1: Node<d.Vec3Desc>, c2: Node<d.Vec3Desc>): Node<d.mat3x3f>;
export function mat3(diag: Node<d.f32>): Node<d.mat3x3f>;
export function mat3(
    s00: Node<d.f32>, s01: Node<d.f32>, s02: Node<d.f32>,
    s10: Node<d.f32>, s11: Node<d.f32>, s12: Node<d.f32>,
    s20: Node<d.f32>, s21: Node<d.f32>, s22: Node<d.f32>
): Node<d.mat3x3f>;
export function mat3(
    c0: Node<d.Vec3Desc> | Node<d.f32>,
    c1?: Node<d.Vec3Desc> | Node<d.f32>,
    c2?: Node<d.Vec3Desc> | Node<d.f32>,
    s10?: Node<d.f32>, s11?: Node<d.f32>, s12?: Node<d.f32>,
    s20?: Node<d.f32>, s21?: Node<d.f32>, s22?: Node<d.f32>
): Node<d.mat3x3f> {
    // 9-scalar overload: mat3x3f(s00..s22) — column-major scalars
    if (s10 !== undefined) {
        return new ConstructNode(d.mat3x3f, [c0, c1!, c2!, s10, s11!, s12!, s20!, s21!, s22!]);
    }
    // 3-column overload
    if (c1 !== undefined && c2 !== undefined) {
        return new ConstructNode(d.mat3x3f, [c0, c1, c2]);
    }
    // scalar diagonal: expand to 9 scalars (WGSL has no single-scalar matrix constructor)
    const z = new ConstNode(d.f32, 0);
    return new ConstructNode(d.mat3x3f, [c0, z, z, z, c0, z, z, z, c0]);
}

// ── Standalone math functions ─────────────────────────────────────────────────

export const add        = <NA extends Node<Any>, NB extends Node<Any>>(a: NA, b: NB): Node<ArithResultDesc<NA['type'], NB['type']>> => new BinopNode('+', d.arithResultDesc(a.type, b.type), a, b) as unknown as Node<ArithResultDesc<NA['type'], NB['type']>>;
export const sub        = <NA extends Node<Any>, NB extends Node<Any>>(a: NA, b: NB): Node<ArithResultDesc<NA['type'], NB['type']>> => new BinopNode('-', d.arithResultDesc(a.type, b.type), a, b) as unknown as Node<ArithResultDesc<NA['type'], NB['type']>>;
export const div        = <NA extends Node<Any>, NB extends Node<Any>>(a: NA, b: NB): Node<ArithResultDesc<NA['type'], NB['type']>> => new BinopNode('/', d.arithResultDesc(a.type, b.type), a, b) as unknown as Node<ArithResultDesc<NA['type'], NB['type']>>;
export const mul        = <NA extends Node<Any>, NB extends Node<Any>>(a: NA, b: NB): Node<MulResultDesc<NA['type'], NB['type']>> => new BinopNode('*', d.mulResultDesc(a.type, b.type), a, b) as unknown as Node<MulResultDesc<NA['type'], NB['type']>>;
export const dot        = (a: Node<Any>, b: Node<Any>): Node<d.f32> => new CallNode(d.f32, 'dot', [a, b]);
export const cross      = <D extends Any>(a: Node<D>, b: Node<D>): Node<D> => new CallNode(a.type, 'cross', [a, b]);
export const normalize  = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'normalize', [a]);
export const length     = (a: Node<Any>): Node<d.f32> => new CallNode(d.f32, 'length', [a]);
export const abs        = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'abs', [a]);
export const floor      = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'floor', [a]);
export const ceil       = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'ceil', [a]);
export const fract      = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'fract', [a]);
export const sqrt       = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'sqrt', [a]);
export const sin        = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'sin', [a]);
export const cos        = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'cos', [a]);
export const negate     = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'negate', [a]);
export const pow        = <D extends Any>(a: Node<D>, b: Node<D>): Node<D> => new CallNode(a.type, 'pow', [a, b]);
export const max        = <D extends Any>(a: Node<D>, b: Node<D>): Node<D> => new CallNode(a.type, 'max', [a, b]);
export const min        = <D extends Any>(a: Node<D>, b: Node<D>): Node<D> => new CallNode(a.type, 'min', [a, b]);
export const clamp      = <D extends Any>(a: Node<D>, lo: Node<D>, hi: Node<D>): Node<D> => new CallNode(a.type, 'clamp', [a, lo, hi]);
export const mix        = <D extends Any>(a: Node<D>, b: Node<D>, t: Node<Any>): Node<D> => new CallNode(a.type, 'mix', [a, b, t]);
export const step       = <D extends Any>(edge: Node<D>, x: Node<D>): Node<D> => new CallNode(x.type, 'step', [edge, x]);
export const smoothstep = <D extends Any>(lo: Node<D>, hi: Node<D>, x: Node<D>): Node<D> => new CallNode(x.type, 'smoothstep', [lo, hi, x]);
export const sign       = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'sign', [a]);
export const mod        = <D extends Any>(a: Node<D>, b: Node<D>): Node<D> => new BinopNode('%', a.type, a, b);
export const or         = (a: Node<d.bool>, b: Node<d.bool>): Node<d.bool> => new BinopNode('||', d.bool, a, b);
export const and        = (a: Node<d.bool>, b: Node<d.bool>): Node<d.bool> => new BinopNode('&&', d.bool, a, b);
export const transpose  = <D extends d.MatDesc>(m: Node<D>): Node<D> => new CallNode(m.type, 'transpose', [m]);

// ── Lang ──────────────────────────────────────────────────────────────────────

export class StackNode extends Node<d.VoidDesc> {
    readonly body: Node<Any>[];
    constructor(initial?: Node<Any>[]) {
        super(d.voidDesc);
        this.body = initial ? [...initial] : [];
    }
    push(node: Node<Any>): void { this.body.push(node); }
}

export class FnNode<D extends Any> extends Node<D> {
    readonly fnName: string;
    readonly paramDescs: (ParamDesc | Any)[];
    readonly jsFunc: (...args: Node<Any>[]) => Node<D>;

    constructor(
        returnType: D,
        paramDescs: (ParamDesc | Any)[],
        jsFunc: (...args: Node<Any>[]) => Node<D>,
        fnName?: string
    ) {
        super(returnType);
        this.fnName = fnName ?? `fn_${this.id}`;
        this.paramDescs = paramDescs;
        this.jsFunc = jsFunc;
    }

    compute(opts: ComputeOptions): ComputeNode { return new ComputeNode({ fn: this, ...opts }); }

    trace(): { params: ParamNode<Any>[]; body: StackNode; output: Node<D> } {
        const params = this.paramDescs.map((pd, i) => {
            const paramName = 'name' in pd ? (pd as ParamDesc).name : undefined;
            const desc = 'name' in pd ? (pd as ParamDesc).type : (pd as Any);
            return new ParamNode(desc, i, paramName);
        });
        const stack = new StackNode();
        const prev = pushStack(stack);
        let output: Node<D>;
        try { output = this.jsFunc(...params); } finally { popStack(prev); }
        return { params, body: stack, output };
    }
}

export class ParamNode<D extends Any> extends Node<D> {
    constructor(type: D, readonly paramIndex: number, readonly paramName?: string) {
        super(type);
    }
}

export class ReturnNode<D extends Any> extends Node<D> {
    constructor(readonly value: Node<D>) { super(value.type); }
}

export class CondNode<D extends Any> extends Node<D> {
    readonly ifFalse?: Node<Any>;
    constructor(readonly condition: Node<Any>, readonly ifTrue: Node<D>, ifFalse?: Node<D>) {
        super(ifTrue.type);
        this.ifFalse = ifFalse;
    }
}

export type ElseIfBranch = { condition: Node<Any>; body: StackNode; };

export class IfNode extends Node<d.VoidDesc> {
    elseIfBranches: ElseIfBranch[] = [];
    elseBody: StackNode | null = null;
    constructor(readonly condition: Node<Any>, readonly thenBody: StackNode) {
        super(d.voidDesc);
    }
}

export type LoopParam = Node<Any> | number | {
    start?: Node<Any> | number;
    end?: Node<Any> | number;
    type?: d.ScalarDesc;
    condition?: '<' | '<=' | '>' | '>=';
    update?: Node<Any> | number | string | ((...args: unknown[]) => void);
    name?: string;
};

let _loopVarCounter = 0;

export class LoopNode extends Node<d.VoidDesc> {
    constructor(
        readonly config: LoopParam,
        readonly loopVar: ParamNode<Any>,
        readonly callbackKey: string,
        readonly body: StackNode
    ) {
        super(d.voidDesc);
    }
}

export class BreakNode    extends Node<d.VoidDesc> { constructor() { super(d.voidDesc); } }
export class ContinueNode extends Node<d.VoidDesc> { constructor() { super(d.voidDesc); } }
export class DiscardNode  extends Node<d.VoidDesc> { constructor() { super(d.voidDesc); } }

export type IfChain = {
    ElseIf(condition: Node<Any>, body: () => void): IfChain;
    Else(body: () => void): IfChain;
};

export function If(condition: Node<Any>, thenBody: () => void): IfChain {
    const thenStack = new StackNode();
    const prev = pushStack(thenStack);
    try { thenBody(); } finally { popStack(prev); }
    const ifNode = new IfNode(condition, thenStack);
    addToStack(ifNode);
    const chain: IfChain = {
        ElseIf(c: Node<Any>, body: () => void): IfChain {
            const s = new StackNode(); const f = pushStack(s);
            try { body(); } finally { popStack(f); }
            ifNode.elseIfBranches.push({ condition: c, body: s });
            return chain;
        },
        Else(body: () => void): IfChain {
            const s = new StackNode(); const f = pushStack(s);
            try { body(); } finally { popStack(f); }
            ifNode.elseBody = s;
            return chain;
        },
    };
    return chain;
}

export type LoopVars = Record<string, Node<Any>>;

export function Loop(range: number, callback: (vars: LoopVars) => void): LoopNode;
export function Loop(o: LoopParam, callback: (vars: LoopVars) => void): LoopNode;
export function Loop(o: number | LoopParam, callback: (vars: LoopVars) => void): LoopNode {
    // Determine loop variable type and name from config
    let loopVarType: Any = d.i32;
    let callbackKey = 'i';
    const varName = `_loop_${_loopVarCounter++}`;

    if (typeof o === 'object' && o !== null && !(o instanceof Node)) {
        const cfg = o as { type?: d.ScalarDesc; name?: string };
        if (cfg.type) loopVarType = cfg.type;
        if (cfg.name) callbackKey = cfg.name;
    }

    // Create the loop variable ParamNode
    const loopVar = new ParamNode(loopVarType, 0, varName);

    // Eagerly capture the body (like If does)
    const bodyStack = new StackNode();
    const prev = pushStack(bodyStack);
    try {
        callback({ [callbackKey]: loopVar } as LoopVars);
    } finally {
        popStack(prev);
    }

    const node = new LoopNode(o, loopVar, callbackKey, bodyStack);
    addToStack(node);
    return node;
}
export const For = Loop;

export function While(condition: Node<Any>, body: () => void): void { Loop(condition, body); }
export function Return(): void;
export function Return<D extends Any>(value: Node<D>): void;
export function Return<D extends Any>(value?: Node<D>): void {
    if (value !== undefined) addToStack(new ReturnNode(value));
    else addToStack(new ReturnNode(new ConstNode(d.voidDesc, 0) as Node<d.VoidDesc>));
}
export function Break(): void    { addToStack(new BreakNode()); }
export function Continue(): void { addToStack(new ContinueNode()); }
export function Discard(): void  { addToStack(new DiscardNode()); }

export type ParamDesc = { readonly name: string; readonly type: Any; };
export type ParamDescsToNodes<P extends readonly ParamDesc[]> = { [K in keyof P]: P[K] extends ParamDesc ? Node<P[K]['type']> : never; };
export type FnLayout<P extends readonly ParamDesc[]> = { readonly name: string; readonly params: [...P]; };

// Overload 1 — with layout
export function Fn<D extends Any, P extends readonly ParamDesc[]>(
    jsFunc: (...args: ParamDescsToNodes<P>) => Node<D>,
    layout: FnLayout<P>
): (...args: ParamDescsToNodes<P>) => CallNode<D>;

// Overload 2 — no-params void body
export function Fn(jsFunc: () => void): FnNode<d.VoidDesc>;

// Overload 3 — no layout
export function Fn<D extends Any>(
    jsFunc: (...args: Node<Any>[]) => Node<D>
): (...args: Node<Any>[]) => CallNode<D>;

// Implementation
export function Fn<D extends Any>(
    jsFunc: ((...args: Node<Any>[]) => Node<D>) | (() => void),
    layout?: FnLayout<readonly ParamDesc[]>
): ((...args: Node<Any>[]) => CallNode<D>) | FnNode<d.VoidDesc> {
    const paramDescs: (ParamDesc | Any)[] = layout?.params ?? [];
    const dummyParams = paramDescs.map((pd, i) => {
        const paramName = 'name' in pd ? (pd as ParamDesc).name : undefined;
        const desc = 'name' in pd ? (pd as ParamDesc).type : (pd as Any);
        return new ParamNode(desc, i, paramName);
    });
    const traceStack = new StackNode();
    const prev = pushStack(traceStack);
    let returnType: D | d.VoidDesc;
    try {
        const output = (jsFunc as (...args: Node<Any>[]) => Node<D> | undefined)(...dummyParams);
        returnType = output != null ? output.type : d.voidDesc;
    } finally { popStack(prev); }

    if (returnType === d.voidDesc && paramDescs.length === 0 && !layout) {
        return new FnNode<d.VoidDesc>(d.voidDesc, [], jsFunc as (...args: Node<Any>[]) => Node<d.VoidDesc>, undefined);
    }
    const fnNode = new FnNode<D>(returnType as D, paramDescs, jsFunc as (...args: Node<Any>[]) => Node<D>, layout?.name);
    return (...args: Node<Any>[]): CallNode<D> => new CallNode<D>(returnType as D, fnNode.fnName, args, fnNode);
}

export const cond = <D extends Any>(condition: Node<Any>, ifTrue: Node<D>, ifFalse?: Node<D>) => new CondNode(condition, ifTrue, ifFalse);

/**
 * WGSL `select(falseVal, trueVal, condition)`.
 * Returns `trueVal` when `condition` is true, `falseVal` otherwise.
 */
export const select = <D extends Any>(falseVal: Node<D>, trueVal: Node<D>, condition: Node<Any>): Node<D> => new CondNode(condition, trueVal, falseVal);

export function Var<D extends Any>(init: Node<D>, label?: string): VarNode<D> {
    const varName = label ? `var_${_nodeId}_${label}` : `var_${_nodeId}`;
    const v = new VarNode(init.type, varName, init);
    if (currentStack !== null) currentStack.push(v);
    return v;
}

export function Const<D extends Any>(init: Node<D>, label?: string): VarNode<D> {
    const varName = label ? `const_${_nodeId}_${label}` : `const_${_nodeId}`;
    const v = new VarNode(init.type, varName, init, true);
    if (currentStack !== null) currentStack.push(v);
    return v;
}

export function assign<D extends Any>(target: Node<D>, value: Node<D>): void { addToStack(new AssignNode(target, value)); }

// ── Compute ───────────────────────────────────────────────────────────────────

export type ComputeOptions = {
    workgroupSize: [x: number, y: number, z: number];
    name?: string;
};
export type ComputeNodeOptions = ComputeOptions & { fn: FnNode<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

let _computeCounter = 0;

export class ComputeNode {
    readonly id: string;
    readonly fn: FnNode<Any>;
    readonly workgroupSize: [number, number, number];
    readonly name: string | undefined;

    /**
     * Set to true after dispose() is called.
     * The renderer checks this flag to skip dispatch and clean up GPU resources.
     */
    disposed: boolean = false;

    /**
     * Internal callback set by the renderer to clean up GPU resources (pipelines, caches).
     * @internal
     */
    _onDispose: (() => void) | null = null;

    constructor(opts: ComputeNodeOptions) {
        this.id = `_compute_${_computeCounter++}`;
        this.fn = opts.fn;
        this.workgroupSize = opts.workgroupSize;
        this.name = opts.name;
    }

    /**
     * Frees GPU-related resources allocated for this compute node.
     * Call this method when the compute node is no longer used.
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this._onDispose?.();
    }
}

export function compute(fn: FnNode<Any>, opts: ComputeOptions): ComputeNode { return new ComputeNode({ fn, ...opts }); }

// ── Struct ────────────────────────────────────────────────────────────────────

export type StructInstance<S extends d.StructSchema> = { readonly $node: Node<d.StructDesc> } & { readonly [K in keyof S]: Node<S[K]> };
export type StructMember = { readonly name: string; readonly type: Any };
export type StructDef<S extends d.StructSchema> = {
    readonly type: 'struct';
    readonly wgslType: string;
    readonly name: string;
    readonly fields: S;
    readonly members: StructMember[];
    readonly node: StructNode<S>;
    readonly nestedDefs: ReadonlyMap<string, StructDef<d.StructSchema>>;
    instantiate<N extends Node<Any>>(base: N): StructInstance<S>;
};

export function struct<S extends d.StructSchema>(name: string, fields: S): StructDef<S> {
    const members: StructMember[] = Object.entries(fields).map(([n, desc]) => ({ name: n, type: desc }));
    const structDesc: d.StructDesc<S> = { type: 'struct', wgslType: name, name, fields };
    const node = new StructNode<S>(structDesc, members);
    const nestedDefs: Map<string, StructDef<d.StructSchema>> = new Map();
    for (const desc of Object.values(fields)) {
        if (isStructDef(desc)) nestedDefs.set(desc.wgslType, desc as unknown as StructDef<d.StructSchema>);
    }
    function instantiate<N extends Node<Any>>(base: N): StructInstance<S> {
        const result: Record<string, Node<Any>> = { $node: base as unknown as Node<d.StructDesc> };
        for (const [fieldName, fieldDesc] of Object.entries(fields)) {
            result[fieldName] = new FieldNode(fieldDesc, base, fieldName);
        }
        return result as StructInstance<S>;
    }
    const def: StructDef<S> = { type: 'struct', wgslType: name, name, fields, members, node, nestedDefs, instantiate };
    return def;
}

export class StructNode<S extends d.StructSchema = d.StructSchema> extends Node<d.StructDesc<S>> {
    constructor(desc: d.StructDesc<S>, readonly members: StructMember[]) {
        super(desc);
    }
}
