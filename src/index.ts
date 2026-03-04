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
    bvec2,
    bvec3,
    bvec4,
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
} from './nodes/nodes.js';

// Schema — WgslDesc constructors and defineStruct
export {
    type WgslDesc,
    type ArrayDesc,
    type StructDef,
    type StructInstance,
    isArrayDesc,
    array,
    itemSizeOf,
    typedArrayCtorOf,
    defineStruct,
} from './nodes/schema.js';
export * as S from './nodes/schema.js';

// Std nodes — builtin helpers + default position graph
export {
    CameraStruct,
    type CameraInstance,
    camera,
    TimeStruct,
    type TimeInstance,
    time,
    MeshStruct,
    type MeshInstance,
    mesh,
    instanceIndex,
    positionClip,
} from './nodes/std-nodes.js';

// Color
export { Color, type ColorInput } from './utils/color.js';

// Collect
export { depsOf, collectGraph, mergeGraphs, topoSort, refCount } from './nodes/collect.js';

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
    box,
    sphere,
    plane,
} from './scene/geometry.js';

export {
    Material,
    UniformsMap,
    type UniformValue,
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
export { RenderPipeline } from './renderer/render-pipeline.js';
export { pass, PassNode, collectPassNodes } from './nodes/pass-node.js';
