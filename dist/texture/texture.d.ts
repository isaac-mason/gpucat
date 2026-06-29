import { GpuSampler } from '../core/gpu-sampler';
import { GpuTexture } from '../core/gpu-texture';
import * as d from '../schema/schema';
import { Source, type SourceData } from './source';
/** Wrap modes matching WebGPU GPUAddressMode */
export type WrapMode = 'clamp-to-edge' | 'repeat' | 'mirror-repeat';
/** Filter modes matching WebGPU GPUFilterMode */
export type FilterMode = 'nearest' | 'linear';
/** Mipmap filter modes matching WebGPU GPUMipmapFilterMode */
export type MipmapFilterMode = 'nearest' | 'linear';
export type TextureOptions = {
    wrapS?: GPUAddressMode;
    wrapT?: GPUAddressMode;
    magFilter?: GPUFilterMode;
    minFilter?: GPUFilterMode;
    mipmapFilter?: GPUMipmapFilterMode;
    anisotropy?: number;
    format?: GPUTextureFormat;
    generateMipmaps?: boolean;
    flipY?: boolean;
    premultiplyAlpha?: boolean;
};
/**
 * High-level 2D texture class.
 *
 * Holds sampling parameters and references a Source for image data.
 */
export declare class Texture<out T extends SourceData = SourceData> {
    /** Type flag for runtime type checking */
    readonly isTexture = true;
    /** The underlying GPU texture resource */
    readonly _gpuTexture: GpuTexture<d.texture2d>;
    /** The underlying sampler */
    readonly _gpuSampler: GpuSampler;
    /** Optional name for debugging */
    name: string;
    /**
     * Callback fired when the texture is updated.
     */
    onUpdate: ((texture: Texture<SourceData>) => void) | null;
    /**
     * Whether this texture belongs to a render target.
     * Set to true by RenderTarget when creating its textures.
     * @default false
     */
    isRenderTargetTexture: boolean;
    /**
     * Constructs a new Texture.
     *
     * @param image - The image source (ImageBitmap, HTMLImageElement, Source, etc.)
     * @param options - Texture options
     */
    constructor(image: T | Source<T> | null, options?: TextureOptions);
    /** Unique numeric ID */
    get id(): number;
    /** Returns the width of the source, or 1 if no data. */
    get width(): number;
    /** Returns the height of the source, or 1 if no data. */
    get height(): number;
    /** The data source for this texture. */
    get source(): Source<T> | null;
    set source(s: Source<T> | null);
    /** Convenience getter for the source data. */
    get image(): T | null;
    /** Convenience setter for the source data. */
    set image(value: T | null);
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
     * User-provided mip levels (index 0 = level 1). When non-empty the renderer
     * uploads these and skips auto-generation. Empty by default.
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
    /** Renderer-set callback to destroy GPU resources. */
    /**
     * Creates a clone of this texture.
     * Note: The clone shares the same Source by default.
     */
    clone(): Texture<T>;
    /**
     * Disposes of the texture and its GPU resources.
     */
    dispose(): void;
}
