/**
 * All known WebGPU feature names as of the current spec.
 *
 * This mirrors the browser's GPUFeatureName type but as a runtime-accessible
 * object so we can iterate over its values when requesting device features.
 * Kept in sync with the WebGPU spec and Three.js's WebGPUConstants.js.
 */
export declare const GPUFeatureName: {
    readonly CoreFeaturesAndLimits: "core-features-and-limits";
    readonly DepthClipControl: "depth-clip-control";
    readonly Depth32FloatStencil8: "depth32float-stencil8";
    readonly TextureCompressionBC: "texture-compression-bc";
    readonly TextureCompressionBCSliced3D: "texture-compression-bc-sliced-3d";
    readonly TextureCompressionETC2: "texture-compression-etc2";
    readonly TextureCompressionASTC: "texture-compression-astc";
    readonly TextureCompressionASTCSliced3D: "texture-compression-astc-sliced-3d";
    readonly TimestampQuery: "timestamp-query";
    readonly IndirectFirstInstance: "indirect-first-instance";
    readonly ShaderF16: "shader-f16";
    readonly RG11B10UFloatRenderable: "rg11b10ufloat-renderable";
    readonly BGRA8UnormStorage: "bgra8unorm-storage";
    readonly Float32Filterable: "float32-filterable";
    readonly Float32Blendable: "float32-blendable";
    readonly ClipDistances: "clip-distances";
    readonly DualSourceBlending: "dual-source-blending";
    readonly Subgroups: "subgroups";
    readonly TextureFormatsTier1: "texture-formats-tier1";
    readonly TextureFormatsTier2: "texture-formats-tier2";
};
