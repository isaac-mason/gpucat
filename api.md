# gpucat API reference

The full generated API, pulled from the source. Every entry shows the real signature and its doc comment.

The shading-language DSL is documented with examples in the [main guide](./README.md); this is the exhaustive reference for it and for the renderer, scene, GPU resources, schema, and controls.

## Node methods

Most DSL operations are also methods on `Node` (`a.mul(b)`, `.toVar()`, `.xyz`, sampling). The full surface:

```ts
export class Node<D extends Any> {
    readonly id: number;
    readonly type: D;
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
```


### Shading language (DSL)

The full node DSL, grouped by category. Learn it with examples in the [guide](./README.md).

**general**

<table><tr>
<td><a href="#orbitcontrolsevent"><code>OrbitControlsEvent</code></a></td><td><a href="#orbitcontrolseventlistener"><code>OrbitControlsEventListener</code></a></td><td><a href="#orbitcontrolseventtype"><code>OrbitControlsEventType</code></a></td><td><a href="#mouseaction"><code>MouseAction</code></a></td>
</tr><tr>
<td><a href="#touchaction"><code>TouchAction</code></a></td><td></td><td></td><td></td>
</tr></table>

**constructors**

<table><tr>
<td><a href="#f16"><code>f16</code></a></td><td><a href="#f32"><code>f32</code></a></td><td><a href="#i32"><code>i32</code></a></td><td><a href="#u32"><code>u32</code></a></td>
</tr><tr>
<td><a href="#bool"><code>bool</code></a></td><td><a href="#rgb"><code>rgb</code></a></td><td><a href="#vec2"><code>vec2</code></a></td><td><a href="#vec2f"><code>vec2f</code></a></td>
</tr><tr>
<td><a href="#vec2h"><code>vec2h</code></a></td><td><a href="#vec2i"><code>vec2i</code></a></td><td><a href="#vec2u"><code>vec2u</code></a></td><td><a href="#vec2b"><code>vec2b</code></a></td>
</tr><tr>
<td><a href="#vec3"><code>vec3</code></a></td><td><a href="#vec3f"><code>vec3f</code></a></td><td><a href="#vec3h"><code>vec3h</code></a></td><td><a href="#vec3i"><code>vec3i</code></a></td>
</tr><tr>
<td><a href="#vec3u"><code>vec3u</code></a></td><td><a href="#vec3b"><code>vec3b</code></a></td><td><a href="#vec4"><code>vec4</code></a></td><td><a href="#vec4f"><code>vec4f</code></a></td>
</tr><tr>
<td><a href="#vec4h"><code>vec4h</code></a></td><td><a href="#vec4i"><code>vec4i</code></a></td><td><a href="#vec4u"><code>vec4u</code></a></td><td><a href="#vec4b"><code>vec4b</code></a></td>
</tr><tr>
<td><a href="#mat3"><code>mat3</code></a></td><td><a href="#mat4"><code>mat4</code></a></td><td><a href="#mat2x2f"><code>mat2x2f</code></a></td><td><a href="#mat2x3f"><code>mat2x3f</code></a></td>
</tr><tr>
<td><a href="#mat2x4f"><code>mat2x4f</code></a></td><td><a href="#mat3x2f"><code>mat3x2f</code></a></td><td><a href="#mat3x3f"><code>mat3x3f</code></a></td><td><a href="#mat3x4f"><code>mat3x4f</code></a></td>
</tr><tr>
<td><a href="#mat4x2f"><code>mat4x2f</code></a></td><td><a href="#mat4x3f"><code>mat4x3f</code></a></td><td><a href="#mat4x4f"><code>mat4x4f</code></a></td><td><a href="#mat2x2h"><code>mat2x2h</code></a></td>
</tr><tr>
<td><a href="#mat2x3h"><code>mat2x3h</code></a></td><td><a href="#mat2x4h"><code>mat2x4h</code></a></td><td><a href="#mat3x2h"><code>mat3x2h</code></a></td><td><a href="#mat3x3h"><code>mat3x3h</code></a></td>
</tr><tr>
<td><a href="#mat3x4h"><code>mat3x4h</code></a></td><td><a href="#mat4x2h"><code>mat4x2h</code></a></td><td><a href="#mat4x3h"><code>mat4x3h</code></a></td><td><a href="#mat4x4h"><code>mat4x4h</code></a></td>
</tr></table>

**math/operators**

<table><tr>
<td><a href="#abs"><code>abs</code></a></td><td><a href="#add"><code>add</code></a></td><td><a href="#sub"><code>sub</code></a></td><td><a href="#mul"><code>mul</code></a></td>
</tr><tr>
<td><a href="#div"><code>div</code></a></td><td><a href="#mod"><code>mod</code></a></td><td><a href="#min"><code>min</code></a></td><td><a href="#max"><code>max</code></a></td>
</tr><tr>
<td><a href="#clamp"><code>clamp</code></a></td><td><a href="#mix"><code>mix</code></a></td><td><a href="#step"><code>step</code></a></td><td><a href="#smoothstep"><code>smoothstep</code></a></td>
</tr><tr>
<td><a href="#ceil"><code>ceil</code></a></td><td><a href="#floor"><code>floor</code></a></td><td><a href="#fract"><code>fract</code></a></td><td><a href="#sqrt"><code>sqrt</code></a></td>
</tr><tr>
<td><a href="#inversesqrt"><code>inverseSqrt</code></a></td><td><a href="#pow"><code>pow</code></a></td><td><a href="#exp"><code>exp</code></a></td><td><a href="#exp2"><code>exp2</code></a></td>
</tr><tr>
<td><a href="#log"><code>log</code></a></td><td><a href="#log2"><code>log2</code></a></td><td><a href="#tan"><code>tan</code></a></td><td><a href="#atan"><code>atan</code></a></td>
</tr><tr>
<td><a href="#atan2"><code>atan2</code></a></td><td><a href="#asin"><code>asin</code></a></td><td><a href="#acos"><code>acos</code></a></td><td><a href="#length"><code>length</code></a></td>
</tr><tr>
<td><a href="#normalize"><code>normalize</code></a></td><td><a href="#dot"><code>dot</code></a></td><td><a href="#cross"><code>cross</code></a></td><td><a href="#pack2x16float"><code>pack2x16float</code></a></td>
</tr><tr>
<td><a href="#unpack2x16float"><code>unpack2x16float</code></a></td><td><a href="#pack2x16snorm"><code>pack2x16snorm</code></a></td><td><a href="#unpack2x16snorm"><code>unpack2x16snorm</code></a></td><td><a href="#pack2x16unorm"><code>pack2x16unorm</code></a></td>
</tr><tr>
<td><a href="#unpack2x16unorm"><code>unpack2x16unorm</code></a></td><td><a href="#pack4x8snorm"><code>pack4x8snorm</code></a></td><td><a href="#unpack4x8snorm"><code>unpack4x8snorm</code></a></td><td><a href="#pack4x8unorm"><code>pack4x8unorm</code></a></td>
</tr><tr>
<td><a href="#unpack4x8unorm"><code>unpack4x8unorm</code></a></td><td><a href="#bitcastf32"><code>bitcastF32</code></a></td><td><a href="#bitcastu32"><code>bitcastU32</code></a></td><td><a href="#bitcasti32"><code>bitcastI32</code></a></td>
</tr><tr>
<td><a href="#sign"><code>sign</code></a></td><td><a href="#sin"><code>sin</code></a></td><td><a href="#cos"><code>cos</code></a></td><td><a href="#transpose"><code>transpose</code></a></td>
</tr><tr>
<td><a href="#countonebits"><code>countOneBits</code></a></td><td><a href="#counttrailingzeros"><code>countTrailingZeros</code></a></td><td><a href="#countleadingzeros"><code>countLeadingZeros</code></a></td><td><a href="#reversebits"><code>reverseBits</code></a></td>
</tr><tr>
<td><a href="#firstleadingbit"><code>firstLeadingBit</code></a></td><td><a href="#firsttrailingbit"><code>firstTrailingBit</code></a></td><td><a href="#dpdx"><code>dpdx</code></a></td><td><a href="#dpdy"><code>dpdy</code></a></td>
</tr><tr>
<td><a href="#fwidth"><code>fwidth</code></a></td><td><a href="#dpdxcoarse"><code>dpdxCoarse</code></a></td><td><a href="#dpdycoarse"><code>dpdyCoarse</code></a></td><td><a href="#fwidthcoarse"><code>fwidthCoarse</code></a></td>
</tr><tr>
<td><a href="#dpdxfine"><code>dpdxFine</code></a></td><td><a href="#dpdyfine"><code>dpdyFine</code></a></td><td><a href="#fwidthfine"><code>fwidthFine</code></a></td><td></td>
</tr></table>

**comparison**

<table><tr>
<td><a href="#greaterthan"><code>greaterThan</code></a></td><td><a href="#lessthan"><code>lessThan</code></a></td><td><a href="#greaterthanequal"><code>greaterThanEqual</code></a></td><td><a href="#lessthanequal"><code>lessThanEqual</code></a></td>
</tr><tr>
<td><a href="#equal"><code>equal</code></a></td><td><a href="#notequal"><code>notEqual</code></a></td><td><a href="#or"><code>or</code></a></td><td><a href="#and"><code>and</code></a></td>
</tr></table>

**bitwise**

<table><tr>
<td><a href="#bitwiseand"><code>bitwiseAnd</code></a></td><td><a href="#bitwiseor"><code>bitwiseOr</code></a></td><td><a href="#bitwisexor"><code>bitwiseXor</code></a></td><td><a href="#shiftleft"><code>shiftLeft</code></a></td>
</tr><tr>
<td><a href="#shiftright"><code>shiftRight</code></a></td><td></td><td></td><td></td>
</tr></table>

**node factories**

<table><tr>
<td><a href="#attribute"><code>attribute</code></a></td><td><a href="#attributeoptions"><code>AttributeOptions</code></a></td><td><a href="#builtin"><code>builtin</code></a></td><td><a href="#index"><code>index</code></a></td>
</tr><tr>
<td><a href="#field"><code>field</code></a></td><td><a href="#fields"><code>fields</code></a></td><td><a href="#uniform"><code>uniform</code></a></td><td><a href="#storage"><code>storage</code></a></td>
</tr><tr>
<td><a href="#array"><code>array</code></a></td><td><a href="#texture"><code>texture</code></a></td><td><a href="#varying"><code>varying</code></a></td><td><a href="#struct"><code>struct</code></a></td>
</tr><tr>
<td><a href="#wgsl"><code>wgsl</code></a></td><td><a href="#wgslfn"><code>wgslFn</code></a></td><td><a href="#fn"><code>Fn</code></a></td><td><a href="#mrt"><code>mrt</code></a></td>
</tr><tr>
<td><a href="#compute"><code>compute</code></a></td><td></td><td></td><td></td>
</tr></table>

**texture/sampler factories and functions**

<table><tr>
<td><a href="#sampler"><code>sampler</code></a></td><td><a href="#comparisonsampler"><code>comparisonSampler</code></a></td><td><a href="#cubetexture"><code>cubeTexture</code></a></td><td><a href="#depthtexture"><code>depthTexture</code></a></td>
</tr><tr>
<td><a href="#arraytexture"><code>arrayTexture</code></a></td><td><a href="#texturebinding"><code>textureBinding</code></a></td><td><a href="#texturesample"><code>textureSample</code></a></td><td><a href="#texturesamplelevel"><code>textureSampleLevel</code></a></td>
</tr><tr>
<td><a href="#texturesamplebias"><code>textureSampleBias</code></a></td><td><a href="#texturesamplegrad"><code>textureSampleGrad</code></a></td><td><a href="#texturesamplecompare"><code>textureSampleCompare</code></a></td><td><a href="#texturesamplecomparelevel"><code>textureSampleCompareLevel</code></a></td>
</tr><tr>
<td><a href="#textureload"><code>textureLoad</code></a></td><td><a href="#texturestore"><code>textureStore</code></a></td><td><a href="#texturedimensions"><code>textureDimensions</code></a></td><td><a href="#texturenumlevels"><code>textureNumLevels</code></a></td>
</tr><tr>
<td><a href="#texturenumlayers"><code>textureNumLayers</code></a></td><td><a href="#texturegather"><code>textureGather</code></a></td><td><a href="#texturegathercompare"><code>textureGatherCompare</code></a></td><td></td>
</tr></table>

**atomic operations**

<table><tr>
<td><a href="#atomicadd"><code>atomicAdd</code></a></td><td><a href="#atomicstore"><code>atomicStore</code></a></td><td><a href="#atomicload"><code>atomicLoad</code></a></td><td><a href="#atomicsub"><code>atomicSub</code></a></td>
</tr><tr>
<td><a href="#atomicmax"><code>atomicMax</code></a></td><td><a href="#atomicmin"><code>atomicMin</code></a></td><td><a href="#atomicand"><code>atomicAnd</code></a></td><td><a href="#atomicor"><code>atomicOr</code></a></td>
</tr><tr>
<td><a href="#atomicxor"><code>atomicXor</code></a></td><td><a href="#atomicexchange"><code>atomicExchange</code></a></td><td><a href="#atomiccompareexchangeweak"><code>atomicCompareExchangeWeak</code></a></td><td></td>
</tr></table>

**variables**

<table><tr>
<td><a href="#var"><code>Var</code></a></td><td><a href="#const"><code>Const</code></a></td><td><a href="#let"><code>Let</code></a></td><td><a href="#privatevar"><code>PrivateVar</code></a></td>
</tr><tr>
<td><a href="#workgroupvar"><code>WorkgroupVar</code></a></td><td></td><td></td><td></td>
</tr></table>

**control flow**

<table><tr>
<td><a href="#if"><code>If</code></a></td><td><a href="#loop"><code>Loop</code></a></td><td><a href="#for"><code>For</code></a></td><td><a href="#while"><code>While</code></a></td>
</tr><tr>
<td><a href="#break"><code>Break</code></a></td><td><a href="#continue"><code>Continue</code></a></td><td><a href="#return"><code>Return</code></a></td><td><a href="#discard"><code>Discard</code></a></td>
</tr><tr>
<td><a href="#workgroupbarrier"><code>workgroupBarrier</code></a></td><td><a href="#storagebarrier"><code>storageBarrier</code></a></td><td><a href="#texturebarrier"><code>textureBarrier</code></a></td><td><a href="#cond"><code>cond</code></a></td>
</tr><tr>
<td><a href="#select"><code>select</code></a></td><td></td><td></td><td></td>
</tr></table>

**camera uniforms**

<table><tr>
<td><a href="#cameraprojectionmatrix"><code>cameraProjectionMatrix</code></a></td><td><a href="#cameraviewmatrix"><code>cameraViewMatrix</code></a></td><td><a href="#cameraposition"><code>cameraPosition</code></a></td><td><a href="#cameranear"><code>cameraNear</code></a></td>
</tr><tr>
<td><a href="#camerafar"><code>cameraFar</code></a></td><td></td><td></td><td></td>
</tr></table>

**model uniforms**

<table><tr>
<td><a href="#modelworldmatrix"><code>modelWorldMatrix</code></a></td><td><a href="#modelnormalmatrix"><code>modelNormalMatrix</code></a></td>
</tr></table>

**builtins**

<table><tr>
<td><a href="#instanceindex"><code>instanceIndex</code></a></td><td><a href="#vertexindex"><code>vertexIndex</code></a></td><td><a href="#globalid"><code>globalId</code></a></td><td><a href="#localid"><code>localId</code></a></td>
</tr><tr>
<td><a href="#localindex"><code>localIndex</code></a></td><td><a href="#workgroupid"><code>workgroupId</code></a></td><td><a href="#numworkgroups"><code>numWorkgroups</code></a></td><td></td>
</tr></table>

**screen/viewport**

<table><tr>
<td><a href="#fragcoord"><code>fragCoord</code></a></td><td><a href="#screencoordinate"><code>screenCoordinate</code></a></td><td><a href="#screensize"><code>screenSize</code></a></td><td><a href="#screenuv"><code>screenUV</code></a></td>
</tr></table>

**compute**

<table><tr>
<td><a href="#computeindex"><code>computeIndex</code></a></td>
</tr></table>

**helpers**

<table><tr>
<td><a href="#positionclip"><code>positionClip</code></a></td>
</tr></table>

**indirect**

<table><tr>
<td><a href="#drawindirect"><code>DrawIndirect</code></a></td><td><a href="#drawindexedindirect"><code>DrawIndexedIndirect</code></a></td>
</tr></table>

**types**

<table><tr>
<td><a href="#binaryop"><code>BinaryOp</code></a></td><td><a href="#builtinkind"><code>BuiltinKind</code></a></td><td><a href="#computenodeoptions"><code>ComputeNodeOptions</code></a></td><td><a href="#computeoptions"><code>ComputeOptions</code></a></td>
</tr><tr>
<td><a href="#gputypedarray"><code>GpuTypedArray</code></a></td><td><a href="#mattype"><code>MatType</code></a></td><td><a href="#numerictype"><code>NumericType</code></a></td><td><a href="#samplertype"><code>SamplerType</code></a></td>
</tr><tr>
<td><a href="#scalartype"><code>ScalarType</code></a></td><td><a href="#structdef"><code>StructDef</code></a></td><td><a href="#structinstance"><code>StructInstance</code></a></td><td><a href="#structmember"><code>StructMember</code></a></td>
</tr><tr>
<td><a href="#texturetype"><code>TextureType</code></a></td><td><a href="#vec2type"><code>Vec2Type</code></a></td><td><a href="#vec3type"><code>Vec3Type</code></a></td><td><a href="#vec4type"><code>Vec4Type</code></a></td>
</tr><tr>
<td><a href="#vectype"><code>VecType</code></a></td><td><a href="#wgsltype"><code>WgslType</code></a></td><td><a href="#interpolationtype"><code>InterpolationType</code></a></td><td><a href="#interpolationsampling"><code>InterpolationSampling</code></a></td>
</tr><tr>
<td><a href="#wgslnodefunction"><code>WgslNodeFunction</code></a></td><td><a href="#wgslnodefunctioninput"><code>WgslNodeFunctionInput</code></a></td><td><a href="#paramdesc"><code>ParamDesc</code></a></td><td><a href="#fnlayout"><code>FnLayout</code></a></td>
</tr></table>

**render pass**

<table><tr>
<td><a href="#pass"><code>pass</code></a></td><td><a href="#passnodeoptions"><code>PassNodeOptions</code></a></td>
</tr></table>

**render output**

<table><tr>
<td><a href="#renderoutput"><code>renderOutput</code></a></td><td><a href="#outputcolorspace"><code>OutputColorSpace</code></a></td><td><a href="#renderoutputoptions"><code>RenderOutputOptions</code></a></td><td><a href="#tonemappingmode"><code>ToneMappingMode</code></a></td>
</tr></table>

**tonemapping and color space conversions**

<table><tr>
<td><a href="#acestonemapping"><code>acesToneMapping</code></a></td><td><a href="#reinhardtonemapping"><code>reinhardToneMapping</code></a></td><td><a href="#srgbtransfereotf"><code>sRGBTransferEOTF</code></a></td><td><a href="#srgbtransferoetf"><code>sRGBTransferOETF</code></a></td>
</tr></table>

**post-processing effects**

<table><tr>
<td><a href="#fxaa"><code>fxaa</code></a></td>
</tr></table>

### Renderer

Drive the GPU: create a renderer, build pipelines, render to the canvas or a target.

**Renderer**

<table><tr>
<td><a href="#webgpurendereroptions"><code>WebGPURendererOptions</code></a></td><td><a href="#computedispatch"><code>ComputeDispatch</code></a></td><td><a href="#webgpurenderer"><code>WebGPURenderer</code></a></td><td><a href="#devicelostinfo"><code>DeviceLostInfo</code></a></td>
</tr></table>

**Pipelines & targets**

<table><tr>
<td><a href="#renderpipeline"><code>RenderPipeline</code></a></td><td><a href="#canvastargetoptions"><code>CanvasTargetOptions</code></a></td><td><a href="#canvastarget"><code>CanvasTarget</code></a></td><td><a href="#readpixels"><code>readPixels</code></a></td>
</tr><tr>
<td><a href="#rendertargetoptions"><code>RenderTargetOptions</code></a></td><td><a href="#rendertarget"><code>RenderTarget</code></a></td><td></td><td></td>
</tr></table>

### Scene & objects

The scene graph, cameras, and the objects you put in it.

**Scene graph**

<table><tr>
<td><a href="#scene"><code>Scene</code></a></td><td><a href="#object3d"><code>Object3D</code></a></td>
</tr></table>

**Cameras**

<table><tr>
<td><a href="#camera"><code>Camera</code></a></td><td><a href="#unproject"><code>unproject</code></a></td><td><a href="#perspectivecamera"><code>PerspectiveCamera</code></a></td><td><a href="#orthographiccamera"><code>OrthographicCamera</code></a></td>
</tr></table>

**Objects**

<table><tr>
<td><a href="#mesh"><code>Mesh</code></a></td><td><a href="#linegeometry"><code>LineGeometry</code></a></td><td><a href="#linesegmentsgeometry"><code>LineSegmentsGeometry</code></a></td><td><a href="#linematerialoptions"><code>LineMaterialOptions</code></a></td>
</tr><tr>
<td><a href="#linematerial"><code>LineMaterial</code></a></td><td><a href="#linesegments"><code>LineSegments</code></a></td><td><a href="#line"><code>Line</code></a></td><td></td>
</tr></table>

**Geometry**

