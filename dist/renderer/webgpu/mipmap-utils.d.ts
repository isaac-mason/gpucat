/**
 * Mipmap generation utilities using direct WebGPU pipelines.
 *
 * Uses render passes to downsample each mip level from the previous one.
 * Pipelines are cached per texture format for efficiency.
 */
/**
 * Cached state for mipmap generation.
 * Created once per device and reused.
 */
export type MipmapState = {
    device: GPUDevice;
    sampler: GPUSampler;
    pipelines2D: Map<GPUTextureFormat, GPURenderPipeline>;
    pipelinesCube: Map<GPUTextureFormat, GPURenderPipeline>;
    shaderModule2D: GPUShaderModule;
    shaderModuleCube: GPUShaderModule;
    faceIndexBuffer: GPUBuffer;
};
/**
 * Create mipmap generation state for a device.
 */
export declare function createMipmapState(device: GPUDevice): MipmapState;
/**
 * Generate mipmaps for a 2D texture.
 *
 * @param state - Mipmap generation state
 * @param texture - The GPU texture to generate mipmaps for
 * @param encoder - Optional command encoder (creates one if not provided)
 */
export declare function generateMipmaps2D(state: MipmapState, texture: GPUTexture, encoder?: GPUCommandEncoder): void;
/**
 * Generate mipmaps for a cube texture.
 *
 * @param state - Mipmap generation state
 * @param texture - The GPU cube texture to generate mipmaps for
 * @param encoder - Optional command encoder (creates one if not provided)
 */
export declare function generateMipmapsCube(state: MipmapState, texture: GPUTexture, encoder?: GPUCommandEncoder): void;
/**
 * Generate mipmaps for a 2D array texture.
 *
 * Each layer is mipmapped independently using the same 2D pipeline.
 * For each mip level, iterates all layers: creates a 2D source view of layer L
 * at mip N-1 and a 2D destination view of layer L at mip N, then renders a
 * fullscreen downsample pass.
 *
 * @param state - Mipmap generation state
 * @param texture - The GPU array texture to generate mipmaps for
 * @param layerCount - Number of array layers
 * @param encoder - Optional command encoder (creates one if not provided)
 */
export declare function generateMipmapsArray(state: MipmapState, texture: GPUTexture, layerCount: number, encoder?: GPUCommandEncoder): void;
/**
 * Generate mipmaps for a texture (auto-detects 2D vs cube vs array).
 *
 * @param state - Mipmap generation state
 * @param texture - The GPU texture to generate mipmaps for
 * @param isCube - Whether this is a cube texture
 * @param arrayLayerCount - Number of array layers (>1 triggers array path)
 * @param encoder - Optional command encoder
 */
export declare function generateMipmaps(state: MipmapState, texture: GPUTexture, isCube?: boolean, arrayLayerCount?: number, encoder?: GPUCommandEncoder): void;
/**
 * Dispose mipmap generation state.
 */
export declare function disposeMipmapState(state: MipmapState): void;
