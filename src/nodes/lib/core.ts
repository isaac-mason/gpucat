import type { NodeFrame } from '../../renderer/core/node-frame';
import type {
    Any,
    ArithResultDesc,
    CompareResultDesc,
    MulResultDesc,
    NumericDescOf,
    StructField,
    StructKeys,
    Vec2DescOf,
    Vec3DescOf,
    Vec4DescOf,
    VecElementDesc,
    WgslType,
} from '../../schema/schema';
import * as d from '../../schema/schema';
import { isStructDef } from '../../schema/schema';
import { convertScalarLiteral, floatLiteral } from '../backend/print';

// ─── Types ────────────────────────────────────────────────────────────────────

// Re-export WgslType from schema for backwards compat in external files
export type { WgslType } from '../../schema/schema';

export type ScalarType = 'f32' | 'i32' | 'u32' | 'bool' | 'f16';
export type AtomicType = 'atomic<i32>' | 'atomic<u32>';

export type Vec2Type = 'vec2f' | 'vec2i' | 'vec2u' | 'vec2<bool>' | 'vec2h';
export type Vec3Type = 'vec3f' | 'vec3i' | 'vec3u' | 'vec3<bool>' | 'vec3h';
export type Vec4Type = 'vec4f' | 'vec4i' | 'vec4u' | 'vec4<bool>' | 'vec4h';
export type VecType = Vec2Type | Vec3Type | Vec4Type;

export type MatType =
    | 'mat2x2f'
    | 'mat2x3f'
    | 'mat2x4f'
    | 'mat3x2f'
    | 'mat3x3f'
    | 'mat3x4f'
    | 'mat4x2f'
    | 'mat4x3f'
    | 'mat4x4f'
    | 'mat2x2h'
    | 'mat2x3h'
    | 'mat2x4h'
    | 'mat3x2h'
    | 'mat3x3h'
    | 'mat3x4h'
    | 'mat4x2h'
    | 'mat4x3h'
    | 'mat4x4h';

export type NumericType = ScalarType | VecType | MatType;
export type SamplerType = 'sampler' | 'sampler_comparison';
export type TextureType = string;

export type GpuTypedArray = Float32Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array;

// ─── Type-level helpers (for return type inference) ───────────────────────────

export type VecElement<T extends VecType> = T extends 'vec2f' | 'vec3f' | 'vec4f'
    ? 'f32'
    : T extends 'vec2i' | 'vec3i' | 'vec4i'
      ? 'i32'
      : T extends 'vec2u' | 'vec3u' | 'vec4u'
        ? 'u32'
        : T extends 'vec2h' | 'vec3h' | 'vec4h'
          ? 'f16'
          : 'bool';

export type Vec2Of<E extends ScalarType> = E extends 'f32'
    ? 'vec2f'
    : E extends 'i32'
      ? 'vec2i'
      : E extends 'u32'
        ? 'vec2u'
        : E extends 'f16'
          ? 'vec2h'
          : 'vec2<bool>';
export type Vec3Of<E extends ScalarType> = E extends 'f32'
    ? 'vec3f'
    : E extends 'i32'
      ? 'vec3i'
      : E extends 'u32'
        ? 'vec3u'
        : E extends 'f16'
          ? 'vec3h'
          : 'vec3<bool>';
export type Vec4Of<E extends ScalarType> = E extends 'f32'
    ? 'vec4f'
    : E extends 'i32'
      ? 'vec4i'
      : E extends 'u32'
        ? 'vec4u'
        : E extends 'f16'
          ? 'vec4h'
          : 'vec4<bool>';

export type Swizzle1<T extends WgslType> = T extends VecType ? VecElement<T> : T extends ScalarType ? T : WgslType;
export type Swizzle2<T extends WgslType> = T extends VecType ? Vec2Of<VecElement<T>> : WgslType;
export type Swizzle3<T extends WgslType> = T extends VecType ? Vec3Of<VecElement<T>> : WgslType;
export type Swizzle4<T extends WgslType> = T extends VecType ? Vec4Of<VecElement<T>> : WgslType;

// ─── Descriptor-based math result types ───────────────────────────────────────

export type BinaryOp =
    | '+'
    | '-'
    | '*'
    | '/'
    | '%'
    | '=='
    | '!='
    | '<'
    | '>'
    | '<='
    | '>='
    | '||'
    | '&&'
    | '&'
    | '|'
    | '^'
    | '<<'
    | '>>';

// ─── Node id utilities ────────────────────────────────────────────────────────

export let _nodeId = 0;

// ─── Runtime type lookup tables ───────────────────────────────────────────────

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
    'mat2x2f',
    'mat2x3f',
    'mat2x4f',
    'mat3x2f',
    'mat3x3f',
    'mat3x4f',
    'mat4x2f',
    'mat4x3f',
    'mat4x4f',
    'mat2x2h',
    'mat2x3h',
    'mat2x4h',
    'mat3x2h',
    'mat3x3h',
    'mat3x4h',
    'mat4x2h',
    'mat4x3h',
    'mat4x4h',
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
export function popStack(prev: StackNode | null): void {
    currentStack = prev;
}
export function addToStack(node: Node<Any>): void {
    if (currentStack === null)
        throw new Error(
            `[gpucat] Control flow (toVar, If, For, Return, Discard) must be called inside a Fn body. ` +
                `You are calling it outside of any Fn, wrap your code in Fn([...], () => { ... }).`,
        );
    currentStack.push(node);
}

// ─── Node base class ──────────────────────────────────────────────────────────

export const NodeUpdateType = {
    NONE: 'none',
    FRAME: 'frame',
    RENDER: 'render',
    OBJECT: 'object',
} as const;
export type NodeUpdateType = (typeof NodeUpdateType)[keyof typeof NodeUpdateType];

/**
 * Numeric discriminant identifying a Node subclass.
 *
 * Used by the builder for fast, tree-shakeable dispatch: checking `node.kind`
 * instead of `node instanceof XNode` avoids referencing the subclass constructor,
 * so unused node types can be dropped by a bundler. Auto-incremented `enum` (not
 * `const enum`, which is unsafe across the package boundary / under isolatedModules)
 * for numeric-compare speed without hand-maintaining member values.
 */
export enum NodeKind {
    // expression / core
    Literal,
    BinaryOp,
    Call,
    Construct,
    Field,
    Index,
    Array,
    Conditional,
    Builtin,
    ComputeIndex,
    Parameter,
    Struct,
    // variables / statements
    Let,
    Var,
    PrivateVar,
    WorkgroupVar,
    Assign,
    Return,
    Break,
    Continue,
    Discard,
    Loop,
    If,
    Stack,
    // functions
    Fn,
    WgslFunction,
    Wgsl,
    // IO / binding
    Uniform,
    Attribute,
    Varying,
    Storage,
    OutputStruct,
    MRT,
    // textures
    TextureBinding,
    StorageTextureBinding,
    Sampler,
    Texture,
    CubeTexture,
    DepthTexture,
    ArrayTexture,
    // display
    RenderTexture,
    // misc
    Inspector,
    SubBuild,
    Invariant,
    // base sentinel (the bare `Node` void placeholder; subclasses always override)
    Node,
}

export class Node<D extends Any> {
    readonly id: number;
    readonly type: D;
    /** Numeric discriminant for fast, tree-shakeable dispatch. Subclasses override. */
    readonly kind: NodeKind = NodeKind.Node;

    _beforeNodes: Node<Any>[] | null = null;
    updateType: NodeUpdateType = NodeUpdateType.NONE;
    updateBeforeType: NodeUpdateType = NodeUpdateType.NONE;
    updateAfterType: NodeUpdateType = NodeUpdateType.NONE;
    global: boolean = false;
    parents: boolean = false;
    readonly isNode: boolean = true;

    constructor(type: D) {
        this.id = _nodeId++;
        this.type = type;
    }

    update?(frame: NodeFrame): unknown;
    updateBefore?(frame: NodeFrame): unknown;
    updateAfter?(frame: NodeFrame): unknown;

    onUpdate(callback: (frame: NodeFrame) => unknown, updateType: NodeUpdateType): this {
        this.updateType = updateType;
        this.update = callback;
        return this;
    }
    onRenderUpdate(callback: (frame: NodeFrame) => unknown): this {
        return this.onUpdate(callback, NodeUpdateType.RENDER);
    }
    onObjectUpdate(callback: (frame: NodeFrame) => unknown): this {
        return this.onUpdate(callback, NodeUpdateType.OBJECT);
    }
    onFrameUpdate(callback: (frame: NodeFrame) => unknown): this {
        return this.onUpdate(callback, NodeUpdateType.FRAME);
    }

    onBeforeUpdate(callback: (frame: NodeFrame) => unknown, updateType: NodeUpdateType): this {
        this.updateBeforeType = updateType;
        this.updateBefore = callback;
        return this;
    }
    onBeforeRender(callback: (frame: NodeFrame) => unknown): this {
        return this.onBeforeUpdate(callback, NodeUpdateType.RENDER);
    }
    onBeforeObject(callback: (frame: NodeFrame) => unknown): this {
        return this.onBeforeUpdate(callback, NodeUpdateType.OBJECT);
    }
    onBeforeFrame(callback: (frame: NodeFrame) => unknown): this {
        return this.onBeforeUpdate(callback, NodeUpdateType.FRAME);
    }

    onAfterUpdate(callback: (frame: NodeFrame) => unknown, updateType: NodeUpdateType): this {
        this.updateAfterType = updateType;
        this.updateAfter = callback;
        return this;
    }
    onAfterRender(callback: (frame: NodeFrame) => unknown): this {
        return this.onAfterUpdate(callback, NodeUpdateType.RENDER);
    }
    onAfterObject(callback: (frame: NodeFrame) => unknown): this {
        return this.onAfterUpdate(callback, NodeUpdateType.OBJECT);
    }
    onAfterFrame(callback: (frame: NodeFrame) => unknown): this {
        return this.onAfterUpdate(callback, NodeUpdateType.FRAME);
    }

    before(node: Node<Any>): this {
        if (this._beforeNodes === null) this._beforeNodes = [];
        this._beforeNodes.push(node);
        return this;
    }

    // ── Type conversions ──────────────────────────────────────────────────────
    // Length-preserving: converting a vecN keeps N (a vec3i → vec3f via `vec3f(...)`), so we never emit
    // the illegal scalar cast `f32(vec3i)`. Scalars convert with the scalar constructor as before.
    toF32(): Node<NumericDescOf<D, d.f32>> {
        const t = d.numericDescOf(this.type, 'f32');
        return new CallNode(t, t.wgslType, [this]) as unknown as Node<NumericDescOf<D, d.f32>>;
    }
    toF16(): Node<NumericDescOf<D, d.f16>> {
        const t = d.numericDescOf(this.type, 'f16');
        return new CallNode(t, t.wgslType, [this]) as unknown as Node<NumericDescOf<D, d.f16>>;
    }
    toU32(): Node<NumericDescOf<D, d.u32>> {
        const t = d.numericDescOf(this.type, 'u32');
        return new CallNode(t, t.wgslType, [this]) as unknown as Node<NumericDescOf<D, d.u32>>;
    }
    toI32(): Node<NumericDescOf<D, d.i32>> {
        const t = d.numericDescOf(this.type, 'i32');
        return new CallNode(t, t.wgslType, [this]) as unknown as Node<NumericDescOf<D, d.i32>>;
    }

    // ── Field access ──────────────────────────────────────────────────────────
    field<K extends StructKeys<D>>(name: K): Node<StructField<D, K>> {
        return field(this, name);
    }

    fields(): Fields<d.StructSchemaOf<D>> {
        return fields(this as unknown as Node<d.StructDesc<d.StructSchemaOf<D>>>);
    }

    // ── Comparisons ───────────────────────────────────────────────────────────
    greaterThan(b: Node<D> | ScalarLiteral<D>): Node<CompareResultDesc<D>> {
        return greaterThan(this, b);
    }
    lessThan(b: Node<D> | ScalarLiteral<D>): Node<CompareResultDesc<D>> {
        return lessThan(this, b);
    }
    greaterThanEqual(b: Node<D> | ScalarLiteral<D>): Node<CompareResultDesc<D>> {
        return greaterThanEqual(this, b);
    }
    lessThanEqual(b: Node<D> | ScalarLiteral<D>): Node<CompareResultDesc<D>> {
        return lessThanEqual(this, b);
    }
    equal(b: Node<D> | ScalarLiteral<D>): Node<CompareResultDesc<D>> {
        return equal(this, b);
    }
    notEqual(b: Node<D> | ScalarLiteral<D>): Node<CompareResultDesc<D>> {
        return notEqual(this, b);
    }

    /** `select(falseVal, trueVal, this)`, use `this` node as the condition. */
    select<T extends Any>(ifTrue: Node<T>, ifFalse: Node<T> | ScalarLiteral<T>): Node<T>;
    select<T extends Any>(ifTrue: ScalarLiteral<T>, ifFalse: Node<T>): Node<T>;
    select(ifTrue: boolean, ifFalse: boolean): Node<d.bool>;
    select(ifTrue: Operand, ifFalse: Operand): Node<Any> {
        return select(ifFalse as Node<Any>, ifTrue as Node<Any>, this as Node<Any>);
    }

    any(): Node<d.bool> {
        return any(this);
    }
    all(): Node<d.bool> {
        return all(this);
    }

