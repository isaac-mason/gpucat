/**
 * All known WebGPU feature names as of the current spec.
 *
 * This mirrors the browser's GPUFeatureName type but as a runtime-accessible
 * object so we can iterate over its values when requesting device features.
 * Kept in sync with the WebGPU spec.
 */
export const GPUFeatureName = {
    CoreFeaturesAndLimits: 'core-features-and-limits',
    DepthClipControl: 'depth-clip-control',
    Depth32FloatStencil8: 'depth32float-stencil8',
    TextureCompressionBC: 'texture-compression-bc',
    TextureCompressionBCSliced3D: 'texture-compression-bc-sliced-3d',
    TextureCompressionETC2: 'texture-compression-etc2',
    TextureCompressionASTC: 'texture-compression-astc',
    TextureCompressionASTCSliced3D: 'texture-compression-astc-sliced-3d',
    TimestampQuery: 'timestamp-query',
    IndirectFirstInstance: 'indirect-first-instance',
    ShaderF16: 'shader-f16',
    RG11B10UFloatRenderable: 'rg11b10ufloat-renderable',
    BGRA8UnormStorage: 'bgra8unorm-storage',
    Float32Filterable: 'float32-filterable',
    Float32Blendable: 'float32-blendable',
    ClipDistances: 'clip-distances',
    DualSourceBlending: 'dual-source-blending',
    Subgroups: 'subgroups',
    TextureFormatsTier1: 'texture-formats-tier1',
    TextureFormatsTier2: 'texture-formats-tier2',
} as const satisfies Record<string, GPUFeatureName>;
