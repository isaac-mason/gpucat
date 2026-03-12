import { Source, type SourceData } from './source';
import { GpuTexture } from '../core/gpu-texture';
import { GpuSampler } from '../core/gpu-sampler';
import * as d from '../schema/schema';

/** Wrap modes matching WebGPU GPUAddressMode */
export type WrapMode = 'clamp-to-edge' | 'repeat' | 'mirror-repeat';

/** Filter modes matching WebGPU GPUFilterMode */
export type FilterMode = 'nearest' | 'linear';

/** Mipmap filter modes matching WebGPU GPUMipmapFilterMode */
export type MipmapFilterMode = 'nearest' | 'linear';

export type TextureOptions = {
    // Sampling
    wrapS?: GPUAddressMode;
    wrapT?: GPUAddressMode;
    magFilter?: GPUFilterMode;
    minFilter?: GPUFilterMode;
    mipmapFilter?: GPUMipmapFilterMode;
    anisotropy?: number;
    
    // Format/upload
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
export class Texture<out T extends SourceData = SourceData> {
    /** Type flag for runtime type checking */
    readonly isTexture = true;

    /** The underlying GPU texture resource */
    readonly _gpuTexture: GpuTexture<d.texture2d>;
    
    /** The underlying sampler */
    readonly _gpuSampler: GpuSampler;

    /** Optional name for debugging */
    name = '';

    /**
     * User-provided mipmaps as Sources. If empty, mipmaps are auto-generated
     * when `generateMipmaps` is true.
     */
    mipmaps: Source[] = [];

    /**
     * Callback fired when the texture is updated.
     */
    onUpdate: ((texture: Texture<SourceData>) => void) | null = null;

    /**
     * Whether this texture belongs to a render target.
     * Set to true by RenderTarget when creating its textures.
     * @default false
     */
    isRenderTargetTexture = false;

    /**
     * Constructs a new Texture.
     *
     * @param image - The image source (ImageBitmap, HTMLImageElement, Source, etc.)
     * @param options - Texture options
     */
    constructor(image: T | Source<T> | null, options: TextureOptions = {}) {
        // Create the source
        const src = image instanceof Source 
            ? image 
            : image !== null 
                ? new Source<T>(image) 
                : null;
        
        // Create the underlying GpuTexture
        this._gpuTexture = new GpuTexture(d.texture2d(), {
            width: src?.width || 1,
            height: src?.height || 1,
            source: src ?? undefined,
            format: options.format,
            generateMipmaps: options.generateMipmaps ?? true,
            flipY: options.flipY ?? false,
            premultiplyAlpha: options.premultiplyAlpha ?? false,
        });
        
        // Create the underlying sampler
        this._gpuSampler = new GpuSampler({
            addressModeU: options.wrapS ?? 'clamp-to-edge',
            addressModeV: options.wrapT ?? 'clamp-to-edge',
            magFilter: options.magFilter ?? 'linear',
            minFilter: options.minFilter ?? 'linear',
            mipmapFilter: options.mipmapFilter ?? 'linear',
            maxAnisotropy: options.anisotropy ?? 1,
        });
    }

    // ─── Convenience getters/setters that forward to internals ───

    /** Unique numeric ID */
    get id(): number { return this._gpuTexture.id; }
    
    /** Returns the width of the source, or 1 if no data. */
    get width(): number { return this._gpuTexture.width; }
    
    /** Returns the height of the source, or 1 if no data. */
    get height(): number { return this._gpuTexture.height; }
    
    /** The data source for this texture. */
    get source(): Source<T> | null { return this._gpuTexture.source as Source<T> | null; }
    set source(s: Source<T> | null) { 
        this._gpuTexture.source = s; 
        if (s) {
            this._gpuTexture.width = s.width || 1;
            this._gpuTexture.height = s.height || 1;
        }
    }
    
    /** Convenience getter for the source data. */
    get image(): T | null {
        return this._gpuTexture.source?.data as T | null;
    }

    /** Convenience setter for the source data. */
    set image(value: T | null) {
        if (this._gpuTexture.source) {
            this._gpuTexture.source.data = value;
        } else if (value !== null) {
            this._gpuTexture.source = new Source(value);
        }
    }

    /** Horizontal wrap mode (U direction). */
    get wrapS(): WrapMode { return this._gpuSampler.addressModeU as WrapMode; }
    set wrapS(v: WrapMode) { this._gpuSampler.addressModeU = v; }

    /** Vertical wrap mode (V direction). */
    get wrapT(): WrapMode { return this._gpuSampler.addressModeV as WrapMode; }
    set wrapT(v: WrapMode) { this._gpuSampler.addressModeV = v; }

    /** Magnification filter. */
    get magFilter(): FilterMode { return this._gpuSampler.magFilter as FilterMode; }
    set magFilter(v: FilterMode) { this._gpuSampler.magFilter = v; }

    /** Minification filter. */
    get minFilter(): FilterMode { return this._gpuSampler.minFilter as FilterMode; }
    set minFilter(v: FilterMode) { this._gpuSampler.minFilter = v; }

    /** Mipmap filter mode. */
    get mipmapFilter(): MipmapFilterMode { return this._gpuSampler.mipmapFilter as MipmapFilterMode; }
    set mipmapFilter(v: MipmapFilterMode) { this._gpuSampler.mipmapFilter = v; }

    /** Anisotropic filtering level. */
    get anisotropy(): number { return this._gpuSampler.maxAnisotropy; }
    set anisotropy(v: number) { this._gpuSampler.maxAnisotropy = v; }

    /** WebGPU texture format. */
    get format(): GPUTextureFormat { return this._gpuTexture.format; }
    set format(v: GPUTextureFormat) { this._gpuTexture.format = v; }

    /** Whether to auto-generate mipmaps. */
    get generateMipmaps(): boolean { return this._gpuTexture.generateMipmaps; }
    set generateMipmaps(v: boolean) { this._gpuTexture.generateMipmaps = v; }

    /** Whether to flip the image vertically when uploading. */
    get flipY(): boolean { return this._gpuTexture.flipY; }
    set flipY(v: boolean) { this._gpuTexture.flipY = v; }

    /** Whether to premultiply alpha. */
    get premultiplyAlpha(): boolean { return this._gpuTexture.premultiplyAlpha; }
    set premultiplyAlpha(v: boolean) { this._gpuTexture.premultiplyAlpha = v; }

    /** Version for dirty tracking. */
    get version(): number { return this._gpuTexture.version; }

    /** Set to `true` to trigger a GPU upload on the next render. */
    set needsUpdate(value: boolean) {
        if (value) {
            this._gpuTexture.needsUpdate = true;
            if (this._gpuTexture.source) {
                this._gpuTexture.source.needsUpdate = true;
            }
            this.onUpdate?.(this);
        }
    }

    /** Renderer-set callback to destroy GPU resources. */
    // TODO: did we ever need it?
    // get _onDispose(): (() => void) | null { return this._gpuTexture._onDispose; }
    // set _onDispose(v: (() => void) | null) { this._gpuTexture._onDispose = v; }

    /**
     * Creates a clone of this texture.
     * Note: The clone shares the same Source by default.
     */
    clone(): Texture<T> {
        const tex = new Texture<T>(this.source, {
            wrapS: this.wrapS,
            wrapT: this.wrapT,
            magFilter: this.magFilter,
            minFilter: this.minFilter,
            mipmapFilter: this.mipmapFilter,
            anisotropy: this.anisotropy,
            format: this.format,
            generateMipmaps: this.generateMipmaps,
            flipY: this.flipY,
            premultiplyAlpha: this.premultiplyAlpha,
        });
        tex.name = this.name;
        tex.mipmaps = [...this.mipmaps];
        return tex;
    }

    /**
     * Disposes of the texture and its GPU resources.
     */
    dispose(): void {
        this._gpuTexture.dispose();
        this._gpuSampler.dispose();
        this.mipmaps = [];
    }
}