    // ── Math ──────────────────────────────────────────────────────────────────
    add<N extends Node<Any> | ArithLiteral<D>>(b: N): Node<ArithResultDesc<D, OperandDesc<N, D>>> {
        return add(this, b as Node<Any>) as unknown as Node<ArithResultDesc<D, OperandDesc<N, D>>>;
    }
    sub<N extends Node<Any> | ArithLiteral<D>>(b: N): Node<ArithResultDesc<D, OperandDesc<N, D>>> {
        return sub(this, b as Node<Any>) as unknown as Node<ArithResultDesc<D, OperandDesc<N, D>>>;
    }
    div<N extends Node<Any> | ArithLiteral<D>>(b: N): Node<ArithResultDesc<D, OperandDesc<N, D>>> {
        return div(this, b as Node<Any>) as unknown as Node<ArithResultDesc<D, OperandDesc<N, D>>>;
    }
    mul<N extends Node<Any> | MulLiteral<D>>(b: N): Node<MulResultDesc<D, OperandDesc<N, D>>> {
        return mul(this, b as Node<Any>) as unknown as Node<MulResultDesc<D, OperandDesc<N, D>>>;
    }
    abs(): Node<D> {
        return abs(this) as Node<D>;
    }
    floor(): Node<D> {
        return floor(this) as Node<D>;
    }
    ceil(): Node<D> {
        return ceil(this) as Node<D>;
    }
    fract(): Node<D> {
        return fract(this) as Node<D>;
    }
    sqrt(): Node<D> {
        return sqrt(this) as Node<D>;
    }
    sin(): Node<D> {
        return sin(this) as Node<D>;
    }
    cos(): Node<D> {
        return cos(this) as Node<D>;
    }
    negate(): Node<D> {
        return negate(this) as Node<D>;
    }
    normalize(): Node<D> {
        return normalize(this) as Node<D>;
    }
    length(): Node<d.f32> {
        return length(this);
    }
    dot(b: Node<D>): Node<VecElementDesc<D>> {
        return dot(this, b);
    }
    cross(b: Node<D>): Node<D> {
        return cross(this, b) as Node<D>;
    }
    pow(b: Node<D> | ScalarLiteral<D>): Node<D> {
        return pow(this, b) as Node<D>;
    }
    max(b: Node<D> | ScalarLiteral<D>): Node<D> {
        return max(this, b) as Node<D>;
    }
    min(b: Node<D> | ScalarLiteral<D>): Node<D> {
        return min(this, b) as Node<D>;
    }
    clamp(lo: Node<D> | ScalarLiteral<D>, hi: Node<D> | ScalarLiteral<D>): Node<D> {
        return clamp(this, lo, hi) as Node<D>;
    }
    mix(b: Node<D> | ScalarLiteral<D>, t: Node<Any> | number): Node<D> {
        return mix(this, b, t) as Node<D>;
    }
    step(x: Node<D> | ScalarLiteral<D>): Node<D> {
        return step(this, x) as Node<D>;
    }
    smoothstep(hi: Node<D> | ScalarLiteral<D>, x: Node<D> | ScalarLiteral<D>): Node<D> {
        return smoothstep(this, hi, x) as Node<D>;
    }
    dpdx(): Node<D> {
        return dpdx(this) as Node<D>;
    }
    dpdy(): Node<D> {
        return dpdy(this) as Node<D>;
    }
    fwidth(): Node<D> {
        return fwidth(this) as Node<D>;
    }
    dpdxCoarse(): Node<D> {
        return dpdxCoarse(this) as Node<D>;
    }
    dpdyCoarse(): Node<D> {
        return dpdyCoarse(this) as Node<D>;
    }
    fwidthCoarse(): Node<D> {
        return fwidthCoarse(this) as Node<D>;
    }
    dpdxFine(): Node<D> {
        return dpdxFine(this) as Node<D>;
    }
    dpdyFine(): Node<D> {
        return dpdyFine(this) as Node<D>;
    }
    fwidthFine(): Node<D> {
        return fwidthFine(this) as Node<D>;
    }

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
        throw new Error(
            `[gpucat] Cannot index into type '${t.wgslType}', only array, matrix, and vector types support .element().`,
        );
    }

    // ── Lang ──────────────────────────────────────────────────────────────────
    assign(value: Node<D> | ScalarLiteral<D>): void {
        addToStack(new AssignNode(this, sameTypeOperands('assign', [this, value])[1]!));
    }
    toVar(label?: string): VarNode<D> {
        return makeVar(this, label);
    }
    toConst(label?: string): LetNode<D> {
        return makeLet(this, label);
    }

    addAssign<N extends Node<Any> | ArithLiteral<D>>(v: N): void {
        addToStack(new AssignNode(this, add(this, v as Node<Any>) as unknown as Node<D>));
    }
    subAssign<N extends Node<Any> | ArithLiteral<D>>(v: N): void {
        addToStack(new AssignNode(this, sub(this, v as Node<Any>) as unknown as Node<D>));
    }
    mulAssign<N extends Node<Any> | MulLiteral<D>>(v: N): void {
        addToStack(new AssignNode(this, mul(this, v as Node<Any>) as unknown as Node<D>));
    }
    divAssign<N extends Node<Any> | ArithLiteral<D>>(v: N): void {
        addToStack(new AssignNode(this, div(this, v as Node<Any>) as unknown as Node<D>));
    }

    sign(): Node<D> {
        return sign(this) as Node<D>;
    }
    round(): Node<D> {
        return round(this) as Node<D>;
    }
    saturate(): Node<D> {
        return saturate(this) as Node<D>;
    }
    reflect(n: Node<D>): Node<D> {
        return reflect(this, n) as Node<D>;
    }
    refract(n: Node<D>, eta: Node<VecElementDesc<D>> | number): Node<D> {
        return refract(this, n, eta) as Node<D>;
    }
    faceForward(i: Node<D>, nref: Node<D>): Node<D> {
        return faceForward(this, i, nref) as Node<D>;
    }
    mod<N extends Node<Any> | ArithLiteral<D>>(b: N): Node<ArithResultDesc<D, OperandDesc<N, D>>> {
        return mod(this, b as Node<Any>) as unknown as Node<ArithResultDesc<D, OperandDesc<N, D>>>;
    }

    /** `1 - this`, the 1 taking this node's element type */
    oneMinus(): Node<D> {
        return sub(1, this as Node<Any>) as unknown as Node<D>;
    }

    or(b: Node<d.bool> | boolean): Node<d.bool> {
        return or(this as unknown as Node<d.bool>, b);
    }
    and(b: Node<d.bool> | boolean): Node<d.bool> {
        return and(this as unknown as Node<d.bool>, b);
    }
    not(): Node<d.bool> {
        return not(this as unknown as Node<d.bool>);
    }

    bitwiseAnd(b: Node<D> | ScalarLiteral<D>): Node<D> {
        return bitwiseAnd(this, b);
    }
    bitwiseOr(b: Node<D> | ScalarLiteral<D>): Node<D> {
        return bitwiseOr(this, b);
    }
    bitwiseXor(b: Node<D> | ScalarLiteral<D>): Node<D> {
        return bitwiseXor(this, b);
    }
    shiftLeft(b: Node<ShiftAmount<D>> | ShiftLiteral<D>): Node<D> {
        return shiftLeft(this, b);
    }
    shiftRight(b: Node<ShiftAmount<D>> | ShiftLiteral<D>): Node<D> {
        return shiftRight(this, b);
    }

    transpose(): Node<D> {
        return new CallNode(this.type, 'transpose', [this]) as unknown as Node<D>;
    }

    // ── Swizzles ──────────────────────────────────────────────────────────────
    get x(): Node<VecElementDesc<D>> {
        return new FieldNode(d.vecElementDescOrSelf(this.type), this, 'x') as unknown as Node<VecElementDesc<D>>;
    }
    get y(): Node<VecElementDesc<D>> {
        return new FieldNode(d.vecElementDescOrSelf(this.type), this, 'y') as unknown as Node<VecElementDesc<D>>;
    }
    get z(): Node<VecElementDesc<D>> {
        return new FieldNode(d.vecElementDescOrSelf(this.type), this, 'z') as unknown as Node<VecElementDesc<D>>;
    }
    get w(): Node<VecElementDesc<D>> {
        return new FieldNode(d.vecElementDescOrSelf(this.type), this, 'w') as unknown as Node<VecElementDesc<D>>;
    }
    get r(): Node<VecElementDesc<D>> {
        return new FieldNode(d.vecElementDescOrSelf(this.type), this, 'x') as unknown as Node<VecElementDesc<D>>;
    }
    get g(): Node<VecElementDesc<D>> {
        return new FieldNode(d.vecElementDescOrSelf(this.type), this, 'y') as unknown as Node<VecElementDesc<D>>;
    }
    get b(): Node<VecElementDesc<D>> {
        return new FieldNode(d.vecElementDescOrSelf(this.type), this, 'z') as unknown as Node<VecElementDesc<D>>;
    }
    get a(): Node<VecElementDesc<D>> {
        return new FieldNode(d.vecElementDescOrSelf(this.type), this, 'w') as unknown as Node<VecElementDesc<D>>;
    }

    get xx(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'xx') as unknown as Node<Vec2DescOf<D>>;
    }
    get xy(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'xy') as unknown as Node<Vec2DescOf<D>>;
    }
    get xz(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'xz') as unknown as Node<Vec2DescOf<D>>;
    }
    get xw(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'xw') as unknown as Node<Vec2DescOf<D>>;
    }
    get yx(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'yx') as unknown as Node<Vec2DescOf<D>>;
    }
    get yy(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'yy') as unknown as Node<Vec2DescOf<D>>;
    }
    get yz(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'yz') as unknown as Node<Vec2DescOf<D>>;
    }
    get yw(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'yw') as unknown as Node<Vec2DescOf<D>>;
    }
    get zx(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'zx') as unknown as Node<Vec2DescOf<D>>;
    }
    get zy(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'zy') as unknown as Node<Vec2DescOf<D>>;
    }
    get zz(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'zz') as unknown as Node<Vec2DescOf<D>>;
    }
    get zw(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'zw') as unknown as Node<Vec2DescOf<D>>;
    }
    get wx(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'wx') as unknown as Node<Vec2DescOf<D>>;
    }
    get wy(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'wy') as unknown as Node<Vec2DescOf<D>>;
    }
    get wz(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'wz') as unknown as Node<Vec2DescOf<D>>;
    }
    get ww(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'ww') as unknown as Node<Vec2DescOf<D>>;
    }
    get rr(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'xx') as unknown as Node<Vec2DescOf<D>>;
    }
    get rg(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'xy') as unknown as Node<Vec2DescOf<D>>;
    }
    get rb(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'xz') as unknown as Node<Vec2DescOf<D>>;
    }
    get ra(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'xw') as unknown as Node<Vec2DescOf<D>>;
    }
    get gr(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'yx') as unknown as Node<Vec2DescOf<D>>;
    }
    get gg(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'yy') as unknown as Node<Vec2DescOf<D>>;
    }
    get gb(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'yz') as unknown as Node<Vec2DescOf<D>>;
    }
    get ga(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'yw') as unknown as Node<Vec2DescOf<D>>;
    }
    get br(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'zx') as unknown as Node<Vec2DescOf<D>>;
    }
    get bg(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'zy') as unknown as Node<Vec2DescOf<D>>;
    }
    get bb(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'zz') as unknown as Node<Vec2DescOf<D>>;
    }
    get ba(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'zw') as unknown as Node<Vec2DescOf<D>>;
    }
    get ar(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'wx') as unknown as Node<Vec2DescOf<D>>;
    }
    get ag(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'wy') as unknown as Node<Vec2DescOf<D>>;
    }
    get ab(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'wz') as unknown as Node<Vec2DescOf<D>>;
    }
    get aa(): Node<Vec2DescOf<D>> {
        return new FieldNode(d.vec2DescOf(this.type), this, 'ww') as unknown as Node<Vec2DescOf<D>>;
    }

    get xxx(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xxx') as unknown as Node<Vec3DescOf<D>>;
    }
    get xxy(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xxy') as unknown as Node<Vec3DescOf<D>>;
    }
    get xxz(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xxz') as unknown as Node<Vec3DescOf<D>>;
    }
    get xxw(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xxw') as unknown as Node<Vec3DescOf<D>>;
    }
    get xyx(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xyx') as unknown as Node<Vec3DescOf<D>>;
    }
    get xyy(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xyy') as unknown as Node<Vec3DescOf<D>>;
    }
    get xyz(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xyz') as unknown as Node<Vec3DescOf<D>>;
    }
    get xyw(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xyw') as unknown as Node<Vec3DescOf<D>>;
    }
    get xzx(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xzx') as unknown as Node<Vec3DescOf<D>>;
    }
    get xzy(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xzy') as unknown as Node<Vec3DescOf<D>>;
    }
    get xzz(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xzz') as unknown as Node<Vec3DescOf<D>>;
    }
    get xzw(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xzw') as unknown as Node<Vec3DescOf<D>>;
    }
    get xwx(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xwx') as unknown as Node<Vec3DescOf<D>>;
    }
    get xwy(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xwy') as unknown as Node<Vec3DescOf<D>>;
    }
    get xwz(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xwz') as unknown as Node<Vec3DescOf<D>>;
    }
    get xww(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xww') as unknown as Node<Vec3DescOf<D>>;
    }
    get yxx(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yxx') as unknown as Node<Vec3DescOf<D>>;
    }
    get yxy(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yxy') as unknown as Node<Vec3DescOf<D>>;
    }
    get yxz(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yxz') as unknown as Node<Vec3DescOf<D>>;
    }
    get yxw(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yxw') as unknown as Node<Vec3DescOf<D>>;
    }
    get yyx(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yyx') as unknown as Node<Vec3DescOf<D>>;
    }
    get yyy(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yyy') as unknown as Node<Vec3DescOf<D>>;
    }
    get yyz(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yyz') as unknown as Node<Vec3DescOf<D>>;
    }
    get yyw(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yyw') as unknown as Node<Vec3DescOf<D>>;
    }
    get yzx(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yzx') as unknown as Node<Vec3DescOf<D>>;
    }
    get yzy(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yzy') as unknown as Node<Vec3DescOf<D>>;
    }
    get yzz(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yzz') as unknown as Node<Vec3DescOf<D>>;
    }
    get yzw(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yzw') as unknown as Node<Vec3DescOf<D>>;
    }
    get ywx(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'ywx') as unknown as Node<Vec3DescOf<D>>;
    }
    get ywy(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'ywy') as unknown as Node<Vec3DescOf<D>>;
    }
    get ywz(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'ywz') as unknown as Node<Vec3DescOf<D>>;
    }
    get yww(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yww') as unknown as Node<Vec3DescOf<D>>;
    }
    get zxx(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zxx') as unknown as Node<Vec3DescOf<D>>;
    }
    get zxy(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zxy') as unknown as Node<Vec3DescOf<D>>;
    }
    get zxz(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zxz') as unknown as Node<Vec3DescOf<D>>;
    }
    get zxw(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zxw') as unknown as Node<Vec3DescOf<D>>;
    }
    get zyx(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zyx') as unknown as Node<Vec3DescOf<D>>;
    }
    get zyy(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zyy') as unknown as Node<Vec3DescOf<D>>;
    }
    get zyz(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zyz') as unknown as Node<Vec3DescOf<D>>;
    }
    get zyw(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zyw') as unknown as Node<Vec3DescOf<D>>;
    }
    get zzx(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zzx') as unknown as Node<Vec3DescOf<D>>;
    }
    get zzy(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zzy') as unknown as Node<Vec3DescOf<D>>;
    }
    get zzz(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zzz') as unknown as Node<Vec3DescOf<D>>;
    }
    get zzw(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zzw') as unknown as Node<Vec3DescOf<D>>;
    }
    get zwx(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zwx') as unknown as Node<Vec3DescOf<D>>;
    }
    get zwy(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zwy') as unknown as Node<Vec3DescOf<D>>;
    }
    get zwz(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zwz') as unknown as Node<Vec3DescOf<D>>;
    }
    get zww(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zww') as unknown as Node<Vec3DescOf<D>>;
    }
    get wxx(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wxx') as unknown as Node<Vec3DescOf<D>>;
    }
    get wxy(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wxy') as unknown as Node<Vec3DescOf<D>>;
    }
    get wxz(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wxz') as unknown as Node<Vec3DescOf<D>>;
    }
    get wxw(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wxw') as unknown as Node<Vec3DescOf<D>>;
    }
    get wyx(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wyx') as unknown as Node<Vec3DescOf<D>>;
    }
    get wyy(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wyy') as unknown as Node<Vec3DescOf<D>>;
    }
    get wyz(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wyz') as unknown as Node<Vec3DescOf<D>>;
    }
    get wyw(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wyw') as unknown as Node<Vec3DescOf<D>>;
    }
    get wzx(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wzx') as unknown as Node<Vec3DescOf<D>>;
    }
    get wzy(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wzy') as unknown as Node<Vec3DescOf<D>>;
    }
    get wzz(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wzz') as unknown as Node<Vec3DescOf<D>>;
    }
    get wzw(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wzw') as unknown as Node<Vec3DescOf<D>>;
    }
    get wwx(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wwx') as unknown as Node<Vec3DescOf<D>>;
    }
    get wwy(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wwy') as unknown as Node<Vec3DescOf<D>>;
    }
    get wwz(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wwz') as unknown as Node<Vec3DescOf<D>>;
    }
    get www(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'www') as unknown as Node<Vec3DescOf<D>>;
    }
    get rrr(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xxx') as unknown as Node<Vec3DescOf<D>>;
    }
    get rrg(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xxy') as unknown as Node<Vec3DescOf<D>>;
    }
    get rrb(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xxz') as unknown as Node<Vec3DescOf<D>>;
    }
    get rra(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xxw') as unknown as Node<Vec3DescOf<D>>;
    }
    get rgr(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xyx') as unknown as Node<Vec3DescOf<D>>;
    }
    get rgg(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xyy') as unknown as Node<Vec3DescOf<D>>;
    }
    get rgb(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xyz') as unknown as Node<Vec3DescOf<D>>;
    }
    get rga(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xyw') as unknown as Node<Vec3DescOf<D>>;
    }
    get rbr(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xzx') as unknown as Node<Vec3DescOf<D>>;
    }
    get rbg(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xzy') as unknown as Node<Vec3DescOf<D>>;
    }
    get rbb(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xzz') as unknown as Node<Vec3DescOf<D>>;
    }
    get rba(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xzw') as unknown as Node<Vec3DescOf<D>>;
    }
    get rar(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xwx') as unknown as Node<Vec3DescOf<D>>;
    }
    get rag(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xwy') as unknown as Node<Vec3DescOf<D>>;
    }
    get rab(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xwz') as unknown as Node<Vec3DescOf<D>>;
    }
    get raa(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'xww') as unknown as Node<Vec3DescOf<D>>;
    }
    get grr(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yxx') as unknown as Node<Vec3DescOf<D>>;
    }
    get grg(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yxy') as unknown as Node<Vec3DescOf<D>>;
    }
    get grb(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yxz') as unknown as Node<Vec3DescOf<D>>;
    }
    get gra(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yxw') as unknown as Node<Vec3DescOf<D>>;
    }
    get ggr(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yyx') as unknown as Node<Vec3DescOf<D>>;
    }
    get ggg(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yyy') as unknown as Node<Vec3DescOf<D>>;
    }
    get ggb(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yyz') as unknown as Node<Vec3DescOf<D>>;
    }
    get gga(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yyw') as unknown as Node<Vec3DescOf<D>>;
    }
    get gbr(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yzx') as unknown as Node<Vec3DescOf<D>>;
    }
    get gbg(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yzy') as unknown as Node<Vec3DescOf<D>>;
    }
    get gbb(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yzz') as unknown as Node<Vec3DescOf<D>>;
    }
    get gba(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yzw') as unknown as Node<Vec3DescOf<D>>;
    }
    get gar(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'ywx') as unknown as Node<Vec3DescOf<D>>;
    }
    get gag(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'ywy') as unknown as Node<Vec3DescOf<D>>;
    }
    get gab(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'ywz') as unknown as Node<Vec3DescOf<D>>;
    }
    get gaa(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'yww') as unknown as Node<Vec3DescOf<D>>;
    }
    get brr(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zxx') as unknown as Node<Vec3DescOf<D>>;
    }
    get brg(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zxy') as unknown as Node<Vec3DescOf<D>>;
    }
    get brb(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zxz') as unknown as Node<Vec3DescOf<D>>;
    }
    get bra(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zxw') as unknown as Node<Vec3DescOf<D>>;
    }
    get bgr(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zyx') as unknown as Node<Vec3DescOf<D>>;
    }
    get bgg(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zyy') as unknown as Node<Vec3DescOf<D>>;
    }
    get bgb(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zyz') as unknown as Node<Vec3DescOf<D>>;
    }
    get bga(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zyw') as unknown as Node<Vec3DescOf<D>>;
    }
    get bbr(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zzx') as unknown as Node<Vec3DescOf<D>>;
    }
    get bbg(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zzy') as unknown as Node<Vec3DescOf<D>>;
    }
    get bbb(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zzz') as unknown as Node<Vec3DescOf<D>>;
    }
    get bba(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zzw') as unknown as Node<Vec3DescOf<D>>;
    }
    get bar(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zwx') as unknown as Node<Vec3DescOf<D>>;
    }
    get bag(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zwy') as unknown as Node<Vec3DescOf<D>>;
    }
    get bab(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zwz') as unknown as Node<Vec3DescOf<D>>;
    }
    get baa(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'zww') as unknown as Node<Vec3DescOf<D>>;
    }
    get arr(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wxx') as unknown as Node<Vec3DescOf<D>>;
    }
    get arg(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wxy') as unknown as Node<Vec3DescOf<D>>;
    }
    get arb(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wxz') as unknown as Node<Vec3DescOf<D>>;
    }
    get ara(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wxw') as unknown as Node<Vec3DescOf<D>>;
    }
    get agr(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wyx') as unknown as Node<Vec3DescOf<D>>;
    }
    get agg(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wyy') as unknown as Node<Vec3DescOf<D>>;
    }
    get agb(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wyz') as unknown as Node<Vec3DescOf<D>>;
    }
    get aga(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wyw') as unknown as Node<Vec3DescOf<D>>;
    }
    get abr(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wzx') as unknown as Node<Vec3DescOf<D>>;
    }
    get abg(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wzy') as unknown as Node<Vec3DescOf<D>>;
    }
    get abb(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wzz') as unknown as Node<Vec3DescOf<D>>;
    }
    get aba(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wzw') as unknown as Node<Vec3DescOf<D>>;
    }
    get aar(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wwx') as unknown as Node<Vec3DescOf<D>>;
    }
    get aag(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wwy') as unknown as Node<Vec3DescOf<D>>;
    }
    get aab(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'wwz') as unknown as Node<Vec3DescOf<D>>;
    }
    get aaa(): Node<Vec3DescOf<D>> {
        return new FieldNode(d.vec3DescOf(this.type), this, 'www') as unknown as Node<Vec3DescOf<D>>;
    }

    get xyzw(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'xyzw') as unknown as Node<Vec4DescOf<D>>;
    }
    get xywz(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'xywz') as unknown as Node<Vec4DescOf<D>>;
    }
    get xzyw(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'xzyw') as unknown as Node<Vec4DescOf<D>>;
    }
    get xzwy(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'xzwy') as unknown as Node<Vec4DescOf<D>>;
    }
    get xwyz(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'xwyz') as unknown as Node<Vec4DescOf<D>>;
    }
    get xwzy(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'xwzy') as unknown as Node<Vec4DescOf<D>>;
    }
    get yxzw(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'yxzw') as unknown as Node<Vec4DescOf<D>>;
    }
    get yxwz(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'yxwz') as unknown as Node<Vec4DescOf<D>>;
    }
    get yzxw(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'yzxw') as unknown as Node<Vec4DescOf<D>>;
    }
    get yzwx(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'yzwx') as unknown as Node<Vec4DescOf<D>>;
    }
    get ywxz(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'ywxz') as unknown as Node<Vec4DescOf<D>>;
    }
    get ywzx(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'ywzx') as unknown as Node<Vec4DescOf<D>>;
    }
    get zxyw(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'zxyw') as unknown as Node<Vec4DescOf<D>>;
    }
    get zxwy(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'zxwy') as unknown as Node<Vec4DescOf<D>>;
    }
    get zyxw(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'zyxw') as unknown as Node<Vec4DescOf<D>>;
    }
    get zywx(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'zywx') as unknown as Node<Vec4DescOf<D>>;
    }
    get zwxy(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'zwxy') as unknown as Node<Vec4DescOf<D>>;
    }
    get zwyx(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'zwyx') as unknown as Node<Vec4DescOf<D>>;
    }
    get wxyz(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'wxyz') as unknown as Node<Vec4DescOf<D>>;
    }
    get wxzy(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'wxzy') as unknown as Node<Vec4DescOf<D>>;
    }
    get wyxz(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'wyxz') as unknown as Node<Vec4DescOf<D>>;
    }
    get wyzx(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'wyzx') as unknown as Node<Vec4DescOf<D>>;
    }
    get wzxy(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'wzxy') as unknown as Node<Vec4DescOf<D>>;
    }
    get wzyx(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'wzyx') as unknown as Node<Vec4DescOf<D>>;
    }
    get rgba(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'xyzw') as unknown as Node<Vec4DescOf<D>>;
    }
    get rgab(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'xywz') as unknown as Node<Vec4DescOf<D>>;
    }
    get rbga(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'xzyw') as unknown as Node<Vec4DescOf<D>>;
    }
    get rbag(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'xzwy') as unknown as Node<Vec4DescOf<D>>;
    }
    get ragb(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'xwyz') as unknown as Node<Vec4DescOf<D>>;
    }
    get rabg(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'xwzy') as unknown as Node<Vec4DescOf<D>>;
    }
    get grba(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'yxzw') as unknown as Node<Vec4DescOf<D>>;
    }
    get grab(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'yxwz') as unknown as Node<Vec4DescOf<D>>;
    }
    get gbra(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'yzxw') as unknown as Node<Vec4DescOf<D>>;
    }
    get gbar(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'yzwx') as unknown as Node<Vec4DescOf<D>>;
    }
    get garb(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'ywxz') as unknown as Node<Vec4DescOf<D>>;
    }
    get gabr(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'ywzx') as unknown as Node<Vec4DescOf<D>>;
    }
    get brga(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'zxyw') as unknown as Node<Vec4DescOf<D>>;
    }
    get brag(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'zxwy') as unknown as Node<Vec4DescOf<D>>;
    }
    get bgra(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'zyxw') as unknown as Node<Vec4DescOf<D>>;
    }
    get bgar(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'zywx') as unknown as Node<Vec4DescOf<D>>;
    }
    get barg(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'zwxy') as unknown as Node<Vec4DescOf<D>>;
    }
    get bagr(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'zwyx') as unknown as Node<Vec4DescOf<D>>;
    }
    get argb(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'wxyz') as unknown as Node<Vec4DescOf<D>>;
    }
    get arbg(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'wxzy') as unknown as Node<Vec4DescOf<D>>;
    }
    get agrb(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'wyxz') as unknown as Node<Vec4DescOf<D>>;
    }
    get agbr(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'wyzx') as unknown as Node<Vec4DescOf<D>>;
    }
    get abrg(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'wzxy') as unknown as Node<Vec4DescOf<D>>;
    }
    get abgr(): Node<Vec4DescOf<D>> {
        return new FieldNode(d.vec4DescOf(this.type), this, 'wzyx') as unknown as Node<Vec4DescOf<D>>;
    }

    // ── Inspector ─────────────────────────────────────────────────────────────
    inspect(name?: string): this {
        const inspector = new InspectorNode<Any>(this, name);
        this.before(inspector);
        return this;
    }
}