<table><tr>
<td><a href="#drawrange"><code>DrawRange</code></a></td><td><a href="#geometry"><code>Geometry</code></a></td><td><a href="#createboxgeometry"><code>createBoxGeometry</code></a></td><td><a href="#createspheregeometry"><code>createSphereGeometry</code></a></td>
</tr><tr>
<td><a href="#createplanegeometry"><code>createPlaneGeometry</code></a></td><td><a href="#createfullscreentrianglegeometry"><code>createFullscreenTriangleGeometry</code></a></td><td><a href="#createcylindergeometry"><code>createCylinderGeometry</code></a></td><td><a href="#createtorusgeometry"><code>createTorusGeometry</code></a></td>
</tr><tr>
<td><a href="#createoctahedrongeometry"><code>createOctahedronGeometry</code></a></td><td></td><td></td><td></td>
</tr></table>

### GPU resources

Declarative, data-oriented resources: buffers, uniforms, materials, and textures.

**Buffers & uniforms**

<table><tr>
<td><a href="#bufferlifecycle"><code>BufferLifecycle</code></a></td><td><a href="#gputypedarray-2"><code>GpuTypedArray</code></a></td><td><a href="#updaterange"><code>UpdateRange</code></a></td><td><a href="#derivevertexformat"><code>deriveVertexFormat</code></a></td>
</tr><tr>
<td><a href="#bufferusage"><code>BufferUsage</code></a></td><td><a href="#indexformat"><code>IndexFormat</code></a></td><td><a href="#getindexformat"><code>getIndexFormat</code></a></td><td><a href="#gpubufferoptions"><code>GpuBufferOptions</code></a></td>
</tr><tr>
<td><a href="#gpubuffer"><code>GpuBuffer</code></a></td><td><a href="#createvertexbuffer"><code>createVertexBuffer</code></a></td><td><a href="#createstoragebuffer"><code>createStorageBuffer</code></a></td><td><a href="#createuniformbuffer"><code>createUniformBuffer</code></a></td>
</tr><tr>
<td><a href="#createindirectbuffer"><code>createIndirectBuffer</code></a></td><td><a href="#createindexbuffer"><code>createIndexBuffer</code></a></td><td><a href="#uniformvalue"><code>UniformValue</code></a></td><td><a href="#uniformupdatetype"><code>UniformUpdateType</code></a></td>
</tr><tr>
<td><a href="#uniformgroup"><code>UniformGroup</code></a></td><td><a href="#uniformgroup-2"><code>uniformGroup</code></a></td><td><a href="#shareduniformgroup"><code>sharedUniformGroup</code></a></td><td><a href="#framegroup"><code>frameGroup</code></a></td>
</tr><tr>
<td><a href="#rendergroup"><code>renderGroup</code></a></td><td><a href="#objectgroup"><code>objectGroup</code></a></td><td><a href="#uniform-2"><code>Uniform</code></a></td><td></td>
</tr></table>

**Materials**

<table><tr>
<td><a href="#materialoptions"><code>MaterialOptions</code></a></td><td><a href="#material"><code>Material</code></a></td>
</tr></table>

**Textures**

<table><tr>
<td><a href="#wrapmode"><code>WrapMode</code></a></td><td><a href="#filtermode"><code>FilterMode</code></a></td><td><a href="#mipmapfiltermode"><code>MipmapFilterMode</code></a></td><td><a href="#textureoptions"><code>TextureOptions</code></a></td>
</tr><tr>
<td><a href="#texture-2"><code>Texture</code></a></td><td><a href="#imagesize"><code>ImageSize</code></a></td><td><a href="#datatextureimage"><code>DataTextureImage</code></a></td><td><a href="#sourcedata"><code>SourceData</code></a></td>
</tr><tr>
<td><a href="#source"><code>Source</code></a></td><td><a href="#canvastexture"><code>CanvasTexture</code></a></td><td><a href="#cubetexturemapping"><code>CubeTextureMapping</code></a></td><td><a href="#cubetextureoptions"><code>CubeTextureOptions</code></a></td>
</tr><tr>
<td><a href="#cubetexture-2"><code>CubeTexture</code></a></td><td><a href="#depthtextureformat"><code>DepthTextureFormat</code></a></td><td><a href="#depthtexture-2"><code>DepthTexture</code></a></td><td><a href="#arraytextureimage"><code>ArrayTextureImage</code></a></td>
</tr><tr>
<td><a href="#arraytexture-2"><code>ArrayTexture</code></a></td><td></td><td></td><td></td>
</tr></table>

### Compilation

Turn a node graph into WGSL.

**Compile**

<table><tr>
<td><a href="#compile"><code>compile</code></a></td><td><a href="#compilecompute"><code>compileCompute</code></a></td><td><a href="#nodeupdatetype"><code>NodeUpdateType</code></a></td><td><a href="#updatebeforenode"><code>UpdateBeforeNode</code></a></td>
</tr><tr>
<td><a href="#updateafternode"><code>UpdateAfterNode</code></a></td><td><a href="#updatenode"><code>UpdateNode</code></a></td><td><a href="#attributeentry"><code>AttributeEntry</code></a></td><td><a href="#vertexbuffergroup"><code>VertexBufferGroup</code></a></td>
</tr><tr>
<td><a href="#varyingentry"><code>VaryingEntry</code></a></td><td><a href="#uniformmember"><code>UniformMember</code></a></td><td><a href="#uniformgroupblock"><code>UniformGroupBlock</code></a></td><td><a href="#storageentry"><code>StorageEntry</code></a></td>
</tr><tr>
<td><a href="#textureentry"><code>TextureEntry</code></a></td><td><a href="#samplerentry"><code>SamplerEntry</code></a></td><td><a href="#computestorageentry"><code>ComputeStorageEntry</code></a></td><td><a href="#nodegraphinfo"><code>NodeGraphInfo</code></a></td>
</tr><tr>
<td><a href="#compileslots"><code>CompileSlots</code></a></td><td><a href="#compileresult"><code>CompileResult</code></a></td><td><a href="#computecompileresult"><code>ComputeCompileResult</code></a></td><td></td>
</tr></table>

### Schema (`d`)

WGSL type descriptors (imported as `d`) and std430 buffer packing.

**Descriptors & packing**

<table><tr>
<td><a href="#addressspace"><code>AddressSpace</code></a></td><td><a href="#compiledlayout"><code>CompiledLayout</code></a></td><td><a href="#pack"><code>pack</code></a></td><td><a href="#packarray"><code>packArray</code></a></td>
</tr><tr>
<td><a href="#packto"><code>packTo</code></a></td><td><a href="#unpack"><code>unpack</code></a></td><td><a href="#unpackarray"><code>unpackArray</code></a></td><td><a href="#layoutsizeof"><code>layoutSizeOf</code></a></td>
</tr><tr>
<td><a href="#layoutstrideof"><code>layoutStrideOf</code></a></td><td><a href="#getcompiledlayout"><code>getCompiledLayout</code></a></td><td><a href="#packtoview"><code>packToView</code></a></td><td><a href="#unpackfromview"><code>unpackFromView</code></a></td>
</tr></table>

### Controls & debugging

**Camera controls**

<table><tr>
<td><a href="#mouse"><code>MOUSE</code></a></td><td><a href="#mouseaction-2"><code>MouseAction</code></a></td><td><a href="#touch"><code>TOUCH</code></a></td><td><a href="#touchaction-2"><code>TouchAction</code></a></td>
</tr><tr>
<td><a href="#orbitcontrolseventtype-2"><code>OrbitControlsEventType</code></a></td><td><a href="#orbitcontrolsevent-2"><code>OrbitControlsEvent</code></a></td><td><a href="#orbitcontrolseventlistener-2"><code>OrbitControlsEventListener</code></a></td><td><a href="#orbitcontrols"><code>OrbitControls</code></a></td>
</tr><tr>
<td><a href="#flycontrols"><code>FlyControls</code></a></td><td><a href="#transformmode"><code>TransformMode</code></a></td><td><a href="#transformspace"><code>TransformSpace</code></a></td><td><a href="#transformcontrols"><code>TransformControls</code></a></td>
</tr></table>

**Inspector**

<table><tr>
<td><a href="#inspector"><code>Inspector</code></a></td>
</tr></table>

### Math & utils

**Math**

<table><tr>
<td><a href="#frustum"><code>Frustum</code></a></td><td><a href="#create"><code>create</code></a></td><td><a href="#clone"><code>clone</code></a></td><td><a href="#copy"><code>copy</code></a></td>
</tr><tr>
<td><a href="#setfromviewprojectionmatrix"><code>setFromViewProjectionMatrix</code></a></td><td><a href="#intersectssphere"><code>intersectsSphere</code></a></td><td><a href="#intersectsbox3"><code>intersectsBox3</code></a></td><td><a href="#ray"><code>Ray</code></a></td>
</tr><tr>
<td><a href="#raytriangleintersection"><code>rayTriangleIntersection</code></a></td><td><a href="#rayintersectsbox3"><code>rayIntersectsBox3</code></a></td><td><a href="#intersection"><code>Intersection</code></a></td><td><a href="#raycaster"><code>Raycaster</code></a></td>
</tr><tr>
<td><a href="#transformraytolocalspace"><code>transformRayToLocalSpace</code></a></td><td><a href="#checktriangleintersection"><code>checkTriangleIntersection</code></a></td><td></td><td></td>
</tr></table>


---

## Shading language (DSL)

The full node DSL, grouped by category. Learn it with examples in the [guide](./README.md).

#### `OrbitControlsEvent`

```ts
export interface OrbitControlsEvent {
    type: OrbitControlsEventType;
    target: OrbitControls;
}
```

#### `OrbitControlsEventListener`

```ts
export type OrbitControlsEventListener = (event: OrbitControlsEvent) => void;
```

#### `OrbitControlsEventType`

```ts
export type OrbitControlsEventType = 'change' | 'start' | 'end';
```

#### `MouseAction`

```ts
export type MouseAction = (typeof MOUSE)[keyof typeof MOUSE];
```

#### `TouchAction`

```ts
export type TouchAction = (typeof TOUCH)[keyof typeof TOUCH];
```

#### `f16`

```ts
export const f16: f16;
export type f16 = {
    type: 'f16';
    wgslType: 'f16';
};
```

#### `f32`

```ts
/**
 * schema.ts, WGSL type descriptors following packcat's discriminated union pattern.
 *
 * Every descriptor has:
 *   - `type`, discriminant string for type-level narrowing and runtime switching
 *   - `wgslType`, the WGSL type name string
 *
 * For primitives, type === wgslType (e.g. { type: 'f32'; wgslType: 'f32' }).
 * For composites, type is the discriminant ('array', 'struct') and wgslType is computed.
 */
export const f32: f32;
export type f32 = {
    type: 'f32';
    wgslType: 'f32';
};
```

#### `i32`

```ts
export const i32: i32;
export type i32 = {
    type: 'i32';
    wgslType: 'i32';
};
```

#### `u32`

```ts
export const u32: u32;
export type u32 = {
    type: 'u32';
    wgslType: 'u32';
};
```

#### `bool`

```ts
export const bool: bool;
export type bool = {
    type: 'bool';
    wgslType: 'bool';
};
```

#### `rgb`

```ts
/**
 * Convert any color input to a `vec3f` linear RGB node.
 *
 * This is the primary way to introduce a color into the node graph.
 * The resulting node has type `vec3f` so it can be used anywhere a `vec3f`
 * is expected, including as the first argument to `vec4(xyz, w)`.
 *
 * @example
 * import { rgb, vec4, f32 } from 'gpucat';
 *
 * const fragColor = vec4(rgb('#f00'), f32(1));
 *
 * // Other accepted forms:
 * rgb('hsl(200, 80%, 50%)');
 * rgb('deepskyblue');
 * rgb(0xff8800);
 * rgb([1, 0.5, 0]);
 */
export function rgb(input: ColorInput): import("./core").ConstructNode<import("../../schema/schema").vec3f>;
```

#### `vec2`

```ts
export const vec2: {
    (v: Scalar): ConstructNode<d.vec2f>;
    (x: Scalar, y: Scalar): ConstructNode<d.vec2f>;
};
```

#### `vec2f`

```ts
export type vec2f = {
    type: 'vec2f';
    wgslType: 'vec2f';
};
export const vec2f: vec2f;
```

#### `vec2h`

```ts
export type vec2h = {
    type: 'vec2h';
    wgslType: 'vec2h';
};
export const vec2h: vec2h;
```

#### `vec2i`

```ts
export type vec2i = {
    type: 'vec2i';
    wgslType: 'vec2i';
};
export const vec2i: vec2i;
```

#### `vec2u`

```ts
export type vec2u = {
    type: 'vec2u';
    wgslType: 'vec2u';
};
export const vec2u: vec2u;
```

#### `vec2b`

```ts
export const vec2b: {
    (v: Scalar): ConstructNode<d.vec2bool>;
    (x: Scalar, y: Scalar): ConstructNode<d.vec2bool>;
};
```

#### `vec3`

```ts
export const vec3: {
    (v: Scalar): ConstructNode<d.vec3f>;
    (xy: Node<Any>, z: Scalar): ConstructNode<d.vec3f>;
    (x: Scalar, y: Scalar, z: Scalar): ConstructNode<d.vec3f>;
};
```

#### `vec3f`

```ts
export type vec3f = {
    type: 'vec3f';
    wgslType: 'vec3f';
};
export const vec3f: vec3f;
```

#### `vec3h`

```ts
export type vec3h = {
    type: 'vec3h';
    wgslType: 'vec3h';
};
export const vec3h: vec3h;
```

#### `vec3i`

```ts
export type vec3i = {
    type: 'vec3i';
    wgslType: 'vec3i';
};
export const vec3i: vec3i;
```

#### `vec3u`

```ts
export type vec3u = {
    type: 'vec3u';
    wgslType: 'vec3u';
};
export const vec3u: vec3u;
```

#### `vec3b`

```ts
export const vec3b: {
    (v: Scalar): ConstructNode<d.vec3bool>;
    (xy: Node<Any>, z: Scalar): ConstructNode<d.vec3bool>;
    (x: Scalar, y: Scalar, z: Scalar): ConstructNode<d.vec3bool>;
};
```

#### `vec4`

```ts
export const vec4: {
    (v: Scalar): ConstructNode<d.vec4f>;
    (xy: Node<Any>, zw: Node<Any>): ConstructNode<d.vec4f>;
    (xy: Node<Any>, z: Scalar, w: Scalar): ConstructNode<d.vec4f>;
    (xyz: Node<Any>, w: Scalar): ConstructNode<d.vec4f>;
    (x: Scalar, y: Scalar, z: Scalar, w: Scalar): ConstructNode<d.vec4f>;
};
```

#### `vec4f`

```ts
export type vec4f = {
    type: 'vec4f';
    wgslType: 'vec4f';
};
export const vec4f: vec4f;
```

#### `vec4h`

```ts
export type vec4h = {
    type: 'vec4h';
    wgslType: 'vec4h';
};
export const vec4h: vec4h;
```

#### `vec4i`

```ts
export type vec4i = {
    type: 'vec4i';
    wgslType: 'vec4i';
};
export const vec4i: vec4i;
```

#### `vec4u`

```ts
export type vec4u = {
    type: 'vec4u';
    wgslType: 'vec4u';
};
export const vec4u: vec4u;
```

#### `vec4b`

```ts
export const vec4b: {
    (v: Scalar): ConstructNode<d.vec4bool>;
    (xy: Node<Any>, zw: Node<Any>): ConstructNode<d.vec4bool>;
    (xy: Node<Any>, z: Scalar, w: Scalar): ConstructNode<d.vec4bool>;
    (xyz: Node<Any>, w: Scalar): ConstructNode<d.vec4bool>;
    (x: Scalar, y: Scalar, z: Scalar, w: Scalar): ConstructNode<d.vec4bool>;
};
```

#### `mat3`

```ts
export function mat3(c0: Node<d.Vec3>, c1: Node<d.Vec3>, c2: Node<d.Vec3>): Node<d.mat3x3f>;
export function mat3(diag: Node<d.f32>): Node<d.mat3x3f>;
export function mat3(s00: Node<d.f32>, s01: Node<d.f32>, s02: Node<d.f32>, s10: Node<d.f32>, s11: Node<d.f32>, s12: Node<d.f32>, s20: Node<d.f32>, s21: Node<d.f32>, s22: Node<d.f32>): Node<d.mat3x3f>;
```

#### `mat4`

```ts
export const mat4: (c0: Node<d.Vec4>, c1: Node<d.Vec4>, c2: Node<d.Vec4>, c3: Node<d.Vec4>) => ConstructNode<d.mat4x4f>;
```

#### `mat2x2f`

```ts
export type mat2x2f = {
    type: 'mat2x2f';
    wgslType: 'mat2x2f';
};
export const mat2x2f: mat2x2f;
```

#### `mat2x3f`

```ts
export type mat2x3f = {
    type: 'mat2x3f';
    wgslType: 'mat2x3f';
};
export const mat2x3f: mat2x3f;
```

#### `mat2x4f`

```ts
export type mat2x4f = {
    type: 'mat2x4f';
    wgslType: 'mat2x4f';
};
export const mat2x4f: mat2x4f;
```

#### `mat3x2f`

```ts
export type mat3x2f = {
    type: 'mat3x2f';
    wgslType: 'mat3x2f';
};
export const mat3x2f: mat3x2f;
```

#### `mat3x3f`

```ts
export type mat3x3f = {
    type: 'mat3x3f';
    wgslType: 'mat3x3f';
};
export const mat3x3f: mat3x3f;
```

#### `mat3x4f`

```ts
export type mat3x4f = {
    type: 'mat3x4f';
    wgslType: 'mat3x4f';
};
export const mat3x4f: mat3x4f;
```

#### `mat4x2f`

```ts
export type mat4x2f = {
    type: 'mat4x2f';
    wgslType: 'mat4x2f';
};
export const mat4x2f: mat4x2f;
```

#### `mat4x3f`

```ts
export type mat4x3f = {
    type: 'mat4x3f';
    wgslType: 'mat4x3f';
};
export const mat4x3f: mat4x3f;
```

#### `mat4x4f`

```ts
export type mat4x4f = {
    type: 'mat4x4f';
    wgslType: 'mat4x4f';
};
export const mat4x4f: mat4x4f;
```

#### `mat2x2h`

```ts
export type mat2x2h = {
    type: 'mat2x2h';
    wgslType: 'mat2x2h';
};
export const mat2x2h: mat2x2h;
```

#### `mat2x3h`

```ts
export type mat2x3h = {
    type: 'mat2x3h';
    wgslType: 'mat2x3h';
};
export const mat2x3h: mat2x3h;
```

#### `mat2x4h`

```ts
export type mat2x4h = {
    type: 'mat2x4h';
    wgslType: 'mat2x4h';
};
export const mat2x4h: mat2x4h;
```

#### `mat3x2h`

```ts
export type mat3x2h = {
    type: 'mat3x2h';
    wgslType: 'mat3x2h';
};
export const mat3x2h: mat3x2h;
```

#### `mat3x3h`

```ts
export type mat3x3h = {
    type: 'mat3x3h';
    wgslType: 'mat3x3h';
};
export const mat3x3h: mat3x3h;
```

#### `mat3x4h`

```ts
export type mat3x4h = {
    type: 'mat3x4h';
    wgslType: 'mat3x4h';
};
export const mat3x4h: mat3x4h;
```

#### `mat4x2h`

```ts
export type mat4x2h = {
    type: 'mat4x2h';
    wgslType: 'mat4x2h';
};
export const mat4x2h: mat4x2h;
```

#### `mat4x3h`

```ts
export type mat4x3h = {
    type: 'mat4x3h';
    wgslType: 'mat4x3h';
};
export const mat4x3h: mat4x3h;
```

#### `mat4x4h`

```ts
export type mat4x4h = {
    type: 'mat4x4h';
    wgslType: 'mat4x4h';
};
export const mat4x4h: mat4x4h;
```

#### `abs`

```ts
export const abs: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `add`

```ts
export const add: <NA extends Node<Any>, NB extends Node<Any>>(a: NA, b: NB) => Node<ArithResultDesc<NA["type"], NB["type"]>>;
```

#### `sub`

```ts
export const sub: <NA extends Node<Any>, NB extends Node<Any>>(a: NA, b: NB) => Node<ArithResultDesc<NA["type"], NB["type"]>>;
```

#### `mul`

```ts
export const mul: <NA extends Node<Any>, NB extends Node<Any>>(a: NA, b: NB) => Node<MulResultDesc<NA["type"], NB["type"]>>;
```

#### `div`

```ts
export const div: <NA extends Node<Any>, NB extends Node<Any>>(a: NA, b: NB) => Node<ArithResultDesc<NA["type"], NB["type"]>>;
```

#### `mod`

```ts
export const mod: <D extends Any>(a: Node<D>, b: Node<D>) => Node<D>;
```

#### `min`

```ts
export function min<D extends Any>(a: Node<D>, b: Node<D>, ...rest: Node<D>[]): Node<D>;
```

#### `max`

```ts
export function max<D extends Any>(a: Node<D>, b: Node<D>, ...rest: Node<D>[]): Node<D>;
```

#### `clamp`

```ts
export const clamp: <D extends Any>(a: Node<D>, lo: Node<D>, hi: Node<D>) => Node<D>;
```

#### `mix`

```ts
export const mix: <D extends Any>(a: Node<D>, b: Node<D>, t: Node<Any>) => Node<D>;
```

#### `step`

```ts
export const step: <D extends Any>(edge: Node<D>, x: Node<D>) => Node<D>;
```

#### `smoothstep`

```ts
export const smoothstep: <D extends Any>(lo: Node<D>, hi: Node<D>, x: Node<D>) => Node<D>;
```

#### `ceil`

```ts
export const ceil: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `floor`

```ts
export const floor: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `fract`

```ts
export const fract: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `sqrt`

