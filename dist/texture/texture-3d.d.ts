import { GpuTexture } from '../core/gpu-texture';
import { GpuSampler } from '../core/gpu-sampler';
import { Source, type DataTextureImage } from './source';
import * as d from '../schema/schema';
import type { WrapMode, FilterMode, MipmapFilterMode, TextureOptions } from './texture';
/** Data format for 3D textures - typed array with width, height, and depth */
export type Texture3DImage = DataTextureImage & {
    depth: number;
};
/**
 * A 3D (volume) texture.
 *
 * Sampled using vec3 UVW coordinates. Useful for:
 * - Volume rendering (medical imaging, clouds, fog)
 * - 3D LUTs (color grading)
 * - Signed distance fields
 */
export declare class Data3DTexture {
    /** Type flag for runtime checking */
    readonly is3DTexture = true;
    /** The underlying GPU texture resource */
    readonly _gpuTexture: GpuTexture<d.texture3d>;
    /** The underlying sampler */
    readonly _gpuSampler: GpuSampler;
    /** Optional name for debugging */
    name: string;
    /**
     * Constructs a new Data3DTexture.
     *
     * @param data - Optional raw data for voxels
     * @param width - Width of the texture
     * @param height - Height of the texture
     * @param depth - Depth of the texture
     * @param options - Texture options
     */
    constructor(data?: DataTextureImage['data'], width?: number, height?: number, depth?: number, options?: TextureOptions);
    /** Unique numeric ID */
    get id(): number;
    /** Returns the width of the texture. */
    get width(): number;
    /** Returns the height of the texture. */
    get height(): number;
    /** Depth of the 3D texture */
    get depth(): number;
    /** The data source for this texture. */
    get source(): Source<Texture3DImage> | null;
    /** Convenience getter for the source data. */
    get image(): Texture3DImage | null;
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
    /** Creates a clone of this texture. */
    clone(): Data3DTexture;
    /** Disposes of the texture and its GPU resources. */
    dispose(): void;
}