export function isNode(v: unknown): v is Node<Any> {
    return v instanceof Node;
}

/**
 * Creates an empty lifecycle node.
 * Useful for attaching update callbacks via .onFrameUpdate(), .onRenderUpdate(), etc.
 * Attach to other nodes via .before() to ensure the lifecycle runs.
 *
 * @example
 * const updater = node().onFrameUpdate(() => {
 *     myUniform.value = computeValue();
 * });
 * return myOutputNode.before(updater);
 */
export function node(): Node<d.Void> {
    return new Node(d.Void);
}

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
    readonly kind = NodeKind.Inspector;
    /** The original node being inspected. */
    readonly wrappedNode: Node<D>;

    /** Display name for the inspector UI. */
    readonly inspectorName: string;

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
        const inspector = frame.renderer!.inspector;
        if (inspector) inspector.inspect(this.wrappedNode, this.inspectorName);
    };

    /**
     * Returns the display name for the inspector.
     */
    getName(): string {
        return this.inspectorName;
    }
}

// ─── Expr nodes ───────────────────────────────────────────────────────────────

export class LiteralNode<D extends Any> extends Node<D> {
    readonly kind = NodeKind.Literal;
    constructor(
        type: D,
        readonly value: number | number[] | string,
    ) {
        super(type);
    }
}