```ts
export const sqrt: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `inverseSqrt`

```ts
export const inverseSqrt: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `pow`

```ts
export const pow: <D extends Any>(a: Node<D>, b: Node<D>) => Node<D>;
```

#### `exp`

```ts
export const exp: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `exp2`

```ts
export const exp2: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `log`

```ts
export const log: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `log2`

```ts
export const log2: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `tan`

```ts
export const tan: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `atan`

```ts
export const atan: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `atan2`

```ts
export const atan2: <D extends Any>(y: Node<D>, x: Node<D>) => Node<D>;
```

#### `asin`

```ts
export const asin: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `acos`

```ts
export const acos: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `length`

```ts
export const length: (a: Node<Any>) => Node<d.f32>;
```

#### `normalize`

```ts
export const normalize: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `dot`

```ts
export const dot: (a: Node<Any>, b: Node<Any>) => Node<d.f32>;
```

#### `cross`

```ts
export const cross: <D extends Any>(a: Node<D>, b: Node<D>) => Node<D>;
```

#### `pack2x16float`

```ts
/** Pack two f32s as halves into a u32. Lower 16 bits = v.x, upper = v.y. WGSL: `pack2x16float`. */
export const pack2x16float: (v: Node<d.vec2f>) => Node<d.u32>;
```

#### `unpack2x16float`

```ts
/** Unpack a u32 into two f32s from half-precision. WGSL: `unpack2x16float`. */
export const unpack2x16float: (v: Node<d.u32>) => Node<d.vec2f>;
```

#### `pack2x16snorm`

```ts
/** Pack two f32s in [-1, 1] into a u32 as 16-bit snorm. WGSL: `pack2x16snorm`. */
export const pack2x16snorm: (v: Node<d.vec2f>) => Node<d.u32>;
```

#### `unpack2x16snorm`

```ts
/** Unpack a u32 into two f32s as 16-bit snorm. WGSL: `unpack2x16snorm`. */
export const unpack2x16snorm: (v: Node<d.u32>) => Node<d.vec2f>;
```

#### `pack2x16unorm`

```ts
/** Pack two f32s in [0, 1] into a u32 as 16-bit unorm. WGSL: `pack2x16unorm`. */
export const pack2x16unorm: (v: Node<d.vec2f>) => Node<d.u32>;
```

#### `unpack2x16unorm`

```ts
/** Unpack a u32 into two f32s as 16-bit unorm. WGSL: `unpack2x16unorm`. */
export const unpack2x16unorm: (v: Node<d.u32>) => Node<d.vec2f>;
```

#### `pack4x8snorm`

```ts
/** Pack four f32s in [-1, 1] into a u32 as 8-bit snorm. WGSL: `pack4x8snorm`. */
export const pack4x8snorm: (v: Node<d.vec4f>) => Node<d.u32>;
```

#### `unpack4x8snorm`

```ts
/** Unpack a u32 into four f32s as 8-bit snorm. WGSL: `unpack4x8snorm`. */
export const unpack4x8snorm: (v: Node<d.u32>) => Node<d.vec4f>;
```

#### `pack4x8unorm`

```ts
/** Pack four f32s in [0, 1] into a u32 as 8-bit unorm. WGSL: `pack4x8unorm`. */
export const pack4x8unorm: (v: Node<d.vec4f>) => Node<d.u32>;
```

#### `unpack4x8unorm`

```ts
/** Unpack a u32 into four f32s as 8-bit unorm. WGSL: `unpack4x8unorm`. */
export const unpack4x8unorm: (v: Node<d.u32>) => Node<d.vec4f>;
```

#### `bitcastF32`

```ts
/** Reinterpret a u32 or i32 bit pattern as f32. WGSL: `bitcast<f32>(x)`. */
export const bitcastF32: (node: Node<d.u32 | d.i32>) => Node<d.f32>;
```

#### `bitcastU32`

```ts
/** Reinterpret an f32 or i32 bit pattern as u32. WGSL: `bitcast<u32>(x)`. */
export const bitcastU32: (node: Node<d.f32 | d.i32>) => Node<d.u32>;
```

#### `bitcastI32`

```ts
/** Reinterpret an f32 or u32 bit pattern as i32. WGSL: `bitcast<i32>(x)`. */
export const bitcastI32: (node: Node<d.f32 | d.u32>) => Node<d.i32>;
```

#### `sign`

```ts
export const sign: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `sin`

```ts
export const sin: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `cos`

```ts
export const cos: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `transpose`

```ts
export const transpose: <D extends d.Mat>(m: Node<D>) => Node<D>;
```

#### `countOneBits`

```ts
export const countOneBits: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `countTrailingZeros`

```ts
export const countTrailingZeros: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `countLeadingZeros`

```ts
export const countLeadingZeros: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `reverseBits`

```ts
export const reverseBits: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `firstLeadingBit`

```ts
export const firstLeadingBit: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `firstTrailingBit`

```ts
export const firstTrailingBit: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `dpdx`

```ts
export const dpdx: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `dpdy`

```ts
export const dpdy: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `fwidth`

```ts
export const fwidth: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `dpdxCoarse`

```ts
export const dpdxCoarse: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `dpdyCoarse`

```ts
export const dpdyCoarse: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `fwidthCoarse`

```ts
export const fwidthCoarse: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `dpdxFine`

```ts
export const dpdxFine: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `dpdyFine`

```ts
export const dpdyFine: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `fwidthFine`

```ts
export const fwidthFine: <D extends Any>(a: Node<D>) => Node<D>;
```

#### `greaterThan`

```ts
export const greaterThan: <D extends Any>(a: Node<D>, b: Node<D>) => Node<CompareResultDesc<D>>;
```

#### `lessThan`

```ts
export const lessThan: <D extends Any>(a: Node<D>, b: Node<D>) => Node<CompareResultDesc<D>>;
```

#### `greaterThanEqual`

```ts
export const greaterThanEqual: <D extends Any>(a: Node<D>, b: Node<D>) => Node<CompareResultDesc<D>>;
```

#### `lessThanEqual`

```ts
export const lessThanEqual: <D extends Any>(a: Node<D>, b: Node<D>) => Node<CompareResultDesc<D>>;
```

#### `equal`

```ts
export const equal: <D extends Any>(a: Node<D>, b: Node<D>) => Node<CompareResultDesc<D>>;
```

#### `notEqual`

```ts
export const notEqual: <D extends Any>(a: Node<D>, b: Node<D>) => Node<CompareResultDesc<D>>;
```

#### `or`

```ts
export const or: (a: Node<d.bool>, b: Node<d.bool>) => Node<d.bool>;
```

#### `and`

```ts
export const and: (a: Node<d.bool>, b: Node<d.bool>) => Node<d.bool>;
```

#### `bitwiseAnd`

```ts
export const bitwiseAnd: <D extends Any>(a: Node<D>, b: Node<D>) => Node<D>;
```

#### `bitwiseOr`

```ts
export const bitwiseOr: <D extends Any>(a: Node<D>, b: Node<D>) => Node<D>;
```

#### `bitwiseXor`

```ts
export const bitwiseXor: <D extends Any>(a: Node<D>, b: Node<D>) => Node<D>;
```

#### `shiftLeft`

```ts
export const shiftLeft: <D extends Any>(a: Node<D>, b: Node<D>) => Node<D>;
```

#### `shiftRight`

```ts
export const shiftRight: <D extends Any>(a: Node<D>, b: Node<D>) => Node<D>;
```

#### `attribute`

```ts
export function attribute<D extends Any>(name: string, schema: D, options?: AttributeOptions): AttributeNode<D>;
export function attribute<D extends Any>(buffer: GpuBuffer<D>, options?: AttributeOptions): AttributeNode<D>;
export function attribute<D extends Any>(data: TypedArrayFor<D>, schema: D, options?: AttributeOptions): AttributeNode<D>;
```

#### `AttributeOptions`

```ts
/**
 * Options for creating an AttributeNode with view semantics.
 */
export type AttributeOptions = {
    /** Byte stride between elements (0 = tightly packed). */
    stride?: number;
    /** Byte offset within each stride. */
    offset?: number;
    /** Whether this is per-instance data (stepMode: 'instance'). */
    instanced?: boolean;
};
```

#### `builtin`

```ts
export const builtin: <D extends Any>(builtinKind: BuiltinKind, desc: D) => BuiltinNode<D>;
```

#### `index`

```ts
export const index: <N extends Node<Any>>(array: N, idx: Node<Any>) => Node<d.ElementOf<N["type"]>>;
```

#### `field`

```ts
/** Type-safe field access for structs - infers the field type from the struct descriptor */
export const field: <D extends Any, K extends StructKeys<D>>(node: Node<D>, name: K) => Node<StructField<D, K>>;
```

#### `fields`

```ts
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
```

#### `uniform`

```ts
/**
 * Declare a material uniform.
 *
 * **Value-based form**, pass a Uniform object; the node references it:
 *   const roughnessU = new Uniform(d.f32, 0.5);
 *   const roughness = uniform(roughnessU);
 *   roughnessU.set(0.8);  // update via Uniform
 *
 * **Name-based form**, resolved from material.uniforms at render time:
 *   const roughness = uniform('roughness', d.f32);
 *   const myVal = uniform('myVal', MyStruct);  // struct variant
 *
 * **Inline form**, pass a typed LiteralNode as the initialiser:
 *   uniform(f32(0.5))               // anonymous, uniformId derived from type
 *   uniform(f32(0.5), 'roughness')  // explicit name used as the WGSL field name
 *   uniform(vec4f(1, 0, 0, 1), 'baseColor')
 */
export function uniform<D extends Any>(u: Uniform<D>): UniformNode<D>;
export function uniform<D extends Any>(name: string, schema: D): UniformNode<D>;
export function uniform<S extends StructSchema>(name: string, def: StructDef<S>): StructInstance<S>;
export function uniform<D extends Any>(init: ConstructNode<D>, name?: string): UniformNode<D>;
export function uniform<D extends Any>(init: LiteralNode<D>, name?: string): UniformNode<D>;
```

#### `storage`

```ts
/**
 * Create a storage buffer node from a GpuBuffer (value-based).
 * Type is inferred from the buffer's schema.
 *
 * @param buffer - The GpuBuffer to bind
 * @param access - Storage access mode: 'read' (default) or 'read_write'
 *
 * @example
 * const particleBuffer = new GpuBuffer(d.array(Particle), { data: new Float32Array(1000 * stride), usage: 'storage' });
 * const particles = storage(particleBuffer, 'read_write');
 * particles.value = otherBuffer;  // swap buffers for double-buffering
 */
export function storage<D extends Any>(buffer: GpuBuffer<D>, access?: 'read' | 'read_write'): StorageNode<D>;
/**
 * Create a storage buffer node by name (name-based).
 * Resolved from `geometry.buffers` at render time.
 *
 * @param name - Buffer name for geometry.buffers lookup
 * @param schema - The WGSL type descriptor (e.g., d.array(d.vec4f))
 * @param access - Storage access mode: 'read' (default) or 'read_write'
 *
 * @example
 * const particles = storage('particles', d.array(Particle), 'read_write');
 * // Different meshes can have different 'particles' buffers with the same material
 */
export function storage<D extends Any>(name: string, schema: D, access?: 'read' | 'read_write'): StorageNode<D>;
```

#### `array`

```ts
export type array<E extends Any = Any> = {
    type: 'array';
    wgslType: `array<${E['wgslType']}>`;
    element: E;
    length?: undefined;
};
export function array<E extends Any>(element: E): {
    type: 'array';
    wgslType: `array<${E['wgslType']}>`;
    element: E;
    length?: undefined;
};
```

#### `texture`

```ts
/**
 * Create a texture node for sampling a 2D texture.
 *
 * Accepts either:
 * - A high-level Texture object (auto-creates sampler from texture settings)
 * - A GpuTexture + GpuSampler pair (low-level)
 *
 * @example
 * // From high-level Texture
 * const albedo = texture(myTexture);
 *
 * // From GpuTexture + GpuSampler (low-level)
 * const albedo = texture(gpuTex, gpuSampler);
 *
 * // Sampling methods
 * albedo.sample(customUv)              // textureSample with custom UVs
 * albedo.level(float(2))               // textureSampleLevel
 * albedo.bias(float(1))                // textureSampleBias
 * albedo.grad(ddx, ddy)                // textureSampleGrad
 * albedo.offset(vec2i(1, 0))           // with offset
 * albedo.load(vec2i(10, 20))           // textureLoad
 */
export function texture(tex: Texture): TextureNode;
export function texture(gpuTex: GpuTexture<FlatSampledTexture>, gpuSampler: GpuSampler): TextureNode;
```

#### `varying`

```ts
export const varying: <D extends Any>(source: Node<D>, name?: string) => VaryingNode<D>;
```

#### `struct`

```ts
export function struct<S extends d.StructSchema>(name: string, fields: S): StructDef<S>;
```

#### `wgsl`

```ts
/**
 * Create an inline WGSL expression node using a tagged template literal.
 *
 * @param desc - A WgslDesc descriptor specifying the result type
 *
 * @example
 * // With WgslDesc:
 * const expr = wgsl(d.f32)`dot(${a}, ${b})`;
 * const rgbaNode = wgsl(d.vec4f)`vec4f(${rgb}, 1.0)`;
 *
 * // Preserving input type:
 * const sinNode = <D extends d.WgslDesc>(a: Node<D>) => wgsl(a.type)`sin(${a})`;
 */
export function wgsl<D extends d.Any>(desc: D): (strings: TemplateStringsArray, ...deps: Node<d.Any>[]) => WgslNode<D>;
```

#### `wgslFn`

```ts
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
 *
 * @param source - Complete WGSL function source code
 * @param layout - Optional layout for typed output and params
 * @param includes - Other wgslFn functions this function depends on
 *
 * @example
 * // Untyped (legacy):
 * const aces = wgslFn(`
 *     fn acesToneMapping(color: vec3f) -> vec3f {
 *         ...
 *     }
 * `);
 *
 * @example
 * // Typed output only:
 * const aces = wgslFn(`
 *     fn acesToneMapping(color: vec3f) -> vec3f {
 *         ...
 *     }
 * `, { output: d.vec3f });
 *
 * @example
 * // Fully typed:
 * const aces = wgslFn(`
 *     fn acesToneMapping(color: vec3f) -> vec3f {
 *         ...
 *     }
 * `, { output: d.vec3f, params: [{ name: 'color', type: d.vec3f }] });
 */
export function wgslFn<D extends d.Any, P extends readonly ParamDesc[]>(source: string, layout: {
    readonly output: D;
    readonly params: [...P];
}, includes?: (WgslFnCallable | WgslFunctionNode)[]): WgslFnCallableTyped<D, P>;
export function wgslFn<D extends d.Any>(source: string, layout: {
    readonly output: D;
    readonly params?: undefined;
}, includes?: (WgslFnCallable | WgslFunctionNode)[]): WgslFnCallableUntyped<D>;
export function wgslFn(source: string, includes?: (WgslFnCallable | WgslFunctionNode)[]): WgslFnCallable;
```

#### `Fn`

```ts
export function Fn<R extends Any, P extends readonly ParamDesc[]>(jsFunc: (...args: ParamDescsToNodes<P>) => Node<R>, layout: {
    readonly name: string;
    readonly params: [...P];
    readonly return: R;
}): (...args: ParamDescsToNodes<P>) => CallNode<R>;
export function Fn<D extends Any, P extends readonly ParamDesc[]>(jsFunc: (...args: ParamDescsToNodes<P>) => Node<D>, layout: {
    readonly name: string;
    readonly params: [...P];
    readonly return?: undefined;
}): (...args: ParamDescsToNodes<P>) => CallNode<D>;
export function Fn(jsFunc: () => void): FnNode<d.Void>;
export function Fn<D extends Any>(jsFunc: (...args: Node<Any>[]) => Node<D>): (...args: Node<Any>[]) => CallNode<D>;
```

#### `mrt`

```ts
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
export function mrt(outputNodes: Record<string, Node<d.Any>>): MRTNode;
```

#### `compute`

```ts
export function compute(fn: FnNode<Any>, opts: ComputeOptions): ComputeNode;
```

#### `sampler`

```ts
export type sampler = {
    type: 'sampler';
    wgslType: 'sampler';
};
export const sampler: sampler;
```

#### `comparisonSampler`

```ts
/**
 * Create a comparison sampler node for shadow mapping.
 *
 * Accepts either:
 * - A GpuSampler directly (low-level) - will create a new GpuSampler with compare function added
 * - A high-level texture to extract _gpuSampler settings from
 *
 * @example
 * // From high-level depth texture
 * const cmpSampler = comparisonSampler(myDepthTex, 'less');
 *
 * // From GpuSampler directly
 * const gpuSampler = new GpuSampler({ minFilter: 'linear' });
 * const cmpSampler = comparisonSampler(gpuSampler, 'less');
 */
export function comparisonSampler(source: GpuSampler, compare?: GPUCompareFunction, groupNode?: UniformGroup): SamplerNode<d.samplerComparison>;
export function comparisonSampler(source: HighLevelTexture, compare?: GPUCompareFunction, groupNode?: UniformGroup): SamplerNode<d.samplerComparison>;
```

#### `cubeTexture`

```ts
/**
 * Create a cube texture node from a CubeTexture object.
 * Auto-creates a SamplerNode from the texture's settings.
 *
 * @param tex - The CubeTexture object containing 6 face images
 *
 * @example
 * // From high-level CubeTexture
 * const env = cubeTexture(myCubeTex);
 *
 * // From GpuTexture + GpuSampler (low-level)
 * const env = cubeTexture(gpuCubeTex, gpuSampler);
 *
 * // Sampling methods
 * env.sample(reflectDir)                    // textureSample with direction
 * env.sample(reflectDir).level(float(0))    // textureSampleLevel
 * env.sample(reflectDir).bias(float(1))     // textureSampleBias
 * env.sample(reflectDir).grad(ddx, ddy)     // textureSampleGrad
 * // NO .offset() - not supported for cube textures
 * // NO .load() - not supported for cube textures
 */
export function cubeTexture(tex: CubeTexture): CubeTextureNode;
export function cubeTexture(gpuTex: GpuTexture<CubeSampledTexture>, gpuSampler: GpuSampler): CubeTextureNode;
```

#### `depthTexture`

```ts
/**
 * Create a depth texture node.
 *
 * Accepts either:
 * - A high-level DepthTexture object (auto-creates sampler from texture settings)
 * - A GpuTexture + GpuSampler pair (low-level)
 *
 * For comparison sampling (shadow mapping), create a comparison sampler separately:
 * ```
 * const shadow = depthTexture(myDepthTex);
 * const cmpSampler = comparisonSampler(myDepthTex, 'less');
 * // Regular depth read:
 * shadow.sample(uv)
 * // Comparison sampling (shadow test):
 * textureSampleCompare(shadow, cmpSampler, uv, depthRef)
 * ```
 *
 * @example
 * // From high-level DepthTexture
 * const shadow = depthTexture(myDepthTex);
 *
 * // From GpuTexture + GpuSampler (low-level)
 * const shadow = depthTexture(gpuDepthTex, gpuSampler);
 */
export function depthTexture(tex: DepthTexture): DepthTextureNode;
export function depthTexture(gpuTex: GpuTexture<FlatDepthTexture>, gpuSampler: GpuSampler): DepthTextureNode;
```

#### `arrayTexture`

```ts
/**
 * Create an array texture node.
 *
 * Accepts either:
 * - A high-level ArrayTexture object (auto-creates sampler from texture settings)
 * - A GpuTexture + GpuSampler pair (low-level)
 *
 * @param layerNode - The initial array layer index (i32 node)
 *
 * @example
 * // From high-level ArrayTexture
 * const frames = arrayTexture(myArrayTex, i32(0));
 *
 * // From GpuTexture + GpuSampler (low-level)
 * const frames = arrayTexture(gpuArrayTex, gpuSampler, i32(0));
 *
 * // Sampling methods
 * frames.layer(frameIndex)                   // change layer
 * frames.sample(customUv)                    // change UVs
 * frames.level(float(2))                     // textureSampleLevel
 * frames.bias(float(1))                      // textureSampleBias
 * frames.grad(ddx, ddy)                      // textureSampleGrad
 * frames.offset(vec2i(1, 0))                 // with offset
 * frames.load(vec2i(10, 20))                 // textureLoad
 */
export function arrayTexture(tex: ArrayTexture, layerNode: Node<d.i32>): ArrayTextureNode;
export function arrayTexture(gpuTex: GpuTexture<d.texture2dArray>, gpuSampler: GpuSampler, layerNode: Node<d.i32>): ArrayTextureNode;
```

#### `textureBinding`

```ts
/**
 * Create a standalone texture binding node.
 *
 * Use this when you want to work with WGSL-level free functions directly
 * (textureSample, textureLoad, etc.) instead of the high-level TextureNode
 * sampling API.
 */
export const textureBinding: <D extends d.Texture>(tex: {
    _gpuTexture: GpuTexture<D>;
    id: number;
}, textureDesc: D) => TextureBindingNode<D>;
```

#### `textureSample`

```ts
/**
 * textureSample - Sample a texture at UV coordinates.
 * Fragment shader only.
 */
export function textureSample<D extends FlatSampledTexture>(t: TextureBindingNode<D>, s: AnySamplerNode, coords: Node<d.vec2f>, offset?: Node<d.vec2i>): CallNode<d.TextureSampleResultOf<D>>;
```

#### `textureSampleLevel`

```ts
/**
 * textureSampleLevel - Sample a texture at a specific mip level.
 * Works in any shader stage.
 */
export function textureSampleLevel<D extends FlatSampledTexture>(t: TextureBindingNode<D>, s: AnySamplerNode, coords: Node<d.vec2f>, level: Node<d.f32>, offset?: Node<d.vec2i>): CallNode<d.TextureSampleResultOf<D>>;
```

