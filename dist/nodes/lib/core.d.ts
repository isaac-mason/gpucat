import type { NodeFrame } from '../../renderer/node-frame';
import type { Any, WgslType, MulResultDesc, ArithResultDesc, CompareResultDesc, StructField, StructKeys, VecElementDesc, Vec2DescOf, Vec3DescOf, Vec4DescOf } from '../../schema/schema';
import * as d from '../../schema/schema';
export type { WgslType } from '../../schema/schema';
export type ScalarType = 'f32' | 'i32' | 'u32' | 'bool' | 'f16';
export type AtomicType = 'atomic<i32>' | 'atomic<u32>';
export type Vec2Type = 'vec2f' | 'vec2i' | 'vec2u' | 'vec2<bool>' | 'vec2h';
export type Vec3Type = 'vec3f' | 'vec3i' | 'vec3u' | 'vec3<bool>' | 'vec3h';
export type Vec4Type = 'vec4f' | 'vec4i' | 'vec4u' | 'vec4<bool>' | 'vec4h';
export type VecType = Vec2Type | Vec3Type | Vec4Type;
export type MatType = 'mat2x2f' | 'mat2x3f' | 'mat2x4f' | 'mat3x2f' | 'mat3x3f' | 'mat3x4f' | 'mat4x2f' | 'mat4x3f' | 'mat4x4f' | 'mat2x2h' | 'mat2x3h' | 'mat2x4h' | 'mat3x2h' | 'mat3x3h' | 'mat3x4h' | 'mat4x2h' | 'mat4x3h' | 'mat4x4h';
export type NumericType = ScalarType | VecType | MatType;
export type SamplerType = 'sampler' | 'sampler_comparison';
export type TextureType = string;
export type GpuTypedArray = Float32Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array;
export type VecElement<T extends VecType> = T extends 'vec2f' | 'vec3f' | 'vec4f' ? 'f32' : T extends 'vec2i' | 'vec3i' | 'vec4i' ? 'i32' : T extends 'vec2u' | 'vec3u' | 'vec4u' ? 'u32' : T extends 'vec2h' | 'vec3h' | 'vec4h' ? 'f16' : 'bool';
export type Vec2Of<E extends ScalarType> = E extends 'f32' ? 'vec2f' : E extends 'i32' ? 'vec2i' : E extends 'u32' ? 'vec2u' : E extends 'f16' ? 'vec2h' : 'vec2<bool>';
export type Vec3Of<E extends ScalarType> = E extends 'f32' ? 'vec3f' : E extends 'i32' ? 'vec3i' : E extends 'u32' ? 'vec3u' : E extends 'f16' ? 'vec3h' : 'vec3<bool>';
export type Vec4Of<E extends ScalarType> = E extends 'f32' ? 'vec4f' : E extends 'i32' ? 'vec4i' : E extends 'u32' ? 'vec4u' : E extends 'f16' ? 'vec4h' : 'vec4<bool>';
export type Swizzle1<T extends WgslType> = T extends VecType ? VecElement<T> : T extends ScalarType ? T : WgslType;
export type Swizzle2<T extends WgslType> = T extends VecType ? Vec2Of<VecElement<T>> : WgslType;
export type Swizzle3<T extends WgslType> = T extends VecType ? Vec3Of<VecElement<T>> : WgslType;
export type Swizzle4<T extends WgslType> = T extends VecType ? Vec4Of<VecElement<T>> : WgslType;
export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '>' | '<=' | '>=' | '||' | '&&' | '&' | '|' | '^' | '<<' | '>>';
export declare let _nodeId: number;
export declare const isVecType: (t: string) => boolean;
export declare const isMatType: (t: string) => boolean;
export declare const isScalarType: (t: string) => boolean;
export declare function vecElementType(t: string): WgslType;
export declare function vecElementTypeOrSelf(t: string): WgslType;
export declare function vec2TypeOf(t: string): WgslType;
export declare function vec3TypeOf(t: string): WgslType;
export declare function vec4TypeOf(t: string): WgslType;
export declare function mulResultType(a: string, b: string): WgslType;
export declare function arithResultType(a: string, b: string): WgslType;
export declare function pushStack(stack: StackNode): StackNode | null;
export declare function popStack(prev: StackNode | null): void;
export declare function addToStack(node: Node<Any>): void;
export declare const NodeUpdateType: {
    readonly NONE: "none";
    readonly FRAME: "frame";
    readonly RENDER: "render";
    readonly OBJECT: "object";
};
export type NodeUpdateType = (typeof NodeUpdateType)[keyof typeof NodeUpdateType];
export declare class Node<D extends Any> {
    readonly id: number;
    readonly type: D;
    _beforeNodes: Node<Any>[] | null;
    updateType: NodeUpdateType;
    updateBeforeType: NodeUpdateType;
    updateAfterType: NodeUpdateType;
    global: boolean;
    parents: boolean;
    readonly isNode: boolean;
    constructor(type: D);
    update?(frame: NodeFrame): unknown;
    updateBefore?(frame: NodeFrame): unknown;
    updateAfter?(frame: NodeFrame): unknown;
    onUpdate(callback: (frame: NodeFrame) => unknown, updateType: NodeUpdateType): this;
    onRenderUpdate(callback: (frame: NodeFrame) => unknown): this;
    onObjectUpdate(callback: (frame: NodeFrame) => unknown): this;
    onFrameUpdate(callback: (frame: NodeFrame) => unknown): this;
    onBeforeUpdate(callback: (frame: NodeFrame) => unknown, updateType: NodeUpdateType): this;
    onBeforeRender(callback: (frame: NodeFrame) => unknown): this;
    onBeforeObject(callback: (frame: NodeFrame) => unknown): this;
    onBeforeFrame(callback: (frame: NodeFrame) => unknown): this;
    onAfterUpdate(callback: (frame: NodeFrame) => unknown, updateType: NodeUpdateType): this;
    onAfterRender(callback: (frame: NodeFrame) => unknown): this;
    onAfterObject(callback: (frame: NodeFrame) => unknown): this;
    onAfterFrame(callback: (frame: NodeFrame) => unknown): this;
    before(node: Node<Any>): this;
    toF32(): Node<d.f32>;
    toF16(): Node<d.f16>;
    toU32(): Node<d.u32>;
    toI32(): Node<d.i32>;
    field<K extends StructKeys<D>>(name: K): Node<StructField<D, K>>;
    fields(): Fields<d.StructSchemaOf<D>>;
    greaterThan(b: Node<D>): Node<CompareResultDesc<D>>;
    lessThan(b: Node<D>): Node<CompareResultDesc<D>>;
    greaterThanEqual(b: Node<D>): Node<CompareResultDesc<D>>;
    lessThanEqual(b: Node<D>): Node<CompareResultDesc<D>>;
    equal(b: Node<D>): Node<CompareResultDesc<D>>;
    notEqual(b: Node<D>): Node<CompareResultDesc<D>>;
    /** `select(falseVal, trueVal, this)`, use `this` node as the condition. */
    select<T extends Any>(ifTrue: Node<T>, ifFalse: Node<T>): Node<T>;
    any(): Node<d.bool>;
    all(): Node<d.bool>;
    add<N extends Node<Any>>(b: N): Node<ArithResultDesc<D, N['type']>>;
    sub<N extends Node<Any>>(b: N): Node<ArithResultDesc<D, N['type']>>;
    div<N extends Node<Any>>(b: N): Node<ArithResultDesc<D, N['type']>>;
    mul<N extends Node<Any>>(b: N): Node<MulResultDesc<D, N['type']>>;
    abs(): Node<D>;
    floor(): Node<D>;
    ceil(): Node<D>;
    fract(): Node<D>;
    sqrt(): Node<D>;
    sin(): Node<D>;
    cos(): Node<D>;
    negate(): Node<D>;
    normalize(): Node<D>;
    length(): Node<d.f32>;
    dot(b: Node<D>): Node<d.f32>;
    cross(b: Node<D>): Node<D>;
    pow(b: Node<D>): Node<D>;
    max(b: Node<D>): Node<D>;
    min(b: Node<D>): Node<D>;
    clamp(lo: Node<D>, hi: Node<D>): Node<D>;
    mix(b: Node<D>, t: Node<Any>): Node<D>;
    step(x: Node<D>): Node<D>;
    smoothstep(hi: Node<D>, x: Node<D>): Node<D>;
    dpdx(): Node<D>;
    dpdy(): Node<D>;
    fwidth(): Node<D>;
    dpdxCoarse(): Node<D>;
    dpdyCoarse(): Node<D>;
    fwidthCoarse(): Node<D>;
    dpdxFine(): Node<D>;
    dpdyFine(): Node<D>;
    fwidthFine(): Node<D>;
    element(idx: Node<Any>): Node<d.ElementOf<D>>;
    assign(value: Node<D>): void;
    toVar(label?: string): VarNode<D>;
    toConst(label?: string): LetNode<D>;
    addAssign<N extends Node<Any>>(v: N): void;
    subAssign<N extends Node<Any>>(v: N): void;
    mulAssign<N extends Node<Any>>(v: N): void;
    divAssign<N extends Node<Any>>(v: N): void;
    sign(): Node<D>;
    mod(b: Node<D>): Node<D>;
    oneMinus(): Node<D>;
    or(b: Node<d.bool>): Node<d.bool>;
    and(b: Node<d.bool>): Node<d.bool>;
    not(): Node<d.bool>;
    bitwiseAnd(b: Node<D>): Node<D>;
    bitwiseOr(b: Node<D>): Node<D>;
    bitwiseXor(b: Node<D>): Node<D>;
    shiftLeft(b: Node<D>): Node<D>;
    shiftRight(b: Node<D>): Node<D>;
    transpose(): Node<D>;
    get x(): Node<VecElementDesc<D>>;
    get y(): Node<VecElementDesc<D>>;
    get z(): Node<VecElementDesc<D>>;
    get w(): Node<VecElementDesc<D>>;
    get r(): Node<VecElementDesc<D>>;
    get g(): Node<VecElementDesc<D>>;
    get b(): Node<VecElementDesc<D>>;
    get a(): Node<VecElementDesc<D>>;
    get xx(): Node<Vec2DescOf<D>>;
    get xy(): Node<Vec2DescOf<D>>;
    get xz(): Node<Vec2DescOf<D>>;
    get xw(): Node<Vec2DescOf<D>>;
    get yx(): Node<Vec2DescOf<D>>;
    get yy(): Node<Vec2DescOf<D>>;
    get yz(): Node<Vec2DescOf<D>>;
    get yw(): Node<Vec2DescOf<D>>;
    get zx(): Node<Vec2DescOf<D>>;
    get zy(): Node<Vec2DescOf<D>>;
    get zz(): Node<Vec2DescOf<D>>;
    get zw(): Node<Vec2DescOf<D>>;
    get wx(): Node<Vec2DescOf<D>>;
    get wy(): Node<Vec2DescOf<D>>;
    get wz(): Node<Vec2DescOf<D>>;
    get ww(): Node<Vec2DescOf<D>>;
    get rr(): Node<Vec2DescOf<D>>;
    get rg(): Node<Vec2DescOf<D>>;
    get rb(): Node<Vec2DescOf<D>>;
    get ra(): Node<Vec2DescOf<D>>;
    get gr(): Node<Vec2DescOf<D>>;
    get gg(): Node<Vec2DescOf<D>>;
    get gb(): Node<Vec2DescOf<D>>;
    get ga(): Node<Vec2DescOf<D>>;
    get br(): Node<Vec2DescOf<D>>;
    get bg(): Node<Vec2DescOf<D>>;
    get bb(): Node<Vec2DescOf<D>>;
    get ba(): Node<Vec2DescOf<D>>;
    get ar(): Node<Vec2DescOf<D>>;
    get ag(): Node<Vec2DescOf<D>>;
    get ab(): Node<Vec2DescOf<D>>;
    get aa(): Node<Vec2DescOf<D>>;
    get xxx(): Node<Vec3DescOf<D>>;
    get xxy(): Node<Vec3DescOf<D>>;
    get xxz(): Node<Vec3DescOf<D>>;
    get xxw(): Node<Vec3DescOf<D>>;
    get xyx(): Node<Vec3DescOf<D>>;
    get xyy(): Node<Vec3DescOf<D>>;
    get xyz(): Node<Vec3DescOf<D>>;
    get xyw(): Node<Vec3DescOf<D>>;
    get xzx(): Node<Vec3DescOf<D>>;
    get xzy(): Node<Vec3DescOf<D>>;
    get xzz(): Node<Vec3DescOf<D>>;
    get xzw(): Node<Vec3DescOf<D>>;
    get xwx(): Node<Vec3DescOf<D>>;
    get xwy(): Node<Vec3DescOf<D>>;
    get xwz(): Node<Vec3DescOf<D>>;
    get xww(): Node<Vec3DescOf<D>>;
    get yxx(): Node<Vec3DescOf<D>>;
    get yxy(): Node<Vec3DescOf<D>>;
    get yxz(): Node<Vec3DescOf<D>>;
    get yxw(): Node<Vec3DescOf<D>>;
    get yyx(): Node<Vec3DescOf<D>>;
    get yyy(): Node<Vec3DescOf<D>>;
    get yyz(): Node<Vec3DescOf<D>>;
    get yyw(): Node<Vec3DescOf<D>>;
    get yzx(): Node<Vec3DescOf<D>>;
    get yzy(): Node<Vec3DescOf<D>>;
    get yzz(): Node<Vec3DescOf<D>>;
    get yzw(): Node<Vec3DescOf<D>>;
    get ywx(): Node<Vec3DescOf<D>>;
    get ywy(): Node<Vec3DescOf<D>>;
    get ywz(): Node<Vec3DescOf<D>>;
    get yww(): Node<Vec3DescOf<D>>;
    get zxx(): Node<Vec3DescOf<D>>;
    get zxy(): Node<Vec3DescOf<D>>;
    get zxz(): Node<Vec3DescOf<D>>;
    get zxw(): Node<Vec3DescOf<D>>;
    get zyx(): Node<Vec3DescOf<D>>;
    get zyy(): Node<Vec3DescOf<D>>;
    get zyz(): Node<Vec3DescOf<D>>;
    get zyw(): Node<Vec3DescOf<D>>;
    get zzx(): Node<Vec3DescOf<D>>;
    get zzy(): Node<Vec3DescOf<D>>;
    get zzz(): Node<Vec3DescOf<D>>;
    get zzw(): Node<Vec3DescOf<D>>;
    get zwx(): Node<Vec3DescOf<D>>;
    get zwy(): Node<Vec3DescOf<D>>;
    get zwz(): Node<Vec3DescOf<D>>;
    get zww(): Node<Vec3DescOf<D>>;
    get wxx(): Node<Vec3DescOf<D>>;
    get wxy(): Node<Vec3DescOf<D>>;
    get wxz(): Node<Vec3DescOf<D>>;
    get wxw(): Node<Vec3DescOf<D>>;
    get wyx(): Node<Vec3DescOf<D>>;
    get wyy(): Node<Vec3DescOf<D>>;
    get wyz(): Node<Vec3DescOf<D>>;
    get wyw(): Node<Vec3DescOf<D>>;
    get wzx(): Node<Vec3DescOf<D>>;
    get wzy(): Node<Vec3DescOf<D>>;
    get wzz(): Node<Vec3DescOf<D>>;
    get wzw(): Node<Vec3DescOf<D>>;
    get wwx(): Node<Vec3DescOf<D>>;
    get wwy(): Node<Vec3DescOf<D>>;
    get wwz(): Node<Vec3DescOf<D>>;
    get www(): Node<Vec3DescOf<D>>;
    get rrr(): Node<Vec3DescOf<D>>;
    get rrg(): Node<Vec3DescOf<D>>;
    get rrb(): Node<Vec3DescOf<D>>;
    get rra(): Node<Vec3DescOf<D>>;
    get rgr(): Node<Vec3DescOf<D>>;
    get rgg(): Node<Vec3DescOf<D>>;
    get rgb(): Node<Vec3DescOf<D>>;
    get rga(): Node<Vec3DescOf<D>>;
    get rbr(): Node<Vec3DescOf<D>>;
    get rbg(): Node<Vec3DescOf<D>>;
    get rbb(): Node<Vec3DescOf<D>>;
    get rba(): Node<Vec3DescOf<D>>;
    get rar(): Node<Vec3DescOf<D>>;
    get rag(): Node<Vec3DescOf<D>>;
    get rab(): Node<Vec3DescOf<D>>;
    get raa(): Node<Vec3DescOf<D>>;
    get grr(): Node<Vec3DescOf<D>>;
    get grg(): Node<Vec3DescOf<D>>;
    get grb(): Node<Vec3DescOf<D>>;
    get gra(): Node<Vec3DescOf<D>>;
    get ggr(): Node<Vec3DescOf<D>>;
    get ggg(): Node<Vec3DescOf<D>>;
    get ggb(): Node<Vec3DescOf<D>>;
    get gga(): Node<Vec3DescOf<D>>;
    get gbr(): Node<Vec3DescOf<D>>;
    get gbg(): Node<Vec3DescOf<D>>;
    get gbb(): Node<Vec3DescOf<D>>;
    get gba(): Node<Vec3DescOf<D>>;
    get gar(): Node<Vec3DescOf<D>>;
    get gag(): Node<Vec3DescOf<D>>;
    get gab(): Node<Vec3DescOf<D>>;
    get gaa(): Node<Vec3DescOf<D>>;
    get brr(): Node<Vec3DescOf<D>>;
    get brg(): Node<Vec3DescOf<D>>;
    get brb(): Node<Vec3DescOf<D>>;
    get bra(): Node<Vec3DescOf<D>>;
    get bgr(): Node<Vec3DescOf<D>>;
    get bgg(): Node<Vec3DescOf<D>>;
    get bgb(): Node<Vec3DescOf<D>>;
    get bga(): Node<Vec3DescOf<D>>;
    get bbr(): Node<Vec3DescOf<D>>;
    get bbg(): Node<Vec3DescOf<D>>;
    get bbb(): Node<Vec3DescOf<D>>;
    get bba(): Node<Vec3DescOf<D>>;
    get bar(): Node<Vec3DescOf<D>>;
    get bag(): Node<Vec3DescOf<D>>;
    get bab(): Node<Vec3DescOf<D>>;
    get baa(): Node<Vec3DescOf<D>>;
    get arr(): Node<Vec3DescOf<D>>;
    get arg(): Node<Vec3DescOf<D>>;
    get arb(): Node<Vec3DescOf<D>>;
    get ara(): Node<Vec3DescOf<D>>;
    get agr(): Node<Vec3DescOf<D>>;
    get agg(): Node<Vec3DescOf<D>>;
    get agb(): Node<Vec3DescOf<D>>;
    get aga(): Node<Vec3DescOf<D>>;
    get abr(): Node<Vec3DescOf<D>>;
    get abg(): Node<Vec3DescOf<D>>;
    get abb(): Node<Vec3DescOf<D>>;
    get aba(): Node<Vec3DescOf<D>>;
    get aar(): Node<Vec3DescOf<D>>;
    get aag(): Node<Vec3DescOf<D>>;
    get aab(): Node<Vec3DescOf<D>>;
    get aaa(): Node<Vec3DescOf<D>>;
    get xyzw(): Node<Vec4DescOf<D>>;
    get xywz(): Node<Vec4DescOf<D>>;
    get xzyw(): Node<Vec4DescOf<D>>;
    get xzwy(): Node<Vec4DescOf<D>>;
    get xwyz(): Node<Vec4DescOf<D>>;
    get xwzy(): Node<Vec4DescOf<D>>;
    get yxzw(): Node<Vec4DescOf<D>>;
    get yxwz(): Node<Vec4DescOf<D>>;
    get yzxw(): Node<Vec4DescOf<D>>;
    get yzwx(): Node<Vec4DescOf<D>>;
    get ywxz(): Node<Vec4DescOf<D>>;
    get ywzx(): Node<Vec4DescOf<D>>;
    get zxyw(): Node<Vec4DescOf<D>>;
    get zxwy(): Node<Vec4DescOf<D>>;
    get zyxw(): Node<Vec4DescOf<D>>;
    get zywx(): Node<Vec4DescOf<D>>;
    get zwxy(): Node<Vec4DescOf<D>>;
    get zwyx(): Node<Vec4DescOf<D>>;
    get wxyz(): Node<Vec4DescOf<D>>;
    get wxzy(): Node<Vec4DescOf<D>>;
    get wyxz(): Node<Vec4DescOf<D>>;
    get wyzx(): Node<Vec4DescOf<D>>;
    get wzxy(): Node<Vec4DescOf<D>>;
    get wzyx(): Node<Vec4DescOf<D>>;
    get rgba(): Node<Vec4DescOf<D>>;
    get rgab(): Node<Vec4DescOf<D>>;
    get rbga(): Node<Vec4DescOf<D>>;
    get rbag(): Node<Vec4DescOf<D>>;
    get ragb(): Node<Vec4DescOf<D>>;
    get rabg(): Node<Vec4DescOf<D>>;
    get grba(): Node<Vec4DescOf<D>>;
    get grab(): Node<Vec4DescOf<D>>;
    get gbra(): Node<Vec4DescOf<D>>;
    get gbar(): Node<Vec4DescOf<D>>;
    get garb(): Node<Vec4DescOf<D>>;
    get gabr(): Node<Vec4DescOf<D>>;
    get brga(): Node<Vec4DescOf<D>>;
    get brag(): Node<Vec4DescOf<D>>;
    get bgra(): Node<Vec4DescOf<D>>;
    get bgar(): Node<Vec4DescOf<D>>;
    get barg(): Node<Vec4DescOf<D>>;
    get bagr(): Node<Vec4DescOf<D>>;
    get argb(): Node<Vec4DescOf<D>>;
    get arbg(): Node<Vec4DescOf<D>>;
    get agrb(): Node<Vec4DescOf<D>>;
    get agbr(): Node<Vec4DescOf<D>>;
    get abrg(): Node<Vec4DescOf<D>>;
    get abgr(): Node<Vec4DescOf<D>>;
    inspect(name?: string): this;
}
export declare function isNode(v: unknown): v is Node<Any>;
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
export declare function node(): Node<d.Void>;
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
export declare class InspectorNode<D extends Any> extends Node<D> {
    /** The original node being inspected. */
    readonly wrappedNode: Node<D>;
    /** Display name for the inspector UI. */
    readonly inspectorName: string;
    /** Marker for type checking. */
    readonly isInspectorNode = true;
    constructor(node: Node<D>, name?: string);
    /**
     * Called by the node update system every frame.
     * Registers this node with the renderer's inspector.
     */
    update: (frame: NodeFrame) => void;
    /**
     * Returns the display name for the inspector.
     */
    getName(): string;
}
export declare class LiteralNode<D extends Any> extends Node<D> {
    readonly value: number | number[] | string;
    constructor(type: D, value: number | number[] | string);
}
export declare class LetNode<D extends Any> extends Node<D> {
    readonly varName: string;
    readonly init: Node<D>;
    constructor(type: D, varName: string, init: Node<D>);
}
export declare class VarNode<D extends Any> extends Node<D> {
    readonly varName: string;
    readonly init: Node<D>;
    constructor(type: D, varName: string, init: Node<D>);
}
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
export declare class PrivateVarNode<D extends Any> extends Node<D> {
    readonly varName: string;
    readonly init?: Node<D> | undefined;
    constructor(type: D, varName: string, init?: Node<D> | undefined);
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
export declare class WorkgroupVarNode<D extends Any> extends Node<D> {
    readonly varName: string;
    constructor(type: D, varName: string);
}
export declare class AssignNode extends Node<d.Void> {
    readonly target: Node<Any>;
    readonly value: Node<Any>;
    constructor(target: Node<Any>, value: Node<Any>);
}
export declare class BinaryOpNode<D extends Any> extends Node<D> {
    readonly op: BinaryOp;
    readonly left: Node<Any>;
    readonly right: Node<Any>;
    constructor(op: BinaryOp, type: D, left: Node<Any>, right: Node<Any>);
}
/** Opaque reference to WgslFunctionNode to avoid circular import */
export interface WgslFunctionNodeRef {
    readonly code: string;
    readonly includes: WgslFunctionNodeRef[];
    getNodeFunction(): {
        outputType: string;
        name: string;
    };
}
export declare class CallNode<D extends Any> extends Node<D> {
    readonly fn: string;
    readonly args: Node<Any>[];
    readonly fnNode?: FnNode<any>;
    readonly wgslFnNode?: WgslFunctionNodeRef;
    constructor(type: D, fn: string, args: Node<Any>[], fnNode?: FnNode<any>, wgslFnNode?: WgslFunctionNodeRef);
}
export declare class ConstructNode<D extends Any> extends Node<D> {
    readonly args: Node<Any>[];
    constructor(type: D, args: Node<Any>[]);
}
export declare class FieldNode<D extends Any> extends Node<D> {
    readonly object: Node<Any>;
    readonly fieldName: string;
    constructor(type: D, object: Node<Any>, fieldName: string);
}
/**
 * Represents an inline fixed-size array expression in WGSL.
 *
 * Use `array([e0, e1, e2])` to construct, then `.element(idx)` to index into it.
 * This corresponds to WGSL's array value constructor expression.
 */
export declare class ArrayNode<E extends Any> extends Node<{
    readonly type: 'sized-array';
    readonly wgslType: `array<${string}, ${number}>`;
    readonly element: E;
    readonly length: number;
}> {
    readonly elements: Node<E>[];
    constructor(elementType: E, elements: Node<E>[]);
}
export declare class IndexNode<D extends Any> extends Node<D> {
    readonly array: Node<Any>;
    readonly index: Node<Any>;
    constructor(type: D, array: Node<Any>, index: Node<Any>);
}
/** Type-safe field access for structs - infers the field type from the struct descriptor */
export declare const field: <D extends Any, K extends StructKeys<D>>(node: Node<D>, name: K) => Node<StructField<D, K>>;
export declare const index: <N extends Node<Any>>(array: N, idx: Node<Any>) => Node<d.ElementOf<N["type"]>>;
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
export declare function fields<S extends d.StructSchema>(node: Node<StructDef<S>>): Fields<S>;
export declare function fields<S extends d.StructSchema>(node: Node<d.StructDesc<S>>): Fields<S>;
export declare const toF32: <D extends Any>(node: Node<D>) => Node<d.f32>;
export declare const toF16: <D extends Any>(node: Node<D>) => Node<d.f16>;
export declare const toU32: <D extends Any>(node: Node<D>) => Node<d.u32>;
export declare const toI32: <D extends Any>(node: Node<D>) => Node<d.i32>;
/** Reinterpret a u32 or i32 bit pattern as f32. WGSL: `bitcast<f32>(x)`. */
export declare const bitcastF32: (node: Node<d.u32 | d.i32>) => Node<d.f32>;
/** Reinterpret an f32 or i32 bit pattern as u32. WGSL: `bitcast<u32>(x)`. */
export declare const bitcastU32: (node: Node<d.f32 | d.i32>) => Node<d.u32>;
/** Reinterpret an f32 or u32 bit pattern as i32. WGSL: `bitcast<i32>(x)`. */
export declare const bitcastI32: (node: Node<d.f32 | d.u32>) => Node<d.i32>;
export declare const greaterThan: <D extends Any>(a: Node<D>, b: Node<D>) => Node<CompareResultDesc<D>>;
export declare const lessThan: <D extends Any>(a: Node<D>, b: Node<D>) => Node<CompareResultDesc<D>>;
export declare const greaterThanEqual: <D extends Any>(a: Node<D>, b: Node<D>) => Node<CompareResultDesc<D>>;
export declare const lessThanEqual: <D extends Any>(a: Node<D>, b: Node<D>) => Node<CompareResultDesc<D>>;
export declare const equal: <D extends Any>(a: Node<D>, b: Node<D>) => Node<CompareResultDesc<D>>;
export declare const notEqual: <D extends Any>(a: Node<D>, b: Node<D>) => Node<CompareResultDesc<D>>;
export declare const any: <D extends Any>(a: Node<D>) => Node<d.bool>;
export declare const all: <D extends Any>(a: Node<D>) => Node<d.bool>;
/**
 * Create an inline fixed-size array of nodes, emitted as `array<E, N>(e0, e1, ..., eN-1)`.
 * All elements must share the same WGSL type.
 * Use `.element(idx)` to index into the result.
 *
 * @example
 * const weights = array([w0, w1, w2]);
 * const w = weights.element(gx);
 */
export declare function array<E extends Any>(elements: [Node<E>, ...Node<E>[]]): Node<{
    readonly type: 'sized-array';
    readonly wgslType: `array<${string}, ${number}>`;
    readonly element: E;
    readonly length: number;
}>;
export declare function f32(v?: number): LiteralNode<d.f32>;
export declare function f32(v: Node<Any>): Node<d.f32>;
export declare function f16(v?: number): LiteralNode<d.f16>;
export declare function f16(v: Node<Any>): Node<d.f16>;
export declare function i32(v?: number): LiteralNode<d.i32>;
export declare function i32(v: Node<Any>): Node<d.i32>;
export declare function u32(v?: number): LiteralNode<d.u32>;
export declare function u32(v: Node<Any>): Node<d.u32>;
export declare const bool: (v: boolean) => LiteralNode<d.bool>;
type Scalar = Node<Any> | number | boolean;
export declare function makeVec2<D extends d.Vec2>(desc: D): {
    (v: Scalar): ConstructNode<D>;
    (x: Scalar, y: Scalar): ConstructNode<D>;
};
export declare function makeVec3<D extends d.Vec3>(desc: D): {
    (v: Scalar): ConstructNode<D>;
    (xy: Node<Any>, z: Scalar): ConstructNode<D>;
    (x: Scalar, y: Scalar, z: Scalar): ConstructNode<D>;
};
export declare function makeVec4<D extends d.Vec4>(desc: D): {
    (v: Scalar): ConstructNode<D>;
    (xy: Node<Any>, zw: Node<Any>): ConstructNode<D>;
    (xy: Node<Any>, z: Scalar, w: Scalar): ConstructNode<D>;
    (xyz: Node<Any>, w: Scalar): ConstructNode<D>;
    (x: Scalar, y: Scalar, z: Scalar, w: Scalar): ConstructNode<D>;
};
export declare const vec2: {
    (v: Scalar): ConstructNode<d.vec2f>;
    (x: Scalar, y: Scalar): ConstructNode<d.vec2f>;
};
export declare const vec3: {
    (v: Scalar): ConstructNode<d.vec3f>;
    (xy: Node<Any>, z: Scalar): ConstructNode<d.vec3f>;
    (x: Scalar, y: Scalar, z: Scalar): ConstructNode<d.vec3f>;
};
export declare const vec4: {
    (v: Scalar): ConstructNode<d.vec4f>;
    (xy: Node<Any>, zw: Node<Any>): ConstructNode<d.vec4f>;
    (xy: Node<Any>, z: Scalar, w: Scalar): ConstructNode<d.vec4f>;
    (xyz: Node<Any>, w: Scalar): ConstructNode<d.vec4f>;
    (x: Scalar, y: Scalar, z: Scalar, w: Scalar): ConstructNode<d.vec4f>;
};
export declare const vec2f: {
    (v: Scalar): ConstructNode<d.vec2f>;
    (x: Scalar, y: Scalar): ConstructNode<d.vec2f>;
};
export declare const vec3f: {
    (v: Scalar): ConstructNode<d.vec3f>;
    (xy: Node<Any>, z: Scalar): ConstructNode<d.vec3f>;
    (x: Scalar, y: Scalar, z: Scalar): ConstructNode<d.vec3f>;
};
export declare const vec4f: {
    (v: Scalar): ConstructNode<d.vec4f>;
    (xy: Node<Any>, zw: Node<Any>): ConstructNode<d.vec4f>;
    (xy: Node<Any>, z: Scalar, w: Scalar): ConstructNode<d.vec4f>;
    (xyz: Node<Any>, w: Scalar): ConstructNode<d.vec4f>;
    (x: Scalar, y: Scalar, z: Scalar, w: Scalar): ConstructNode<d.vec4f>;
};
export declare const vec2i: {
    (v: Scalar): ConstructNode<d.vec2i>;
    (x: Scalar, y: Scalar): ConstructNode<d.vec2i>;
};
export declare const vec3i: {
    (v: Scalar): ConstructNode<d.vec3i>;
    (xy: Node<Any>, z: Scalar): ConstructNode<d.vec3i>;
    (x: Scalar, y: Scalar, z: Scalar): ConstructNode<d.vec3i>;
};
export declare const vec4i: {
    (v: Scalar): ConstructNode<d.vec4i>;
    (xy: Node<Any>, zw: Node<Any>): ConstructNode<d.vec4i>;
    (xy: Node<Any>, z: Scalar, w: Scalar): ConstructNode<d.vec4i>;
    (xyz: Node<Any>, w: Scalar): ConstructNode<d.vec4i>;
    (x: Scalar, y: Scalar, z: Scalar, w: Scalar): ConstructNode<d.vec4i>;
};
export declare const vec2u: {
    (v: Scalar): ConstructNode<d.vec2u>;
    (x: Scalar, y: Scalar): ConstructNode<d.vec2u>;
};
export declare const vec3u: {
    (v: Scalar): ConstructNode<d.vec3u>;
    (xy: Node<Any>, z: Scalar): ConstructNode<d.vec3u>;
    (x: Scalar, y: Scalar, z: Scalar): ConstructNode<d.vec3u>;
};
export declare const vec4u: {
    (v: Scalar): ConstructNode<d.vec4u>;
    (xy: Node<Any>, zw: Node<Any>): ConstructNode<d.vec4u>;
    (xy: Node<Any>, z: Scalar, w: Scalar): ConstructNode<d.vec4u>;
    (xyz: Node<Any>, w: Scalar): ConstructNode<d.vec4u>;
    (x: Scalar, y: Scalar, z: Scalar, w: Scalar): ConstructNode<d.vec4u>;
};
export declare const vec2h: {
    (v: Scalar): ConstructNode<d.vec2h>;
    (x: Scalar, y: Scalar): ConstructNode<d.vec2h>;
};
export declare const vec3h: {
    (v: Scalar): ConstructNode<d.vec3h>;
    (xy: Node<Any>, z: Scalar): ConstructNode<d.vec3h>;
    (x: Scalar, y: Scalar, z: Scalar): ConstructNode<d.vec3h>;
};
export declare const vec4h: {
    (v: Scalar): ConstructNode<d.vec4h>;
    (xy: Node<Any>, zw: Node<Any>): ConstructNode<d.vec4h>;
    (xy: Node<Any>, z: Scalar, w: Scalar): ConstructNode<d.vec4h>;
    (xyz: Node<Any>, w: Scalar): ConstructNode<d.vec4h>;
    (x: Scalar, y: Scalar, z: Scalar, w: Scalar): ConstructNode<d.vec4h>;
};
export declare const vec2b: {
    (v: Scalar): ConstructNode<d.vec2bool>;
    (x: Scalar, y: Scalar): ConstructNode<d.vec2bool>;
};
export declare const vec3b: {
    (v: Scalar): ConstructNode<d.vec3bool>;
    (xy: Node<Any>, z: Scalar): ConstructNode<d.vec3bool>;
    (x: Scalar, y: Scalar, z: Scalar): ConstructNode<d.vec3bool>;
};
export declare const vec4b: {
    (v: Scalar): ConstructNode<d.vec4bool>;
    (xy: Node<Any>, zw: Node<Any>): ConstructNode<d.vec4bool>;
    (xy: Node<Any>, z: Scalar, w: Scalar): ConstructNode<d.vec4bool>;
    (xyz: Node<Any>, w: Scalar): ConstructNode<d.vec4bool>;
    (x: Scalar, y: Scalar, z: Scalar, w: Scalar): ConstructNode<d.vec4bool>;
};
export declare const mat2x2f: (...v: number[]) => LiteralNode<d.mat2x2f>;
export declare const mat2x3f: (...v: number[]) => LiteralNode<d.mat2x3f>;
export declare const mat2x4f: (...v: number[]) => LiteralNode<d.mat2x4f>;
export declare const mat3x2f: (...v: number[]) => LiteralNode<d.mat3x2f>;
export declare const mat3x3f: (...v: number[]) => LiteralNode<d.mat3x3f>;
export declare const mat3x4f: (...v: number[]) => LiteralNode<d.mat3x4f>;
export declare const mat4x2f: (...v: number[]) => LiteralNode<d.mat4x2f>;
export declare const mat4x3f: (...v: number[]) => LiteralNode<d.mat4x3f>;
export declare const mat4x4f: (...v: number[]) => LiteralNode<d.mat4x4f>;
export declare const mat2x2h: (...v: number[]) => LiteralNode<d.mat2x2h>;
export declare const mat2x3h: (...v: number[]) => LiteralNode<d.mat2x3h>;
export declare const mat2x4h: (...v: number[]) => LiteralNode<d.mat2x4h>;
export declare const mat3x2h: (...v: number[]) => LiteralNode<d.mat3x2h>;
export declare const mat3x3h: (...v: number[]) => LiteralNode<d.mat3x3h>;
export declare const mat3x4h: (...v: number[]) => LiteralNode<d.mat3x4h>;
export declare const mat4x2h: (...v: number[]) => LiteralNode<d.mat4x2h>;
export declare const mat4x3h: (...v: number[]) => LiteralNode<d.mat4x3h>;
export declare const mat4x4h: (...v: number[]) => LiteralNode<d.mat4x4h>;
export declare const mat4: (c0: Node<d.Vec4>, c1: Node<d.Vec4>, c2: Node<d.Vec4>, c3: Node<d.Vec4>) => ConstructNode<d.mat4x4f>;
export declare function mat3(c0: Node<d.Vec3>, c1: Node<d.Vec3>, c2: Node<d.Vec3>): Node<d.mat3x3f>;
export declare function mat3(diag: Node<d.f32>): Node<d.mat3x3f>;
export declare function mat3(s00: Node<d.f32>, s01: Node<d.f32>, s02: Node<d.f32>, s10: Node<d.f32>, s11: Node<d.f32>, s12: Node<d.f32>, s20: Node<d.f32>, s21: Node<d.f32>, s22: Node<d.f32>): Node<d.mat3x3f>;
export declare const add: <NA extends Node<Any>, NB extends Node<Any>>(a: NA, b: NB) => Node<ArithResultDesc<NA["type"], NB["type"]>>;
export declare const sub: <NA extends Node<Any>, NB extends Node<Any>>(a: NA, b: NB) => Node<ArithResultDesc<NA["type"], NB["type"]>>;
export declare const div: <NA extends Node<Any>, NB extends Node<Any>>(a: NA, b: NB) => Node<ArithResultDesc<NA["type"], NB["type"]>>;
export declare const mul: <NA extends Node<Any>, NB extends Node<Any>>(a: NA, b: NB) => Node<MulResultDesc<NA["type"], NB["type"]>>;
export declare const dot: (a: Node<Any>, b: Node<Any>) => Node<d.f32>;
export declare const cross: <D extends Any>(a: Node<D>, b: Node<D>) => Node<D>;
export declare const normalize: <D extends Any>(a: Node<D>) => Node<D>;
export declare const length: (a: Node<Any>) => Node<d.f32>;
/** Pack two f32s as halves into a u32. Lower 16 bits = v.x, upper = v.y. WGSL: `pack2x16float`. */
export declare const pack2x16float: (v: Node<d.vec2f>) => Node<d.u32>;
/** Unpack a u32 into two f32s from half-precision. WGSL: `unpack2x16float`. */
export declare const unpack2x16float: (v: Node<d.u32>) => Node<d.vec2f>;
/** Pack two f32s in [-1, 1] into a u32 as 16-bit snorm. WGSL: `pack2x16snorm`. */
export declare const pack2x16snorm: (v: Node<d.vec2f>) => Node<d.u32>;
/** Unpack a u32 into two f32s as 16-bit snorm. WGSL: `unpack2x16snorm`. */
export declare const unpack2x16snorm: (v: Node<d.u32>) => Node<d.vec2f>;
/** Pack two f32s in [0, 1] into a u32 as 16-bit unorm. WGSL: `pack2x16unorm`. */
export declare const pack2x16unorm: (v: Node<d.vec2f>) => Node<d.u32>;
/** Unpack a u32 into two f32s as 16-bit unorm. WGSL: `unpack2x16unorm`. */
export declare const unpack2x16unorm: (v: Node<d.u32>) => Node<d.vec2f>;
/** Pack four f32s in [-1, 1] into a u32 as 8-bit snorm. WGSL: `pack4x8snorm`. */
export declare const pack4x8snorm: (v: Node<d.vec4f>) => Node<d.u32>;
/** Unpack a u32 into four f32s as 8-bit snorm. WGSL: `unpack4x8snorm`. */
export declare const unpack4x8snorm: (v: Node<d.u32>) => Node<d.vec4f>;
/** Pack four f32s in [0, 1] into a u32 as 8-bit unorm. WGSL: `pack4x8unorm`. */
export declare const pack4x8unorm: (v: Node<d.vec4f>) => Node<d.u32>;
/** Unpack a u32 into four f32s as 8-bit unorm. WGSL: `unpack4x8unorm`. */
export declare const unpack4x8unorm: (v: Node<d.u32>) => Node<d.vec4f>;
export declare const abs: <D extends Any>(a: Node<D>) => Node<D>;
export declare const floor: <D extends Any>(a: Node<D>) => Node<D>;
export declare const ceil: <D extends Any>(a: Node<D>) => Node<D>;
export declare const fract: <D extends Any>(a: Node<D>) => Node<D>;
export declare const sqrt: <D extends Any>(a: Node<D>) => Node<D>;
export declare const sin: <D extends Any>(a: Node<D>) => Node<D>;
export declare const cos: <D extends Any>(a: Node<D>) => Node<D>;
export declare const negate: <D extends Any>(a: Node<D>) => Node<D>;
export declare const pow: <D extends Any>(a: Node<D>, b: Node<D>) => Node<D>;
export declare const exp: <D extends Any>(a: Node<D>) => Node<D>;
export declare const log: <D extends Any>(a: Node<D>) => Node<D>;
export declare const exp2: <D extends Any>(a: Node<D>) => Node<D>;
export declare const log2: <D extends Any>(a: Node<D>) => Node<D>;
export declare const tan: <D extends Any>(a: Node<D>) => Node<D>;
export declare const atan: <D extends Any>(a: Node<D>) => Node<D>;
export declare const atan2: <D extends Any>(y: Node<D>, x: Node<D>) => Node<D>;
export declare const asin: <D extends Any>(a: Node<D>) => Node<D>;
export declare const acos: <D extends Any>(a: Node<D>) => Node<D>;
export declare const inverseSqrt: <D extends Any>(a: Node<D>) => Node<D>;
export declare function max<D extends Any>(a: Node<D>, b: Node<D>, ...rest: Node<D>[]): Node<D>;
export declare function min<D extends Any>(a: Node<D>, b: Node<D>, ...rest: Node<D>[]): Node<D>;
export declare const clamp: <D extends Any>(a: Node<D>, lo: Node<D>, hi: Node<D>) => Node<D>;
export declare const mix: <D extends Any>(a: Node<D>, b: Node<D>, t: Node<Any>) => Node<D>;
export declare const step: <D extends Any>(edge: Node<D>, x: Node<D>) => Node<D>;
export declare const smoothstep: <D extends Any>(lo: Node<D>, hi: Node<D>, x: Node<D>) => Node<D>;
export declare const sign: <D extends Any>(a: Node<D>) => Node<D>;
export declare const mod: <D extends Any>(a: Node<D>, b: Node<D>) => Node<D>;
export declare const or: (a: Node<d.bool>, b: Node<d.bool>) => Node<d.bool>;
export declare const and: (a: Node<d.bool>, b: Node<d.bool>) => Node<d.bool>;
export declare const not: (a: Node<d.bool>) => Node<d.bool>;
export declare const transpose: <D extends d.Mat>(m: Node<D>) => Node<D>;
export declare const countOneBits: <D extends Any>(a: Node<D>) => Node<D>;
export declare const countTrailingZeros: <D extends Any>(a: Node<D>) => Node<D>;
export declare const countLeadingZeros: <D extends Any>(a: Node<D>) => Node<D>;
export declare const reverseBits: <D extends Any>(a: Node<D>) => Node<D>;
export declare const firstLeadingBit: <D extends Any>(a: Node<D>) => Node<D>;
export declare const firstTrailingBit: <D extends Any>(a: Node<D>) => Node<D>;
export declare const dpdx: <D extends Any>(a: Node<D>) => Node<D>;
export declare const dpdy: <D extends Any>(a: Node<D>) => Node<D>;
export declare const fwidth: <D extends Any>(a: Node<D>) => Node<D>;
export declare const dpdxCoarse: <D extends Any>(a: Node<D>) => Node<D>;
export declare const dpdyCoarse: <D extends Any>(a: Node<D>) => Node<D>;
export declare const fwidthCoarse: <D extends Any>(a: Node<D>) => Node<D>;
export declare const dpdxFine: <D extends Any>(a: Node<D>) => Node<D>;
export declare const dpdyFine: <D extends Any>(a: Node<D>) => Node<D>;
export declare const fwidthFine: <D extends Any>(a: Node<D>) => Node<D>;
export declare const bitwiseAnd: <D extends Any>(a: Node<D>, b: Node<D>) => Node<D>;
export declare const bitwiseOr: <D extends Any>(a: Node<D>, b: Node<D>) => Node<D>;
export declare const bitwiseXor: <D extends Any>(a: Node<D>, b: Node<D>) => Node<D>;
export declare const shiftLeft: <D extends Any>(a: Node<D>, b: Node<D>) => Node<D>;
export declare const shiftRight: <D extends Any>(a: Node<D>, b: Node<D>) => Node<D>;
export declare class StackNode extends Node<d.Void> {
    readonly body: Node<Any>[];
    constructor(initial?: Node<Any>[]);
    push(node: Node<Any>): void;
}
export declare class FnNode<D extends Any> extends Node<D> {
    readonly fnName: string;
    readonly paramDescs: (ParamDesc | Any)[];
    readonly jsFunc: (...args: Node<Any>[]) => Node<D>;
    constructor(returnType: D, paramDescs: (ParamDesc | Any)[], jsFunc: (...args: Node<Any>[]) => Node<D>, fnName?: string);
    compute(opts: ComputeOptions): ComputeNode;
    trace(): {
        params: ParameterNode<Any>[];
        body: StackNode;
        output: Node<D>;
    };
}
export declare class ParameterNode<D extends Any> extends Node<D> {
    readonly paramIndex: number;
    readonly paramName?: string | undefined;
    constructor(type: D, paramIndex: number, paramName?: string | undefined);
}
export declare class ReturnNode<D extends Any> extends Node<D> {
    readonly value: Node<D>;
    constructor(value: Node<D>);
}
export declare class ConditionalNode<D extends Any> extends Node<D> {
    readonly condition: Node<Any>;
    readonly ifTrue: Node<D>;
    readonly ifFalse?: Node<Any>;
    constructor(condition: Node<Any>, ifTrue: Node<D>, ifFalse?: Node<D>);
}
export type ElseIfBranch = {
    condition: Node<Any>;
    body: StackNode;
};
export declare class IfNode extends Node<d.Void> {
    readonly condition: Node<Any>;
    readonly thenBody: StackNode;
    elseIfBranches: ElseIfBranch[];
    elseBody: StackNode | null;
    constructor(condition: Node<Any>, thenBody: StackNode);
}
export type LoopParam = Node<Any> | number | {
    start?: Node<Any> | number;
    end?: Node<Any> | number;
    type?: d.Scalar;
    condition?: '<' | '<=' | '>' | '>=';
    update?: Node<Any> | number | string | ((...args: unknown[]) => void);
    name?: string;
};
export declare class LoopNode extends Node<d.Void> {
    readonly config: LoopParam;
    readonly loopVar: ParameterNode<Any>;
    readonly callbackKey: string;
    readonly body: StackNode;
    constructor(config: LoopParam, loopVar: ParameterNode<Any>, callbackKey: string, body: StackNode);
}
export declare class BreakNode extends Node<d.Void> {
    constructor();
}
export declare class ContinueNode extends Node<d.Void> {
    constructor();
}
export declare class DiscardNode extends Node<d.Void> {
    constructor();
}
export type IfChain = {
    ElseIf(condition: Node<Any>, body: () => void): IfChain;
    Else(body: () => void): IfChain;
};
export declare function If(condition: Node<Any>, thenBody: () => void): IfChain;
export type LoopVars = Record<string, Node<Any>>;
export declare function Loop(range: number, callback: (vars: LoopVars) => void): LoopNode;
export declare function Loop(o: LoopParam, callback: (vars: LoopVars) => void): LoopNode;
export declare const For: typeof Loop;
export declare function While(condition: Node<Any>, body: () => void): void;
export declare function Return(): void;
export declare function Return<D extends Any>(value: Node<D>): void;
export declare function Break(): void;
export declare function Continue(): void;
export declare function Discard(): void;
/** Workgroup synchronization barrier. WGSL: `workgroupBarrier()`. */
export declare function workgroupBarrier(): void;
/** Storage-buffer write/read sync within a workgroup. WGSL: `storageBarrier()`. */
export declare function storageBarrier(): void;
/** Texture write/read sync within a workgroup. WGSL: `textureBarrier()`. */
export declare function textureBarrier(): void;
export type ParamDesc = {
    readonly name: string;
    readonly type: Any;
};
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
export declare function Fn<R extends Any, P extends readonly ParamDesc[]>(jsFunc: (...args: ParamDescsToNodes<P>) => Node<R>, layout: {
    readonly name: string;
    readonly params: [...P];
    readonly return: R;
}): (...args: ParamDescsToNodes<P>) => CallNode<R>;
export declare function Fn<D extends Any, P extends readonly ParamDesc[]>(jsFunc: (...args: ParamDescsToNodes<P>) => Node<D>, layout: {
    readonly name: string;
    readonly params: [...P];
    readonly return?: undefined;
}): (...args: ParamDescsToNodes<P>) => CallNode<D>;
export declare function Fn(jsFunc: () => void): FnNode<d.Void>;
export declare function Fn<D extends Any>(jsFunc: (...args: Node<Any>[]) => Node<D>): (...args: Node<Any>[]) => CallNode<D>;
export declare const cond: <D extends Any>(condition: Node<Any>, ifTrue: Node<D>, ifFalse?: Node<D>) => ConditionalNode<D>;
/**
 * WGSL `select(falseVal, trueVal, condition)`.
 * Returns `trueVal` when `condition` is true, `falseVal` otherwise.
 */
export declare const select: <D extends Any>(falseVal: Node<D>, trueVal: Node<D>, condition: Node<Any>) => Node<D>;
/**
 * Function-scope mutable variable: `var name = init;`
 *
 * @example
 * const velocity = Var('velocity', vec3f(0));
 * // → var velocity = vec3f(0.0);
 */
export declare function Var<D extends Any>(name: string, init: Node<D>): VarNode<D>;
/**
 * Function-scope immutable binding: `let name = init;`
 *
 * @example
 * const half = Let('half', value.mul(0.5));
 * // → let half = (value * 0.5);
 */
export declare function Let<D extends Any>(name: string, init: Node<D>): LetNode<D>;
/** @deprecated Use Let() instead */
export declare function Const<D extends Any>(name: string, init: Node<D>): LetNode<D>;
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
export declare function PrivateVar<D extends Any>(name: string, type: D): PrivateVarNode<D>;
export declare function PrivateVar<D extends Any>(name: string, init: Node<D>): PrivateVarNode<D>;
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
export declare function WorkgroupVar<D extends Any>(name: string, type: D): WorkgroupVarNode<D>;
export declare function assign<D extends Any>(target: Node<D>, value: Node<D>): void;
export type ComputeOptions = {
    workgroupSize: [x: number, y: number, z: number];
    name?: string;
};
export type ComputeNodeOptions = ComputeOptions & {
    fn: FnNode<any>;
};
export declare class ComputeNode {
    readonly id: string;
    readonly fn: FnNode<Any>;
    readonly workgroupSize: [number, number, number];
    readonly name: string | undefined;
    /**
     * Set to true after dispose() is called.
     * The renderer checks this flag to skip dispatch and clean up GPU resources.
     */
    disposed: boolean;
    /**
     * Internal callback set by the renderer to clean up GPU resources (pipelines, caches).
     * @internal
     */
    _onDispose: (() => void) | null;
    constructor(opts: ComputeNodeOptions);
    /**
     * Frees GPU-related resources allocated for this compute node.
     * Call this method when the compute node is no longer used.
     */
    dispose(): void;
}
export declare function compute(fn: FnNode<Any>, opts: ComputeOptions): ComputeNode;
export type StructInstance<S extends d.StructSchema> = {
    readonly $node: Node<d.StructDesc>;
} & {
    readonly [K in keyof S]: Node<S[K]>;
};
export type StructMember = {
    readonly name: string;
    readonly type: Any;
};
export type StructDef<S extends d.StructSchema> = {
    readonly type: 'struct';
    readonly wgslType: string;
    readonly name: string;
    readonly fields: S;
    readonly members: StructMember[];
    readonly node: StructNode<S>;
    readonly nestedDefs: ReadonlyMap<string, StructDef<d.StructSchema>>;
    construct(fields: {
        readonly [K in keyof S]: Node<S[K]>;
    }): ConstructNode<StructDef<S>>;
};
export declare function struct<S extends d.StructSchema>(name: string, fields: S): StructDef<S>;
export declare class StructNode<S extends d.StructSchema = d.StructSchema> extends Node<d.StructDesc<S>> {
    readonly members: StructMember[];
    constructor(desc: d.StructDesc<S>, members: StructMember[]);
}
