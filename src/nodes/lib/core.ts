import type { NodeFrame } from '../../renderer/node-frame';
import type { WgslDesc, StructSchema } from '../schema';
import { isStructDef } from '../schema';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ScalarType = 'f32' | 'i32' | 'u32' | 'bool' | 'f16';

export type Vec2Type = 'vec2f' | 'vec2i' | 'vec2u' | 'vec2<bool>' | 'vec2h';
export type Vec3Type = 'vec3f' | 'vec3i' | 'vec3u' | 'vec3<bool>' | 'vec3h';
export type Vec4Type = 'vec4f' | 'vec4i' | 'vec4u' | 'vec4<bool>' | 'vec4h';
export type VecType = Vec2Type | Vec3Type | Vec4Type;

export type MatType = 'mat2x2f' | 'mat2x3f' | 'mat2x4f' | 'mat3x2f' | 'mat3x3f' | 'mat3x4f' | 'mat4x2f' | 'mat4x3f' | 'mat4x4f' |
    'mat2x2h' | 'mat2x3h' | 'mat2x4h' | 'mat3x2h' | 'mat3x3h' | 'mat3x4h' | 'mat4x2h' | 'mat4x3h' | 'mat4x4h';

export type NumericType = ScalarType | VecType | MatType;
export type SamplerType = 'sampler' | 'sampler_comparison';
export type TextureType = string;
export type WgslType = NumericType | SamplerType | TextureType;

export type VecElement<T extends VecType> = T extends 'vec2f' | 'vec3f' | 'vec4f' ? 'f32' : T extends 'vec2i' | 'vec3i' | 'vec4i' ? 'i32' : T extends 'vec2u' | 'vec3u' | 'vec4u' ? 'u32' : T extends 'vec2h' | 'vec3h' | 'vec4h' ? 'f16' : 'bool';

export type Vec2Of<E extends ScalarType> = E extends 'f32' ? 'vec2f' : E extends 'i32' ? 'vec2i' : E extends 'u32' ? 'vec2u' : E extends 'f16' ? 'vec2h' : 'vec2<bool>';
export type Vec3Of<E extends ScalarType> = E extends 'f32' ? 'vec3f' : E extends 'i32' ? 'vec3i' : E extends 'u32' ? 'vec3u' : E extends 'f16' ? 'vec3h' : 'vec3<bool>';
export type Vec4Of<E extends ScalarType> = E extends 'f32' ? 'vec4f' : E extends 'i32' ? 'vec4i' : E extends 'u32' ? 'vec4u' : E extends 'f16' ? 'vec4h' : 'vec4<bool>';

export type Swizzle1<T extends WgslType> = T extends VecType ? VecElement<T> : T extends ScalarType ? T : WgslType;
export type Swizzle2<T extends WgslType> = T extends VecType ? Vec2Of<VecElement<T>> : WgslType;
export type Swizzle3<T extends WgslType> = T extends VecType ? Vec3Of<VecElement<T>> : WgslType;
export type Swizzle4<T extends WgslType> = T extends VecType ? Vec4Of<VecElement<T>> : WgslType;

export type GpuTypedArray = Float32Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array;

// ─── Math result types ────────────────────────────────────────────────────────

export type MulResult<A extends WgslType, B extends WgslType> = [A] extends [MatType] ? [B] extends [VecType] ? B : A : [B] extends [ScalarType] ? A : [A] extends [ScalarType] ? B : A;
export type ArithResult<A extends WgslType, B extends WgslType> = [A] extends [B] ? A : [B] extends [A] ? B : [A] extends [ScalarType] ? B : A;
export type BinopOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '>' | '<=' | '>=';

// ─── Node id utilities ────────────────────────────────────────────────────────

export let _nodeCounter = 0;
export const nextId = () => `s_${_nodeCounter++}`;