#### `textureSampleBias`

```ts
/**
 * textureSampleBias - Sample a texture with mip level bias.
 * Fragment shader only. Not supported for depth textures.
 */
export function textureSampleBias<D extends FlatSampledTexture>(t: TextureBindingNode<D>, s: AnySamplerNode, coords: Node<d.vec2f>, bias: Node<d.f32>, offset?: Node<d.vec2i>): CallNode<d.TextureSampleResultOf<D>>;
```

#### `textureSampleGrad`

```ts
/**
 * textureSampleGrad - Sample a texture with explicit gradients.
 * Works in any shader stage. Not supported for depth textures.
 */
export function textureSampleGrad<D extends FlatSampledTexture>(t: TextureBindingNode<D>, s: AnySamplerNode, coords: Node<d.vec2f>, ddx: Node<d.vec2f>, ddy: Node<d.vec2f>, offset?: Node<d.vec2i>): CallNode<d.TextureSampleResultOf<D>>;
```

#### `textureSampleCompare`

```ts
/**
 * textureSampleCompare - Compare-sample a depth texture.
 * Fragment shader only. Requires sampler_comparison.
 */
export function textureSampleCompare(t: TextureBindingNode<FlatDepthTexture>, s: AnyComparisonSamplerNode, coords: Node<d.vec2f>, depthRef: Node<d.f32>, offset?: Node<d.vec2i>): CallNode<d.f32>;
```

#### `textureSampleCompareLevel`

```ts
/**
 * textureSampleCompareLevel - Compare-sample a depth texture at a specific level.
 * Works in any shader stage. Requires sampler_comparison.
 */
export function textureSampleCompareLevel(t: TextureBindingNode<FlatDepthTexture>, s: AnyComparisonSamplerNode, coords: Node<d.vec2f>, depthRef: Node<d.f32>, level: Node<d.i32>, offset?: Node<d.vec2i>): CallNode<d.f32>;
```

#### `textureLoad`

```ts
/**
 * textureLoad - Load a texel directly without filtering.
 * Works in any shader stage. No sampler needed.
 */
export function textureLoad<D extends d.Texture>(t: TextureBindingNode<D>, coords: Node<d.vec2i>, level: Node<d.i32>): CallNode<d.TextureSampleResultOf<D>>;
```

#### `textureStore`

```ts
/**
 * textureStore - Store a value to a storage texture.
 */
export function textureStore(t: Node<Any>, // StorageTextureNode when we add it
coords: Node<d.vec2i>, value: Node<d.vec4f>): CallNode<d.Void>;
```

#### `textureDimensions`

```ts
/**
 * textureDimensions - Get texture dimensions.
 */
export function textureDimensions(t: TextureBindingNode, level?: Node<d.u32>): CallNode<d.vec2u>;
```

#### `textureNumLevels`

```ts
/**
 * textureNumLevels - Get number of mip levels.
 */
export function textureNumLevels(t: TextureBindingNode): CallNode<d.u32>;
```

#### `textureNumLayers`

```ts
/**
 * textureNumLayers - Get number of array layers.
 */
export function textureNumLayers(t: Node<Any>): CallNode<d.u32>;
```

#### `textureGather`

```ts
/**
 * textureGather - Gather a single component from 4 texels.
 */
export function textureGather<D extends FlatSampledTexture>(component: Node<d.i32>, t: TextureBindingNode<D>, s: AnySamplerNode, coords: Node<d.vec2f>, offset?: Node<d.vec2i>): CallNode<d.TextureSampleResultOf<D>>;
```

#### `textureGatherCompare`

```ts
/**
 * textureGatherCompare - Gather compare results from 4 texels.
 * Requires sampler_comparison.
 */
export function textureGatherCompare(t: TextureBindingNode<FlatDepthTexture>, s: AnyComparisonSamplerNode, coords: Node<d.vec2f>, depthRef: Node<d.f32>, offset?: Node<d.vec2i>): CallNode<d.vec4f>;
```

#### `atomicAdd`

```ts
/**
 * Atomically adds `value` to the atomic value at `ptr` and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicAdd(&ptr, value) -> i32/u32`
 */
export function atomicAdd<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc>;
```

#### `atomicStore`

```ts
/**
 * Atomically stores `value` to the atomic location at `ptr`.
 *
 * In WGSL: `atomicStore(&ptr, value)`
 */
export function atomicStore<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): void;
```

#### `atomicLoad`

```ts
/**
 * Atomically loads the value from the atomic location at `ptr`.
 *
 * In WGSL: `atomicLoad(&ptr) -> i32/u32`
 */
export function atomicLoad<D extends AtomicPtrDesc>(ptr: Node<D>): Node<ScalarResultDesc>;
```

#### `atomicSub`

```ts
/**
 * Atomically subtracts `value` from the atomic value at `ptr` and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicSub(&ptr, value) -> i32/u32`
 */
export function atomicSub<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc>;
```

#### `atomicMax`

```ts
/**
 * Atomically computes the maximum of the atomic value and `value`, stores it, and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicMax(&ptr, value) -> i32/u32`
 */
export function atomicMax<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc>;
```

#### `atomicMin`

```ts
/**
 * Atomically computes the minimum of the atomic value and `value`, stores it, and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicMin(&ptr, value) -> i32/u32`
 */
export function atomicMin<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc>;
```

#### `atomicAnd`

```ts
/**
 * Atomically computes the bitwise AND of the atomic value and `value`, stores it, and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicAnd(&ptr, value) -> i32/u32`
 */
export function atomicAnd<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc>;
```

#### `atomicOr`

```ts
/**
 * Atomically computes the bitwise OR of the atomic value and `value`, stores it, and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicOr(&ptr, value) -> i32/u32`
 */
export function atomicOr<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc>;
```

#### `atomicXor`

```ts
/**
 * Atomically computes the bitwise XOR of the atomic value and `value`, stores it, and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicXor(&ptr, value) -> i32/u32`
 */
export function atomicXor<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc>;
```

#### `atomicExchange`

```ts
/**
 * Atomically exchanges the value at `ptr` with `value` and returns the old value.
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicExchange(&ptr, value) -> i32/u32`
 */
export function atomicExchange<D extends AtomicPtrDesc>(ptr: Node<D>, value: Node<d.i32 | d.u32>): Node<ScalarResultDesc>;
```

#### `atomicCompareExchangeWeak`

```ts
/**
 * Atomically compares the value at `ptr` with `comparator` and if equal, stores `value`.
 * Returns the old value (regardless of whether the exchange happened).
 * The call is always added to the stack so side effects are captured even if the
 * return value is discarded.
 *
 * In WGSL: `atomicCompareExchangeWeak(&ptr, comparator, value) -> __atomic_compare_exchange_result<T>`
 *
 * Note: WGSL returns a struct { old_value: T, exchanged: bool }. This function returns the struct type
 * which you need to access via .old_value and .exchanged fields.
 */
export function atomicCompareExchangeWeak<D extends AtomicPtrDesc>(ptr: Node<D>, comparator: Node<d.i32 | d.u32>, value: Node<d.i32 | d.u32>): Node<Any>;
```

#### `Var`

```ts
/**
 * Function-scope mutable variable: `var name = init;`
 *
 * @example
 * const velocity = Var('velocity', vec3f(0));
 * // → var velocity = vec3f(0.0);
 */
export function Var<D extends Any>(name: string, init: Node<D>): VarNode<D>;
```

#### `Const`

```ts
/** @deprecated Use Let() instead */
export function Const<D extends Any>(name: string, init: Node<D>): LetNode<D>;
```

#### `Let`

```ts
/**
 * Function-scope immutable binding: `let name = init;`
 *
 * @example
 * const half = Let('half', value.mul(0.5));
 * // → let half = (value * 0.5);
 */
export function Let<D extends Any>(name: string, init: Node<D>): LetNode<D>;
```

#### `PrivateVar`

```ts
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
```

#### `WorkgroupVar`

```ts
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
export function WorkgroupVar<D extends Any>(name: string, type: D): WorkgroupVarNode<D>;
```

#### `If`

```ts
export function If(condition: Node<Any>, thenBody: () => void): IfChain;
```

#### `Loop`

```ts
export function Loop(range: number, callback: (vars: LoopVars) => void): LoopNode;
export function Loop(o: LoopParam, callback: (vars: LoopVars) => void): LoopNode;
```

#### `For`

```ts
export const For: typeof Loop;
```

#### `While`

```ts
export function While(condition: Node<Any>, body: () => void): void;
```

#### `Break`

```ts
export function Break(): void;
```

#### `Continue`

```ts
export function Continue(): void;
```

#### `Return`

```ts
export function Return(): void;
export function Return<D extends Any>(value: Node<D>): void;
```

#### `Discard`

```ts
export function Discard(): void;
```

#### `workgroupBarrier`

```ts
/** Workgroup synchronization barrier. WGSL: `workgroupBarrier()`. */
export function workgroupBarrier(): void;
```

#### `storageBarrier`

```ts
/** Storage-buffer write/read sync within a workgroup. WGSL: `storageBarrier()`. */
export function storageBarrier(): void;
```

#### `textureBarrier`

```ts
/** Texture write/read sync within a workgroup. WGSL: `textureBarrier()`. */
export function textureBarrier(): void;
```

#### `cond`

```ts
export const cond: <D extends Any>(condition: Node<Any>, ifTrue: Node<D>, ifFalse?: Node<D>) => ConditionalNode<D>;
```

#### `select`

```ts
/**
 * WGSL `select(falseVal, trueVal, condition)`.
 * Returns `trueVal` when `condition` is true, `falseVal` otherwise.
 */
export const select: <D extends Any>(falseVal: Node<D>, trueVal: Node<D>, condition: Node<Any>) => Node<D>;
```

#### `cameraProjectionMatrix`

```ts
/** Projection matrix of the scene camera. In renderGroup. */
export const cameraProjectionMatrix: UniformNode<d.mat4x4f>;
```

#### `cameraViewMatrix`

```ts
/** View (world-to-camera) matrix. In renderGroup. */
export const cameraViewMatrix: UniformNode<d.mat4x4f>;
```

#### `cameraPosition`

```ts
/** Camera world-space position. In renderGroup. */
export const cameraPosition: UniformNode<d.vec3f>;
```

#### `cameraNear`

```ts
/** Camera near plane distance. In renderGroup. */
export const cameraNear: UniformNode<d.f32>;
```

#### `cameraFar`

```ts
/** Camera far plane distance. In renderGroup. */
export const cameraFar: UniformNode<d.f32>;
```

#### `modelWorldMatrix`

```ts
/** Model-to-world transform matrix. */
export const modelWorldMatrix: UniformNode<d.mat4x4f>;
```

#### `modelNormalMatrix`

```ts
/** Normal matrix (inverse-transpose of upper-left 3x3 of model matrix). In objectGroup. */
export const modelNormalMatrix: UniformNode<d.mat3x3f>;
```

#### `instanceIndex`

```ts
/** @builtin(instance_index), the instance index for instanced draw calls. */
export const instanceIndex: BuiltinNode<d.u32>;
```

#### `vertexIndex`

```ts
/** @builtin(vertex_index), the vertex index in the current draw call. */
export const vertexIndex: BuiltinNode<d.u32>;
```

#### `globalId`

```ts
/** @builtin(global_invocation_id), unique thread ID across the entire dispatch. */
export const globalId: BuiltinNode<d.vec3u>;
```

#### `localId`

```ts
/** @builtin(local_invocation_id), thread ID within its workgroup. */
export const localId: BuiltinNode<d.vec3u>;
```

#### `localIndex`

```ts
/** @builtin(local_invocation_index), flat 1-D index within the workgroup. */
export const localIndex: BuiltinNode<d.u32>;
```

#### `workgroupId`

```ts
/** @builtin(workgroup_id), workgroup coordinate in the dispatch grid. */
export const workgroupId: BuiltinNode<d.vec3u>;
```

#### `numWorkgroups`

```ts
/** @builtin(num_workgroups), total number of workgroups dispatched. */
export const numWorkgroups: BuiltinNode<d.vec3u>;
```

#### `fragCoord`

```ts
/**
 * Fragment position in window/pixel coordinates.
 * @builtin(position) in the fragment shader, vec4f where xy are pixel coordinates.
 *
 * This is the raw fragment coordinate from the rasterizer.
 * Use screenCoordinate.xy for 2D pixel position.
 */
export const fragCoord: BuiltinNode<d.vec4f>;
```

#### `screenCoordinate`

```ts
/**
 * Screen coordinate, the current fragment's xy position in pixels.
 * Equivalent to @builtin(position).xy in WGSL.
 *
 * @example
 * // Get pixel position
 * const pixelPos = screenCoordinate;
 */
export const screenCoordinate: Node<d.vec2f>;
```

#### `screenSize`

```ts
/**
 * Screen/viewport size in pixels. Updated per render by the renderer.
 * In renderGroup so it's shared across all objects in a frame.
 *
 * @example
 * // Get screen dimensions
 * const size = screenSize; // vec2f(width, height)
 */
export const screenSize: UniformNode<d.vec2f>;
```

#### `screenUV`

```ts
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
export const screenUV: Node<d.vec2f>;
```

#### `computeIndex`

```ts
export const computeIndex: ComputeIndexNode;
```

#### `positionClip`

```ts
/** helper for vertex shader: compute clip-space position from vertex position attribute and camera matrices. */
export const positionClip: Node<d.vec4f>;
```

#### `DrawIndirect`

```ts
/**
 * Basic struct descriptor for a non-indexed indirect draw call (`drawIndirect`) with no additional fields.
 * Memory layout (4 × u32, 16 bytes):
 *   vertexCount, instanceCount, firstVertex, firstInstance
 */
export const DrawIndirect: import("./core").StructDef<{
    vertexCount: d.u32;
    instanceCount: d.u32;
    firstVertex: d.u32;
    firstInstance: d.u32;
}>;
```

#### `DrawIndexedIndirect`

```ts
/**
 * Basic struct descriptor for an indexed indirect draw call (`drawIndexedIndirect`) with no additional fields.
 * Memory layout (5 × u32, 20 bytes):
 *   indexCount, instanceCount, firstIndex, baseVertex, firstInstance
 */
export const DrawIndexedIndirect: import("./core").StructDef<{
    indexCount: d.u32;
    instanceCount: d.u32;
    firstIndex: d.u32;
    baseVertex: d.u32;
    firstInstance: d.u32;
}>;
```

#### `BinaryOp`

```ts
export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '>' | '<=' | '>=' | '||' | '&&' | '&' | '|' | '^' | '<<' | '>>';
```

#### `BuiltinKind`

```ts
export type BuiltinKind = 'instance_index' | 'instance_data' | 'vertex_index' | 'global_invocation_id' | 'local_invocation_id' | 'local_invocation_index' | 'workgroup_id' | 'num_workgroups' | 'position';
```

#### `ComputeNodeOptions`

```ts
export type ComputeNodeOptions = ComputeOptions & {
    fn: FnNode<any>;
};
```

#### `ComputeOptions`

```ts
export type ComputeOptions = {
    workgroupSize: [x: number, y: number, z: number];
    name?: string;
};
```

#### `GpuTypedArray`

```ts
export type GpuTypedArray = Float32Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array;
```

#### `MatType`

```ts
export type MatType = 'mat2x2f' | 'mat2x3f' | 'mat2x4f' | 'mat3x2f' | 'mat3x3f' | 'mat3x4f' | 'mat4x2f' | 'mat4x3f' | 'mat4x4f' | 'mat2x2h' | 'mat2x3h' | 'mat2x4h' | 'mat3x2h' | 'mat3x3h' | 'mat3x4h' | 'mat4x2h' | 'mat4x3h' | 'mat4x4h';
```

#### `NumericType`

```ts
export type NumericType = ScalarType | VecType | MatType;
```

#### `SamplerType`

```ts
export type SamplerType = 'sampler' | 'sampler_comparison';
```

#### `ScalarType`

```ts
export type ScalarType = 'f32' | 'i32' | 'u32' | 'bool' | 'f16';
```

#### `StructDef`

```ts
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
```

#### `StructInstance`

```ts
export type StructInstance<S extends d.StructSchema> = {
    readonly $node: Node<d.StructDesc>;
} & {
    readonly [K in keyof S]: Node<S[K]>;
};
```

#### `StructMember`

```ts
export type StructMember = {
    readonly name: string;
    readonly type: Any;
};
```

#### `TextureType`

```ts
export type TextureType = string;
```

#### `Vec2Type`

```ts
export type Vec2Type = 'vec2f' | 'vec2i' | 'vec2u' | 'vec2<bool>' | 'vec2h';
```

#### `Vec3Type`

```ts
export type Vec3Type = 'vec3f' | 'vec3i' | 'vec3u' | 'vec3<bool>' | 'vec3h';
```

#### `Vec4Type`

```ts
export type Vec4Type = 'vec4f' | 'vec4i' | 'vec4u' | 'vec4<bool>' | 'vec4h';
```

#### `VecType`

```ts
export type VecType = Vec2Type | Vec3Type | Vec4Type;
```

#### `WgslType`

```ts
export type WgslType = PrimType | AtomicType | `array<${string}>` | `array<${string}, ${number}>` | string;
```

#### `InterpolationType`

```ts
/**
 * WGSL @interpolate interpolation type.
 *   - perspective  : values are interpolated in a perspective-correct manner (default for float types)
 *   - linear       : values are interpolated in a linear, non-perspective-correct manner
 *   - flat         : values are not interpolated; the value from the provoking vertex is used
 *                    (required for integer/unsigned-integer types)
 */
export type InterpolationType = 'perspective' | 'linear' | 'flat';
```

#### `InterpolationSampling`

```ts
/**
 * WGSL @interpolate sampling mode (only valid when interpolation type is 'perspective' or 'linear').
 *   - center    : interpolation is performed at the center of the pixel (default)
 *   - centroid  : interpolation is performed at a point inside the primitive that is also
 *                 inside all samples covered by the fragment (avoids aliasing at primitive edges)
 *   - sample    : interpolation is performed per-sample; the fragment shader runs once per sample
 *   - either    : implementation may choose center or centroid (valid only with 'flat' in WGSL)
 */
export type InterpolationSampling = 'center' | 'centroid' | 'sample' | 'either';
```

#### `WgslNodeFunction`

```ts
export type WgslNodeFunction = {
    type: string;
    inputs: WgslNodeFunctionInput[];
    name: string;
    inputsCode: string;
    blockCode: string;
    outputType: string;
    getCode(name?: string): string;
};
```

#### `WgslNodeFunctionInput`

```ts
/**
 * Parsed WGSL function info returned by parseWgslFunction().
 */
export type WgslNodeFunctionInput = {
    name: string;
    type: string;
    pointer?: boolean;
};
```

#### `ParamDesc`

```ts
export type ParamDesc = {
    readonly name: string;
    readonly type: Any;
};
```

#### `FnLayout`

```ts
export type FnLayout<P extends readonly ParamDesc[]> = {
    /** Function name in the generated WGSL. */
    readonly name: string;
    /** Named, typed parameters, in order. */
    readonly params: [...P];
    /** Explicit return type (WGSL `-> return`), checked against the body. Omit to infer from the body. */
    readonly return?: Any;
};
```

#### `pass`

```ts
/** creates a pass node */
export const pass: (scene: Scene, camera: Camera, options?: PassNodeOptions) => PassNode;
```

#### `PassNodeOptions`

```ts
export type PassNodeOptions = {
    /** RGBA clear color for this pass's color attachment. Defaults to [0, 0, 0, 1]. */
    clearColor?: [number, number, number, number];
    /** GPUTextureFormat for the color render target. Defaults to 'rgba16float'. */
    colorFormat?: GPUTextureFormat;
    /** Number of MSAA samples. Defaults to 1 (no MSAA). */
    samples?: number;
};
```

#### `renderOutput`

```ts
/**
 * Wrap `inputNode` in tone-mapping and color-space conversion.
 *
 * Returns a `Node<d.vec4f>` suitable for final output:
 * `renderer.render(renderOutput(scenePass.getTextureNode()))`.
 */
export function renderOutput(inputNode: Node<d.vec4f>, options?: RenderOutputOptions): Node<d.vec4f>;
```

#### `OutputColorSpace`

```ts
export type OutputColorSpace = 'srgb' | 'linear';
```

#### `RenderOutputOptions`

```ts
export type RenderOutputOptions = {
    /**
     * Tone mapping operator to apply.
     * @default 'aces'
     */
    toneMapping?: ToneMappingMode;
    /**
     * Output color space.  'srgb' applies the standard linear→sRGB
     * transfer function (IEC 61966-2-1).  'linear' skips it.
     * @default 'srgb'
     */
    colorSpace?: OutputColorSpace;
    /**
     * Scene exposure multiplier, applied before tone mapping.
     * Pass a UniformNode<d.f32> to animate it.
     * @default f32(1.0)
     */
    exposure?: Node<d.f32>;
};
```

#### `ToneMappingMode`

```ts
export type ToneMappingMode = 'aces' | 'reinhard' | 'linear' | 'none';
```

#### `acesToneMapping`

```ts
/**
 * ACES filmic tone mapping (Narkowicz 2015).
 * f(x) = clamp((x * (2.51x + 0.03)) / (x * (2.43x + 0.59) + 0.14), 0, 1)
 */
export const acesToneMapping: (args_0: import("../core").Node<d.vec3f>) => import("../core").CallNode<d.vec3f>;
```

#### `reinhardToneMapping`

```ts
/**
 * Reinhard tone mapping.
 * f(x) = x / (1 + x)
 */