/**
 * `label` is what the author called the value, not its shader identifier — the emitters allocate that
 * per function scope, so the same name can be requested twice without the graph having to disambiguate.
 * Undefined for an unnamed `.toVar()` / `.toConst()`.
 */
export class LetNode<D extends Any> extends Node<D> {
    readonly kind = NodeKind.Let;
    constructor(
        type: D,
        readonly label: string | undefined,
        readonly init: Node<D>,
    ) {
        super(type);
    }
}

export class VarNode<D extends Any> extends Node<D> {
    readonly kind = NodeKind.Var;
    constructor(
        type: D,
        readonly label: string | undefined,
        readonly init: Node<D>,
    ) {
        super(type);
    }
}

// ─── Module-scope variables ───────────────────────────────────────────────────

/**
 * Module-scope private variable: `var<private> name: T [= init];`
 *
 * Private variables are per-invocation storage at module scope.
 * Unlike function-scope variables, they persist across function calls
 * within the same shader invocation.
 *
 * @example
 * const counter = PrivateVar('counter', d.u32);
 * // → var<private> counter: u32;
 *
 * const gravity = PrivateVar('gravity', vec3f(0, -9.8, 0));
 * // → var<private> gravity: vec3f = vec3f(0.0, -9.8, 0.0);
 */
export class PrivateVarNode<D extends Any> extends Node<D> {
    readonly kind = NodeKind.PrivateVar;
    constructor(
        type: D,
        readonly varName: string,
        readonly init?: Node<D>,
    ) {
        super(type);
    }
}

/**
 * Module-scope workgroup variable: `var<workgroup> name: T;`
 *
 * Workgroup variables are shared across all invocations in a workgroup.
 * Only valid in compute shaders. Cannot have an initializer.
 *
 * @example
 * const shared = WorkgroupVar('sharedData', d.array(d.f32, 256));
 * // → var<workgroup> sharedData: array<f32, 256>;
 */
export class WorkgroupVarNode<D extends Any> extends Node<D> {
    readonly kind = NodeKind.WorkgroupVar;
    constructor(
        type: D,
        readonly varName: string,
    ) {
        super(type);
    }
}

export class AssignNode extends Node<d.Void> {
    readonly kind = NodeKind.Assign;
    constructor(
        readonly target: Node<Any>,
        readonly value: Node<Any>,
    ) {
        super(d.Void);
    }
}

export class BinaryOpNode<D extends Any> extends Node<D> {
    readonly kind = NodeKind.BinaryOp;
    constructor(
        readonly op: BinaryOp,
        type: D,
        readonly left: Node<Any>,
        readonly right: Node<Any>,
        /** An integer `/` or `%` whose divisor can't be zero (a texture's width), so GLSL needs no WGSL guard. */
        readonly divisorNonzero = false,
    ) {
        super(type);
    }
}

/** Opaque reference to WgslFunctionNode to avoid circular import */
export interface WgslFunctionNodeRef {
    readonly code: string;
    /** GLSL companion source (complete function definition). Undefined for WGSL-only functions. */
    readonly glslCode?: string;
    readonly includes: WgslFunctionNodeRef[];
    getNodeFunction(): { outputType: string; name: string };
}

export class CallNode<D extends Any> extends Node<D> {
    readonly kind = NodeKind.Call;
    readonly fnNode?: FnNode<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    readonly wgslFnNode?: WgslFunctionNodeRef;
    constructor(
        type: D,
        readonly fn: string,
        readonly args: Node<Any>[],
        fnNode?: FnNode<any>,
        wgslFnNode?: WgslFunctionNodeRef,
    ) {
        super(type);
        this.fnNode = fnNode;
        this.wgslFnNode = wgslFnNode;
    }
}

export class ConstructNode<D extends Any> extends Node<D> {
    readonly kind = NodeKind.Construct;
    constructor(
        type: D,
        readonly args: Node<Any>[],
    ) {
        super(type);
    }
}

export class FieldNode<D extends Any> extends Node<D> {
    readonly kind = NodeKind.Field;
    constructor(
        type: D,
        readonly object: Node<Any>,
        readonly fieldName: string,
    ) {
        super(type);
    }
}

/**
 * Represents an inline fixed-size array expression in WGSL.
 *
 * Use `array([e0, e1, e2])` to construct, then `.element(idx)` to index into it.
 * This corresponds to WGSL's array value constructor expression.
 */