export function computeId(kind: string, fields: Record<string, unknown>): string {
    return 'n_' + djb2(stableStringify({ kind, ...fields })).toString(36);
}
function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const keys = Object.keys(value as object).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') + '}';
}
function djb2(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
        hash = hash >>> 0;
    }
    return hash;
}

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
export function addToStack(node: Node<WgslType>): void {
    if (currentStack === null) throw new Error(
        `[gpucat] Control flow (toVar, If, For, Return) must be called inside a Fn body. ` +
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

export class Node<T extends WgslType> {
    readonly id: string;
    readonly type: T;

    _beforeNodes: Node<WgslType>[] | null = null;
    updateType: NodeUpdateType = NodeUpdateType.NONE;
    updateBeforeType: NodeUpdateType = NodeUpdateType.NONE;
    updateAfterType: NodeUpdateType = NodeUpdateType.NONE;
    global: boolean = false;
    parents: boolean = false;
    readonly isNode: boolean = true;
    update?: (frame: NodeFrame) => unknown;

    constructor(id: string, type: T) {
        this.id = id;
        this.type = type;
    }

    onUpdate(callback: (frame: NodeFrame) => unknown, updateType: NodeUpdateType): this {
        this.updateType = updateType;
        this.update = callback;
        return this;
    }
    onRenderUpdate(callback: (frame: NodeFrame) => unknown): this { return this.onUpdate(callback, NodeUpdateType.RENDER); }
    onObjectUpdate(callback: (frame: NodeFrame) => unknown): this { return this.onUpdate(callback, NodeUpdateType.OBJECT); }

    before(node: Node<WgslType>): this {
        if (this._beforeNodes === null) this._beforeNodes = [];
        this._beforeNodes.push(node);
        return this;
    }

    // ── Type conversions ──────────────────────────────────────────────────────
    toF32(): Node<'f32'>  { return new CallNode('f32', 'f32', [this]); }
    toF16(): Node<'f16'>  { return new CallNode('f16', 'f16', [this]); }
    toU32(): Node<'u32'>  { return new CallNode('u32', 'u32', [this]); }
    toI32(): Node<'i32'>  { return new CallNode('i32', 'i32', [this]); }

    // ── Field access ──────────────────────────────────────────────────────────
    field<R extends WgslType>(name: string, resultType: R): Node<R> { return new FieldNode(resultType, this, name); }

    // ── Comparisons ───────────────────────────────────────────────────────────
    greaterThan(b: Node<T>): Node<'bool'>      { return new BinopNode('>', 'bool', this, b); }
    lessThan(b: Node<T>): Node<'bool'>         { return new BinopNode('<', 'bool', this, b); }
    greaterThanEqual(b: Node<T>): Node<'bool'> { return new BinopNode('>=', 'bool', this, b); }
    lessThanEqual(b: Node<T>): Node<'bool'>    { return new BinopNode('<=', 'bool', this, b); }
    equal(b: Node<T>): Node<'bool'>            { return new BinopNode('==', 'bool', this, b); }
    notEqual(b: Node<T>): Node<'bool'>         { return new BinopNode('!=', 'bool', this, b); }

    // ── Math ──────────────────────────────────────────────────────────────────
    add<B extends WgslType>(b: Node<B>): Node<ArithResult<T, B>>  { return add(this, b); }
    sub<B extends WgslType>(b: Node<B>): Node<ArithResult<T, B>>  { return sub(this, b); }
    div<B extends WgslType>(b: Node<B>): Node<ArithResult<T, B>>  { return div(this, b); }
    mul<B extends WgslType>(b: Node<B>): Node<MulResult<T, B>>    { return mul(this, b); }
    abs(): Node<T>                   { return new CallNode(this.type, 'abs',       [this]) as Node<T>; }
    floor(): Node<T>                 { return new CallNode(this.type, 'floor',     [this]) as Node<T>; }
    ceil(): Node<T>                  { return new CallNode(this.type, 'ceil',      [this]) as Node<T>; }
    fract(): Node<T>                 { return new CallNode(this.type, 'fract',     [this]) as Node<T>; }
    sqrt(): Node<T>                  { return new CallNode(this.type, 'sqrt',      [this]) as Node<T>; }
    sin(): Node<T>                   { return new CallNode(this.type, 'sin',       [this]) as Node<T>; }
    cos(): Node<T>                   { return new CallNode(this.type, 'cos',       [this]) as Node<T>; }
    negate(): Node<T>                { return new CallNode(this.type, 'negate',    [this]) as Node<T>; }
    normalize(): Node<T>             { return new CallNode(this.type, 'normalize', [this]) as Node<T>; }
    length(): Node<'f32'>            { return new CallNode('f32',     'length',    [this]); }
    dot(b: Node<T>): Node<T extends VecType ? VecElement<T> : 'f32'> {
        return new CallNode('f32', 'dot', [this, b]) as unknown as Node<T extends VecType ? VecElement<T> : 'f32'>;
    }
    cross(b: Node<T>): Node<T>                                   { return new CallNode(this.type, 'cross',      [this, b]) as Node<T>; }
    pow(b: Node<T>): Node<T>                                     { return new CallNode(this.type, 'pow',        [this, b]) as Node<T>; }
    max(b: Node<T>): Node<T>                                     { return new CallNode(this.type, 'max',        [this, b]) as Node<T>; }
    min(b: Node<T>): Node<T>                                     { return new CallNode(this.type, 'min',        [this, b]) as Node<T>; }
    clamp(lo: Node<T>, hi: Node<T>): Node<T>                     { return new CallNode(this.type, 'clamp',      [this, lo, hi]) as Node<T>; }
    mix(b: Node<T>, t: Node<T>): Node<T>                         { return new CallNode(this.type, 'mix',        [this, b, t]) as Node<T>; }
    step(x: Node<T>): Node<T>                                    { return new CallNode(this.type, 'step',       [this, x]) as Node<T>; }
    smoothstep(hi: Node<T>, x: Node<T>): Node<T>                 { return new CallNode(this.type, 'smoothstep', [this, hi, x]) as Node<T>; }

    // ── Lang ──────────────────────────────────────────────────────────────────
    assign(value: Node<T>): void           { addToStack(new AssignNode(this, value)); }
    toVar(label?: string): VarNode<T>      { return Var(this, label); }
    toConst(label?: string): VarNode<T>    { return Const(this, label); }

    // ── Swizzles ──────────────────────────────────────────────────────────────
    get x(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'x') as unknown as Node<Swizzle1<T>>; }
    get y(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'y') as unknown as Node<Swizzle1<T>>; }
    get z(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'z') as unknown as Node<Swizzle1<T>>; }
    get w(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'w') as unknown as Node<Swizzle1<T>>; }
    get r(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'x') as unknown as Node<Swizzle1<T>>; }
    get g(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'y') as unknown as Node<Swizzle1<T>>; }
    get b(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'z') as unknown as Node<Swizzle1<T>>; }
    get a(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'w') as unknown as Node<Swizzle1<T>>; }

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

    // ── Inspector ─────────────────────────────────────────────────────────────
    inspect(name?: string): this {
        const inspector = new InspectorNode(this, name);
        this.before(inspector as unknown as Node<WgslType>);
        return this;
    }
}