export const reinhardToneMapping: (args_0: import("../core").Node<d.vec3f>) => import("../core").CallNode<d.vec3f>;
```

#### `sRGBTransferEOTF`

```ts
/**
 * sRGB EOTF (electro-optical transfer function).
 * Converts sRGB gamma-encoded values to linear-sRGB.
 */
export const sRGBTransferEOTF: (args_0: import("../core").Node<d.vec3f>) => import("../core").CallNode<d.vec3f>;
```

#### `sRGBTransferOETF`

```ts
/**
 * sRGB OETF (opto-electronic transfer function).
 * Converts linear-sRGB values to sRGB gamma-encoded.
 */
export const sRGBTransferOETF: (args_0: import("../core").Node<d.vec3f>) => import("../core").CallNode<d.vec3f>;
```

#### `fxaa`

```ts
/**
 * FXAA (Fast Approximate Anti-Aliasing) post-processing effect.
 *
 * Uses the standard FXAA 3.11 algorithm:
 * 1. Samples luminance of neighboring pixels
 * 2. Detects edges based on contrast
 * 3. Blends pixels along detected edges to smooth jaggies
 *
 * The inverse texture size uniform is automatically updated each frame.
 *
 * @param textureNode - The texture to apply FXAA to (typically from pass.getTextureNode())
 * @returns A vec4f node containing the anti-aliased color
 *
 * @example
 * const scenePass = pass(scene, camera);
 * const fxaaOutput = fxaa(scenePass.getTextureNode());
 *
 * const postMaterial = new Material({
 *     vertex: fullscreenQuadVertex,
 *     fragment: fxaaOutput,
 * });
 */
export function fxaa(textureNode: TextureNode): Node<d.vec4f>;
```

## Renderer

Drive the GPU: create a renderer, build pipelines, render to the canvas or a target.

#### `WebGPURendererOptions`

```ts
export type WebGPURendererOptions = {
    /** Enable 4x MSAA antialiasing. Overridden by `samples` if both set. */
    antialias?: boolean;
    /** Explicit MSAA sample count. 0 or 1 = no MSAA. Takes precedence over antialias. */
    samples?: number;
    /** GPURequestAdapterOptions forwarded to navigator.gpu.requestAdapter(). */
    adapterOptions?: GPURequestAdapterOptions;
    /** GPUDeviceDescriptor forwarded to adapter.requestDevice(). */
    deviceDescriptor?: GPUDeviceDescriptor;
    /** Pre-created GPUDevice. When provided, skips navigator.gpu initialization. */
    device?: GPUDevice;
    /** Pre-created GPUAdapter. Required when `device` is provided. */
    adapter?: GPUAdapter;
    /** Canvas texture format. Defaults to navigator.gpu.getPreferredCanvasFormat() or 'bgra8unorm' when using a pre-created device. */
    format?: GPUTextureFormat;
    /** Canvas element to render into. If not provided, one will be created. Ignored when `headless` is true. */
    canvas?: HTMLCanvasElement;
    /** When true, the canvas context uses premultiplied alpha compositing. Defaults to false (opaque). */
    alpha?: boolean;
    /**
     * Headless mode, no canvas, no swapchain. Requires a pre-created `device`.
     * Renders must target a `RenderTarget` (set via `renderer.renderTarget`).
     * Useful for Node.js with a native WebGPU library, or for off-screen rendering pipelines.
     */
    headless?: boolean;
};
```

#### `ComputeDispatch`

```ts
/**
 * A single compute dispatch in a `WebGPURenderer.compute()` batch.
 *
 * Either `dispatch` (CPU-side workgroup counts) or `indirect` (GPU buffer holding counts)
 * must be provided. `buffers` (optional, on either form) overrides named storage refs.
 */
export type ComputeDispatch = {
    /** The ComputeNode to dispatch. */
    node: ComputeNode;
    /** Workgroup counts [x, y, z] dispatched from the CPU. */
    dispatch: [number, number, number];
    indirect?: never;
    indirectOffset?: never;
    /**
     * Override map for named storage buffers (those declared via `storage('name', schema, ...)`).
     * Takes precedence over the node's value/geometry, lets one ComputeNode be reused
     * across different buffers without recompiling the pipeline.
     */
    buffers?: Record<string, GpuBuffer<d.Any>>;
} | {
    /** The ComputeNode to dispatch. */
    node: ComputeNode;
    /**
     * GPU buffer holding `[countX, countY, countZ]` as u32 (matches `dispatchWorkgroupsIndirect` layout).
     * Buffer must have 'indirect' usage. Typically written by an earlier compute pass.
     */
    indirect: GpuBuffer<d.Any>;
    /** Byte offset into `indirect`. Defaults to 0. */
    indirectOffset?: number;
    dispatch?: never;
    /** See `dispatch` form for details. */
    buffers?: Record<string, GpuBuffer<d.Any>>;
};
```

#### `WebGPURenderer`

```ts
export class WebGPURenderer {
    /**
     * Inspector. `null` means no inspector is attached, hot path pays zero cost.
     * Install with `renderer.setInspector(new Inspector())` and remove with
     * `renderer.setInspector(null)`. The inspector subclass handles its own
     * setup/teardown via setRenderer(); ordering relative to renderer.init()
     * does not matter (inspectors set up lazily on first frame).
     */
    inspector: InspectorBase | null;
    /**
     * Install or remove the inspector. Safe to call at any time, including
     * before `renderer.init()`. Passing `null` triggers the old inspector's
     * detach path (releases GPU resources, removes DOM, drops listeners).
     */
    setInspector(next: InspectorBase | null): void;
    /** The canvas dom element for the current canvas target. Throws in headless mode. */
    get domElement(): HTMLCanvasElement;
    /** MSAA sample count (0 or 1 = no MSAA). */
    samples: number;
    /**
     * A callback function that is executed when a device loss occurs.
     * @example
     * renderer.onDeviceLost = (info) => {
     *     console.error('GPU device lost:', info.message);
     *     // Optionally: show error UI, attempt recovery, etc.
     * };
     */
    onDeviceLost: ((info: DeviceLostInfo) => void) | null;
    /** clear color for the final swapchain composite pass. defaults to opaque black. */
    clearColor: [number, number, number, number];
    /** current MRT configuration. when set, materials using mrt() nodes write to multiple color attachments. */
    mrt: MRTNode | null;
    /** current render target. when set, render() renders to this target instead of the swapchain. */
    renderTarget: RenderTarget | null;
    /** when set, all meshes in the scene render with this material instead of their own. */
    overrideMaterial: Material | null;
    /** swap the active canvas target (used by inspector viewer for preview renders). */
    setCanvasTarget(canvasTarget: CanvasTarget | null): this;
    getCanvasTarget(): CanvasTarget | null;
    constructor(opts?: WebGPURendererOptions);
    /**
     * Initialise the WebGPU adapter, device, and canvas context.
     * Must be called (and awaited) before the first call to pipeline.render().
     *
     * @throws if WebGPU is not available or no suitable adapter is found.
     */
    init(): Promise<this>;
    /** set the device pixel ratio. call before setSize(). Throws in headless mode. */
    setPixelRatio(value: number): void;
    /** resize the canvas to logical pixel dimensions (physical = logical * pixelRatio). Throws in headless mode. */
    setSize(width: number, height: number, updateStyle?: boolean): void;
    /**
     * Check if a GPU feature is available on the current device.
     *
     * @example
     * ```ts
     * if (renderer.hasFeature('shader-f16')) {
     *     // Can use f16, vec2h, vec3h, vec4h, mat*h types
     * }
     * ```
     */
    hasFeature(feature: GPUFeatureName): boolean;
    /**
     * Pre-compile render pipelines and pre-upload GPU resources for a scene.
     * Optional, resources are created on-demand during the first render if not pre-warmed.
     */
    compile(scene: Scene, camera: Camera, samples?: number): Promise<void>;
    /**
     * Pre-compile a compute pipeline before the render loop starts.
     * This is optional, pipelines are compiled on-demand during the first
     * dispatch if not pre-warmed.
     *
     * @param computeNode The ComputeNode to pre-compile.
     * @throws if the renderer has not been initialised yet.
     */
    compileCompute(computeNode: ComputeNode): Promise<void>;
    /**
     * Encode and submit a batch of compute dispatches. Must be called **inside** a
     * `requestAnimationFrame` callback, before `renderPipeline.render()`, so the
     * compute work is submitted alongside the render pass.
     *
     * All entries share a single command encoder and a single `queue.submit()`,
     * minimizing CPU round-trip overhead. Each entry gets its own compute pass
     * so per-node inspector hooks (timestamps, perf) still work.
     *
     * Each entry supplies `dispatch: [x, y, z]` (CPU-side counts) or
     * `indirect: gpuBuffer` (GPU-side counts). Optional `buffers` overrides named
     * storage refs without recompiling the pipeline.
     *
     * ```ts
     * renderer.compute([
     *     { node: updateParticles, dispatch: [Math.ceil(N / 64), 1, 1] },
     * ]);
     *
     * renderer.compute([
     *     { node: cull,  dispatch: [n, 1, 1], buffers: { visible: bufA } },
     *     { node: build, indirect: indirectBuf },
     * ]);
     * ```
     *
     * @throws if the renderer has not been initialised.
     */
    compute(entries: ComputeDispatch[]): void;
    /** save the current renderer state into a plain object and return it */
    saveRendererState(): {
        renderTarget: RenderTarget | null;
        mrt: MRTNode | null;
        clearColor: [number, number, number, number];
        overrideMaterial: Material | null;
    };
    /** restore renderer state previously saved with `saveRendererState()` */
    restoreRendererState(state: ReturnType<WebGPURenderer['saveRendererState']>): void;
    /**
     * Render a scene from a camera's perspective.
     * Renders to `this.renderTarget` if set, otherwise to the swapchain.
     */
    render(scene: Object3D, camera: Camera, commandEncoder?: GPUCommandEncoder, passId?: string): void;
    /**
     * Dispose the renderer and release all GPU resources.
     *
     * Destroys all cached GPU buffers, textures, pipelines, and the device
     * itself (unless a pre-created device was provided). After calling dispose(),
     * the renderer cannot be used again.
     */
    dispose(): void;
}
```

#### `DeviceLostInfo`

```ts
/** Information about a device lost event. */
export type DeviceLostInfo = {
    /** The API that lost the device ('WebGPU'). */
    api: 'WebGPU';
    /** Human-readable message about the loss. */
    message: string;
    /** The reason for the loss, if available. */
    reason: GPUDeviceLostReason | null;
    /** The original GPUDeviceLostInfo event. */
    originalEvent: GPUDeviceLostInfo;
};
```

#### `RenderPipeline`

```ts
/**
 * RenderPipeline - manages the rendering pipeline for fullscreen effects.
 *
 * Usage:
 * ```ts
 * const renderPipeline = new RenderPipeline(renderer);
 *
 * const scenePass = pass(scene, camera);
 * renderPipeline.outputNode = scenePass;
 *
 * function frame() {
 *     renderPipeline.render();
 *     requestAnimationFrame(frame);
 * }
 *
 * // cleanup
 * renderPipeline.dispose();
 * ```
 */
export class RenderPipeline {
    /** reference to the renderer */
    readonly renderer: WebGPURenderer;
    /** the output node to render */
    outputNode: Node<Any>;
    /** set to `true` to rebuild the material, e.g. when the outputNode changes */
    needsUpdate: boolean;
    /**
     * @param renderer the renderer.
     * @param outputNode output node. Defaults to solid blue.
     */
    constructor(renderer: WebGPURenderer, outputNode?: Node<Any>);
    /**
     * Renders the output node to the renderer's current target.
     *
     * Each top-level `render()`/`compute()` call is a self-contained frame: it advances
     * the frame id and brackets inspector capture on its own. Example:
     * ```ts
     * renderer.compute([{ node: myCompute, dispatch: [n, 1, 1] }]);
     * renderPipeline.render();
     * ```
     */
    render(): void;
    /**
     * Dispose of resources owned by this pipeline.
     */
    dispose(): void;
}
```

#### `CanvasTargetOptions`

```ts
export type CanvasTargetOptions = {
    /** alpha compositing mode for the WebGPU canvas context. defaults to 'opaque'. */
    alphaMode?: GPUCanvasAlphaMode;
};
```

#### `CanvasTarget`

```ts
/** The HTMLCanvasElement target for the renderer to draw into. Wraps a canvas and its WebGPU context. */
export class CanvasTarget {
    /** The canvas element this target wraps. */
    readonly domElement: HTMLCanvasElement;
    /**
     * True when this is the renderer's default (main) canvas target.
     * Set by the renderer after construction; the inspector preview targets are not default.
     * The renderer sets isDefaultCanvasTarget = true on the initial target.
     */
    isDefaultCanvasTarget: boolean;
    /** Alpha compositing mode for the WebGPU canvas context. */
    readonly alphaMode: GPUCanvasAlphaMode;
    constructor(canvas: HTMLCanvasElement, opts?: CanvasTargetOptions);
    /**
     * Get (or lazily create) the WebGPU canvas context and configure it.
     * Safe to call multiple times, returns the cached context after first call.
     * WebGPURenderer lazily reads the context from the current canvasTarget.
     *
     * @param device the GPUDevice to configure the context with.
     * @param format the preferred canvas format (e.g. 'bgra8unorm').
     * @param alphaMode override for the alpha mode. defaults to the value set in the constructor.
     */
    getContext(device: GPUDevice, format: GPUTextureFormat, alphaMode?: GPUCanvasAlphaMode): GPUCanvasContext;
    /**
     * Unconfigure and release the WebGPU context. Called when the target is disposed
     * or replaced. After this, getContext() will create a fresh context.
     */
    unconfigure(): void;
    /**
     * Get the pixel ratio.
     */
    getPixelRatio(): number;
    /**
     * Set the pixel ratio and resize the canvas to match.
     */
    setPixelRatio(value: number): void;
    /**
     * Returns the drawing buffer size in physical pixels (honors pixel ratio).
     */
    getDrawingBufferSize(): {
        width: number;
        height: number;
    };
    /**
     * Returns the size in logical pixels (does not honor pixel ratio).
     */
    getSize(): {
        width: number;
        height: number;
    };
    /**
     * Set the size of the canvas in logical pixels.
     * Updates domElement.width/height (physical) and fires 'resize'.
     */
    setSize(width: number, height: number, updateStyle?: boolean): void;
    /**
     * Set the drawing buffer size directly (width, height, pixelRatio all at once).
     */
    setDrawingBufferSize(width: number, height: number, pixelRatio: number): void;
    /**
     * Dispose this target: unconfigure the GPU context and fire 'dispose'.
     */
    dispose(): void;
}
```

#### `readPixels`

```ts
/**
 * Read pixels from a RenderTarget color attachment back to a tightly-packed Uint8Array.
 *
 * The target's color format must be a 4-byte format (`rgba8unorm`, `bgra8unorm`,
 * `rgba8unorm-srgb`, `bgra8unorm-srgb`). For HDR formats like `rgba16float`,
 * render through `renderOutput()` into an `rgba8unorm` RenderTarget first.
 *
 * Returns rows top-to-bottom, RGBA (or BGRA) order, length = width * height * 4.
 * Must be called after `render()` has populated the target.
 */
export function readPixels(renderer: WebGPURenderer, renderTarget: RenderTarget, attachmentIndex?: number): Promise<Uint8Array>;
```

#### `RenderTargetOptions`

```ts
export type RenderTargetOptions = {
    /**
     * Default format applied to every color attachment at construction.
     * For per-attachment formats (MRT with mixed formats), mutate `rt.textures[i].format` after construction.
     * Default: 'rgba16float'.
     */
    colorFormat?: GPUTextureFormat;
    /** Whether to allocate a depth attachment. Default: true. */
    depthBuffer?: boolean;
    /** Format of the auto-allocated DepthTexture. Default: 'depth24plus'. Ignored if `depthTexture` is provided or `depthBuffer` is false. */
    depthFormat?: DepthTextureFormat;
    /** Caller-provided depth texture. Overrides `depthBuffer`/`depthFormat`. */
    depthTexture?: DepthTexture;
    /** MSAA sample count. Default: 1. */
    samples?: number;
    /** Number of color attachments (MRT). Default: 1. */
    count?: number;
};
```

#### `RenderTarget`

```ts
/**
 * A render target is a buffer where the video card draws pixels for a scene
 * that is being rendered in the background. It is used in different effects,
 * such as applying postprocessing to a rendered image before displaying it
 * on the screen.
 */
export class RenderTarget {
    /** The width of the render target */
    width: number;
    /** The height of the render target */
    height: number;
    /** The MSAA sample count of the render target */
    readonly samples: number;
    /**
     * Array of color attachment textures.
     * Each has its own mutable `.format` (per-attachment formats supported by mutating `textures[i].format`).
     * Each has a `.name` for MRT mapping; the first texture is also accessible via the `texture` getter.
     */
    textures: Texture[];
    /** Depth texture, or null if no depth */
    depthTexture: DepthTexture | null;
    /** Constructs a new render target */
    constructor(width: number, height: number, opts?: RenderTargetOptions);
    /** The first color attachment texture, or undefined when count=0 (depth-only target). */
    get texture(): Texture | undefined;
    /** Sets the size of the render target, disposes existing GPU resources; renderer will reallocate on next use */
    setSize(width: number, height: number): void;
    /**
     * Dispose of the render target's GPU resources.
     * This triggers the _onDispose callbacks set by the renderer cache.
     */
    dispose(): void;
    /** Returns the texture index for the given name, or -1 if not found. */
    getTextureIndex(name: string): number;
}
```

## Scene & objects

The scene graph, cameras, and the objects you put in it.

#### `Scene`

```ts
export class Scene extends Object3D {
    constructor();
}
```

#### `Object3D`

```ts
export class Object3D {
    readonly objectId: number;
    name: string;
    visible: boolean;
    renderOrder: number;
    position: Vec3;
    quaternion: Quat;
    scale: Vec3;
    parent: Object3D | null;
    children: Object3D[];
    matrix: import("mathcat").Mat4;
    matrixWorld: import("mathcat").Mat4;
    normalMatrix: import("mathcat").Mat3;
    matrixVersion: number;
    add(child: Object3D): this;
    remove(child: Object3D): this;
    removeFromParent(): this;
    lookAt(target: Vec3, up?: Vec3): void;
    updateWorldMatrix(): void;
    traverse(callback: (object: Object3D) => void): void;
    getWorldPosition(out: Vec3): Vec3;
    getWorldQuaternion(out: Quat): Quat;
    getWorldDirection(out: Vec3): Vec3;
    /**
     * Abstract method for raycasting. Override in subclasses (e.g., Mesh) to
     * implement intersection testing. Base implementation does nothing.
     *
     * @param _raycaster - The Raycaster instance
     * @param _intersects - Array to push intersection results into
     */
    raycast(_raycaster: any, _intersects: any[]): void;
}
```

#### `Camera`

```ts
export class Camera extends Object3D {
    near: number;
    far: number;
    projectionMatrix: import("mathcat").Mat4;
    matrixWorldInverse: import("mathcat").Mat4;
    constructor();
    /** recompute the matrixWorldInverse from the current matrixWorld. */
    updateViewMatrix(): void;
}
```

#### `unproject`

```ts
/**
 * Unproject a point from NDC (normalized device coordinates) to world space.
 * NDC: x,y in [-1, 1], z in [0, 1] where 0 is near plane, 1 is far plane (WebGPU convention).
 */
export function unproject(out: Vec3, ndc: Vec3, camera: Camera): Vec3;
```

#### `PerspectiveCamera`

```ts
export class PerspectiveCamera extends Camera {
    fov: number;
    aspect: number;
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    /** Recompute the projection matrix from current fov / aspect / near / far. */
    updateProjectionMatrix(): void;
}
```

#### `OrthographicCamera`

```ts
/**
 * Camera that uses orthographic projection.
 *
 * In this projection mode, an object's size in the rendered image stays constant
 * regardless of its distance from the camera. Useful for 2D scenes, UI, and
 * post-processing passes.
 *
 * Uses WebGPU depth range (0→1) via orthoZO, matching PerspectiveCamera's perspectiveZO.
 *
 * ```ts
 * const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
 * ```
 */
export class OrthographicCamera extends Camera {
    left: number;
    right: number;
    top: number;
    bottom: number;
    zoom: number;
    view: ViewOffset | null;
    /**
     * @param left   - Left plane of the frustum.
     * @param right  - Right plane of the frustum.
     * @param top    - Top plane of the frustum.
     * @param bottom - Bottom plane of the frustum.
     * @param near   - Near plane. Unlike perspective cameras, 0 is valid here.
     * @param far    - Far plane.
     */
    constructor(left?: number, right?: number, top?: number, bottom?: number, near?: number, far?: number);
    /**
     * Sets an offset into a larger frustum for multi-window / multi-monitor setups.
     *
     * @param fullWidth  - Full width of the multiview setup.
     * @param fullHeight - Full height of the multiview setup.
     * @param x          - Horizontal offset of the subcamera.
     * @param y          - Vertical offset of the subcamera.
     * @param width      - Width of the subcamera.
     * @param height     - Height of the subcamera.
     */
    setViewOffset(fullWidth: number, fullHeight: number, x: number, y: number, width: number, height: number): void;
    /** Removes any view offset and recomputes the projection matrix. */
    clearViewOffset(): void;
    /** Recompute the projection matrix from current frustum planes, zoom, and view offset. */
    updateProjectionMatrix(): void;
}
```

#### `Mesh`

```ts
export class Mesh extends Object3D {
    geometry: Geometry;
    material: Material;
    count: number;
    frustumCulled: boolean;
    constructor(geometry: Geometry, material: Material);
    raycast(raycaster: Raycaster, intersects: Intersection[]): void;
}
```

#### `LineGeometry`

```ts
/**
 * Screen-space expanded line geometry.
 *
 * Allocates GPU buffers once at construction for up to `maxPoints` points.
 * Subsequent calls to `update()` write into the existing buffers and adjust
 * `drawRange.count`, no reallocation unless the point array exceeds `maxPoints`.
 *
 * Vertex buffers (per-vertex, 4 verts per segment):
 *   'instanceStart'  vec3f  - world-space segment start
 *   'instanceEnd'    vec3f  - world-space segment end
 *   'side'           f32    - +1 / -1 expansion side
 *   'uv'             vec2f  - u along segment, v across width
 *
 * Pair with a `LineMaterial`.
 *
 * @param points    Initial flat [x,y,z,...] point list. At least 2 points required.
 * @param closed    Connect last point back to first. Default false.
 * @param maxPoints Maximum points this geometry will ever hold. Defaults to the
 *                  initial point count. Pass a larger value to avoid reallocation
 *                  when calling update() with more points later.
 */
