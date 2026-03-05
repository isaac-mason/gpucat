/**
 * index.ts — Public API re-exports for gpucat.
 *
 * Layer 1 — Node graph
 */

// Node types + DSL constructors
export {
    // Type vocab
    type ScalarType,
    type Vec2Type,
    type Vec3Type,
    type Vec4Type,
    type VecType,
    type MatType,
    type NumericType,
    type SamplerType,
    type TextureType,
    type WgslType,
    type GpuTypedArray,
    type NodeKind,
    type BuiltinKind,
    type BinopOp,
    type StructMember,
    type UpdateRange,
    // Node classes
    Node,
    ConstNode,
    UniformNode,
    AttributeNode,
    BufferAttributeNode,
    StorageNode,
    TextureNode,
    VaryingNode,
    BinopNode,
    CallNode,
    RawNode,
    AssignNode,
    ConstructNode,
    StructNode,
    FieldNode,
    IndexNode,
    BuiltinNode,
    StackNode,
    CondNode,
    VarNode,
    IfNode,
    ForNode,
    type ForRange,
    WhileNode,
    BreakNode,
    ContinueNode,
    FnNode,
    ParamNode,
    ReturnNode,
    // wgslFn — raw WGSL function support
    WgslFnNode,
    wgslFn,
    type WgslFnParam,
    // MRT (Multiple Render Targets)
    OutputStructNode,
    MRTNode,
    mrt,
    // DSL constructors
    attribute,
    bufferAttribute,
    instancedBufferAttribute,
    uniform,
    storage,
    storageArray,
    texture,
    varying,
    raw,
    builtin,
    index,
    add,
    sub,
    mul,
    div,
    vec2,
    vec3,
    vec4,
    ivec2,
    ivec3,
    ivec4,
    uvec2,
    uvec3,
    uvec4,
    mat4,
    f32,
    i32,
    u32,
    bool,
    vec2f,
    vec3f,
    vec4f,
    vec2i,
    vec3i,
    vec4i,
    vec2u,
    vec3u,
    vec4u,
    vec2b,
    vec3b,
    vec4b,
    color,
    // control flow
    Var,
    If,
    For,
    While,
    Break,
    Continue,
    Return,
    Fn,
    // Math functions
    dot,
    cross,
    normalize,
    length,
    abs,
    floor,
    ceil,
    fract,
    sqrt,
    sin,
    cos,
    pow,
    max,
    min,
    clamp,
    mix,
    step,
    smoothstep,
} from './nodes/nodes';

// Schema — WgslDesc constructors and struct()
export {
    type WgslDesc,
    type ArrayDesc,
    type StructDef,
    type StructInstance,
    isArrayDesc,
    array,
    itemSizeOf,
    typedArrayCtorOf,
    struct,
} from './nodes/nodes';
export * as d from './nodes/schema';

/* builtins */
export {
    modelWorldMatrix,
    modelNormalMatrix,
    instanceIndex,
    positionClip,
    globalId,
    localId,
    localIndex,
    workgroupId,
    numWorkgroups,
    cameraProjectionMatrix,
    cameraViewMatrix,
    cameraPosition,
    cameraNear,
    cameraFar,
    timeElapsed,
    timeDelta,
} from './nodes/nodes';

// export {
//     UniformGroupNode,
//     uniformGroup,
//     sharedUniformGroup,
//     frameGroup,
//     renderGroup,
//     objectGroup,
//     NodeUpdateType,
//     type NodeUpdateTypeValue,
// } from './nodes/nodes';

export { Color, type ColorInput } from './utils/color';

export { Frustum } from './utils/frustum';

// export { getChildren, collectGraph, mergeGraphs } from './nodes/collect';

// Compile
// export {
//     compile,
//     type CompileSlots,
//     type CompileResult,
//     type AttributeEntry,
//     type VaryingEntry,
//     type UniformMember,
//     type UniformBlockEntry,
//     type StorageEntry,
//     type TextureEntry,
//     type SamplerEntry,
//     type UpdateBeforeNode,
//     type UpdateAfterNode,
//     type UpdateNode,
// } from './nodes/compile';

// ---------------------------------------------------------------------------
// Layer 2 — Scene
// ---------------------------------------------------------------------------

export { Object3D } from './scene/object3d';

export { Scene } from './scene/scene';

export { Camera, PerspectiveCamera } from './scene/camera';

export {
    Geometry,
    BufferAttribute,
    IndexAttribute,
    StorageBufferAttribute,
    InstancedBufferAttribute,
    StorageInstancedBufferAttribute,
    IndirectStorageBufferAttribute,
    createBoxGeometry,
    createSphereGeometry,
    createPlaneGeometry,
} from './scene/geometry';

export {
    Material,
    type MaterialOptions,
} from './scene/material';

export { Mesh } from './scene/mesh';

export {
    Texture,
    CanvasTexture,
    DataTexture,
    VideoTexture,
    type WrapMode,
    type FilterMode,
    type MipmapFilterMode,
    type TextureSource,
} from './scene/texture';

export { WebGPURenderer, type WebGPURendererOptions } from './renderer/renderer';
export { RenderTarget, RenderTargetTexture, type RenderTargetOptions } from './renderer/render-target';
export { pass, PassNode, type PassNodeOptions } from './nodes/pass-node';
export { renderOutput, type RenderOutputOptions, type ToneMappingMode, type OutputColorSpace } from './nodes/render-output';

// ---------------------------------------------------------------------------
// Compute — ComputeNode, compile-compute, compute-pipeline
// ---------------------------------------------------------------------------

export {
    ComputeNode,
    compute,
    type ComputeNodeOptions,
    type ComputeOpts,
} from './nodes/nodes';

export {
    compileCompute,
    type ComputeCompileResult,
    type ComputeStorageEntry,
} from './nodes/compile';

export {
    ComputePipelineCache,
    type ComputePipelineEntry,
} from './renderer/compute-pipeline';

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

export { InspectorBase } from './inspector/inspector-base';
export { RendererInspector, type FrameRecord, type PassRecord } from './inspector/renderer-inspector';
export { Inspector } from './inspector/inspector';
