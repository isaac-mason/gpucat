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
    SamplerNode,
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
    // DSL constructors
    konst,
    attribute,
    bufferAttribute,
    instancedBufferAttribute,
    uniform,
    storage,
    storageArray,
    texture,
    sampler,
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
    // Control-flow DSL
    toVar,
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
export * as S from './nodes/schema';

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

/* Uniform groups — Three.js-aligned (PR #33047) */
export {
    UniformGroupNode,
    uniformGroup,
    sharedUniformGroup,
    frameGroup,
    renderGroup,
    objectGroup,
    NodeUpdateType,
    type NodeUpdateTypeValue,
} from './nodes/nodes';

// Color
export { Color, type ColorInput } from './utils/color';

// Frustum culling
export { Frustum } from './utils/frustum';

// Collect
export { getChildren, collectGraph, mergeGraphs } from './nodes/collect';

// Compile
export {
    compile,
    type CompileSlots,
    type CompileResult,
    type AttributeEntry,
    type VaryingEntry,
    type UniformMember,
    type UniformBlockEntry,
    type StorageEntry,
    type TextureEntry,
    type SamplerEntry,
    type UpdateBeforeNode,
    type UpdateAfterNode,
    type UpdateNode,
} from './nodes/compile';

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

// ---------------------------------------------------------------------------
// Layer 3 — Renderer
// ---------------------------------------------------------------------------

export { BufferCache } from './renderer/buffers';
export { PipelineCache, makePipelineKey, type PipelineEntry } from './renderer/pipeline';
export {
    buildRenderGroupBindGroup,
    buildObjectGroupBindGroup,
} from './renderer/bindgroups';
export { collectDraws, type DrawCall } from './renderer/collect';
export { WebGPURenderer, type WebGPURendererOptions } from './renderer/renderer';
export { RenderTarget, type RenderTargetOptions } from './renderer/render-target';
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