export function isNode(v: unknown): v is Node<WgslType> { return v instanceof Node; }

// ─── InspectorNode ────────────────────────────────────────────────────────────

let _inspectorNodeCounter = 0;

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
export class InspectorNode<T extends WgslType> extends Node<T> {
    /** The original node being inspected. */
    readonly wrappedNode: Node<T>;

    /** Display name for the inspector UI. */
    readonly inspectorName: string;

    /** Marker for type checking. */
    readonly isInspectorNode = true;

    constructor(node: Node<T>, name?: string) {
        // Generate a unique ID for this inspector node
        const id = `inspector_${_inspectorNodeCounter++}_${node.id}`;
        super(id, node.type);

        this.wrappedNode = node;
        this.inspectorName = name ?? node.id;

        // Key: use the FRAME update type so update() is called every frame
        this.updateType = NodeUpdateType.FRAME;
    }

    /**
     * Called by the node update system every frame.
     * Registers this node with the renderer's inspector.
     */
    override update = (frame: NodeFrame): void => {
        frame.renderer!.inspector.inspect(this as unknown as InspectorNode<WgslType>);
    };

    /**
     * Returns the display name for the inspector.
     */
    getName(): string {
        return this.inspectorName;
    }
}

// ─── Expr nodes ───────────────────────────────────────────────────────────────

export class ConstNode<T extends WgslType> extends Node<T> {
    constructor(type: T, readonly value: number | number[] | string) {
        super(computeId('const', { type, value }), type);
    }
}

