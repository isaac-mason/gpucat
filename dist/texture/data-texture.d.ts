import { GpuTexture } from '../core/gpu-texture';
import { GpuSampler } from '../core/gpu-sampler';
import { Source, type DataTextureImage } from './source';
import * as d from '../schema/schema';
import type { WrapMode, FilterMode, MipmapFilterMode, TextureOptions } from './texture';
/** Valid typed array types for DataTexture */
export type DataTextureData = Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array | Float32Array;
/**
 * A texture created from raw typed array data.
 *
 * Useful for procedural textures, LUTs, noise textures, heightmaps, etc.
 */
export declare class DataTexture {
    /** Type flag for runtime checking */
    readonly isDataTexture = true;
    /** The underlying GPU texture resource */
    readonly _gpuTexture: GpuTexture<d.texture2d>;
    /** The underlying sampler */
    readonly _gpuSampler: GpuSampler;
    /** Optional name for debugging */
    name: string;
    /**
     * Constructs a new DataTexture.
     *
     * @param data - Raw pixel data
     * @param width - Width of the texture
     * @param height - Height of the texture
     * @param options - Texture options (including format)
     */
    constructor(data: DataTextureData | null, width: number, height: number, options?: TextureOptions);
    /** Unique numeric ID */
    get id(): number;
    /** Returns the width of the texture. */
    get width(): number;
    /** Returns the height of the texture. */
    get height(): number;
    /** The data source for this texture. */
    get source(): Source<DataTextureImage> | null;
    /** Convenience getter for the source data. */
    get image(): DataTextureImage | null;
    /** The underlying data array */
    get data(): DataTextureData | null;
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
    /**
     * Creates a clone of this texture.
     */
    clone(): DataTexture;
    /**
     * Disposes of the texture and its GPU resources.
     */
    dispose(): void;
}
