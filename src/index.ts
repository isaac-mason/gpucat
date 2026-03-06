/**
 * index.ts — Public API re-exports for gpucat.
 *
 * Layer 1 — Node graph
 */

// Node types + DSL constructors
export {
    abs, add, AssignNode,
    attribute, AttributeNode, BinopNode, bool, Break, BreakNode, bufferAttribute, BufferAttributeNode, builtin, BuiltinNode, CallNode, cameraFar, cameraNear, cameraPosition, cameraProjectionMatrix,
    cameraViewMatrix, ceil, clamp, color, CondNode, ConstNode, ConstructNode, Continue, ContinueNode, cos, cross, div,
    dot, f16, f32, FieldNode, floor, Fn, FnNode, For, ForNode, fract, globalId, i32, If, IfNode, index, IndexNode, instancedBufferAttribute, instanceIndex, length, localId,
    localIndex, mat4, max,
    min, mix, modelNormalMatrix, modelWorldMatrix, mrt, MRTNode, mul,
    Node, normalize, numWorkgroups, OutputStructNode, ParamNode, positionClip, pow, raw, RawNode, Return, ReturnNode, sin, smoothstep, sqrt, StackNode, step, storage,
    storageArray, StorageNode, struct, StructNode, sub, texture, TextureNode, timeDelta, timeElapsed, u32, uniform, UniformNode,
    Var, VarNode, varying, VaryingNode, vec2, vec2b, vec2f, vec2h, vec2i, vec2u, vec3, vec3b, vec3f, vec3h, vec3i, vec3u, vec4, vec4b, vec4f, vec4h, vec4i, vec4u, vertexIndex, wgslFn,
    WgslFnNode, While, WhileNode, workgroupId, type BinopOp, type BuiltinKind, type ForRange, type GpuTypedArray, type MatType, type NodeKind, type NumericType,
    type SamplerType,
    type ScalarType, type StructDef,
    type StructInstance, type StructMember, type TextureType, type UpdateRange, type Vec2Type,
    type Vec3Type,
    type Vec4Type,
    type VecType, type WgslFnParam, type WgslType
} from './nodes/nodes';
export * as d from './nodes/schema';
export type {
    ArrayDesc, WgslDesc
} from './nodes/schema';



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
    BufferAttribute, createBoxGeometry, createPlaneGeometry, createSphereGeometry, Geometry, IndexAttribute, IndirectStorageBufferAttribute, InstancedBufferAttribute, StorageBufferAttribute, StorageInstancedBufferAttribute
} from './scene/geometry';

export {
    Material,
    type MaterialOptions
} from './scene/material';

export { Mesh } from './scene/mesh';

export {
    CanvasTexture,
    DataTexture, Texture, VideoTexture, type FilterMode,
    type MipmapFilterMode,
    type TextureSource, type WrapMode
} from './scene/texture';

export { pass, PassNode, type PassNodeOptions } from './nodes/pass-node';
export { renderOutput, type OutputColorSpace, type RenderOutputOptions, type ToneMappingMode } from './nodes/render-output';
export { RenderTarget, RenderTargetTexture, type RenderTargetOptions } from './renderer/render-target';
export { WebGPURenderer, type WebGPURendererOptions, type DeviceLostInfo } from './renderer/renderer';

// ---------------------------------------------------------------------------
// Compute — ComputeNode, compile-compute, compute-pipeline
// ---------------------------------------------------------------------------

export {
    compute, ComputeNode, type ComputeNodeOptions,
    type ComputeOpts
} from './nodes/nodes';

export {
    compileCompute,
    type ComputeCompileResult,
    type ComputeStorageEntry
} from './nodes/compile';

export {
    ComputePipelineCache,
    type ComputePipelineEntry
} from './renderer/compute-pipeline';

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

export { Inspector } from './inspector/inspector';
export { InspectorBase } from './inspector/inspector-base';
export { RendererInspector, type FrameRecord, type PassRecord } from './inspector/renderer-inspector';