export class VarNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly varName: string,
        readonly init: Node<T>,
        readonly isConst: boolean = false
    ) {
        super(nextId(), type);
    }
}

export class AssignNode extends Node<'void'> {
    constructor(readonly target: Node<WgslType>, readonly value: Node<WgslType>) {
        super(computeId('assign', { target: target.id, value: value.id }), 'void');
    }
}

export class BinopNode<T extends WgslType> extends Node<T> {
    constructor(
        readonly op: BinopOp,
        type: T,
        readonly left: Node<WgslType>,
        readonly right: Node<WgslType>
    ) {
        super(computeId('binop', { type, op, a: left.id, b: right.id }), type);
    }
}

/** Opaque reference to WgslFunctionNode to avoid circular import */
export interface WgslFunctionNodeRef {
    readonly code: string;
    readonly includes: WgslFunctionNodeRef[];
    getNodeFunction(): { outputType: string; name: string };
}

export class CallNode<T extends WgslType> extends Node<T> {
    readonly fnNode?: FnNode<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    readonly wgslFnNode?: WgslFunctionNodeRef;
    constructor(type: T, readonly fn: string, readonly args: Node<WgslType>[], fnNode?: FnNode<any>, wgslFnNode?: WgslFunctionNodeRef) {
        super(computeId('call', { type, fn, args: args.map((n) => n.id) }), type);
        this.fnNode = fnNode;
        this.wgslFnNode = wgslFnNode;
    }
}

export class ConstructNode<T extends WgslType> extends Node<T> {
    constructor(type: T, readonly args: Node<WgslType>[]) {
        super(computeId('construct', { type, args: args.map((n) => n.id) }), type);
    }
}

export class FieldNode<T extends WgslType> extends Node<T> {
    constructor(type: T, readonly object: Node<WgslType>, readonly fieldName: string) {
        super(computeId('field', { type, object: object.id, field: fieldName }), type);
    }
}

export class IndexNode<T extends WgslType> extends Node<T> {
    constructor(type: T, readonly array: Node<WgslType>, readonly index: Node<WgslType>) {
        super(computeId('index', { type, array: array.id, index: index.id }), type);
    }
}

// ── Standalone expr functions ─────────────────────────────────────────────────

export const field  = <T extends WgslType, R extends WgslType>(node: Node<T>, name: string, resultType: R): Node<R> => new FieldNode(resultType, node, name);
export const toF32  = <T extends WgslType>(node: Node<T>): Node<'f32'> => new CallNode('f32', 'f32', [node]);
export const toF16  = <T extends WgslType>(node: Node<T>): Node<'f16'> => new CallNode('f16', 'f16', [node]);
export const toU32  = <T extends WgslType>(node: Node<T>): Node<'u32'> => new CallNode('u32', 'u32', [node]);
export const toI32  = <T extends WgslType>(node: Node<T>): Node<'i32'> => new CallNode('i32', 'i32', [node]);

export const greaterThan      = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<'bool'> => new BinopNode('>', 'bool', a, b);
export const lessThan         = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<'bool'> => new BinopNode('<', 'bool', a, b);
export const greaterThanEqual = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<'bool'> => new BinopNode('>=', 'bool', a, b);
export const lessThanEqual    = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<'bool'> => new BinopNode('<=', 'bool', a, b);
export const equal            = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<'bool'> => new BinopNode('==', 'bool', a, b);
export const notEqual         = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<'bool'> => new BinopNode('!=', 'bool', a, b);
export const index            = <T extends WgslType>(array: Node<T>, idx: Node<WgslType>) => new IndexNode(array.type, array, idx);

// ── Const constructors ────────────────────────────────────────────────────────

export const f32  = (v = 0): ConstNode<'f32'>  => new ConstNode('f32', v);
export const f16  = (v = 0): ConstNode<'f16'>  => new ConstNode('f16', v);
export const i32  = (v = 0): ConstNode<'i32'>  => new ConstNode('i32', v);
export const u32  = (v = 0): ConstNode<'u32'>  => new ConstNode('u32', v);
export const bool = (v: boolean): ConstNode<'bool'> => new ConstNode('bool', v ? 1 : 0);

type Scalar = Node<WgslType> | number | boolean;