export class LineGeometry extends Geometry {
    constructor(points: Float32Array | number[], closed?: boolean, maxPoints?: number);
    /** Number of segments currently drawn. */
    get segmentCount(): number;
    /**
     * Update the line's point data in-place.
     *
     * If the new point count fits within the pre-allocated capacity, this only
     * writes into existing typed arrays and adjusts `drawRange.count`, no GPU
     * buffer reallocation occurs. If the new count exceeds capacity, buffers are
     * reallocated to the new size (capacity grows, never shrinks).
     *
     * @param points  New flat [x,y,z,...] array. At least 2 points.
     * @param closed  Whether the line is closed. Defaults to the value set at construction.
     */
    update(points: Float32Array | number[], closed?: boolean): void;
    /**
     * Compute cumulative arc-length distances along the polyline and store them
     * as 'instanceDistanceStart' / 'instanceDistanceEnd' vertex buffers.
     *
     * Each segment vertex carries the cumulative distance at its start and end
     * endpoint in world units. Used by dash shaders.
     *
     * Call after construction or after update(). Returns `this` for chaining.
     */
    computeLineDistances(): this;
}
```

#### `LineSegmentsGeometry`

```ts
/**
 * Geometry for rendering independent line segments from disjoint point pairs.
 *
 * Points are consumed as pairs: [p0,p1, p2,p3, ...]. Each pair is one segment.
 * An odd trailing point is ignored. There is no concept of "closed".
 *
 * Allocates GPU buffers once at construction for up to `maxPoints` points.
 * Subsequent calls to `update()` write into the existing buffers and adjust
 * `drawRange.count`, no reallocation unless the point array exceeds `maxPoints`.
 *
 * Pair with a `LineMaterial`.
 *
 * @param points    Initial flat [x,y,z,...] point list. At least 2 points (one pair).
 * @param maxPoints Maximum points this geometry will ever hold. Defaults to the
 *                  initial point count. Pass a larger value to avoid reallocation.
 */
export class LineSegmentsGeometry extends Geometry {
    constructor(points: Float32Array | number[], maxPoints?: number);
    /** Number of segments currently drawn. */
    get segmentCount(): number;
    /**
     * Update the segment data in-place.
     *
     * If the new point count fits within the pre-allocated capacity, this only
     * writes into existing typed arrays and adjusts `drawRange.count`, no GPU
     * buffer reallocation occurs. If the new count exceeds capacity, buffers are
     * reallocated to the new size (capacity grows, never shrinks).
     *
     * @param points  New flat [x,y,z,...] array. At least 2 points.
     */
    update(points: Float32Array | number[]): void;
    /**
     * Compute per-segment distances and store as 'instanceDistanceStart' /
     * 'instanceDistanceEnd' vertex buffers.
     *
     * For disjoint pairs each segment is independent: distanceStart = 0,
     * distanceEnd = length(end - start). Used by dash shaders.
     *
     * Call after construction or after update(). Returns `this` for chaining.
     */
    computeLineDistances(): this;
}
```

#### `LineMaterialOptions`

```ts
export type LineMaterialOptions = {
    /** RGBA color node. Defaults to opaque white. */
    color?: Node<d.vec4f>;
    /** Line width in pixels (or world units if worldUnits=true). Default 2. */
    lineWidth?: number;
    /** When true lineWidth is in world units, not pixels. Default false. */
    worldUnits?: boolean;
    /** Enable alpha blending. Default false. */
    transparent?: boolean;
    /** Custom blend state. Only used when transparent=true. */
    blend?: GPUBlendState;
};
```

#### `LineMaterial`

```ts
/**
 * Material for rendering screen-space expanded lines.
 *
 * Pair with a `LineGeometry`.
 *
 * @example
 * const geom = new LineGeometry([0,0,0, 1,0,0, 1,1,0]);
 * const mat  = new LineMaterial({ color: vec4f(1, 0.3, 0, 1), lineWidth: 3 });
 * scene.add(new Mesh(geom, mat));
 */
export class LineMaterial extends Material {
    private lineWidthUniform;
    readonly worldUnits: boolean;
    constructor(opts?: LineMaterialOptions);
    /** Line width in pixels (or world units if the material was created with worldUnits=true). */
    get lineWidth(): number;
    set lineWidth(px: number);
}
```

#### `LineSegments`

```ts
/**
 * Scene object for rendering independent line segment pairs with `LineSegmentsGeometry` and `LineMaterial`.
 */
export class LineSegments extends Mesh {
    /**
     * Extra pick radius added to `material.lineWidth` for raycasting, in the same
     * units as the material (pixels for screen-space, world units for world-units mode).
     */
    threshold: number;
    constructor(geometry: LineSegmentsGeometry, material: LineMaterial);
    raycast(raycaster: Raycaster, intersects: Intersection[]): void;
}
```

#### `Line`

```ts
/**
 * Scene object for rendering a continuous polyline with `LineGeometry` and `LineMaterial`.
 */
export class Line extends Mesh {
    /**
     * Extra pick radius added to `material.lineWidth` for raycasting, in the same
     * units as the material (pixels for screen-space, world units for world-units mode).
     */
    threshold: number;
    constructor(geometry: LineGeometry, material: LineMaterial);
    raycast(raycaster: Raycaster, intersects: Intersection[]): void;
}
```

#### `DrawRange`

```ts
/**
 * Subset of geometry to draw.
 * - `start` maps to `firstVertex` (non-indexed) or `firstIndex` (indexed).
 * - `count` is the number of vertices/indices to draw. `Infinity` means the full buffer.
 */
export type DrawRange = {
    start: number;
    count: number;
};
```

#### `Geometry`

```ts
export class Geometry {
    /** Buffers mapped by name. Can be vertex attributes, storage buffers, or any buffer type. @see setBuffer() @see removeBuffer() */
    buffers: Map<string, GpuBuffer<Any>>;
    /** Optional index buffer. Must have 'index' usage. @see setIndex(). */
    index: GpuBuffer<Any> | undefined;
    /**
     * Range of vertices/indices to draw.
     * `start` maps to `firstVertex` (non-indexed) or `firstIndex` (indexed).
     * `count` is the number of vertices/indices. Defaults to `Infinity` (full buffer).
     */
    drawRange: DrawRange;
    /** Geometry ersion counter. Auto-incremented when buffers are added/removed */
    version: number;
    /**
     * Optional indirect draw buffer. When set, the renderer calls
     * drawIndirect / drawIndexedIndirect using this buffer instead of
     * draw / drawIndexed. `mesh.count` is ignored when this is set.
     * Must have 'indirect' usage.
     * @see setIndirect
     */
    indirect: GpuBuffer<Any> | undefined;
    /**
     * Byte offset into the indirect buffer where draw parameters begin.
     * Useful when non-indirect data precedes the DrawIndirect/DrawIndexedIndirect structs.
     * Defaults to 0.
     */
    indirectOffset: number;
    /**
     * Number of indirect draws to issue from `indirect`. Defaults to `undefined`,
     * meaning "use the full buffer" (`indirect.count`). Set this when the buffer
     * is pre-sized to a capacity and only a prefix of entries are active,
     * avoids padding unused slots with zero-instance entries.
     *
     * When stable WebGPU multi-draw lands, this is the natural place to map to
     * the native `drawCount` parameter, same semantics, same field.
     */
    indirectDrawCount: number | undefined;
    /**
     * Axis-aligned bounding box in local space.
     * Set by createBoxGeometry / createSphereGeometry / createPlaneGeometry.
     * You may set this manually for custom geometry to enable frustum culling.
     */
    boundingBox: Box3 | undefined;
    /**
     * Bounding sphere in local space.
     * Set by createBoxGeometry / createSphereGeometry / createPlaneGeometry.
     * You may set this manually for custom geometry to enable frustum culling.
     */
    boundingSphere: Sphere | undefined;
    /**
     * Set to true after dispose() is called.
     * The renderer checks this flag to skip rendering and clean up GPU resources.
     */
    disposed: boolean;
    /**
     * Get a named buffer with optional type narrowing.
     */
    getBuffer<T extends Any = Any>(name: string): GpuBuffer<T> | undefined;
    /**
     * Set a named buffer.
     * Works for vertex attributes, storage buffers, or any buffer type.
     * Automatically bumps version when a new buffer name is added.
     * For REF_COUNTED buffers, increments usage count.
     *
     * @example Vertex attribute
     * geometry.setBuffer('position', new GpuBuffer(d.vec3f, { data: positions, usage: 'vertex' }));
     *
     * @example Storage buffer
     * geometry.setBuffer('particles', new GpuBuffer(d.array(Particle), { data: new Float32Array(1000 * stride), usage: 'storage' }));
     */
    setBuffer(name: string, buffer: GpuBuffer<Any>): this;
    /**
     * Remove a buffer by name.
     * Automatically bumps version when a buffer is removed.
     * For REF_COUNTED buffers, decrements usage count.
     */
    removeBuffer(name: string): this;
    /**
     * Set the indirect draw buffer.
     * For REF_COUNTED buffers, manages usage count properly.
     * @param buffer The indirect buffer, or undefined to clear.
     * @param offset Byte offset into the buffer where draw parameters begin.
     */
    setIndirect(buffer: GpuBuffer<Any> | undefined, offset?: number): this;
    /**
     * Set the index buffer.
     * For REF_COUNTED buffers, manages usage count properly.
     * @param buffer The index buffer, or undefined to clear. Must have 'index' usage.
     */
    setIndex(buffer: GpuBuffer<Any> | undefined): this;
    /**
     * Frees GPU-related resources allocated for this geometry.
     * For REF_COUNTED buffers, decrements usage count (may trigger buffer disposal).
     * Call this method when the geometry is no longer used.
     */
    dispose(): void;
}
```

#### `createBoxGeometry`

```ts
export function createBoxGeometry(width?: number, height?: number, depth?: number): Geometry;
```

#### `createSphereGeometry`

```ts
export function createSphereGeometry(radius?: number, widthSegments?: number, heightSegments?: number): Geometry;
```

#### `createPlaneGeometry`

```ts
/**
 * Creates a plane geometry in the XY plane (facing +Z).
 *
 * Vertices span [-width/2, width/2] in X and [-height/2, height/2] in Y, at z=0.
 * Normals point +Z. Triangles wound CCW when viewed from +Z.
 *
 * @param width - Total width along X. Defaults to 1.
 * @param height - Total height along Y. Defaults to 1.
 * @param widthSegments - Subdivisions along X. Defaults to 1.
 * @param heightSegments - Subdivisions along Y. Defaults to 1.
 */
export function createPlaneGeometry(width?: number, height?: number, widthSegments?: number, heightSegments?: number): Geometry;
```

#### `createFullscreenTriangleGeometry`

```ts
/**
 * Creates a fullscreen triangle geometry for post-processing passes.
 *
 * Uses an oversized triangle technique for efficiency (3 vertices instead of 6).
 * The triangle covers clip space from (-1,-1) to (3,-1) to (-1,3), ensuring
 * full viewport coverage after clipping.
 *
 * UV coordinates follow WebGPU conventions:
 *   - (0, 0) at top-left of texture
 *   - (1, 1) at bottom-right of texture
 *
 * Since clip space Y=-1 is bottom and Y=+1 is top, but texture V=0 is top and V=1 is bottom,
 * we map: bottom-left clip (-1,-1) → UV (0,1), top-left clip (-1,3) → UV (0,-1).
 *
 * @param flipY - Whether to flip UV coordinates along the vertical axis. Defaults to false.
 */
export function createFullscreenTriangleGeometry(flipY?: boolean): Geometry;
```

#### `createCylinderGeometry`

```ts
/**
 * Creates a cylinder geometry along the Y axis, centered at the origin.
 * When radiusTop is 0, produces a cone. Includes top and bottom caps.
 *
 * @param radiusTop - Radius at y = +height/2. 0 for a cone.
 * @param radiusBottom - Radius at y = -height/2.
 * @param height - Total height along Y.
 * @param radialSegments - Number of segments around the circumference.
 */
export function createCylinderGeometry(radiusTop?: number, radiusBottom?: number, height?: number, radialSegments?: number): Geometry;
```

#### `createTorusGeometry`

```ts
/**
 * Creates a torus geometry in the XZ plane.
 *
 * @param radius - Distance from center of torus to center of tube.
 * @param tube - Radius of the tube.
 * @param radialSegments - Segments around the tube cross-section.
 * @param tubularSegments - Segments around the torus ring.
 * @param arc - Central angle of the torus in radians. Defaults to full circle.
 */
export function createTorusGeometry(radius?: number, tube?: number, radialSegments?: number, tubularSegments?: number, arc?: number): Geometry;
```

#### `createOctahedronGeometry`

```ts
/**
 * Creates an octahedron geometry (dual of cube).
 * At detail=0: 6 vertices, 8 triangular faces.
 * Higher detail subdivides each face recursively.
 *
 * @param radius - Circumscribed sphere radius.
 * @param detail - Subdivision level. 0 = base octahedron.
 */
export function createOctahedronGeometry(radius?: number, detail?: number): Geometry;
```

## GPU resources

Declarative, data-oriented resources: buffers, uniforms, materials, and textures.

#### `BufferLifecycle`

```ts
/** determines how a buffer's lifecycle is managed */
export enum BufferLifecycle {
    /** Usages are tracked, GPU resources are disposed when usage count hits 0 */
    REF_COUNTED = 0,
    /** User is responsible for calling buffer.dispose() */
    MANUAL = 1
}
```

#### `GpuTypedArray`

```ts
export type GpuTypedArray = Float32Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array;
```

#### `UpdateRange`

```ts
export type UpdateRange = {
    start: number;
    count: number;
};
```

#### `deriveVertexFormat`

```ts
/** Derive GPUVertexFormat from typed array type and itemSize */
export function deriveVertexFormat(array: GpuTypedArray, itemSize: number): GPUVertexFormat | undefined;
```

#### `BufferUsage`

```ts
/**
 * Allowed usages for a GpuBuffer. Multiple usages can be combined.
 */
export type BufferUsage = 'vertex' | 'index' | 'storage' | 'uniform' | 'indirect';
```

#### `IndexFormat`

```ts
/**
 * Index buffer format - only uint16 or uint32 are valid.
 */
export type IndexFormat = 'uint16' | 'uint32';
```

#### `getIndexFormat`

```ts
/**
 * Get the index format for a buffer's array.
 * Returns undefined if the array is null or not an index buffer array type.
 */
export function getIndexFormat(array: GpuTypedArray | null): IndexFormat | undefined;
```

#### `GpuBufferOptions`

```ts
/**
 * Options for creating a GpuBuffer.
 * Provide either `data` (existing TypedArray) or `count` (allocate new array), not both.
 */
export type GpuBufferOptions<T extends Any = Any> = {
    /** Initial data as a TypedArray. Mutually exclusive with `count`. */
    data?: TypedArrayFor<T>;
    /** Number of elements to allocate (creates array of `count * itemSize`). Mutually exclusive with `data`. */
    count?: number;
    /** Allowed usages for this buffer. Defaults to ['vertex']. */
    usage?: BufferUsage | BufferUsage[];
    /** How this buffer's lifecycle is managed. Defaults to MANUAL. */
    lifecycle?: BufferLifecycle;
};
```

#### `GpuBuffer`

```ts
/**
 * Unified buffer class for vertex attributes, storage buffers, index buffers, etc.
 *
 * Replaces BufferAttribute, StorageBufferAttribute, InstancedBufferAttribute,
 * StorageInstancedBufferAttribute, and IndirectStorageBufferAttribute.
 *
 * @example Vertex buffer
 * const positions = new GpuBuffer(d.vec3f, { data: positionArray, usage: 'vertex' });
 *
 * @example Storage buffer
 * const particles = new GpuBuffer(d.array(Particle), { data: new Float32Array(1000 * stride), usage: 'storage' });
 *
 * @example Dual-use buffer (storage + vertex, instanced)
 * const transforms = new GpuBuffer(d.mat4x4f, {
 *     data: new Float32Array(1000 * 16),
 *     usage: ['storage', 'vertex'],
 *     instanced: true,
 * });
 */
export class GpuBuffer<T extends Any = Any> {
    /** Type descriptor (d.vec3f, d.array(Particle), etc.) */
    readonly schema: T;
    /** Allowed usages */
    readonly usage: Set<BufferUsage>;
    /** How this buffer's lifecycle is managed */
    readonly lifecycle: BufferLifecycle;
    /** CPU-side typed array. Can be set to null after onUpload releases memory. */
    array: TypedArrayFor<T> | null;
    /** Number of elements */
    readonly count: number;
    /** Components per element (e.g., 3 for vec3f) */
    readonly itemSize: number;
    /** Version for dirty tracking. Incremented when needsUpdate is set. */
    version: number;
    /** Pending partial-upload ranges (flat component indices). */
    readonly updateRanges: UpdateRange[];
    /** Callback after GPU upload (e.g., release CPU memory via `this.array = null`). */
    onUpload: (() => void) | null;
    /** The GPUVertexFormat for vertex buffers (e.g., 'float32x3'). Derived or explicit. */
    readonly format: GPUVertexFormat | undefined;
    /** Set to true after dispose() is called. */
    disposed: boolean;
    constructor(schema: T, options?: GpuBufferOptions<T>);
    /** Mark buffer as needing re-upload */
    set needsUpdate(_: true);
    /** Register a dirty range for partial re-upload */
    addUpdateRange(start: number, count: number): void;
    /** Clear pending update ranges (called by renderer after upload) */
    clearUpdateRanges(): void;
    /**
     * Increment usage count.
     * For REF_COUNTED buffers: tracks usage and can "revive" a disposed buffer.
     * For MANUAL buffers: no-op (lifecycle is user-managed).
     * @returns this for chaining
     */
    increaseUsages(): this;
    /**
     * Decrement usage count.
     * For REF_COUNTED buffers: decrements count and disposes GPU resources when it hits 0.
     * For MANUAL buffers: no-op (lifecycle is user-managed).
     */
    decreaseUsages(): void;
    /**
     * Dispose of this buffer's resources.
     * For MANUAL buffers: destroys GPU buffer and cleans up CPU-side data.
     * For REF_COUNTED buffers: throws error (use decreaseUsages() instead).
     */
    dispose(): void;
}
```

#### `createVertexBuffer`

```ts
/**
 * Create a vertex buffer with sensible defaults.
 * - usage: 'vertex'
 * - lifecycle: REF_COUNTED (vertex buffers are typically owned by a Geometry)
 *
 * @example
 * const positions = createVertexBuffer(d.vec3f, new Float32Array([...]));
 */
export function createVertexBuffer<T extends Any>(schema: T, data: TypedArrayFor<T>): GpuBuffer<T>;
```

#### `createStorageBuffer`

```ts
/**
 * Create a storage buffer with sensible defaults.
 * - usage: 'storage'
 * - lifecycle: MANUAL (storage buffers are often managed directly by user code)
 *
 * @example
 * const particles = createStorageBuffer(d.array(Particle, 1000), new Float32Array(1000 * particleStride));
 */
export function createStorageBuffer<T extends Any>(schema: T, data: TypedArrayFor<T>): GpuBuffer<T>;
```

#### `createUniformBuffer`

```ts
/**
 * Create a uniform buffer with sensible defaults.
 * - usage: 'uniform'
 * - lifecycle: REF_COUNTED
 *
 * @example
 * const uniforms = createUniformBuffer(MyUniforms, new Float32Array([...]));
 */
export function createUniformBuffer<T extends Any>(schema: T, data: TypedArrayFor<T>): GpuBuffer<T>;
```

#### `createIndirectBuffer`

```ts
/**
 * Create an indirect draw buffer with sensible defaults.
 * - usage: ['storage', 'indirect'] (can be written by compute, read by draw)
 * - lifecycle: REF_COUNTED
 *
 * @example
 * const indirectBuffer = createIndirectBuffer(DrawIndirectArgs, new Uint32Array([vertexCount, instanceCount, firstVertex, firstInstance]));
 */
export function createIndirectBuffer<T extends Any>(schema: T, data: TypedArrayFor<T>): GpuBuffer<T>;
```

#### `createIndexBuffer`

```ts
/**
 * Create an index buffer with sensible defaults.
 * - usage: 'index'
 * - lifecycle: REF_COUNTED (index buffers are typically owned by a Geometry)
 *
 * @example
 * const indices = createIndexBuffer(new Uint16Array([0, 1, 2, 2, 3, 0]));
 */
export function createIndexBuffer(data: Uint16Array | Uint32Array): GpuBuffer<Any>;
```

#### `UniformValue`

```ts
export type UniformValue<T extends Any = Any> = Any extends T ? number | number[] | Float32Array | Int32Array | Uint32Array : Infer<T> | number[] | TypedArrayFor<T>;
```

#### `UniformUpdateType`

```ts
/**
 * Update frequency for uniform groups.
 */
