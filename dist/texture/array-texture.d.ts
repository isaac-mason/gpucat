import { GpuSampler } from '../core/gpu-sampler';
import { GpuTexture } from '../core/gpu-texture';
import * as d from '../schema/schema';
import { type DataTextureImage, Source } from './source';
import type { FilterMode, MipmapFilterMode, TextureOptions, WrapMode } from './texture';
/** Data format for array textures - typed array with width, height, and layer count */
export type ArrayTextureImage = DataTextureImage & {
    depth: number;
};
/**
 * A 2D texture array - multiple 2D textures stacked as layers.
 *
 * Each layer has the same dimensions. Sampled using vec2 UV + layer index.
 * Useful for: sprite atlases, terrain splatting, shadow map arrays.
 */
export declare class ArrayTexture {
    /** Type flag for runtime checking */
    readonly isArrayTexture = true;
    /** The underlying GPU texture resource */
    readonly _gpuTexture: GpuTexture<d.texture2dArray>;
    /** The underlying sampler */
    readonly _gpuSampler: GpuSampler;
    /** Optional name for debugging */
    name: string;
    /**
     * Constructs a new ArrayTexture.
     *
     * @param data - Optional raw data for all layers
     * @param width - Width of each layer
     * @param height - Height of each layer
     * @param depth - Number of layers
     * @param options - Texture options
     */
    constructor(data?: DataTextureImage['data'], width?: number, height?: number, depth?: number, options?: TextureOptions);
    /** Unique numeric ID */
    get id(): number;
    /** Returns the width of each layer. */
    get width(): number;
    /** Returns the height of each layer. */
    get height(): number;
    /** Depth (number of layers) of the texture array */
    get depth(): number;
    /** The data source for this texture. */
    get source(): Source<ArrayTextureImage> | null;
    /** Convenience getter for the source data. */
    get image(): ArrayTextureImage | null;
    /** Horizontal wrap mode (U direction). */
    get wrapS(): WrapMode;
    set wrapS(v: WrapMode);
    /** Vertical wrap mode (V direction). */
    get wrapT(): WrapMode;
    set wrapT(v: WrapMode);
    /** Magnification filter. */
    get magFilter(): FilterMode;
    set magFilter(v: FilterMode);
    /** Minification filter. */
    get minFilter(): FilterMode;
    set minFilter(v: FilterMode);
    /** Mipmap filter mode. */
    get mipmapFilter(): MipmapFilterMode;
    set mipmapFilter(v: MipmapFilterMode);
    /** Anisotropic filtering level. */
    get anisotropy(): number;
    set anisotropy(v: number);
    /** WebGPU texture format. */
    get format(): GPUTextureFormat;
    set format(v: GPUTextureFormat);
    /** Whether to auto-generate mipmaps. */
    get generateMipmaps(): boolean;
    set generateMipmaps(v: boolean);
    /**
     * User-provided mip levels (index 0 = level 1; level 0 lives in the layer data).
     * Each entry is a packed all-layers buffer for that level. When non-empty the
     * renderer uploads these and skips auto-generation.
     */
    get mipmaps(): Source[];
    set mipmaps(v: Source[]);
    /** Whether to flip the image vertically when uploading. */
    get flipY(): boolean;
    set flipY(v: boolean);
    /** Whether to premultiply alpha. */
    get premultiplyAlpha(): boolean;
    set premultiplyAlpha(v: boolean);
    /** Version for dirty tracking. */
    get version(): number;
    /** Set to `true` to trigger a GPU upload on the next render. */
    set needsUpdate(value: boolean);
    /** Track which layers have been modified (forwards to GpuTexture). */
    get layerUpdates(): Set<number>;
    /** Mark a specific layer as needing update. On next upload, only this layer will be transferred. */
    addLayerUpdate(layerIndex: number): void;
    /** Clear the layer update tracking, called by the renderer after upload. */
    clearLayerUpdates(): void;
    /** Creates a clone of this texture. */
    clone(): ArrayTexture;
    /** Disposes of the texture and its GPU resources. */
    dispose(): void;
}