function wrapScalar(v: Scalar, elemType: 'f32' | 'f16' | 'i32' | 'u32' | 'bool'): Node<WgslType> {
    if (isNode(v)) return v;
    if (elemType === 'bool') return new ConstNode('bool', (v as boolean | number) ? 1 : 0);
    if (elemType === 'i32')  return new ConstNode('i32', Math.trunc(v as number));
    if (elemType === 'u32')  return new ConstNode('u32', Math.trunc(v as number));
    if (elemType === 'f16')  return new ConstNode('f16', v as number);
    return new ConstNode('f32', v as number);
}
function elemOf(type: Vec2Type | Vec3Type | Vec4Type): 'f32' | 'f16' | 'i32' | 'u32' | 'bool' {
    if (type.endsWith('h')) return 'f16';
    if (type.endsWith('f')) return 'f32';
    if (type.endsWith('i')) return 'i32';
    if (type.endsWith('u')) return 'u32';
    return 'bool';
}

export function makeVec2<T extends Vec2Type>(type: T) {
    return (x: Scalar, y: Scalar): ConstructNode<T> => new ConstructNode(type, [wrapScalar(x, elemOf(type)), wrapScalar(y, elemOf(type))]);
}
export function makeVec3<T extends Vec3Type>(type: T) {
    function ctor(xy: Node<WgslType>, z: Scalar): ConstructNode<T>;
    function ctor(x: Scalar, y: Scalar, z: Scalar): ConstructNode<T>;
    function ctor(a: Scalar, b: Scalar, c?: Scalar): ConstructNode<T> {
        const e = elemOf(type);
        if (c === undefined) return new ConstructNode(type, [wrapScalar(a, e), wrapScalar(b, e)]);
        return new ConstructNode(type, [wrapScalar(a, e), wrapScalar(b, e), wrapScalar(c, e)]);
    }
    return ctor;
}
export function makeVec4<T extends Vec4Type>(type: T) {
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

export const vec2  = makeVec2('vec2f');
export const vec3  = makeVec3('vec3f');
export const vec4  = makeVec4('vec4f');
export const vec2f = makeVec2('vec2f');
export const vec3f = makeVec3('vec3f');
export const vec4f = makeVec4('vec4f');
export const vec2i = makeVec2('vec2i');
export const vec3i = makeVec3('vec3i');
export const vec4i = makeVec4('vec4i');
export const vec2u = makeVec2('vec2u');
export const vec3u = makeVec3('vec3u');
export const vec4u = makeVec4('vec4u');
export const vec2h = makeVec2('vec2h');
export const vec3h = makeVec3('vec3h');
export const vec4h = makeVec4('vec4h');
export const vec2b = makeVec2('vec2<bool>');
export const vec3b = makeVec3('vec3<bool>');
export const vec4b = makeVec4('vec4<bool>');

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

export const mat4 = (c0: Node<'vec4f'>, c1: Node<'vec4f'>, c2: Node<'vec4f'>, c3: Node<'vec4f'>) => new ConstructNode('mat4x4f', [c0, c1, c2, c3]);

// ── Standalone math functions ─────────────────────────────────────────────────

export const add        = <A extends WgslType, B extends WgslType>(a: Node<A>, b: Node<B>) => new BinopNode('+', arithResultType(a.type, b.type), a, b) as unknown as Node<ArithResult<A, B>>;
export const sub        = <A extends WgslType, B extends WgslType>(a: Node<A>, b: Node<B>) => new BinopNode('-', arithResultType(a.type, b.type), a, b) as unknown as Node<ArithResult<A, B>>;
export const div        = <A extends WgslType, B extends WgslType>(a: Node<A>, b: Node<B>) => new BinopNode('/', arithResultType(a.type, b.type), a, b) as unknown as Node<ArithResult<A, B>>;
export const mul        = <A extends WgslType, B extends WgslType>(a: Node<A>, b: Node<B>) => new BinopNode('*', mulResultType(a.type, b.type), a, b) as unknown as Node<MulResult<A, B>>;
export const dot        = (a: Node<WgslType>, b: Node<WgslType>): Node<'f32'> => new CallNode('f32', 'dot', [a, b]);
export const cross      = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<T> => new CallNode(a.type, 'cross', [a, b]) as Node<T>;
export const normalize  = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'normalize', [a]) as Node<T>;
export const length     = (a: Node<WgslType>): Node<'f32'> => new CallNode('f32', 'length', [a]);
export const abs        = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'abs', [a]) as Node<T>;
export const floor      = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'floor', [a]) as Node<T>;
export const ceil       = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'ceil', [a]) as Node<T>;
export const fract      = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'fract', [a]) as Node<T>;
export const sqrt       = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'sqrt', [a]) as Node<T>;
export const sin        = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'sin', [a]) as Node<T>;
export const cos        = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'cos', [a]) as Node<T>;
export const negate     = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'negate', [a]) as Node<T>;
export const pow        = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<T> => new CallNode(a.type, 'pow', [a, b]) as Node<T>;
export const max        = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<T> => new CallNode(a.type, 'max', [a, b]) as Node<T>;
export const min        = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<T> => new CallNode(a.type, 'min', [a, b]) as Node<T>;
export const clamp      = <T extends WgslType>(a: Node<T>, lo: Node<T>, hi: Node<T>): Node<T> => new CallNode(a.type, 'clamp', [a, lo, hi]) as Node<T>;
export const mix        = <T extends WgslType>(a: Node<T>, b: Node<T>, t: Node<T>): Node<T> => new CallNode(a.type, 'mix', [a, b, t]) as Node<T>;
export const step       = <T extends WgslType>(edge: Node<T>, x: Node<T>): Node<T> => new CallNode(x.type, 'step', [edge, x]) as Node<T>;
export const smoothstep = <T extends WgslType>(lo: Node<T>, hi: Node<T>, x: Node<T>): Node<T> => new CallNode(x.type, 'smoothstep', [lo, hi, x]) as Node<T>;
export const transpose  = <T extends MatType>(m: Node<T>): Node<T> => new CallNode(m.type, 'transpose', [m]) as Node<T>;