export const UniformUpdateType: {
    readonly NONE: "none";
    readonly FRAME: "frame";
    readonly RENDER: "render";
    readonly OBJECT: "object";
};
export type UniformUpdateType = (typeof UniformUpdateType)[keyof typeof UniformUpdateType];
```

#### `UniformGroup`

```ts
/**
 * Uniform group, determines WGSL @group index and struct packing.
 */
export class UniformGroup {
    readonly name: string;
    readonly shared: boolean;
    readonly order: number;
    readonly updateType: UniformUpdateType;
    constructor(name: string, shared: boolean, order: number, updateType?: UniformUpdateType);
}
```

#### `uniformGroup`

```ts
/** Create a per-object (non-shared) uniform group. */
export const uniformGroup: (name: string, order?: number, updateType?: UniformUpdateType) => UniformGroup;
```

#### `sharedUniformGroup`

```ts
/** Create a shared uniform group. */
export const sharedUniformGroup: (name: string, order?: number, updateType?: UniformUpdateType) => UniformGroup;
```

#### `frameGroup`

```ts
/**
 * frameGroup, shared uniforms updated once per frame.
 * Maps to @group(0) with FRAME update type.
 */
export const frameGroup: UniformGroup;
```

#### `renderGroup`

```ts
/**
 * renderGroup, shared uniforms updated per render() call.
 * Contains camera uniforms (projection, view, position, near, far).
 * Maps to @group(0) with RENDER update type.
 */
export const renderGroup: UniformGroup;
```

#### `objectGroup`

```ts
/**
 * objectGroup, per-object uniforms updated per draw call.
 * Contains mesh matrices (modelWorldMatrix, modelNormalMatrix) and user material uniforms.
 * Maps to @group(1) with OBJECT update type.
 */
export const objectGroup: UniformGroup;
```

#### `Uniform`

```ts
/**
 * Core uniform data container.
 *
 * Owns the CPU-side value, version for dirty tracking, and group assignment.
 * Referenced by UniformNode in the DSL layer.
 *
 * @example
 * const roughness = new Uniform(d.f32, 0.5);
 * roughness.set(0.8);
 *
 * @example
 * const color = new Uniform(d.vec3f, [1, 0, 0]);
 * color.set([0, 1, 0]);
 *
 * @example With explicit group
 * const time = new Uniform(d.f32, 0, frameGroup);
 */
export class Uniform<T extends Any = Any> {
    readonly schema: T;
    /** Determines @group index, update cadence, and packing. Mutable, but only
     *  read at compile time, set it before the owning node is first rendered. */
    group: UniformGroup;
    value: UniformValue<T> | null;
    constructor(schema: T, initialValue?: UniformValue<T>, group?: UniformGroup);
}
```

#### `MaterialOptions`

```ts
export interface MaterialOptions {
    /** Material name, for debugging. */
    name?: string;
    /**
     * vec4f clip-space position graph.
     * Use `positionClip` for standard MVP transform.
     */
    vertex: Node<Any>;
    /**
     * Fragment output. Can be:
     * - A vec4f node for single color output
     * - An OutputStructNode/MRTNode for multiple render targets
     * - Omitted/null for depth-only rendering (e.g. shadow passes)
     */
    fragment?: Node<Any>;
    /**
     * An optional `f32` override for the fragment depth written to the depth buffer.
     * When set, the compiler emits `@builtin(frag_depth)` on the fragment
     * output and assigns this value.
     */
    depth?: Node<Any>;
    /** Controls draw sort order (opaque vs transparent) AND the default for depthWrite. */
    transparent?: boolean;
    /** Optional blend state. Only meaningful when transparent=true or custom blending. */
    blend?: GPUBlendState;
    /** Whether depth testing is active. When false, depthCompare is forced to 'always'. */
    depthTest?: boolean;
    /** Whether to write to the depth buffer. Default: true for opaque, false for transparent. */
    depthWrite?: boolean;
    /** Depth comparison function. Default 'less'. Forced to 'always' when depthTest=false. */
    depthCompare?: GPUCompareFunction;
    /** Back-face culling mode. Default 'back'. */
    cullMode?: GPUCullMode;
    /** Alpha-to-coverage. Meaningful only when renderer.samples > 1. Default false. */
    alphaToCoverage?: boolean;
    /** Constant depth bias in depth buffer precision steps. Default 0. */
    depthBias?: number;
    /** Depth bias scaled by the fragment's slope (dz/dx, dz/dy). Default 0. */
    depthBiasSlopeScale?: number;
    /** Maximum absolute depth bias value. Default 0 (no clamp). */
    depthBiasClamp?: number;
}
```

#### `Material`

```ts
export class Material {
    /** Material name, for debugging. */
    name: string;
    /** Vertex node. Use `positionClip` for standard MVP transform. */
    vertex: Node<Any>;
    /** Fragment output. Can be vec4f, OutputStructNode for MRT, or undefined for depth-only. */
    fragment: Node<Any> | undefined;
    /** f32 depth override, written to @builtin(frag_depth) */
    depth: Node<Any> | undefined;
    /** Controls draw sort order (opaque vs transparent) AND the default for depthWrite. */
    transparent: boolean;
    /** Optional blend state. Only meaningful when transparent=true or custom blending. */
    blend?: GPUBlendState;
    /** Whether depth testing is active. When false, depthCompare is forced to 'always'. */
    depthTest: boolean;
    /** Whether to write to the depth buffer. Default: true for opaque, false for transparent. */
    depthWrite: boolean;
    /** Depth comparison function. Default 'less'. Forced to 'always' when depthTest=false. */
    depthCompare: GPUCompareFunction;
    /** Back-face culling mode. Default 'back'. */
    cullMode: GPUCullMode;
    /** Alpha-to-coverage. Meaningful only when renderer.samples > 1. Default false. */
    alphaToCoverage: boolean;
    /** Constant depth bias in depth buffer precision steps. Default 0. */
    depthBias: number;
    /** Depth bias scaled by the fragment's slope (dz/dx, dz/dy). Default 0. */
    depthBiasSlopeScale: number;
    /** Maximum absolute depth bias value. Default 0 (no clamp). */
    depthBiasClamp: number;
    /**
     * Named uniforms for this material.
     * Used for name-based uniform resolution: uniform('roughness', d.f32) resolves
     * to material.uniforms.get('roughness') at render time.
     */
    uniforms: Map<string, Uniform<any>>;
    constructor(opts: MaterialOptions);
    /**
     * Incremented whenever the material's node graph configuration changes in a
     * way that requires a shader recompile.  The renderer includes this in the
     * RenderObject cache key so that bumping it triggers recompilation on the
     * next frame.
     */
    version: number;
    /**
     * Setting needsUpdate = true increments version, which causes the renderer
     * to recompile the material's shader on the next frame.
     */
    set needsUpdate(value: boolean);
    /**
     * Set to true after dispose() is called.
     * The renderer checks this flag to skip rendering and clean up GPU resources.
     */
    disposed: boolean;
    /**
     * Frees GPU-related resources allocated for this material.
     * Call this method when the material is no longer used.
     */
    dispose(): void;
}
```

#### `WrapMode`

```ts
/** Wrap modes matching WebGPU GPUAddressMode */
export type WrapMode = 'clamp-to-edge' | 'repeat' | 'mirror-repeat';
```

#### `FilterMode`

```ts
/** Filter modes matching WebGPU GPUFilterMode */
export type FilterMode = 'nearest' | 'linear';
```

#### `MipmapFilterMode`

```ts
/** Mipmap filter modes matching WebGPU GPUMipmapFilterMode */
export type MipmapFilterMode = 'nearest' | 'linear';
```

#### `TextureOptions`

```ts
export type TextureOptions = {
    wrapS?: GPUAddressMode;
    wrapT?: GPUAddressMode;
    magFilter?: GPUFilterMode;
    minFilter?: GPUFilterMode;
    mipmapFilter?: GPUMipmapFilterMode;
    anisotropy?: number;
    format?: GPUTextureFormat;
    generateMipmaps?: boolean;
    flipY?: boolean;
    premultiplyAlpha?: boolean;
};
```

#### `Texture`

```ts
/**
 * High-level 2D texture class.
 *
 * Holds sampling parameters and references a Source for image data.
 */
export class Texture<out T extends SourceData = SourceData> {
    /** Type flag for runtime type checking */
    readonly isTexture = true;
    /** Optional name for debugging */
    name: string;
    /**
     * User-provided mipmaps as Sources. If empty, mipmaps are auto-generated
     * when `generateMipmaps` is true.
     */
    mipmaps: Source[];
    /**
     * Callback fired when the texture is updated.
     */
    onUpdate: ((texture: Texture<SourceData>) => void) | null;
    /**
     * Whether this texture belongs to a render target.
     * Set to true by RenderTarget when creating its textures.
     * @default false
     */
    isRenderTargetTexture: boolean;
    /**
     * Constructs a new Texture.
     *
     * @param image - The image source (ImageBitmap, HTMLImageElement, Source, etc.)
     * @param options - Texture options
     */
    constructor(image: T | Source<T> | null, options?: TextureOptions);
    /** Unique numeric ID */
    get id(): number;
    /** Returns the width of the source, or 1 if no data. */
    get width(): number;
    /** Returns the height of the source, or 1 if no data. */
    get height(): number;
    /** The data source for this texture. */
    get source(): Source<T> | null;
    set source(s: Source<T> | null);
    /** Convenience getter for the source data. */
    get image(): T | null;
    /** Convenience setter for the source data. */
    set image(value: T | null);
    /** Horizontal wrap mode (U direction). */
    get wrapS(): WrapMode;
    set wrapS(v: WrapMode);
    /** Vertical wrap mode (V direction). */
    get wrapT(): WrapMode;
    set wrapT(v: WrapMode);
    /** Magnification filter. */
    get magFilter(): FilterMode;
    set magFilter(v: FilterMode);
    /** Minification filter. */
    get minFilter(): FilterMode;
    set minFilter(v: FilterMode);
    /** Mipmap filter mode. */
    get mipmapFilter(): MipmapFilterMode;
    set mipmapFilter(v: MipmapFilterMode);
    /** Anisotropic filtering level. */
    get anisotropy(): number;
    set anisotropy(v: number);
    /** WebGPU texture format. */
    get format(): GPUTextureFormat;
    set format(v: GPUTextureFormat);
    /** Whether to auto-generate mipmaps. */
    get generateMipmaps(): boolean;
    set generateMipmaps(v: boolean);
    /** Whether to flip the image vertically when uploading. */
    get flipY(): boolean;
    set flipY(v: boolean);
    /** Whether to premultiply alpha. */
    get premultiplyAlpha(): boolean;
    set premultiplyAlpha(v: boolean);
    /** Version for dirty tracking. */
    get version(): number;
    /** Set to `true` to trigger a GPU upload on the next render. */
    set needsUpdate(value: boolean);
    /**
     * Creates a clone of this texture.
     * Note: The clone shares the same Source by default.
     */
    clone(): Texture<T>;
    /**
     * Disposes of the texture and its GPU resources.
     */
    dispose(): void;
}
```

#### `ImageSize`

```ts
export type ImageSize = {
    width: number;
    height: number;
    depth?: number;
};
```

#### `DataTextureImage`

```ts
/** Data texture image format - raw typed array with dimensions */
export type DataTextureImage = {
    data: Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array | Float32Array | null;
    width: number;
    height: number;
    depth?: number;
};
```

#### `SourceData`

```ts
export type SourceData = ImageBitmap | HTMLImageElement | HTMLCanvasElement | HTMLVideoElement | OffscreenCanvas | VideoFrame | ImageData | ImageSize | DataTextureImage | null;
```

#### `Source`

```ts
/**
 * Represents the data source of a texture.
 *
 * The main purpose of this class is to decouple the data definition from the texture
 * definition so the same data can be used with multiple texture instances.
 */
export class Source<out T = SourceData> {
    /** unique numeric ID */
    readonly id: number;
    /** the data definition of a texture, can be an ImageBitmap, HTMLImageElement, canvas, video, or null */
    data: T;
    /** when set to `false`, the engine performs memory allocation but does not transfer data to GPU memory, useful for deferred loading */
    dataReady: boolean;
    /** version number, incremented when `needsUpdate` is set to true, used for dirty checking by the renderer */
    version: number;
    /**
     * Constructs a new Source
     * @param data the data definition (ImageBitmap, HTMLImageElement, etc.)
     */
    constructor(data: T);
    /** when set to `true`, increments the version counter to trigger a GPU upload on the next render */
    set needsUpdate(value: boolean);
    /** returns the width of the source data, or 0 if no data */
    get width(): number;
    /** returns the height of the source data, or 0 if no data */
    get height(): number;
    /** returns the depth of the source data (for 3D textures), or 0 */
    get depth(): number;
}
```

#### `CanvasTexture`

```ts
/**
 * A texture created from a canvas element.
 * Convenience subclass that sets appropriate defaults.
 */
export class CanvasTexture extends Texture<HTMLCanvasElement | OffscreenCanvas> {
    readonly isCanvasTexture = true;
    constructor(canvas: HTMLCanvasElement | OffscreenCanvas);
}
```

#### `CubeTextureMapping`

```ts
/**
 * Cube texture mapping modes.
 * Determines which vector to use for cube texture sampling.
 */
export type CubeTextureMapping = 'reflection' | 'refraction';
```

#### `CubeTextureOptions`

```ts
export type CubeTextureOptions = {
    wrapS?: GPUAddressMode;
    wrapT?: GPUAddressMode;
    magFilter?: GPUFilterMode;
    minFilter?: GPUFilterMode;
    mipmapFilter?: GPUMipmapFilterMode;
    format?: GPUTextureFormat;
    generateMipmaps?: boolean;
    flipY?: boolean;
    mapping?: CubeTextureMapping;
};
```

#### `CubeTexture`

```ts
/**
 * A texture for cubemaps (environment maps, skyboxes, etc).
 *
 * Stores 6 faces: +X, -X, +Y, -Y, +Z, -Z.
 * Sampled using a 3D direction vector.
 */
export class CubeTexture {
    /** Type flag for runtime checking */
    readonly isCubeTexture = true;
    /** Optional name for debugging */
    name: string;
    /**
     * Mapping mode - determines default UV vector.
     * - 'reflection': uses reflect(viewDir, normal)
     * - 'refraction': uses refract(viewDir, normal, ior)
     */
    mapping: CubeTextureMapping;
    /**
     * Constructs a new CubeTexture.
     *
     * @param faces - Array of 6 images for cube faces (+X, -X, +Y, -Y, +Z, -Z)
     * @param options - Texture options
     */
    constructor(faces?: [SourceData, SourceData, SourceData, SourceData, SourceData, SourceData] | SourceData[], options?: CubeTextureOptions);
    get id(): number;
    get width(): number;
    get height(): number;
    get size(): number;
    /** Check if all 6 faces are present and ready */
    get isComplete(): boolean;
    /** The 6 face images as SourceData */
    get images(): SourceData[];
    set images(value: SourceData[]);
    /** The 6 face Sources */
    get imageSources(): Source[];
    get wrapS(): GPUAddressMode;
    set wrapS(v: GPUAddressMode);
    get wrapT(): GPUAddressMode;
    set wrapT(v: GPUAddressMode);
    get magFilter(): GPUFilterMode;
    set magFilter(v: GPUFilterMode);
    get minFilter(): GPUFilterMode;
    set minFilter(v: GPUFilterMode);
    get mipmapFilter(): GPUMipmapFilterMode;
    set mipmapFilter(v: GPUMipmapFilterMode);
    get anisotropy(): number;
    set anisotropy(v: number);
    get format(): GPUTextureFormat;
    set format(v: GPUTextureFormat);
    get generateMipmaps(): boolean;
    set generateMipmaps(v: boolean);
    get flipY(): boolean;
    set flipY(v: boolean);
    get premultiplyAlpha(): boolean;
    set premultiplyAlpha(v: boolean);
    get version(): number;
    set needsUpdate(v: boolean);
    clone(): CubeTexture;
    dispose(): void;
}
```

#### `DepthTextureFormat`

```ts
export type DepthTextureFormat = 'depth16unorm' | 'depth24plus' | 'depth24plus-stencil8' | 'depth32float' | 'depth32float-stencil8';
```

#### `DepthTexture`

```ts
/**
 * A texture for storing depth information.
 * Used as the depth attachment in RenderTarget, or for shadow mapping.
 *
 * Defaults to comparison sampler for shadow mapping convenience.
 */
export class DepthTexture {
    /** Optional name for debugging */
    name: string;
    /**
     * Constructs a new DepthTexture.
     *
     * @param width - The width of the texture
     * @param height - The height of the texture
     * @param format - The depth format (default: 'depth24plus')
     */
    constructor(width: number, height: number, format?: DepthTextureFormat);
    get id(): number;
    get width(): number;
    get height(): number;
    get format(): DepthTextureFormat;
    get compareFunction(): GPUCompareFunction | undefined;
    set compareFunction(v: GPUCompareFunction | undefined);
    /** Version for dirty tracking. */
    get version(): number;
    /** Mark as needing re-upload. */
    set needsUpdate(v: boolean);
    /** Set the size of the depth texture. */
    setSize(width: number, height: number): void;
    clone(): DepthTexture;
    dispose(): void;
}
```

#### `ArrayTextureImage`

```ts
/** Data format for array textures - typed array with width, height, and layer count */
export type ArrayTextureImage = DataTextureImage & {
    depth: number;
};
```

#### `ArrayTexture`

```ts
/**
 * A 2D texture array - multiple 2D textures stacked as layers.
 *
 * Each layer has the same dimensions. Sampled using vec2 UV + layer index.
 * Useful for: sprite atlases, terrain splatting, shadow map arrays.
 */
export class ArrayTexture {
    /** Type flag for runtime checking */
    readonly isArrayTexture = true;
    /** Optional name for debugging */
    name: string;
    /**
     * Constructs a new ArrayTexture.
     *
     * @param data - Optional raw data for all layers
     * @param width - Width of each layer
     * @param height - Height of each layer
     * @param depth - Number of layers
     * @param options - Texture options
     */
    constructor(data?: DataTextureImage['data'], width?: number, height?: number, depth?: number, options?: TextureOptions);
    /** Unique numeric ID */
    get id(): number;
    /** Returns the width of each layer. */
    get width(): number;
    /** Returns the height of each layer. */
    get height(): number;
    /** Depth (number of layers) of the texture array */
    get depth(): number;
    /** The data source for this texture. */
    get source(): Source<ArrayTextureImage> | null;
    /** Convenience getter for the source data. */
    get image(): ArrayTextureImage | null;
    /** Horizontal wrap mode (U direction). */
    get wrapS(): WrapMode;
    set wrapS(v: WrapMode);
    /** Vertical wrap mode (V direction). */
    get wrapT(): WrapMode;
    set wrapT(v: WrapMode);
    /** Magnification filter. */
    get magFilter(): FilterMode;
    set magFilter(v: FilterMode);
    /** Minification filter. */
    get minFilter(): FilterMode;
    set minFilter(v: FilterMode);
    /** Mipmap filter mode. */
    get mipmapFilter(): MipmapFilterMode;
    set mipmapFilter(v: MipmapFilterMode);
    /** Anisotropic filtering level. */
    get anisotropy(): number;
    set anisotropy(v: number);
    /** WebGPU texture format. */
    get format(): GPUTextureFormat;
    set format(v: GPUTextureFormat);
    /** Whether to auto-generate mipmaps. */
    get generateMipmaps(): boolean;
    set generateMipmaps(v: boolean);
    /** Whether to flip the image vertically when uploading. */
    get flipY(): boolean;
    set flipY(v: boolean);
    /** Whether to premultiply alpha. */
    get premultiplyAlpha(): boolean;
    set premultiplyAlpha(v: boolean);
    /** Version for dirty tracking. */
    get version(): number;
    /** Set to `true` to trigger a GPU upload on the next render. */
    set needsUpdate(value: boolean);
    /** Track which layers have been modified (forwards to GpuTexture). */
    get layerUpdates(): Set<number>;
    /** Mark a specific layer as needing update. On next upload, only this layer will be transferred. */
    addLayerUpdate(layerIndex: number): void;
    /** Clear the layer update tracking, called by the renderer after upload. */
    clearLayerUpdates(): void;
    /** Creates a clone of this texture. */
    clone(): ArrayTexture;
    /** Disposes of the texture and its GPU resources. */
    dispose(): void;
}
```

## Compilation

Turn a node graph into WGSL.

#### `compile`

```ts
export function compile(slots: CompileSlots): CompileResult;
```

#### `compileCompute`

```ts
export function compileCompute(node: ComputeNode): ComputeCompileResult;
```

#### `NodeUpdateType`

```ts
export type NodeUpdateType = 'none' | 'frame' | 'render' | 'object';
```

#### `UpdateBeforeNode`

```ts
export type UpdateBeforeNode = {
    readonly id: number;
    readonly updateBeforeType: NodeUpdateType;
    updateBefore(frame: NodeFrame): boolean | void;
};
```

#### `UpdateAfterNode`

```ts
export type UpdateAfterNode = {
    readonly id: number;
    readonly updateAfterType: NodeUpdateType;
    updateAfter(frame: NodeFrame): boolean | void;
};
```

#### `UpdateNode`

```ts
export type UpdateNode = {
    readonly id: number;
    readonly updateType: NodeUpdateType;
    update(frame: NodeFrame): boolean | void;
};
```

#### `AttributeEntry`

```ts
export type AttributeEntry = {
    kind: 'geometry' | 'buffer';
    /** For geometry: the geometry buffer name. For buffer: null (direct reference). */
    name: string | null;
    /** WGSL struct member name (e.g. '_position_0', '_buf_1'). */
    shaderName: string;
    type: string;
    location: number;
    node: AttributeNode<d.Any>;
    stride: number;
    offset: number;
    instanced: boolean;
};
```

#### `VertexBufferGroup`

```ts
/**
 * VertexBufferGroup, groups attributes that share the same underlying buffer.
 *
 * For interleaved vertex data, multiple attributes may reference the same buffer
 * with different offsets. Grouping them enables:
 * - One GPUVertexBufferLayout with multiple attributes
 * - One setVertexBuffer() call per unique buffer
 *
 * This follows WebGPU's design where VertexBufferLayout.attributes is an array.
 */
