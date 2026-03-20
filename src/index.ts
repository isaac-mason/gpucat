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
export * from "./camera/orthographic-camera";

export * from "./core/gpu-buffer";
export * from "./core/uniform";
export * from "./geometry/geometry";
export * from "./geometry/geometry-helpers";

export * from "./material/material";
export * from './material/material';

export * from './texture/texture';
export * from './texture/cube-texture';
export * from './texture/depth-texture';
export * from './texture/array-texture';

export * as color from './utils/color';
export { type Color, type ColorInput } from './utils/color';

export * as frustum from './math/frustum';
export { type Frustum } from './math/frustum';

export {
    // constructors
    f16, f32, i32, u32, bool, rgb,
    vec2, vec2f, vec2h, vec2i, vec2u, vec2b,
    vec3, vec3f, vec3h, vec3i, vec3u, vec3b,
    vec4, vec4f, vec4h, vec4i, vec4u, vec4b,
    mat3, mat4,
    mat2x2f, mat2x3f, mat2x4f,
    mat3x2f, mat3x3f, mat3x4f,
    mat4x2f, mat4x3f, mat4x4f,
    mat2x2h, mat2x3h, mat2x4h,
    mat3x2h, mat3x3h, mat3x4h,
    mat4x2h, mat4x3h, mat4x4h,

    // math/operators
    abs, add, sub, mul, div, mod, min, max, clamp, mix, step, smoothstep,
    ceil, floor, fract, sqrt, pow, length, normalize, dot, cross,
    sign, sin, cos, transpose,

    // comparison
    greaterThan, lessThan, greaterThanEqual, lessThanEqual, equal, notEqual,
    or, and,

    // node factories
    attribute, type AttributeOptions,
    builtin, index, field, fields, uniform, storage,
    array,
    texture, varying, struct, wgsl, wgslFn, Fn, mrt,
    compute,

    // texture/sampler factories and functions
    sampler, comparisonSampler, cubeTexture, depthTexture, arrayTexture, textureBinding,
    textureSample, textureSampleLevel, textureSampleBias, textureSampleGrad,
    textureSampleCompare, textureSampleCompareLevel,
    textureLoad, textureStore,
    textureDimensions, textureNumLevels, textureNumLayers,
    textureGather, textureGatherCompare,

    // texture/sampler types
    type TextureNode, type SamplerNode, type CubeTextureNode, type DepthTextureNode, type ArrayTextureNode, type TextureBindingNode,

    // atomic operations
    atomicAdd, atomicStore, atomicLoad, atomicSub,
    atomicMax, atomicMin, atomicAnd, atomicOr, atomicXor,
    atomicExchange, atomicCompareExchangeWeak,

    // variables
    Var, Const,

    // control flow
    If, Loop, For, While, Break, Continue, Return, Discard,
    cond, select,

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

    // compute
    computeIndex,

    // helpers
    positionClip,

    // indirect
    DrawIndirect, DrawIndexedIndirect,

    // types
    type BinopOp, type BuiltinKind, type ComputeNodeOptions,
    type ComputeOptions, type GpuTypedArray, type MatType, type NumericType,
    type SamplerType, type ScalarType, type StructDef,
    type StructInstance, type StructMember, type TextureType, type Vec2Type,
    type Vec3Type, type Vec4Type, type VecType, type WgslType,
    type Node,
    type InterpolationType, type InterpolationSampling,
    type WgslNodeFunction as NodeFunction, type WgslNodeFunctionInput as NodeFunctionInput, type ParamDesc, type FnLayout,

    // render pass
    pass, type PassNodeOptions,

    // render output
    renderOutput, type OutputColorSpace, type RenderOutputOptions, type ToneMappingMode,

    // tonemapping and color space conversions
    acesToneMapping, reinhardToneMapping, sRGBTransferEOTF, sRGBTransferOETF,

    // post-processing effects
    fxaa,
} from './nodes/nodes';

export { compile, compileCompute } from './nodes/builder';

export * as d from './schema/schema';
export {
    pack, packArray, packTo,
    unpack, unpackArray,
    layoutSizeOf, layoutStrideOf,
    type AddressSpace,
} from './schema/pack';

export { Mesh } from './objects/mesh';
export * from './core/object3d';

export * from './core/render-target';

export { WebGPURenderer, type DeviceLostInfo, type WebGPURendererOptions } from './renderer/renderer';
export { RenderPipeline } from './renderer/render-pipeline';