// ── Lang ──────────────────────────────────────────────────────────────────────

export class StackNode extends Node<'void'> {
    readonly body: Node<WgslType>[];
    constructor(initial?: Node<WgslType>[]) {
        super(nextId(), 'void');
        this.body = initial ? [...initial] : [];
    }
    push(node: Node<WgslType>): void { this.body.push(node); }
}

export class FnNode<T extends WgslType> extends Node<T> {
    readonly fnName: string;
    readonly paramDescs: (ParamDesc | WgslDesc<WgslType>)[];
    readonly jsFunc: (...args: Node<WgslType>[]) => Node<T>;

    constructor(
        returnType: T,
        paramDescs: (ParamDesc | WgslDesc<WgslType>)[],
        jsFunc: (...args: Node<WgslType>[]) => Node<T>,
        fnName?: string
    ) {
        super(nextId(), returnType);
        this.fnName = fnName ?? `fn_${this.id}`;
        this.paramDescs = paramDescs;
        this.jsFunc = jsFunc;
    }

    compute(opts: ComputeOptions): ComputeNode { return new ComputeNode({ fn: this, ...opts }); }

    trace(): { params: ParamNode<WgslType>[]; body: StackNode; output: Node<T> } {
        const params = this.paramDescs.map((d, i) => {
            const paramName = 'name' in d ? (d as ParamDesc).name : undefined;
            const wgslType = 'name' in d ? (d as ParamDesc).type.wgslType : (d as WgslDesc<WgslType>).wgslType;
            return new ParamNode(wgslType, i, paramName);
        });
        const stack = new StackNode();
        const prev = pushStack(stack);
        let output: Node<T>;
        try { output = this.jsFunc(...params); } finally { popStack(prev); }
        return { params, body: stack, output };
    }
}

export class ParamNode<T extends WgslType> extends Node<T> {
    constructor(type: T, readonly paramIndex: number, readonly paramName?: string) {
        super(nextId(), type);
    }
}

export class ReturnNode<T extends WgslType> extends Node<T> {
    constructor(readonly value: Node<T>) { super(nextId(), value.type); }
}

