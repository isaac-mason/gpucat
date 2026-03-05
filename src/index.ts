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
    InstancedBufferAttributeNode,
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
} from './nodes/nodes.js';

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
    meshModelMatrix,
    meshNormalMatrix,
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
} from './nodes/nodes.js';

// Color
export { Color, type ColorInput } from './utils/color.js';

// Frustum culling
export { Frustum } from './utils/frustum.js';

// Collect
export { getChildren, depsOf, collectGraph, mergeGraphs } from './nodes/collect.js';

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
} from './nodes/compile.js';

// ---------------------------------------------------------------------------
// Layer 2 — Scene
// ---------------------------------------------------------------------------

export { Object3D } from './scene/object3d.js';

export { Scene } from './scene/scene.js';

export { Camera, PerspectiveCamera } from './scene/camera.js';

export {
    Geometry,
    BufferAttribute,
    IndexAttribute,
    StorageBufferAttribute,
    createBoxGeometry,
    createSphereGeometry,
    createPlaneGeometry,
} from './scene/geometry.js';

export {
    IndirectStorageBufferAttribute,
} from './scene/indirect-storage-buffer-attribute.js';

export {
    Material,
    type MaterialOptions,
} from './scene/material.js';

export { Mesh } from './scene/mesh.js';

// ---------------------------------------------------------------------------
// Layer 3 — Renderer
// ---------------------------------------------------------------------------

export { BufferCache } from './renderer/buffers.js';
export { PipelineCache, makePipelineKey, type PipelineEntry } from './renderer/pipeline.js';
export {
    buildFrameBindGroup,
    buildMeshBindGroup,
    packMaterialUBO,
} from './renderer/bindgroups.js';
export { collectDraws, type DrawCall } from './renderer/collect.js';
export { WebGPURenderer, type WebGPURendererOptions } from './renderer/renderer.js';
export { RenderTarget, type RenderTargetOptions } from './renderer/render-target.js';
export { pass, PassNode, type PassNodeOptions, collectPassNodes } from './nodes/pass-node.js';

// ---------------------------------------------------------------------------
// Compute — ComputeNode, compile-compute, compute-pipeline
// ---------------------------------------------------------------------------

export {
    ComputeNode,
    compute,
    type ComputeNodeOptions,
    type ComputeOpts,
} from './nodes/nodes.js';

export {
    compileCompute,
    type ComputeCompileResult,
    type ComputeStorageEntry,
} from './nodes/compile.js';

export {
    ComputePipelineCache,
    type ComputePipelineEntry,
} from './renderer/compute-pipeline.js';
