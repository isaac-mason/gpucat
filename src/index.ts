export * from './inspector/inspector';

export { OrbitControls, MOUSE, TOUCH } from './controls/orbit-controls';
export type {
    OrbitControlsEvent,
    OrbitControlsEventListener,
    OrbitControlsEventType,
    MouseAction,
    TouchAction,
} from './controls/orbit-controls';

export * from './scene/scene';

export * from "./camera/camera";
export * from "./camera/perspective-camera";

export * from "./geometry/attribute";
export * from "./geometry/geometry";
export * from "./geometry/helpers";

export * from "./material/material";
export * from './material/material';

export * from './texture/texture';

export * from './utils/color';

export * as frustum from './math/frustum';
export { type Frustum } from './math/frustum';

export {
    // math/operators
    abs, add, sub, mul, div, min, max, clamp, mix, step, smoothstep,
    ceil, floor, fract, sqrt, pow, length, normalize, dot, cross,
    sin, cos,

    // constructors
    f16, f32, i32, u32, bool, color,
    vec2, vec2f, vec2h, vec2i, vec2u, vec2b,
    vec3, vec3f, vec3h, vec3i, vec3u, vec3b,
    vec4, vec4f, vec4h, vec4i, vec4u, vec4b,
    mat4,

    // node factories
    attribute, bufferAttribute, instancedBufferAttribute,
    builtin, index, uniform, storage, storageArray,
    texture, varying, struct, wgsl, wgslFn, Fn, mrt,
    compute,

    // control flow
    Var, If, For, While, Break, Continue, Return,

    // camera uniforms
    cameraProjectionMatrix, cameraViewMatrix, cameraPosition, cameraNear, cameraFar,

    // time uniforms
    timeElapsed, timeDelta,

    // model uniforms
    modelWorldMatrix, modelNormalMatrix,

    // builtins
    instanceIndex, vertexIndex, globalId, localId, localIndex, workgroupId, numWorkgroups,

    // screen/viewport
    fragCoord, screenCoordinate, screenSize, screenUV,

    // helpers
    positionClip,

    // base node class
    Node,

    // indirect draw struct descriptors
    DrawIndirect,
    DrawIndexedIndirect,

    // types
    type BinopOp, type BuiltinKind, type ComputeNodeOptions,
    type ComputeOptions, type ForRange, type GpuTypedArray, type MatType, type NodeKind, type NumericType,
    type SamplerType, type ScalarType, type StructDef,
    type StructInstance, type StructMember, type TextureType, type UpdateRange, type Vec2Type,
    type Vec3Type, type Vec4Type, type VecType, type WgslFnParam, type WgslType,
    type InterpolationType, type InterpolationSampling,
    VaryingNode,
} from './nodes/nodes';

export { pass, type PassNodeOptions } from './nodes/pass-node';
export { renderOutput, type OutputColorSpace, type RenderOutputOptions, type ToneMappingMode } from './nodes/render-output';

export * as d from './nodes/schema';
export type {
    ArrayDesc, WgslDesc, SizedArrayDesc,
} from './nodes/schema';
export { arrayOf, wgslAlignOf, wgslSizeOf, wgslStrideOf, roundUp } from './nodes/schema';

export { packStruct, packStructArray, writeStructArray, f32ToF16Bits, type InferValue } from './utils/buffer-layout';

export { Mesh } from './objects/mesh';
export * from './objects/object3d';

export { DepthTexture, RenderTarget, type RenderTargetOptions } from './renderer/render-target';

export { WebGPURenderer, type DeviceLostInfo, type WebGPURendererOptions } from './renderer/renderer';