export class CondNode<T extends WgslType> extends Node<T> {
    readonly ifFalse?: Node<WgslType>;
    constructor(readonly condition: Node<WgslType>, readonly ifTrue: Node<T>, ifFalse?: Node<T>) {
        super(computeId('cond', { condition: condition.id, ifTrue: ifTrue.id, ifFalse: ifFalse?.id }), ifTrue.type);
        this.ifFalse = ifFalse;
    }
}

export type ElseIfBranch = { condition: Node<WgslType>; body: StackNode; };

export class IfNode extends Node<'void'> {
    elseIfBranches: ElseIfBranch[] = [];
    elseBody: StackNode | null = null;
    constructor(readonly condition: Node<WgslType>, readonly thenBody: StackNode) {
        super(nextId(), 'void');
    }
}

export type LoopParam = Node<WgslType> | number | {
    start?: Node<WgslType> | number;
    end?: Node<WgslType> | number;
    type?: ScalarType;
    condition?: '<' | '<=' | '>' | '>=';
    update?: Node<WgslType> | number | string | ((...args: unknown[]) => void);
    name?: string;
};

export class LoopNode extends Node<'void'> {
    readonly params: unknown[];
    constructor(params: unknown[] = []) { super(nextId(), 'void'); this.params = params; }
    getVarName(index: number): string { return String.fromCharCode('i'.charCodeAt(0) + index); }
    toStack(): this { addToStack(this); return this; }
}

export class BreakNode    extends Node<'void'> { constructor() { super(nextId(), 'void'); } }
export class ContinueNode extends Node<'void'> { constructor() { super(nextId(), 'void'); } }

export type IfChain = {
    ElseIf(condition: Node<WgslType>, body: () => void): IfChain;
    Else(body: () => void): IfChain;
};