export class ArrayNode<E extends Any> extends Node<{
    readonly type: 'sized-array';
    readonly wgslType: `array<${string}, ${number}>`;
    readonly element: E;
    readonly length: number;
}> {
    readonly kind = NodeKind.Array;
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
    readonly kind = NodeKind.Index;
    constructor(
        type: D,
        readonly array: Node<Any>,
        readonly index: Node<Any>,
    ) {
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

export const index = <N extends Node<Any>>(array: N, idx: Node<Any>): Node<d.ElementOf<N['type']>> => {
    const t = array.type;
    let elementDesc: Any;
    if (t.type === 'array' || t.type === 'sized-array') {
        elementDesc = t.element;
    } else if (d.isMatDesc(t)) {
        elementDesc = d.matColumnDesc(t);
    } else if (d.isVecDesc(t)) {
        elementDesc = d.vecElementDescOrSelf(t);
    } else {
        throw new Error(
            `[gpucat] Cannot index into type '${t.wgslType}', only array, matrix, and vector types support indexing.`,
        );
    }
    return new IndexNode(elementDesc, array, idx) as unknown as Node<d.ElementOf<N['type']>>;
};

export type Fields<S extends d.StructSchema> = StructInstance<S>;

/**
 * Create field accessor object for a struct node.
 * Returns an object with typed Node properties for each field plus the $node reference.
 *
 * @example
 * const particle = index(particleBuffer, computeIndex);
 * const { position, velocity } = fields(particle);
 * position.assign(newPos);
 */
export function fields<S extends d.StructSchema>(node: Node<StructDef<S>>): Fields<S>;
export function fields<S extends d.StructSchema>(node: Node<d.StructDesc<S>>): Fields<S>;
export function fields<S extends d.StructSchema>(node: Node<d.StructDesc<S>>): StructInstance<S> {
    const desc = node.type;
    if (!desc || typeof desc !== 'object' || !('fields' in desc)) {
        throw new Error('[gpucat] fields() requires a struct-typed node');
    }
    const structFields = (desc as { fields: d.StructSchema }).fields;
    const result: Record<string, Node<Any>> = { $node: node as unknown as Node<d.StructDesc> };
    for (const [fieldName, fieldDesc] of Object.entries(structFields)) {
        result[fieldName] = new FieldNode(fieldDesc as Any, node, fieldName);
    }
    return result as StructInstance<S>;
}

// Length-preserving numeric conversions (see the method forms above): a vecN converts to vecN, not a
// scalar, so `vec3i.toF32()` emits `vec3f(...)` rather than the illegal `f32(vec3i)`.
export const toF32 = <D extends Any>(node: Node<D>): Node<NumericDescOf<D, d.f32>> => {
    const t = d.numericDescOf(node.type, 'f32');
    return new CallNode(t, t.wgslType, [node]) as unknown as Node<NumericDescOf<D, d.f32>>;
};
export const toF16 = <D extends Any>(node: Node<D>): Node<NumericDescOf<D, d.f16>> => {
    const t = d.numericDescOf(node.type, 'f16');
    return new CallNode(t, t.wgslType, [node]) as unknown as Node<NumericDescOf<D, d.f16>>;
};
export const toU32 = <D extends Any>(node: Node<D>): Node<NumericDescOf<D, d.u32>> => {
    const t = d.numericDescOf(node.type, 'u32');
    return new CallNode(t, t.wgslType, [node]) as unknown as Node<NumericDescOf<D, d.u32>>;
};
export const toI32 = <D extends Any>(node: Node<D>): Node<NumericDescOf<D, d.i32>> => {
    const t = d.numericDescOf(node.type, 'i32');
    return new CallNode(t, t.wgslType, [node]) as unknown as Node<NumericDescOf<D, d.i32>>;
};

/** Reinterpret a u32 or i32 bit pattern as f32. WGSL: `bitcast<f32>(x)`. */
export const bitcastF32 = (node: Node<d.u32 | d.i32>): Node<d.f32> => new CallNode(d.f32, 'bitcast<f32>', [node]);
/** Reinterpret an f32 or i32 bit pattern as u32. WGSL: `bitcast<u32>(x)`. */
export const bitcastU32 = (node: Node<d.f32 | d.i32>): Node<d.u32> => new CallNode(d.u32, 'bitcast<u32>', [node]);
/** Reinterpret an f32 or u32 bit pattern as i32. WGSL: `bitcast<i32>(x)`. */
export const bitcastI32 = (node: Node<d.f32 | d.u32>): Node<d.i32> => new CallNode(d.i32, 'bitcast<i32>', [node]);

/** A comparison of two values of one type; a number on either side takes a scalar node's type. */
export type Compare = {
    <D extends Any>(a: Node<D>, b: Node<D> | ScalarLiteral<D>): Node<CompareResultDesc<D>>;
    <D extends Any>(a: ScalarLiteral<D>, b: Node<D>): Node<CompareResultDesc<D>>;
};
const compare =
    (op: BinaryOp, name: string): Compare =>
    (a: Operand, b: Operand) => {
        const [l, r] = sameTypeOperands(name, [a, b]) as [Node<Any>, Node<Any>];
        return new BinaryOpNode(op, d.compareResultDesc(l.type), l, r) as never;
    };
export const greaterThan: Compare = /*@__PURE__*/ compare('>', 'greaterThan');
export const lessThan: Compare = /*@__PURE__*/ compare('<', 'lessThan');
export const greaterThanEqual: Compare = /*@__PURE__*/ compare('>=', 'greaterThanEqual');
export const lessThanEqual: Compare = /*@__PURE__*/ compare('<=', 'lessThanEqual');
export const equal: Compare = /*@__PURE__*/ compare('==', 'equal');
export const notEqual: Compare = /*@__PURE__*/ compare('!=', 'notEqual');

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
export function array<E extends Any>(
    elements: [Node<E>, ...Node<E>[]],
): Node<{
    readonly type: 'sized-array';
    readonly wgslType: `array<${string}, ${number}>`;
    readonly element: E;
    readonly length: number;
}> {
    return new ArrayNode(elements[0].type, elements) as unknown as Node<{
        readonly type: 'sized-array';
        readonly wgslType: `array<${string}, ${number}>`;
        readonly element: E;
        readonly length: number;
    }>;
}

// ── Const constructors ────────────────────────────────────────────────────────

export function f32(v?: number): LiteralNode<d.f32>;
export function f32(v: Node<Any>): Node<d.f32>;
export function f32(v: number | Node<Any> = 0): LiteralNode<d.f32> | Node<d.f32> {
    if (isNode(v)) return new CallNode(d.f32, 'f32', [v]);
    return new LiteralNode(d.f32, v);
}

export function f16(v?: number): LiteralNode<d.f16>;
export function f16(v: Node<Any>): Node<d.f16>;
export function f16(v: number | Node<Any> = 0): LiteralNode<d.f16> | Node<d.f16> {
    if (isNode(v)) return new CallNode(d.f16, 'f16', [v]);
    return new LiteralNode(d.f16, v);
}

export function i32(v?: number): LiteralNode<d.i32>;
export function i32(v: Node<Any>): Node<d.i32>;
export function i32(v: number | Node<Any> = 0): LiteralNode<d.i32> | Node<d.i32> {
    if (isNode(v)) return new CallNode(d.i32, 'i32', [v]);
    return new LiteralNode(d.i32, convertedInteger(v, 'i32'));
}

export function u32(v?: number): LiteralNode<d.u32>;
export function u32(v: Node<Any>): Node<d.u32>;
export function u32(v: number | Node<Any> = 0): LiteralNode<d.u32> | Node<d.u32> {
    if (isNode(v)) return new CallNode(d.u32, 'u32', [v]);
    return new LiteralNode(d.u32, convertedInteger(v, 'u32'));
}

export const bool = (v: boolean): LiteralNode<d.bool> => new LiteralNode(d.bool, v ? 1 : 0);

type Scalar = Node<Any> | number | boolean;
type ScalarElemType = 'f32' | 'f16' | 'i32' | 'u32' | 'bool';

function wrapScalar(v: Scalar, elemType: ScalarElemType): Node<Any> {
    if (isNode(v)) return v;
    if (elemType === 'bool') return new LiteralNode(d.bool, (v as boolean | number) ? 1 : 0);
    if (elemType === 'i32') return new LiteralNode(d.i32, convertedInteger(v as number, 'i32'));
    if (elemType === 'u32') return new LiteralNode(d.u32, convertedInteger(v as number, 'u32'));
    if (elemType === 'f16') return new LiteralNode(d.f16, v as number);
    return new LiteralNode(d.f32, v as number);
}
function elemOf(type: Vec2Type | Vec3Type | Vec4Type): ScalarElemType {
    if (type.endsWith('h')) return 'f16';
    if (type.endsWith('f')) return 'f32';
    if (type.endsWith('i')) return 'i32';
    if (type.endsWith('u')) return 'u32';
    return 'bool';
}

export function makeVec2<D extends d.Vec2>(desc: D) {
    const e = elemOf(desc.wgslType);
    function ctor(v: Scalar): ConstructNode<D>;
    function ctor(x: Scalar, y: Scalar): ConstructNode<D>;
    function ctor(a: Scalar, b?: Scalar): ConstructNode<D> {
        if (b === undefined) return new ConstructNode(desc, [wrapScalar(a, e)]);
        return new ConstructNode(desc, [wrapScalar(a, e), wrapScalar(b, e)]);
    }
    return ctor;
}
export function makeVec3<D extends d.Vec3>(desc: D) {
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
export function makeVec4<D extends d.Vec4>(desc: D) {
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

export const vec2 = makeVec2(d.vec2f);
export const vec3 = makeVec3(d.vec3f);
export const vec4 = makeVec4(d.vec4f);
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

export const mat2x2f = (...v: number[]): LiteralNode<d.mat2x2f> => new LiteralNode(d.mat2x2f, v.length ? v : []);
export const mat2x3f = (...v: number[]): LiteralNode<d.mat2x3f> => new LiteralNode(d.mat2x3f, v.length ? v : []);
export const mat2x4f = (...v: number[]): LiteralNode<d.mat2x4f> => new LiteralNode(d.mat2x4f, v.length ? v : []);
export const mat3x2f = (...v: number[]): LiteralNode<d.mat3x2f> => new LiteralNode(d.mat3x2f, v.length ? v : []);
export const mat3x3f = (...v: number[]): LiteralNode<d.mat3x3f> => new LiteralNode(d.mat3x3f, v.length ? v : []);
export const mat3x4f = (...v: number[]): LiteralNode<d.mat3x4f> => new LiteralNode(d.mat3x4f, v.length ? v : []);
export const mat4x2f = (...v: number[]): LiteralNode<d.mat4x2f> => new LiteralNode(d.mat4x2f, v.length ? v : []);
export const mat4x3f = (...v: number[]): LiteralNode<d.mat4x3f> => new LiteralNode(d.mat4x3f, v.length ? v : []);
export const mat4x4f = (...v: number[]): LiteralNode<d.mat4x4f> => new LiteralNode(d.mat4x4f, v.length ? v : []);
export const mat2x2h = (...v: number[]): LiteralNode<d.mat2x2h> => new LiteralNode(d.mat2x2h, v.length ? v : []);
export const mat2x3h = (...v: number[]): LiteralNode<d.mat2x3h> => new LiteralNode(d.mat2x3h, v.length ? v : []);
export const mat2x4h = (...v: number[]): LiteralNode<d.mat2x4h> => new LiteralNode(d.mat2x4h, v.length ? v : []);
export const mat3x2h = (...v: number[]): LiteralNode<d.mat3x2h> => new LiteralNode(d.mat3x2h, v.length ? v : []);
export const mat3x3h = (...v: number[]): LiteralNode<d.mat3x3h> => new LiteralNode(d.mat3x3h, v.length ? v : []);
export const mat3x4h = (...v: number[]): LiteralNode<d.mat3x4h> => new LiteralNode(d.mat3x4h, v.length ? v : []);
export const mat4x2h = (...v: number[]): LiteralNode<d.mat4x2h> => new LiteralNode(d.mat4x2h, v.length ? v : []);
export const mat4x3h = (...v: number[]): LiteralNode<d.mat4x3h> => new LiteralNode(d.mat4x3h, v.length ? v : []);
export const mat4x4h = (...v: number[]): LiteralNode<d.mat4x4h> => new LiteralNode(d.mat4x4h, v.length ? v : []);

export const mat4 = (c0: Node<d.Vec4>, c1: Node<d.Vec4>, c2: Node<d.Vec4>, c3: Node<d.Vec4>) =>
    new ConstructNode(d.mat4x4f, [c0, c1, c2, c3]);
export function mat3(c0: Node<d.Vec3>, c1: Node<d.Vec3>, c2: Node<d.Vec3>): Node<d.mat3x3f>;
export function mat3(diag: Node<d.f32>): Node<d.mat3x3f>;
export function mat3(
    s00: Node<d.f32>,
    s01: Node<d.f32>,
    s02: Node<d.f32>,
    s10: Node<d.f32>,
    s11: Node<d.f32>,
    s12: Node<d.f32>,
    s20: Node<d.f32>,
    s21: Node<d.f32>,
    s22: Node<d.f32>,
): Node<d.mat3x3f>;
export function mat3(
    c0: Node<d.Vec3> | Node<d.f32>,
    c1?: Node<d.Vec3> | Node<d.f32>,
    c2?: Node<d.Vec3> | Node<d.f32>,
    s10?: Node<d.f32>,
    s11?: Node<d.f32>,
    s12?: Node<d.f32>,
    s20?: Node<d.f32>,
    s21?: Node<d.f32>,
    s22?: Node<d.f32>,
): Node<d.mat3x3f> {
    // 9-scalar overload: mat3x3f(s00..s22), column-major scalars
    if (s10 !== undefined) {
        return new ConstructNode(d.mat3x3f, [c0, c1!, c2!, s10, s11!, s12!, s20!, s21!, s22!]);
    }
    // 3-column overload
    if (c1 !== undefined && c2 !== undefined) {
        return new ConstructNode(d.mat3x3f, [c0, c1, c2]);
    }
    // scalar diagonal: expand to 9 scalars (WGSL has no single-scalar matrix constructor)
    const z = new LiteralNode(d.f32, 0);
    return new ConstructNode(d.mat3x3f, [c0, z, z, z, c0, z, z, z, c0]);
}

// ── Plain numbers and booleans as operands ───────────────────────────────────

/**
 * A JS number or boolean where a node is expected. It takes the type of the node it meets, as a WGSL literal does, and
 * is accepted exactly where WGSL accepts one: beside a vector only in arithmetic (`v.mul(2)`, `mix(a, b, 0.5)`),
 * otherwise beside a scalar (`clamp(t, 0, 1)`, `t.lessThan(0.5)`). A number must be exactly a value of that type.
 */
export type Literal = number | boolean;
/** A node, or a {@link Literal} standing in for one. */
export type Operand = Node<Any> | Literal;

export type NumericScalar = d.f32 | d.i32 | d.u32 | d.f16;
export type NumericScalarOrVec =
    | NumericScalar
    | d.vec2f
    | d.vec3f
    | d.vec4f
    | d.vec2i
    | d.vec3i
    | d.vec4i
    | d.vec2u
    | d.vec3u
    | d.vec4u
    | d.vec2h
    | d.vec3h
    | d.vec4h;
/** A literal where it must be a `D` itself: a number for a numeric scalar, a boolean for a bool, nothing otherwise. */
export type ScalarLiteral<D extends Any> = D extends d.bool ? boolean : D extends NumericScalar ? number : never;
/** A number beside a `D` in `+ - / %`: a numeric scalar or vector meets one. */
export type ArithLiteral<D extends Any> = D extends NumericScalarOrVec ? number : never;
/** A number beside a `D` in `*`: a matrix meets one too. */
export type MulLiteral<D extends Any> = D extends NumericScalarOrVec | d.Mat ? number : never;
/** A number for a shift amount: only an integer scalar shifts by one; a vector shifts by a vector. */
export type ShiftLiteral<D extends Any> = D extends d.i32 | d.u32 ? number : never;
/** The type a number takes beside a `D`: its element type. */
export type LiteralDesc<D extends Any> = D extends d.Mat
    ? D extends { wgslType: `${string}h` }
        ? d.f16
        : d.f32
    : VecElementDesc<D>;
/** An operand's type: a node's own, or for a number, what it takes beside a `D`. */
export type OperandDesc<N, D extends Any> = N extends Node<Any> ? N['type'] : LiteralDesc<D>;

/** `an i32`, `a u32`: a type name with its article, as said aloud. */
function aType(t: string): string {
    return `${/^[if]/.test(t) ? 'an' : 'a'} ${t}`;
}

/** The scalar a number beside a `desc` value takes: its element type. */
function scalarElementOf(desc: Any, op: string): Any {
    if (d.isMatDesc(desc)) return desc.wgslType.endsWith('h') ? d.f16 : d.f32;
    if ('len' in desc && desc.scalar !== 'bool') return d.vecElementDescOrSelf(desc);
    throw new Error(`[gpucat] ${op}: ${aType(desc.wgslType)} takes no number`);
}

/** `v` as a literal of the scalar `elem`, throwing where `v` isn't exactly one: as WGSL does, but where it's written. */
function literalOf(v: Literal, elem: Any, op: string): LiteralNode<Any> {
    const t = elem.wgslType;
    if (typeof v === 'boolean') {
        if (t !== 'bool') throw new Error(`[gpucat] ${op}: ${v} is a bool, and ${aType(t)} takes a number`);
        return new LiteralNode(d.bool, v ? 1 : 0);
    }
    if (t === 'bool') throw new Error(`[gpucat] ${op}: a bool takes true or false, not ${v}`);
    if (t === 'i32' || t === 'u32') {
        if (!Number.isInteger(v)) {
            throw new Error(
                `[gpucat] ${op}: ${v} is not ${aType(t)}, which takes whole numbers; do the maths in f32, or round it in JS`,
            );
        }
        if (t === 'u32' && v < 0) throw new Error(`[gpucat] ${op}: ${v} is not a u32, which takes no negatives`);
        const [lo, hi] = t === 'i32' ? [-2147483648, 2147483647] : [0, 4294967295];
        if (v < lo || v > hi) throw new Error(`[gpucat] ${op}: ${v} is outside the ${t} range, ${lo} to ${hi}`);
        return new LiteralNode(elem, v === 0 ? 0 : v);
    }
    try {
        floatLiteral(v, t === 'f16' ? 'f16' : 'f32');
    } catch (e) {
        throw new Error(`[gpucat] ${op}: ${(e as Error).message.replace('[gpucat] ', '')}`);
    }
    return new LiteralNode(elem, v);
}

/** `nodes`, which must share one type: WGSL converts none of them, so gpucat doesn't either. */
function assertSameType(op: string, nodes: Node<Any>[]): Node<Any>[] {
    const t = nodes[0]!.type.wgslType;
    const other = nodes.find((n) => n.type.wgslType !== t);
    if (other !== undefined) throw new Error(`[gpucat] ${op}: ${mismatch(nodes[0]!.type, other.type)}`);
    return nodes;
}

/** why `a` can't meet `b`, and the conversion to write when one would do */
function mismatch(a: Any, b: Any): string {
    const [ta, tb] = [a.wgslType, b.wgslType];
    const lenOf = (t: Any) => (d.isMatDesc(t) ? 0 : 'len' in t ? t.len : -1);
    const numeric = (t: Any) => 'scalar' in t && t.scalar !== 'bool';
    const hint =
        numeric(a) && numeric(b) && lenOf(a) === lenOf(b) && lenOf(a) > 0 ? `; convert one, with ${ta}(…) or ${tb}(…)` : '';
    return `${aType(ta)} meets only ${aType(ta)}, not ${aType(tb)}${hint}`;
}

/** The type of `l op r` for `+ - / %`, or for `*` with `matrices`, as WGSL types it, throwing where WGSL rejects it:
 *  both sides of one element type, and a scalar beside a vector the only mix of shapes. */
function arithResult(op: string, l: Node<Any>, r: Node<Any>, matrices: boolean): Any {
    const [a, b] = [l.type, r.type];
    const scalarOf = (t: Any) => ('scalar' in t ? t.scalar : undefined);
    const fail = (why = mismatch(a, b)): never => {
        throw new Error(`[gpucat] ${op}: ${why}`);
    };
    if (scalarOf(a) === undefined || scalarOf(a) === 'bool' || scalarOf(b) === undefined || scalarOf(b) === 'bool') {
        fail(`takes numbers, not ${aType(scalarOf(a) === undefined || scalarOf(a) === 'bool' ? a.wgslType : b.wgslType)}`);
    }
    if (scalarOf(a) !== scalarOf(b)) fail();
    const ma = d.isMatDesc(a);
    const mb = d.isMatDesc(b);
    const lenOf = (t: Any) => ('len' in t ? t.len : 1);
    if (ma || mb) {
        if (!matrices) return a.wgslType === b.wgslType && op !== 'div' && op !== 'mod' ? a : fail();
        // matCxR: C columns of R rows
        const shape = (t: Any) =>
            t.wgslType
                .match(/^mat(\d)x(\d)/)!
                .slice(1)
                .map(Number) as [cols: number, rows: number];
        const suffix = a.wgslType.endsWith('h') || b.wgslType.endsWith('h') ? 'h' : 'f';
        const vecOf = (len: number) => d.numericDescOf({ len } as Any, scalarOf(a) as 'f32' | 'f16');
        if (ma && mb) {
            const [[ac, ar], [bc, br]] = [shape(a), shape(b)];
            if (ac !== br) fail(`${a.wgslType} * ${b.wgslType} needs as many columns on the left as rows on the right`);
            return (d as unknown as Record<string, Any>)[`mat${bc}x${ar}${suffix}`]!;
        }
        if (ma) {
            if (lenOf(b) === 1) return a;
            const [cols, rows] = shape(a);
            if (cols !== lenOf(b)) fail(`${a.wgslType} * ${b.wgslType} needs a vec${cols}`);
            return vecOf(rows);
        }
        if (lenOf(a) === 1) return b;
        const [cols, rows] = shape(b);
        if (lenOf(a) !== rows) fail(`${a.wgslType} * ${b.wgslType} needs a vec${rows} on the left`);
        return vecOf(cols);
    }
    if (lenOf(a) === 1) return b;
    if (lenOf(b) === 1 || lenOf(a) === lenOf(b)) return a;
    return fail();
}

/** A factor node beside values of type `of`: of their element type, or, `orSame`, of their own type too. */
function factorOperand(op: string, of: Any, t: Node<Any>, orSame: boolean): Node<Any> {
    const element = scalarElementOf(of, op).wgslType;
    if (t.type.wgslType === element || (orSame && t.type.wgslType === of.wgslType)) return t;
    const want = orSame && element !== of.wgslType ? `${aType(element)} or ${aType(of.wgslType)}` : aType(element);
    throw new Error(`[gpucat] ${op}: the factor beside ${aType(of.wgslType)} is ${want}, not ${aType(t.type.wgslType)}`);
}

/** Both sides of `+ - * / %` as nodes. A number takes the element type of the node on the other side, as a scalar,
 *  which WGSL accepts beside a vector, and for `*` beside a matrix. */
function arithOperands(op: string, a: Operand, b: Operand, matrices: boolean): [Node<Any>, Node<Any>] {
    if (isNode(a) && isNode(b)) return [a, b];
    const node = isNode(a) ? a : isNode(b) ? b : undefined;
    if (node === undefined) {
        throw new Error(`[gpucat] ${op}: ${a} and ${b} are both numbers, which name no type; write f32(${a}) (or i32/u32)`);
    }
    if (d.isMatDesc(node.type) && !matrices) {
        throw new Error(
            `[gpucat] ${op}: ${aType(node.type.wgslType)} meets only ${aType(node.type.wgslType)}, not a number; scale it with mul`,
        );
    }
    const elem = scalarElementOf(node.type, op);
    return isNode(a) ? [a, literalOf(b as Literal, elem, op)] : [literalOf(a, elem, op), b as Node<Any>];
}

/** Values that must share one type, as nodes. A number takes the type of a node among them, which must be a scalar:
 *  WGSL widens a literal to no vector here. Booleans alone are a bool. */
function sameTypeOperands(op: string, values: readonly Operand[]): Node<Any>[] {
    if (values.every(isNode)) return assertSameType(op, values as Node<Any>[]);
    const node = values.find(isNode);
    const type = node?.type ?? (values.every((v) => typeof v === 'boolean') ? d.bool : undefined);
    if (type === undefined) {
        throw new Error(`[gpucat] ${op}: only numbers, which name no type; write f32(…) (or i32/u32) for one of them`);
    }
    if (!('len' in type) || type.len !== 1) {
        const n = values.find((v) => !isNode(v));
        throw new Error(
            `[gpucat] ${op}: ${aType(type.wgslType)} meets only ${aType(type.wgslType)}, not ${n}; write ${type.wgslType}(${n}) to splat it`,
        );
    }
    return values.map((v) => (isNode(v) ? v : literalOf(v, type, op)));
}

/** A condition as a node: a boolean is a bool literal. */
function boolOperand(op: string, v: Node<Any> | boolean): Node<Any> {
    if (isNode(v)) {
        if (!('scalar' in v.type) || v.type.scalar !== 'bool') {
            throw new Error(`[gpucat] ${op}: takes a bool, not ${aType(v.type.wgslType)}; compare it to make one`);
        }
        return v;
    }
    if (typeof v !== 'boolean') throw new Error(`[gpucat] ${op}: takes true, false or a bool node, not ${v}`);
    return new LiteralNode(d.bool, v ? 1 : 0);
}

/** A Var or Let's initial value: a boolean is a bool; a number names no type. */
function initOperand(op: string, init: Node<Any> | boolean): Node<Any> {
    if (typeof init === 'number') throw new Error(`[gpucat] ${op}: ${init} names no type; write f32(${init}) (or i32/u32)`);
    return isNode(init) ? init : boolOperand(op, init);
}

/** A shift amount as a node: a number is a u32, for an integer scalar. */
function shiftOperand(op: string, a: Node<Any>, b: Node<Any> | number): Node<Any> {
    if (!isNode(a)) throw new Error(`[gpucat] ${op}: a number shifted names no type; write u32(${a}) or i32(${a})`);
    const scalar = 'scalar' in a.type ? a.type.scalar : undefined;
    if (scalar !== 'i32' && scalar !== 'u32') throw new Error(`[gpucat] ${op}: shifts an integer, not ${aType(a.type.wgslType)}`);
    if (isNode(b)) {
        const want = d.numericDescOf(a.type, 'u32').wgslType;
        if (b.type.wgslType !== want) {
            throw new Error(`[gpucat] ${op}: ${aType(a.type.wgslType)} shifts by ${aType(want)}, not ${aType(b.type.wgslType)}`);
        }
        return b;
    }
    if ('len' in a.type && a.type.len > 1) {
        throw new Error(`[gpucat] ${op}: ${aType(a.type.wgslType)} shifts by a vec${a.type.len}u; write vec${a.type.len}u(${b})`);
    }
    return literalOf(b, d.u32, op);
}

/** `i32(v)` or `u32(v)` of a number, converting as WGSL converts a float: truncated, then clamped to the range. */
function convertedInteger(v: number, t: 'i32' | 'u32'): number {
    if (!Number.isFinite(v)) throw new Error(`[gpucat] ${t}(${v}): no ${t} has that value`);
    return convertScalarLiteral(v, 'f32', t);
}

/** What WGSL rejects when the shader is created: an integer `/` or `%` by a literal 0, and an operation on two literals
 *  whose result its type can't hold. Integer `+ - *` on literals wrap, as WGSL's do. */
function assertConstantBinary(op: string, sym: string, l: Node<Any>, r: Node<Any>): void {
    const scalar = 'scalar' in l.type ? l.type.scalar : undefined;
    const literal = (n: Node<Any>) => (n.kind === NodeKind.Literal ? (n as LiteralNode<Any>).value : undefined);
    const lv = literal(l);
    const rv = literal(r);
    const integer = scalar === 'i32' || scalar === 'u32';
    if ((sym === '/' || sym === '%') && integer && (rv === 0 || (Array.isArray(rv) && rv.includes(0)))) {
        throw new Error(`[gpucat] ${op}: an integer ${sym} by a literal 0 fails when the shader is created`);
    }
    if (typeof lv !== 'number' || typeof rv !== 'number') return;
    const fail = (why: string) => {
        throw new Error(`[gpucat] ${op}: ${lv} ${sym} ${rv} ${why}, which WGSL rejects when the shader is created`);
    };
    if (scalar === 'i32' && (sym === '/' || sym === '%') && lv === -2147483648 && rv === -1) fail('overflows an i32');
    if (sym === '<<' && integer) {
        const shifted = lv * 2 ** rv;
        if (scalar === 'i32' ? shifted < -2147483648 || shifted > 2147483647 : shifted > 4294967295)
            fail(`overflows ${aType(scalar)}`);
    }
    if ((scalar === 'f32' || scalar === 'f16') && (sym === '+' || sym === '-' || sym === '*' || sym === '/')) {
        const result = sym === '+' ? lv + rv : sym === '-' ? lv - rv : sym === '*' ? lv * rv : lv / rv;
        try {
            floatLiteral(result, scalar);
        } catch {
            fail(`is beyond ${aType(scalar)}`);
        }
    }
}

// ── Standalone math functions ─────────────────────────────────────────────────

/** `+ - / %`: a number on either side takes the element type of the node on the other, as a scalar, which WGSL
 *  accepts beside a vector. */
export type Arith = {
    <NA extends Node<Any>, NB extends Node<Any> | ArithLiteral<NA['type']>>(
        a: NA,
        b: NB,
    ): Node<ArithResultDesc<NA['type'], OperandDesc<NB, NA['type']>>>;
    <NB extends Node<Any>>(a: ArithLiteral<NB['type']>, b: NB): Node<ArithResultDesc<LiteralDesc<NB['type']>, NB['type']>>;
};
/** `*`: as {@link Arith}, and a number also scales a matrix. */
export type Mul = {
    <NA extends Node<Any>, NB extends Node<Any> | MulLiteral<NA['type']>>(
        a: NA,
        b: NB,
    ): Node<MulResultDesc<NA['type'], OperandDesc<NB, NA['type']>>>;
    <NB extends Node<Any>>(a: MulLiteral<NB['type']>, b: NB): Node<MulResultDesc<LiteralDesc<NB['type']>, NB['type']>>;
};
const arith =
    (op: BinaryOp, name: string): Arith =>
    (a: Operand, b: Operand) => {
        const [l, r] = arithOperands(name, a, b, false);
        const type = arithResult(name, l, r, false);
        assertConstantBinary(name, op, l, r);
        return new BinaryOpNode(op, type, l, r) as never;
    };
export const add: Arith = /*@__PURE__*/ arith('+', 'add');
export const sub: Arith = /*@__PURE__*/ arith('-', 'sub');
export const div: Arith = /*@__PURE__*/ arith('/', 'div');
export const mul: Mul = (a: Operand, b: Operand) => {
    const [l, r] = arithOperands('mul', a, b, true);
    const type = arithResult('mul', l, r, true);
    assertConstantBinary('mul', '*', l, r);
    return new BinaryOpNode('*', type, l, r) as never;
};
/** The dot product, in the vectors' element type: WGSL's `dot` of two `vec3i` is an `i32`. */
export const dot = <D extends Any>(a: Node<D>, b: Node<D>): Node<VecElementDesc<D>> =>
    new CallNode(d.vecElementDescOrSelf(a.type), 'dot', [a, b]) as unknown as Node<VecElementDesc<D>>;
export const cross = <D extends Any>(a: Node<D>, b: Node<D>): Node<D> => new CallNode(a.type, 'cross', [a, b]);
export const normalize = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'normalize', [a]);
export const length = (a: Node<Any>): Node<d.f32> => new CallNode(d.f32, 'length', [a]);

/** Pack two f32s as halves into a u32. Lower 16 bits = v.x, upper = v.y. WGSL: `pack2x16float`. */
export const pack2x16float = (v: Node<d.vec2f>): Node<d.u32> => new CallNode(d.u32, 'pack2x16float', [v]);
/** Unpack a u32 into two f32s from half-precision. WGSL: `unpack2x16float`. */
export const unpack2x16float = (v: Node<d.u32>): Node<d.vec2f> => new CallNode(d.vec2f, 'unpack2x16float', [v]);
/** Pack two f32s in [-1, 1] into a u32 as 16-bit snorm. WGSL: `pack2x16snorm`. */
export const pack2x16snorm = (v: Node<d.vec2f>): Node<d.u32> => new CallNode(d.u32, 'pack2x16snorm', [v]);
/** Unpack a u32 into two f32s as 16-bit snorm. WGSL: `unpack2x16snorm`. */
export const unpack2x16snorm = (v: Node<d.u32>): Node<d.vec2f> => new CallNode(d.vec2f, 'unpack2x16snorm', [v]);
/** Pack two f32s in [0, 1] into a u32 as 16-bit unorm. WGSL: `pack2x16unorm`. */
export const pack2x16unorm = (v: Node<d.vec2f>): Node<d.u32> => new CallNode(d.u32, 'pack2x16unorm', [v]);
/** Unpack a u32 into two f32s as 16-bit unorm. WGSL: `unpack2x16unorm`. */
export const unpack2x16unorm = (v: Node<d.u32>): Node<d.vec2f> => new CallNode(d.vec2f, 'unpack2x16unorm', [v]);
/** Pack four f32s in [-1, 1] into a u32 as 8-bit snorm. WGSL: `pack4x8snorm`. */
export const pack4x8snorm = (v: Node<d.vec4f>): Node<d.u32> => new CallNode(d.u32, 'pack4x8snorm', [v]);
/** Unpack a u32 into four f32s as 8-bit snorm. WGSL: `unpack4x8snorm`. */
export const unpack4x8snorm = (v: Node<d.u32>): Node<d.vec4f> => new CallNode(d.vec4f, 'unpack4x8snorm', [v]);
/** Pack four f32s in [0, 1] into a u32 as 8-bit unorm. WGSL: `pack4x8unorm`. */
export const pack4x8unorm = (v: Node<d.vec4f>): Node<d.u32> => new CallNode(d.u32, 'pack4x8unorm', [v]);
/** Unpack a u32 into four f32s as 8-bit unorm. WGSL: `unpack4x8unorm`. */
export const unpack4x8unorm = (v: Node<d.u32>): Node<d.vec4f> => new CallNode(d.vec4f, 'unpack4x8unorm', [v]);
export const abs = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'abs', [a]);
export const floor = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'floor', [a]);
export const ceil = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'ceil', [a]);
export const fract = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'fract', [a]);
export const sqrt = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'sqrt', [a]);
export const sin = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'sin', [a]);
export const cos = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'cos', [a]);
export const negate = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'negate', [a]);
/** A builtin of two values of one type; a number on either side takes a scalar node's type. */
export type SameType2 = {
    <D extends Any>(a: Node<D>, b: Node<D> | ScalarLiteral<D>): Node<D>;
    <D extends Any>(a: ScalarLiteral<D>, b: Node<D>): Node<D>;
};
/** A builtin of three values of one type; numbers anywhere take the type of a scalar node among them. */
export type SameType3 = {
    <D extends Any>(a: Node<D>, b: Node<D> | ScalarLiteral<D>, c: Node<D> | ScalarLiteral<D>): Node<D>;
    <D extends Any>(a: ScalarLiteral<D>, b: Node<D>, c: Node<D> | ScalarLiteral<D>): Node<D>;
    <D extends Any>(a: ScalarLiteral<D>, b: ScalarLiteral<D>, c: Node<D>): Node<D>;
};
const sameTypeCall =
    (fn: string) =>
    (...values: Operand[]): never => {
        const args = sameTypeOperands(fn, values);
        return new CallNode(args.find(isNode)!.type, fn, args) as never;
    };