export type VertexBufferGroup = {
    /** For geometry-based: the buffer name. For direct buffer: null. */
    name: string | null;
    /** For direct buffer: the GpuBuffer. For geometry-based: null (resolved at render time). */
    buffer: GpuBuffer<d.Any> | null;
    /** Shared stride (must match across grouped attributes). */
    stride: number;
    /** Whether these are per-instance attributes. */
    instanced: boolean;
    /** The attributes in this group (for building GPUVertexBufferLayout.attributes). */
    attributes: {
        type: string;
        offset: number;
        shaderLocation: number;
    }[];
};
```

#### `VaryingEntry`

```ts
export type VaryingEntry = {
    name: string;
    type: string;
    location: number;
    interpolationType: InterpolationType | null;
    interpolationSampling: InterpolationSampling | null;
};
```

#### `UniformMember`

```ts
export type UniformMember = {
    uniformId: string;
    schema: d.Any;
    offset: number;
    size: number;
    node: UniformNode<d.Any>;
};
```

#### `UniformGroupBlock`

```ts
export type UniformGroupBlock = {
    groupName: string;
    groupIndex: number;
    binding: number;
    shared: boolean;
    members: UniformMember[];
    totalBytes: number;
    groupNode: UniformGroup;
};
```

#### `StorageEntry`

```ts
export type StorageEntry = {
    node: StorageNode<d.Any>;
    name: string;
    type: string;
    access: 'read' | 'read_write';
    group: number;
    binding: number;
};
```

#### `TextureEntry`

```ts
export type TextureEntry = {
    textureId: string;
    type: string;
    group: number;
    binding: number;
    node: TextureBindingNode;
};
```

#### `SamplerEntry`

```ts
export type SamplerEntry = {
    samplerId: string;
    type: 'sampler' | 'sampler_comparison';
    group: number;
    binding: number;
    samplerNode: SamplerNode<d.sampler | d.samplerComparison>;
};
```

#### `ComputeStorageEntry`

```ts
export type ComputeStorageEntry = {
    node: StorageNode<d.Any>;
    name: string;
    type: string;
    access: 'read' | 'read_write';
    group: number;
    binding: number;
};
```

#### `NodeGraphInfo`

```ts
export type NodeGraphInfo = {
    stages: ReadonlyArray<'vertex' | 'fragment' | 'compute'>;
    cseVar: string | undefined;
    usageCount: number;
    expression: string | undefined;
};
```

#### `CompileSlots`

```ts
export type CompileSlots = {
    vertex: Node<d.Any>;
    fragment?: Node<d.Any>;
    depth?: Node<d.Any>;
};
```

#### `CompileResult`

```ts
export type CompileResult = {
    code: string;
    vertexEntryPoint: string;
    fragmentEntryPoint: string | null;
    attributes: AttributeEntry[];
    vertexBufferGroups: VertexBufferGroup[];
    varyings: VaryingEntry[];
    uniformGroups: UniformGroupBlock[];
    storage: StorageEntry[];
    textures: TextureEntry[];
    samplers: SamplerEntry[];
    builtinsUsed: Set<string>;
    updateBeforeNodes: UpdateBeforeNode[];
    updateAfterNodes: UpdateAfterNode[];
    updateNodes: UpdateNode[];
    graphNodes: ReadonlyMap<number, Node<d.Any>>;
    graphEdges: ReadonlyMap<number, readonly number[]>;
    graphInfo: ReadonlyMap<number, NodeGraphInfo>;
};
```

#### `ComputeCompileResult`

```ts
export type ComputeCompileResult = {
    code: string;
    storage: ComputeStorageEntry[];
    workgroupSize: [number, number, number];
    builtinsUsed: Set<string>;
    uniformGroups: UniformGroupBlock[];
};
```

## Schema (`d`)

WGSL type descriptors (imported as `d`) and std430 buffer packing.

#### `AddressSpace`

```ts
export type AddressSpace = 'storage' | 'uniform';
```

#### `CompiledLayout`

```ts
export type CompiledLayout<T = unknown> = {
    /** Size of one element in bytes */
    totalSize: number;
    /** Stride for array elements (size with tail padding) */
    stride: number;
    /** Generated write function */
    write: (view: DataView, offset: number, value: T) => void;
    /** Generated read function */
    read: (view: DataView, offset: number) => T;
};
```

#### `pack`

```ts
/**
 * Pack a value into a new ArrayBuffer.
 *
 * @example
 * const buf = pack(Particle, { position: [1, 2, 3], health: 100 });
 * const f32 = new Float32Array(buf);
 */
export function pack<D extends Any>(schema: D, value: Infer<D>, addressSpace?: AddressSpace): ArrayBuffer;
```

#### `packArray`

```ts
/**
 * Pack an array of values into a new ArrayBuffer.
 *
 * @example
 * const buf = packArray(Particle, particles);
 * const f32 = new Float32Array(buf);
 */
export function packArray<D extends Any>(schema: D, items: Infer<D>[], addressSpace?: AddressSpace): ArrayBuffer;
```

#### `packTo`

```ts
/**
 * Pack a value into an existing buffer at a byte offset.
 *
 * @example
 * const buf = new ArrayBuffer(1024);
 * packTo(Particle, buf, 0, particle1);
 * packTo(Particle, buf, stride, particle2);
 */
export function packTo<D extends Any>(schema: D, dest: BufferSource, offset: number, value: Infer<D>, addressSpace?: AddressSpace): void;
```

#### `unpack`

```ts
/**
 * Unpack a value from a buffer.
 *
 * @example
 * const particle = unpack(Particle, buf);
 * const secondParticle = unpack(Particle, buf, stride);
 */
export function unpack<D extends Any>(schema: D, src: BufferSource, offset?: number, addressSpace?: AddressSpace): Infer<D>;
```

#### `unpackArray`

```ts
/**
 * Unpack an array of values from a buffer.
 *
 * @example
 * const particles = unpackArray(Particle, buf, 100);
 */
export function unpackArray<D extends Any>(schema: D, src: BufferSource, count: number, offset?: number, addressSpace?: AddressSpace): Infer<D>[];
```

#### `layoutSizeOf`

```ts
/**
 * Get the byte size of a schema.
 *
 * @example
 * const size = layoutSizeOf(Particle); // 32
 */
export function layoutSizeOf(schema: Any, addressSpace?: AddressSpace): number;
```

#### `layoutStrideOf`

```ts
/**
 * Get the stride (size with tail padding) for array elements.
 *
 * @example
 * const stride = layoutStrideOf(Particle); // 32
 */
export function layoutStrideOf(schema: Any, addressSpace?: AddressSpace): number;
```

#### `getCompiledLayout`

```ts
/**
 * Get the compiled layout for a schema (for advanced use cases).
 */
export function getCompiledLayout<D extends Any>(schema: D, addressSpace?: AddressSpace): CompiledLayout<Infer<D>>;
```

#### `packToView`

```ts
/** Pack a value into a DataView. */
export function packToView<D extends Any>(schema: D, view: DataView, offset: number, value: Infer<D>, addressSpace?: AddressSpace): void;
```

#### `unpackFromView`

```ts
/** Unpack a value from a DataView. */
export function unpackFromView<D extends Any>(schema: D, view: DataView, offset: number, addressSpace?: AddressSpace): Infer<D>;
```

## Controls & debugging

#### `MOUSE`

```ts
export const MOUSE: {
    readonly ROTATE: 0;
    readonly DOLLY: 1;
    readonly PAN: 2;
};
```

#### `MouseAction`

```ts
export type MouseAction = (typeof MOUSE)[keyof typeof MOUSE];
```

#### `TOUCH`

```ts
export const TOUCH: {
    readonly ROTATE: 0;
    readonly PAN: 1;
    readonly DOLLY_PAN: 2;
    readonly DOLLY_ROTATE: 3;
};
```

#### `TouchAction`

```ts
export type TouchAction = (typeof TOUCH)[keyof typeof TOUCH];
```

#### `OrbitControlsEventType`

```ts
export type OrbitControlsEventType = 'change' | 'start' | 'end';
```

#### `OrbitControlsEvent`

```ts
export interface OrbitControlsEvent {
    type: OrbitControlsEventType;
    target: OrbitControls;
}
```

#### `OrbitControlsEventListener`

```ts
export type OrbitControlsEventListener = (event: OrbitControlsEvent) => void;
```

#### `OrbitControls`

```ts
/**
 * OrbitControls
 *
 * Orbit: left mouse / one-finger touch.
 * Zoom:  middle mouse / wheel / two-finger pinch.
 * Pan:   right mouse / left mouse + ctrl|meta|shift / two-finger drag / arrow keys.
 *
 * Call `update()` each frame when `enableDamping` or `autoRotate` are `true`.
 */
export class OrbitControls {
    /** The camera being controlled. */
    readonly object: Camera;
    /** The DOM element used for event listeners. */
    domElement: HTMLElement | null;
    /** Whether the controls are active. */
    enabled: boolean;
    /** The point the camera orbits around. */
    target: Vec3;
    /**
     * The focus point of the `minTargetRadius` / `maxTargetRadius` limits.
     */
    cursor: Vec3;
    minDistance: number;
    maxDistance: number;
    minZoom: number;
    maxZoom: number;
    minTargetRadius: number;
    maxTargetRadius: number;
    /** Minimum polar angle (radians), default 0. */
    minPolarAngle: number;
    /** Maximum polar angle (radians), default Math.PI. */
    maxPolarAngle: number;
    minAzimuthAngle: number;
    maxAzimuthAngle: number;
    enableDamping: boolean;
    dampingFactor: number;
    enableZoom: boolean;
    zoomSpeed: number;
    zoomToCursor: boolean;
    enableRotate: boolean;
    rotateSpeed: number;
    keyRotateSpeed: number;
    enablePan: boolean;
    panSpeed: number;
    /** When true the camera pans in screen space; otherwise in world-up plane. */
    screenSpacePanning: boolean;
    keyPanSpeed: number;
    autoRotate: boolean;
    /** 2.0 ≈ 30 s per orbit at 60 fps */
    autoRotateSpeed: number;
    keys: {
        LEFT: string;
        UP: string;
        RIGHT: string;
        BOTTOM: string;
    };
    mouseButtons: {
        LEFT: MouseAction;
        MIDDLE: MouseAction;
        RIGHT: MouseAction;
    };
    touches: {
        ONE: TouchAction;
        TWO: TouchAction;
    };
    target0: Vec3;
    position0: Vec3;
    zoom0: number;
    state: StateValue;
    constructor(object: Camera, domElement?: HTMLElement | null);
    addEventListener(type: OrbitControlsEventType, listener: OrbitControlsEventListener): void;
    removeEventListener(type: OrbitControlsEventType, listener: OrbitControlsEventListener): void;
    dispatchEvent(type: OrbitControlsEventType): void;
    get cursorStyle(): 'auto' | 'grab';
    set cursorStyle(type: 'auto' | 'grab');
    connect(element: HTMLElement): void;
    disconnect(): void;
    dispose(): void;
    getPolarAngle(): number;
    getAzimuthalAngle(): number;
    getDistance(): number;
    listenToKeyEvents(domElement: EventTarget): void;
    stopListenToKeyEvents(): void;
    saveState(): void;
    reset(): void;
    pan(deltaX: number, deltaY: number): void;
    dollyIn(dollyScale: number): void;
    dollyOut(dollyScale: number): void;
    rotateLeft(angle: number): void;
    rotateUp(angle: number): void;
    update(deltaTime?: number | null): boolean;
}
```

#### `FlyControls`

```ts
/**
 * FlyControls, WASD + right-click look camera controller.
 *
 * Movement: W/S forward/back, A/D strafe left/right, Space up, Shift down.
 * Look: Right-click + drag to yaw/pitch.
 * Speed: Scroll wheel adjusts movementSpeed.
 *
 * Call `update(delta)` each frame where delta is seconds since last frame.
 */
export class FlyControls {
    readonly object: Camera;
    domElement: HTMLElement | null;
    enabled: boolean;
    /** Movement speed in world units per second. */
    movementSpeed: number;
    /** Look sensitivity in radians per pixel. */
    lookSpeed: number;
    /** Scroll wheel speed multiplier factor. Each tick multiplies/divides movementSpeed by this. */
    speedScrollFactor: number;
    /** Minimum movementSpeed (clamped on scroll). */
    minSpeed: number;
    /** Maximum movementSpeed (clamped on scroll). */
    maxSpeed: number;
    onChange: Topic<[]>;
    constructor(object: Camera, domElement?: HTMLElement | null);
    connect(element: HTMLElement): void;
    disconnect(): void;
    dispose(): void;
    /**
     * Update camera position and orientation.
     * @param delta - Time elapsed since last frame in seconds.
     */
    update(delta: number): void;
}
```

#### `TransformMode`

```ts
export type TransformMode = 'translate' | 'rotate' | 'scale';
```

#### `TransformSpace`

```ts
export type TransformSpace = 'world' | 'local';
```

#### `TransformControls`

```ts
export class TransformControls {
    camera: Camera;
    domElement: HTMLElement | null;
    object: Object3D | undefined;
    enabled: boolean;
    mode: TransformMode;
    space: TransformSpace;
    axis: string | null;
    dragging: boolean;
    size: number;
    showX: boolean;
    showY: boolean;
    showZ: boolean;
    translationSnap: number | null;
    rotationSnap: number | null;
    scaleSnap: number | null;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
    worldPosition: Vec3;
    worldPositionStart: Vec3;
    worldQuaternion: Quat;
    worldQuaternionStart: Quat;
    cameraPosition: Vec3;
    cameraQuaternion: Quat;
    pointStart: Vec3;
    pointEnd: Vec3;
    rotationAxis: Vec3;
    rotationAngle: number;
    eye: Vec3;
    onChange: Topic<[]>;
    onMouseDown: Topic<[{
        mode: TransformMode;
    }]>;
    onMouseUp: Topic<[{
        mode: TransformMode;
    }]>;
    onObjectChange: Topic<[]>;
    constructor(camera: Camera, domElement?: HTMLElement);
    getHelper(): TransformControlsRoot;
    connect(element: HTMLElement): void;
    disconnect(): void;
    attach(object: Object3D): this;
    detach(): this;
    setMode(mode: TransformMode): void;
    setSpace(space: TransformSpace): void;
    setSize(size: number): void;
    setTranslationSnap(snap: number | null): void;
    setRotationSnap(snap: number | null): void;
    setScaleSnap(snap: number | null): void;
    getRaycaster(): Raycaster;
    getMode(): TransformMode;
    reset(): void;
    dispose(): void;
    pointerHover(pointer: {
        x: number;
        y: number;
        button: number;
    }): void;
    pointerDown(pointer: {
        x: number;
        y: number;
        button: number;
    }): void;
    pointerMove(pointer: {
        x: number;
        y: number;
        button: number;
    }): void;
    pointerUp(pointer: {
        x: number;
        y: number;
        button: number;
    }): void;
}
```

#### `Inspector`

```ts
export class Inspector extends RendererInspector {
    readonly profiler: Profiler;
    readonly performance: Performance;
    readonly performanceTimeline: PerformanceTimeline;
    readonly memory: Memory;
    readonly console: Console;
    readonly parameters: Parameters;
    readonly viewer: Viewer;
    readonly timeline: Timeline;
    readonly settings: Settings;
    readonly sceneHierarchy: SceneHierarchy;
    readonly drawCalls: DrawCalls;
    readonly computeCalls: ComputeCalls;
    constructor();
    get domElement(): HTMLElement;
    /**
     * Surface log messages in the Console tab AND devtools. Overrides the
     * no-op base. Callers route via `renderer.inspector?.log.warn('...')`.
     */
    readonly log: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
    };
    setRenderer(renderer: WebGPURenderer | null): void;
    /**
     * Release everything this Inspector owns: GPU resources (probe + timestamp
     * query state), DOM (panel + any detached tab windows), and window
     * listeners. Safe to call multiple times. After dispose the instance is
     * dead, discard it and `new Inspector()` if you need one again.
     *
     * Normally called automatically via `renderer.setInspector(null)`; expose
     * directly for callers that want explicit teardown.
     */
    dispose(): void;
    begin(frameId: number): void;
    beginRender(passId: string, frameId: number): void;
    finishRender(passId: string, frameId: number): void;
    beginCompute(node: ComputeNode, frameId: number): void;
    finishCompute(nodeId: string, frameId: number): void;
    setPipeline(label: string): void;
    setBindGroup(index: number, label: string): void;
    setVertexBuffer(slot: number): void;
    setIndexBuffer(): void;
    draw(vertexCount: number, instanceCount: number): void;
    drawIndexed(indexCount: number, instanceCount: number): void;
    drawIndirect(): void;
    drawIndexedIndirect(): void;
    dispatchWorkgroups(x: number, y: number, z: number): void;
    dispatchWorkgroupsIndirect(_buffer: GPUBuffer, offset: number): void;
    finish(frameId: number): void;
    createParameters(name: string): GUI;
    /**
     * Set the active probe to the given variable expression in the given mesh's
     * compiled WGSL.  Builds a new probe pipeline (patched WGSL + same bind
     * group layouts), creates a 140×140 CanvasTarget, and wires it to render
     * every frame in _processFrame.
     *
     * Returns the probe canvas element so the caller can display it, or null
     * if patching / pipeline creation fails.
     */
    setProbe(target: ProbeTarget, sourceRO: RenderObject): HTMLCanvasElement | null;
    /** Remove the active probe. */
    clearProbe(): void;
    navigateToRO(ro: RenderObject): void;
    /**
     * Build canvasData for each inspectable node and call viewer.update().
     */
    resolveViewer(nodes: InspectorNode<Any>[]): void;
    /**
     * Get or create the CanvasData for an inspectable node.
     * Creates a 140×140 CanvasTarget, wraps the node as vec4(vec3(node), 1),
     * and builds a fullscreen Material. Cached per node, never recreated.
     */
    getCanvasDataByNode(node: InspectorNode<Any>): CanvasData;
}
```

## Math & utils

#### `Frustum`

```ts
export type Frustum = [Plane3, Plane3, Plane3, Plane3, Plane3, Plane3];
```

#### `create`

```ts
export function create(): Frustum;
```

#### `clone`

```ts
export function clone(f: Frustum): Frustum;
```

#### `copy`

```ts
export function copy(out: Frustum, f: Frustum): Frustum;
```

#### `setFromViewProjectionMatrix`

```ts
export function setFromViewProjectionMatrix(out: Frustum, proj: Mat4, view: Mat4): Frustum;
```

#### `intersectsSphere`

```ts
export function intersectsSphere(f: Frustum, s: Sphere): boolean;
```

#### `intersectsBox3`

```ts
export function intersectsBox3(f: Frustum, box: Box3): boolean;
```

#### `Ray`

```ts
export type Ray = {
    origin: Vec3;
    direction: Vec3;
};
```

#### `rayTriangleIntersection`

```ts
/**
 * Möller-Trumbore ray-triangle intersection.
 * Returns raw t (distance along ray direction) or null if no hit.
 */
export function rayTriangleIntersection(origin: Vec3, direction: Vec3, a: Vec3, b: Vec3, c: Vec3, backfaceCulling: boolean): number | null;
```

#### `rayIntersectsBox3`

```ts
/**
 * Slab-based ray-AABB intersection test.
 * Tests intersection within [0, maxT] along the ray.
 */
export function rayIntersectsBox3(origin: Vec3, direction: Vec3, aabb: Box3, maxT: number): boolean;
```

#### `Intersection`

```ts
export type Intersection = {
    distance: number;
    point: Vec3;
    object: Object3D;
    faceIndex?: number;
    face?: {
        a: number;
        b: number;
        c: number;
        normal: Vec3;
    };
    uv?: [number, number];
    normal?: Vec3;
};
```

#### `Raycaster`

```ts
export class Raycaster {
    ray: Ray;
    near: number;
    far: number;
    camera: Camera | null;
    constructor(origin?: Vec3, direction?: Vec3, near?: number, far?: number);
    set(origin: Vec3, direction: Vec3): void;
    setFromCamera(coords: [number, number], camera: Camera): void;
    intersectObject(object: Object3D, recursive?: boolean, intersects?: Intersection[]): Intersection[];
    intersectObjects(objects: Object3D[], recursive?: boolean, intersects?: Intersection[]): Intersection[];
}
```

#### `transformRayToLocalSpace`

```ts
/**
 * Transform a ray into the local space of an object.
 * Returns the local ray for intersection testing.
 */
export function transformRayToLocalSpace(raycaster: Raycaster, matrixWorld: Mat4): Ray;
```

#### `checkTriangleIntersection`

```ts
/**
 * Test ray-triangle intersection and add to intersects if hit.
 * Positions are in local space, ray should be in local space.
 */
export function checkTriangleIntersection(object: Object3D, raycaster: Raycaster, localRay: Ray, matrixWorld: Mat4, a: number, b: number, c: number, positions: Float32Array, indices: Uint16Array | Uint32Array | null, uvs: Float32Array | null, intersects: Intersection[], faceIndex: number): void;
```