export function If(condition: Node<WgslType>, thenBody: () => void): IfChain {
    const thenStack = new StackNode();
    const prev = pushStack(thenStack);
    try { thenBody(); } finally { popStack(prev); }
    const ifNode = new IfNode(condition, thenStack);
    addToStack(ifNode);
    const chain: IfChain = {
        ElseIf(c: Node<WgslType>, body: () => void): IfChain {
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

export type LoopVars = { i: Node<'i32'> };

export function Loop(range: number, callback: (vars: LoopVars) => void): LoopNode;
export function Loop(o: LoopParam, callback: (vars: LoopVars) => void): LoopNode;
export function Loop(o: number | LoopParam, callback: (vars: LoopVars) => void): LoopNode {
    return new LoopNode([o, callback]).toStack();
}
export const For = Loop;

export function While(condition: Node<WgslType>, body: () => void): void { Loop(condition, body); }
export function Return<T extends WgslType>(value: Node<T>): void   { addToStack(new ReturnNode(value) as Node<WgslType>); }
export function Break(): void    { addToStack(new BreakNode()); }
export function Continue(): void { addToStack(new ContinueNode()); }

export type ParamDesc<T extends WgslType = WgslType> = { readonly name: string; readonly type: WgslDesc<T>; };
export type ParamDescsToNodes<P extends readonly ParamDesc[]> = { [K in keyof P]: P[K] extends ParamDesc<infer U> ? Node<U> : never; };
export type FnLayout<P extends readonly ParamDesc[]> = { readonly name: string; readonly params: [...P]; };

// Overload 1 — with layout
export function Fn<T extends WgslType, P extends readonly ParamDesc[]>(
    jsFunc: (...args: ParamDescsToNodes<P>) => Node<T>,
    layout: FnLayout<P>
): (...args: ParamDescsToNodes<P>) => CallNode<T>;

// Overload 2 — no-params void body
export function Fn(jsFunc: () => void): FnNode<'void'>;

// Overload 3 — no layout
export function Fn<T extends WgslType>(
    jsFunc: (...args: Node<WgslType>[]) => Node<T>
): (...args: Node<WgslType>[]) => CallNode<T>;

// Implementation
export function Fn<T extends WgslType>(
    jsFunc: ((...args: Node<WgslType>[]) => Node<T>) | (() => void),
    layout?: FnLayout<readonly ParamDesc[]>
): ((...args: Node<WgslType>[]) => CallNode<T>) | FnNode<'void'> {
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
    } finally { popStack(prev); }

    if (returnType === 'void' && paramDescs.length === 0 && !layout) {
        return new FnNode<'void'>('void', [], jsFunc as (...args: Node<WgslType>[]) => Node<'void'>, undefined);
    }
    const fnNode = new FnNode<T>(returnType as T, paramDescs, jsFunc as (...args: Node<WgslType>[]) => Node<T>, layout?.name);
    return (...args: Node<WgslType>[]): CallNode<T> => new CallNode<T>(returnType as T, fnNode.fnName, args, fnNode);
}

export const cond = <T extends WgslType>(condition: Node<WgslType>, ifTrue: Node<T>, ifFalse?: Node<T>) => new CondNode(condition, ifTrue, ifFalse);

export function Var<T extends WgslType>(init: Node<T>, label?: string): VarNode<T> {
    const varName = label ? `var_${_nodeCounter}_${label}` : `var_${_nodeCounter}`;
    const v = new VarNode(init.type as T, varName, init);
    if (currentStack !== null) currentStack.push(v as Node<WgslType>);
    return v;
}

export function Const<T extends WgslType>(init: Node<T>, label?: string): VarNode<T> {
    const varName = label ? `const_${_nodeCounter}_${label}` : `const_${_nodeCounter}`;
    const v = new VarNode(init.type as T, varName, init, true);
    if (currentStack !== null) currentStack.push(v as Node<WgslType>);
    return v;
}

export function assign<T extends WgslType>(target: Node<T>, value: Node<T>): void { addToStack(new AssignNode(target, value)); }

// ── Compute ───────────────────────────────────────────────────────────────────

export type ComputeOptions = {
    dispatch: [x: number, y: number, z: number] | [x: number, y: number] | [x: number];
    workgroupSize?: [x: number, y: number, z: number];
};
export type ComputeNodeOptions = ComputeOptions & { fn: FnNode<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

let _computeCounter = 0;

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
}

export function compute(fn: FnNode<WgslType>, opts: ComputeOptions): ComputeNode { return new ComputeNode({ fn, ...opts }); }

// ── Struct ────────────────────────────────────────────────────────────────────

export type StructInstance<S extends StructSchema> = { readonly $node: Node<WgslType> } & { readonly [K in keyof S]: Node<S[K]['wgslType'] & WgslType> };
export type StructMember = { readonly name: string; readonly type: WgslType };
export type StructDef<S extends StructSchema> = WgslDesc<string> & {
    readonly schema: S;
    readonly members: StructMember[];
    readonly node: StructNode;
    readonly nestedDefs: ReadonlyMap<string, StructDef<StructSchema>>;
    instantiate<N extends Node<WgslType>>(base: N): StructInstance<S>;
};

const _structNodeRegistry: WeakMap<StructNode, StructDef<StructSchema>> = new WeakMap();
const _structNameRegistry: Map<string, StructDef<StructSchema>> = new Map();

export function lookupStructDef(node: StructNode): StructDef<StructSchema> | undefined { return _structNodeRegistry.get(node); }
export function lookupStructDefByName(wgslType: string): StructDef<StructSchema> | undefined { return _structNameRegistry.get(wgslType); }

export function struct<S extends StructSchema>(wgslType: string, schema: S): StructDef<S> {
    const members: StructMember[] = Object.entries(schema).map(([name, f]) => ({ name, type: f.wgslType }));
    const node = new StructNode(wgslType, members);
    const nestedDefs: Map<string, StructDef<StructSchema>> = new Map();
    for (const f of Object.values(schema)) {
        if (isStructDef(f)) nestedDefs.set(f.wgslType, f as unknown as StructDef<StructSchema>);
    }
    function instantiate<N extends Node<WgslType>>(base: N): StructInstance<S> {
        const result: Record<string, Node<WgslType>> = { $node: base };
        for (const [name, f] of Object.entries(schema)) result[name] = new FieldNode(f.wgslType as WgslType, base, name);
        return result as StructInstance<S>;
    }
    const def: StructDef<S> = { wgslType, schema, members, node, nestedDefs, instantiate };
    _structNodeRegistry.set(node, def);
    _structNameRegistry.set(wgslType, def);
    return def;
}

export class StructNode extends Node<string> {
    constructor(typeName: string, readonly members: StructMember[]) {
        super(computeId('struct', { type: typeName, members }), typeName);
    }
}