export const pow: SameType2 = /*@__PURE__*/ sameTypeCall('pow');
export const exp = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'exp', [a]);
export const log = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'log', [a]);
export const exp2 = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'exp2', [a]);
export const log2 = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'log2', [a]);
export const tan = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'tan', [a]);
export const atan = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'atan', [a]);
export const atan2: SameType2 = /*@__PURE__*/ sameTypeCall('atan2');
export const asin = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'asin', [a]);
export const acos = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'acos', [a]);
export const inverseSqrt = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'inverseSqrt', [a]);
/** Round to the nearest whole number, halves to even. WGSL: `round`; GLSL: `roundEven`. */
export const round = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'round', [a]);
/** Clamp to [0, 1]. WGSL: `saturate`; GLSL has none, so it lowers to `clamp(a, 0.0, 1.0)`. */
export const saturate = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'saturate', [a]);
/** The incident direction `i` reflected about the surface normal `n`: `i - 2 * dot(n, i) * n`. */
export const reflect = <D extends Any>(i: Node<D>, n: Node<D>): Node<D> => new CallNode(i.type, 'reflect', [i, n]);
/** The incident direction `i` refracted through the surface normal `n` at the ratio of indices `eta`. */
export const refract = <D extends Any>(i: Node<D>, n: Node<D>, eta: Node<VecElementDesc<D>> | number): Node<D> =>
    new CallNode(i.type, 'refract', [
        ...assertSameType('refract', [i, n]),
        isNode(eta)
            ? factorOperand('refract', i.type, eta, false)
            : literalOf(eta, scalarElementOf(i.type, 'refract'), 'refract'),
    ]);
/** `n` turned to face against `i`, judged by the reference normal `nref`: `dot(nref, i) < 0 ? n : -n`. WGSL: `faceForward`; GLSL: `faceforward`. */
export const faceForward = <D extends Any>(n: Node<D>, i: Node<D>, nref: Node<D>): Node<D> =>
    new CallNode(n.type, 'faceForward', [n, i, nref]);

export function max<D extends Any>(a: Node<D>, b: Node<D> | ScalarLiteral<D>, ...rest: (Node<D> | ScalarLiteral<D>)[]): Node<D>;
export function max<D extends Any>(a: ScalarLiteral<D>, b: Node<D>, ...rest: (Node<D> | ScalarLiteral<D>)[]): Node<D>;
export function max(...values: Operand[]): Node<Any> {
    return chainCall('max', values);
}

export function min<D extends Any>(a: Node<D>, b: Node<D> | ScalarLiteral<D>, ...rest: (Node<D> | ScalarLiteral<D>)[]): Node<D>;
export function min<D extends Any>(a: ScalarLiteral<D>, b: Node<D>, ...rest: (Node<D> | ScalarLiteral<D>)[]): Node<D>;
export function min(...values: Operand[]): Node<Any> {
    return chainCall('min', values);
}

/** `fn(fn(a, b), c)…`, one type throughout */
function chainCall(fn: string, values: Operand[]): Node<Any> {
    const [first, ...rest] = sameTypeOperands(fn, values) as [Node<Any>, ...Node<Any>[]];
    let result = first;
    for (const n of rest) result = new CallNode(first.type, fn, [result, n]);
    return result;
}

export const clamp: SameType3 = /*@__PURE__*/ sameTypeCall('clamp');
/**
 * `a` to `b` by `t`. A number for `t` takes the element type of `a` and `b`, as a scalar, which WGSL accepts beside
 * vectors; numbers for `a` and `b` take the type of a scalar node among the three.
 */
export type Mix = {
    <D extends Any>(a: Node<D>, b: Node<D> | ScalarLiteral<D>, t: Node<Any> | number): Node<D>;
    <D extends Any>(a: ScalarLiteral<D>, b: Node<D>, t: Node<Any> | number): Node<D>;
    <D extends Any>(a: ScalarLiteral<D>, b: ScalarLiteral<D>, t: Node<D>): Node<D>;
};
export const mix: Mix = (a: Operand, b: Operand, t: Operand): never => {
    if (!isNode(a) && !isNode(b)) {
        const [l, r, tt] = sameTypeOperands('mix', [a, b, t]);
        return new CallNode(tt!.type, 'mix', [l!, r!, tt!]) as never;
    }
    const [l, r] = sameTypeOperands('mix', [a, b]) as [Node<Any>, Node<Any>];
    const factor = isNode(t) ? factorOperand('mix', l.type, t, true) : literalOf(t, scalarElementOf(l.type, 'mix'), 'mix');
    return new CallNode(l.type, 'mix', [l, r, factor]) as never;
};
export const step: SameType2 = /*@__PURE__*/ sameTypeCall('step');
export const smoothstep: SameType3 = /*@__PURE__*/ sameTypeCall('smoothstep');
export const sign = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'sign', [a]);
/**
 * WGSL's `%`, on both backends: a truncating remainder, so the result takes the sign of `a` (`-1.5 % 1.0` is `-0.5`).
 * GLSL's `mod()` floors instead; for that, write `a.sub(b.mul(floor(a.div(b))))`.
 */
export const mod: Arith = /*@__PURE__*/ arith('%', 'mod');
export const or = (a: Node<d.bool> | boolean, b: Node<d.bool> | boolean): Node<d.bool> =>
    new BinaryOpNode('||', d.bool, boolOperand('or', a), boolOperand('or', b));
export const and = (a: Node<d.bool> | boolean, b: Node<d.bool> | boolean): Node<d.bool> =>
    new BinaryOpNode('&&', d.bool, boolOperand('and', a), boolOperand('and', b));
export const not = (a: Node<d.bool> | boolean): Node<d.bool> => new CallNode(d.bool, 'not', [boolOperand('not', a)]);
export const transpose = <D extends d.Mat>(m: Node<D>): Node<D> => new CallNode(m.type, 'transpose', [m]);

// ── Bit-count builtins (integer-only) ────────────────────────────────────────
export const countOneBits = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'countOneBits', [a]);
export const countTrailingZeros = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'countTrailingZeros', [a]);
export const countLeadingZeros = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'countLeadingZeros', [a]);
export const reverseBits = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'reverseBits', [a]);
export const firstLeadingBit = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'firstLeadingBit', [a]);
export const firstTrailingBit = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'firstTrailingBit', [a]);

// ── Derivative builtins (fragment-only) ───────────────────────────────────────
export const dpdx = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'dpdx', [a]);
export const dpdy = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'dpdy', [a]);
export const fwidth = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'fwidth', [a]);
export const dpdxCoarse = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'dpdxCoarse', [a]);
export const dpdyCoarse = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'dpdyCoarse', [a]);
export const fwidthCoarse = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'fwidthCoarse', [a]);
export const dpdxFine = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'dpdxFine', [a]);
export const dpdyFine = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'dpdyFine', [a]);
export const fwidthFine = <D extends Any>(a: Node<D>): Node<D> => new CallNode(a.type, 'fwidthFine', [a]);

const bitwise =
    (op: BinaryOp, name: string): SameType2 =>
    (a: Operand, b: Operand) => {
        const [l, r] = sameTypeOperands(name, [a, b]) as [Node<Any>, Node<Any>];
        return new BinaryOpNode(op, l.type, l, r) as never;
    };
export const bitwiseAnd: SameType2 = /*@__PURE__*/ bitwise('&', 'bitwiseAnd');
export const bitwiseOr: SameType2 = /*@__PURE__*/ bitwise('|', 'bitwiseOr');
export const bitwiseXor: SameType2 = /*@__PURE__*/ bitwise('^', 'bitwiseXor');
/**
 * what a value of type D shifts by: WGSL takes an unsigned amount whatever the value's signedness, one lane per lane of
 * the value, so `i32 >> u32` (arithmetic) and `vec3i << vec3u` are the valid forms.
 */
export type ShiftAmount<D> = D extends { len: 2 }
    ? d.vec2u
    : D extends { len: 3 }
      ? d.vec3u
      : D extends { len: 4 }
        ? d.vec4u
        : d.u32;

/** A literal amount of 32 or more is a WGSL shader-creation error (a runtime one is masked to its low five bits), and
 *  GLSL would compile it silently, so it throws where it's written. */
function assertShiftAmount(op: string, b: Node<Any>): void {
    if (b.kind !== NodeKind.Literal) return;
    const value = (b as LiteralNode<Any>).value;
    const amounts = Array.isArray(value) ? value : [value];
    const bad = amounts.find((v) => typeof v === 'number' && v >= 32);
    if (bad !== undefined) throw new Error(`[gpucat] ${op}: a shift of ${bad} is past a 32-bit integer; shift by 0 to 31`);
}
export const shiftLeft = <D extends Any>(a: Node<D>, b: Node<ShiftAmount<D>> | ShiftLiteral<D>): Node<D> => {
    const amount = shiftOperand('shiftLeft', a, b);
    assertShiftAmount('shiftLeft', amount);
    assertConstantBinary('shiftLeft', '<<', a, amount);
    return new BinaryOpNode('<<', a.type, a, amount);
};
export const shiftRight = <D extends Any>(a: Node<D>, b: Node<ShiftAmount<D>> | ShiftLiteral<D>): Node<D> => {
    const amount = shiftOperand('shiftRight', a, b);
    assertShiftAmount('shiftRight', amount);
    return new BinaryOpNode('>>', a.type, a, amount);
};

// ── Lang ──────────────────────────────────────────────────────────────────────

export class StackNode extends Node<d.Void> {
    readonly kind = NodeKind.Stack;
    readonly body: Node<Any>[];
    constructor(initial?: Node<Any>[]) {
        super(d.Void);
        this.body = initial ? [...initial] : [];
    }
    push(node: Node<Any>): void {
        this.body.push(node);
    }
}

export class FnNode<D extends Any> extends Node<D> {
    readonly kind = NodeKind.Fn;
    readonly fnName: string;
    readonly paramDescs: (ParamDesc | Any)[];
    readonly jsFunc: (...args: Node<Any>[]) => Node<D>;

    constructor(returnType: D, paramDescs: (ParamDesc | Any)[], jsFunc: (...args: Node<Any>[]) => Node<D>, fnName?: string) {
        super(returnType);
        this.fnName = fnName ?? `fn_${this.id}`;
        this.paramDescs = paramDescs;
        this.jsFunc = jsFunc;
    }

    compute(opts: ComputeOptions): ComputeNode {
        // Delegate to the free `compute()` factory so there is one construction path.
        return compute(this, opts);
    }

    /** the body as statements, and the value it returns: none for a void function. */
    trace(): { params: ParameterNode<Any>[]; body: StackNode; output: Node<D> | undefined } {
        const params = this.paramDescs.map((pd, i) => {
            const paramName = 'name' in pd ? (pd as ParamDesc).name : undefined;
            const desc = 'name' in pd ? (pd as ParamDesc).type : (pd as Any);
            return new ParameterNode(desc, i, paramName);
        });
        const stack = new StackNode();
        const prev = pushStack(stack);
        let output: Node<D> | undefined;
        try {
            output = this.jsFunc(...params) ?? undefined;
        } finally {
            popStack(prev);
        }
        return { params, body: stack, output };
    }
}

export class ParameterNode<D extends Any> extends Node<D> {
    readonly kind = NodeKind.Parameter;
    constructor(
        type: D,
        readonly paramIndex: number,
        readonly paramName?: string,
    ) {
        super(type);
    }
}

export class ReturnNode<D extends Any> extends Node<D> {
    readonly kind = NodeKind.Return;
    constructor(readonly value: Node<D>) {
        super(value.type);
    }
}

export class ConditionalNode<D extends Any> extends Node<D> {
    readonly kind = NodeKind.Conditional;
    readonly ifFalse?: Node<Any>;
    constructor(
        readonly condition: Node<Any>,
        readonly ifTrue: Node<D>,
        ifFalse?: Node<D>,
    ) {
        super(ifTrue.type);
        this.ifFalse = ifFalse;
    }
}

export type ElseIfBranch = { condition: Node<Any>; body: StackNode };

export class IfNode extends Node<d.Void> {
    readonly kind = NodeKind.If;
    elseIfBranches: ElseIfBranch[] = [];
    elseBody: StackNode | null = null;
    constructor(
        readonly condition: Node<Any>,
        readonly thenBody: StackNode,
    ) {
        super(d.Void);
    }
}

export type LoopParam =
    | Node<Any>
    | number
    | {
          start?: Node<Any> | number;
          end?: Node<Any> | number;
          type?: d.Scalar;
          /** inferred as three.js TSL infers it: '>=' when a numeric `start` is above a numeric `end`, else '<' */
          condition?: '<' | '<=' | '>' | '>=';
          /**
           * How the loop variable steps, after three.js TSL's `Loop`: a number or a node adds itself (subtracts, with a
           * '>' or '>=' condition), a string follows the variable as written (`'+= 2'`, `'*= 2'`), and a function is
           * the step's own statement, given the loop variable as the body is. Left out, `++` (`--` counting down), or
           * `+= 1.0` for a float. A for header holds one statement, so a function makes exactly one.
           */
          update?: Node<Any> | number | string | ((vars: LoopVars) => void);
          name?: string;
      };

/**
 * A counted loop's range as three.js TSL completes it: a `start` with no `end` counts down from `start - 1` to 0, and a
 * condition left out is '>=' when a numeric `start` is above a numeric `end`, else '<'. Missing ends are 0.
 */
export function loopRange(
    start: Node<Any> | number | undefined,
    end: Node<Any> | number | undefined,
    condition: '<' | '<=' | '>' | '>=' | undefined,
): {
    start: Node<Any> | number | undefined;
    end: Node<Any> | number | undefined;
    condition: '<' | '<=' | '>' | '>=';
    startLessOne: boolean;
} {
    if (start !== undefined && end === undefined) return { start, end: undefined, condition: '>=', startLessOne: true };
    const inferred = condition ?? (typeof start === 'number' && typeof end === 'number' && start > end ? '>=' : '<');
    return { start, end, condition: inferred, startLessOne: false };
}

let _loopVarCounter = 0;

export class LoopNode extends Node<d.Void> {
    readonly kind = NodeKind.Loop;
    constructor(
        readonly config: LoopParam,
        readonly loopVar: ParameterNode<Any>,
        readonly callbackKey: string,
        readonly body: StackNode,
        /** a function `update`'s statement, captured as the body is; null for any other update */
        readonly updateNode: StackNode | null,
    ) {
        super(d.Void);
    }
}

export class BreakNode extends Node<d.Void> {
    readonly kind = NodeKind.Break;
    constructor() {
        super(d.Void);
    }
}
export class ContinueNode extends Node<d.Void> {
    readonly kind = NodeKind.Continue;
    constructor() {
        super(d.Void);
    }
}
export class DiscardNode extends Node<d.Void> {
    readonly kind = NodeKind.Discard;
    constructor() {
        super(d.Void);
    }
}

export type IfChain = {
    ElseIf(condition: Node<Any> | boolean, body: () => void): IfChain;
    Else(body: () => void): IfChain;
};

export function If(condition: Node<Any> | boolean, thenBody: () => void): IfChain {
    const thenStack = new StackNode();
    const prev = pushStack(thenStack);
    try {
        thenBody();
    } finally {
        popStack(prev);
    }
    const ifNode = new IfNode(boolOperand('If', condition), thenStack);
    addToStack(ifNode);
    const chain: IfChain = {
        ElseIf(c: Node<Any> | boolean, body: () => void): IfChain {
            const s = new StackNode();
            const f = pushStack(s);
            try {
                body();
            } finally {
                popStack(f);
            }
            ifNode.elseIfBranches.push({ condition: boolOperand('ElseIf', c), body: s });
            return chain;
        },
        Else(body: () => void): IfChain {
            const s = new StackNode();
            const f = pushStack(s);
            try {
                body();
            } finally {
                popStack(f);
            }
            ifNode.elseBody = s;
            return chain;
        },
    };
    return chain;
}

/** The loop variable is a scalar; `i32` unless a `LoopParam` names another `type`. */
export type LoopVars = Record<string, Node<d.i32>>;

export function Loop(range: number, callback: (vars: LoopVars) => void): LoopNode;
export function Loop(o: LoopParam, callback: (vars: LoopVars) => void): LoopNode;
export function Loop(o: number | LoopParam, callback: (vars: LoopVars) => void): LoopNode {
    // Determine loop variable type and name from config
    let loopVarType: Any = d.i32;
    let callbackKey = 'i';
    const varName = `_loop_${_loopVarCounter++}`;

    let updateFn: ((vars: LoopVars) => void) | null = null;
    if (typeof o === 'object' && o !== null && !(o instanceof Node)) {
        const cfg = o as { type?: d.Scalar; name?: string; update?: unknown };
        if (cfg.type) loopVarType = cfg.type;
        if (cfg.name) callbackKey = cfg.name;
        if (typeof cfg.update === 'function') updateFn = cfg.update as (vars: LoopVars) => void;
    }

    // Create the loop variable ParameterNode
    const loopVar = new ParameterNode(loopVarType, 0, varName);

    // Eagerly capture the body (like If does)
    const bodyStack = new StackNode();
    const prev = pushStack(bodyStack);
    try {
        callback({ [callbackKey]: loopVar } as LoopVars);
    } finally {
        popStack(prev);
    }

    let updateStack: StackNode | null = null;
    if (updateFn !== null) {
        updateStack = new StackNode();
        const prevUpdate = pushStack(updateStack);
        try {
            updateFn({ [callbackKey]: loopVar } as LoopVars);
        } finally {
            popStack(prevUpdate);
        }
    }

    const node = new LoopNode(o, loopVar, callbackKey, bodyStack, updateStack);
    addToStack(node);
    return node;
}
export const For = Loop;

export function While(condition: Node<Any>, body: () => void): void {
    Loop(condition, body);
}
export function Return(): void;
export function Return<D extends Any>(value: Node<D>): void;
export function Return<D extends Any>(value?: Node<D>): void {
    if (value !== undefined) addToStack(new ReturnNode(value));
    else addToStack(new ReturnNode(new LiteralNode(d.Void, 0) as Node<d.Void>));
}
export function Break(): void {
    addToStack(new BreakNode());
}
export function Continue(): void {
    addToStack(new ContinueNode());
}
export function Discard(): void {
    addToStack(new DiscardNode());
}
/** Workgroup synchronization barrier. WGSL: `workgroupBarrier()`. */
export function workgroupBarrier(): void {
    addToStack(new CallNode(d.Void, 'workgroupBarrier', []));
}
/** Storage-buffer write/read sync within a workgroup. WGSL: `storageBarrier()`. */
export function storageBarrier(): void {
    addToStack(new CallNode(d.Void, 'storageBarrier', []));
}
/** Texture write/read sync within a workgroup. WGSL: `textureBarrier()`. */
export function textureBarrier(): void {
    addToStack(new CallNode(d.Void, 'textureBarrier', []));
}

export type ParamDesc = { readonly name: string; readonly type: Any };
export type ParamDescsToNodes<P extends readonly ParamDesc[]> = {
    [K in keyof P]: P[K] extends ParamDesc ? Node<P[K]['type']> : never;
};
export type FnLayout<P extends readonly ParamDesc[]> = {
    /** Function name in the generated WGSL. */
    readonly name: string;
    /** Named, typed parameters, in order. */
    readonly params: [...P];
    /** Explicit return type (WGSL `-> return`), checked against the body. Omit to infer from the body. */
    readonly return?: Any;
};

// Overload 1a, layout with an explicit return type (checked against the body)
export function Fn<R extends Any, P extends readonly ParamDesc[]>(
    jsFunc: (...args: ParamDescsToNodes<P>) => Node<R>,
    layout: { readonly name: string; readonly params: [...P]; readonly return: R },
): (...args: ParamDescsToNodes<P>) => CallNode<R>;

// Overload 1b, layout with the return type inferred from the body (no `return`)
export function Fn<D extends Any, P extends readonly ParamDesc[]>(
    jsFunc: (...args: ParamDescsToNodes<P>) => Node<D>,
    layout: { readonly name: string; readonly params: [...P]; readonly return?: undefined },
): (...args: ParamDescsToNodes<P>) => CallNode<D>;

// Overload 2, no-params void body
export function Fn(jsFunc: () => void): FnNode<d.Void>;

// Overload 2b, a void body with a layout: a call of it is a statement, or a fragment that writes no colour
export function Fn<P extends readonly ParamDesc[]>(
    jsFunc: (...args: ParamDescsToNodes<P>) => void,
    layout: { readonly name: string; readonly params: [...P]; readonly return?: undefined },
): (...args: ParamDescsToNodes<P>) => CallNode<d.Void>;

// Overload 3, no layout
export function Fn<D extends Any>(jsFunc: (...args: Node<Any>[]) => Node<D>): (...args: Node<Any>[]) => CallNode<D>;

// Implementation
export function Fn<D extends Any>(
    jsFunc: ((...args: Node<Any>[]) => Node<D>) | (() => void),
    layout?: FnLayout<readonly ParamDesc[]>,
): ((...args: Node<Any>[]) => CallNode<D>) | FnNode<d.Void> {
    const paramDescs: (ParamDesc | Any)[] = layout?.params ?? [];
    const dummyParams = paramDescs.map((pd, i) => {
        const paramName = 'name' in pd ? (pd as ParamDesc).name : undefined;
        const desc = 'name' in pd ? (pd as ParamDesc).type : (pd as Any);
        return new ParameterNode(desc, i, paramName);
    });

    const traceStack = new StackNode();
    const prev = pushStack(traceStack);
    let inferred: D | d.Void;
    try {
        const output = (jsFunc as (...args: Node<Any>[]) => Node<D> | undefined)(...dummyParams);
        inferred = output != null ? output.type : d.Void;
    } finally {
        popStack(prev);
    }

    let returnType: D | d.Void = inferred;
    if (layout?.return) {
        // Verify the declared return matches what the body actually returns.
        if (inferred.wgslType !== layout.return.wgslType) {
            throw new Error(
                `[gpucat] Fn '${layout.name}' declares return '${layout.return.wgslType}' but the body returns '${inferred.wgslType}'.`,
            );
        }
        returnType = layout.return as D;
    }

    if (returnType === d.Void && paramDescs.length === 0 && !layout) {
        return new FnNode<d.Void>(d.Void, [], jsFunc as (...args: Node<Any>[]) => Node<d.Void>, undefined);
    }
    const fnNode = new FnNode<D>(returnType as D, paramDescs, jsFunc as (...args: Node<Any>[]) => Node<D>, layout?.name);
    return (...args: Node<Any>[]): CallNode<D> => new CallNode<D>(returnType as D, fnNode.fnName, args, fnNode);
}

export const cond = <D extends Any>(condition: Node<Any> | boolean, ifTrue: Node<D>, ifFalse?: Node<D> | ScalarLiteral<D>) =>
    new ConditionalNode(
        boolOperand('cond', condition),
        ifTrue,
        ifFalse === undefined ? undefined : (sameTypeOperands('cond', [ifTrue, ifFalse])[1] as Node<D>),
    );

/**
 * WGSL `select(falseVal, trueVal, condition)`.
 * Returns `trueVal` when `condition` is true, `falseVal` otherwise. A number for one value takes a scalar node's type
 * from the other; two booleans are a bool.
 */
export type Select = {
    <D extends Any>(falseVal: Node<D>, trueVal: Node<D> | ScalarLiteral<D>, condition: Node<Any> | boolean): Node<D>;
    <D extends Any>(falseVal: ScalarLiteral<D>, trueVal: Node<D>, condition: Node<Any> | boolean): Node<D>;
    (falseVal: boolean, trueVal: boolean, condition: Node<Any> | boolean): Node<d.bool>;
};
export const select: Select = (falseVal: Operand, trueVal: Operand, condition: Node<Any> | boolean): never => {
    const [f, t] = sameTypeOperands('select', [falseVal, trueVal]) as [Node<Any>, Node<Any>];
    return new ConditionalNode(boolOperand('select', condition), t, f) as never;
};

function makeVar<D extends Any>(init: Node<D>, label?: string): VarNode<D> {
    const v = new VarNode(init.type, label, init);
    // Add to current stack if building inside Fn, otherwise return standalone node.
    // The standalone VarNode still participates in the graph via its `init` reference.
    if (currentStack !== null) currentStack.push(v);
    return v;
}

function makeLet<D extends Any>(init: Node<D>, label?: string): LetNode<D> {
    const v = new LetNode(init.type, label, init);
    if (currentStack !== null) currentStack.push(v);
    return v;
}

/**
 * Function-scope mutable variable: `var name = init;`
 *
 * @example
 * const velocity = Var('velocity', vec3f(0));
 * // → var velocity = vec3f(0.0);
 */
export function Var<D extends Any>(name: string, init: Node<D>): VarNode<D>;
export function Var(name: string, init: boolean): VarNode<d.bool>;
export function Var(name: string, init: Node<Any> | boolean): VarNode<Any> {
    return makeVar(initOperand('Var', init), name);
}

/**
 * Function-scope immutable binding: `let name = init;`
 *
 * @example
 * const half = Let('half', value.mul(0.5));
 * // → let half = (value * 0.5);
 */
export function Let<D extends Any>(name: string, init: Node<D>): LetNode<D>;
export function Let(name: string, init: boolean): LetNode<d.bool>;
export function Let(name: string, init: Node<Any> | boolean): LetNode<Any> {
    return makeLet(initOperand('Let', init), name);
}

/** @deprecated Use Let() instead */
export function Const<D extends Any>(name: string, init: Node<D>): LetNode<D> {
    return makeLet(init, name);
}

// ─── Module-scope variable factories ──────────────────────────────────────────

/**
 * Create a module-scope private variable: `var<private> name: T [= init];`
 *
 * Private variables are per-invocation storage at module scope.
 *
 * @example Type-only (no initializer)
 * const counter = PrivateVar('counter', d.u32);
 * // → var<private> counter: u32;
 *
 * @example With initializer (type inferred from node)
 * const gravity = PrivateVar('gravity', vec3f(0, -9.8, 0));
 * // → var<private> gravity: vec3f = vec3f(0.0, -9.8, 0.0);
 */
export function PrivateVar<D extends Any>(name: string, type: D): PrivateVarNode<D>;
export function PrivateVar<D extends Any>(name: string, init: Node<D>): PrivateVarNode<D>;
export function PrivateVar<D extends Any>(name: string, typeOrInit: D | Node<D>): PrivateVarNode<D> {
    if (typeOrInit instanceof Node) return new PrivateVarNode(typeOrInit.type, name, typeOrInit);
    return new PrivateVarNode(typeOrInit, name);
}

/**
 * Create a module-scope workgroup variable: `var<workgroup> name: T;`
 *
 * Workgroup variables are shared across all invocations in a workgroup.
 * Only valid in compute shaders. Cannot have an initializer.
 *
 * @example
 * const shared = WorkgroupVar('sharedData', d.array(d.f32, 256));
 * // → var<workgroup> sharedData: array<f32, 256>;
 */
export function WorkgroupVar<D extends Any>(name: string, type: D): WorkgroupVarNode<D> {
    return new WorkgroupVarNode(type, name);
}

export function assign<D extends Any>(target: Node<D>, value: Node<D>): void {
    addToStack(new AssignNode(target, value));
}

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

export function compute(fn: FnNode<Any>, opts: ComputeOptions): ComputeNode {
    return new ComputeNode({ fn, ...opts });
}

// ── Struct ────────────────────────────────────────────────────────────────────

export type StructInstance<S extends d.StructSchema> = { readonly $node: Node<d.StructDesc> } & {
    readonly [K in keyof S]: Node<S[K]>;
};
export type StructMember = { readonly name: string; readonly type: Any };

export type StructDef<S extends d.StructSchema> = {
    readonly type: 'struct';
    readonly wgslType: string;
    // GLSL struct name == WGSL struct name (see StructDesc); glslType === wgslType === name.
    readonly glslType: string;
    readonly name: string;
    readonly fields: S;
    readonly members: StructMember[];
    readonly node: StructNode<S>;
    readonly nestedDefs: ReadonlyMap<string, StructDef<d.StructSchema>>;
    construct(fields: { readonly [K in keyof S]: Node<S[K]> }): ConstructNode<StructDef<S>>;
};

export function struct<S extends d.StructSchema>(name: string, fields: S): StructDef<S> {
    const members: StructMember[] = Object.entries(fields).map(([n, desc]) => ({ name: n, type: desc }));
    const structDesc: d.StructDesc<S> = { type: 'struct', wgslType: name, glslType: name, name, fields };
    const node = new StructNode<S>(structDesc, members);
    const nestedDefs: Map<string, StructDef<d.StructSchema>> = new Map();
    for (const desc of Object.values(fields)) {
        if (isStructDef(desc)) nestedDefs.set(desc.wgslType, desc as unknown as StructDef<d.StructSchema>);
    }
    function construct(fieldNodes: { readonly [K in keyof S]: Node<S[K]> }): ConstructNode<StructDef<S>> {
        const args = members.map((m) => fieldNodes[m.name as keyof S] as Node<Any>);
        return new ConstructNode(def as unknown as StructDef<S>, args);
    }
    const def: StructDef<S> = {
        type: 'struct',
        wgslType: name,
        glslType: name,
        name,
        fields,
        members,
        node,
        nestedDefs,
        construct,
    };
    return def;
}

export class StructNode<S extends d.StructSchema = d.StructSchema> extends Node<d.StructDesc<S>> {
    readonly kind = NodeKind.Struct;
    constructor(
        desc: d.StructDesc<S>,
        readonly members: StructMember[],
    ) {
        super(desc);
    }
}
