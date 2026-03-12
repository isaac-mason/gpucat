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
export class DataTexture {
    /** Type flag for runtime checking */
    readonly isDataTexture = true;

    /** The underlying GPU texture resource */
    readonly _gpuTexture: GpuTexture<d.texture2d>;
    
    /** The underlying sampler */
    readonly _gpuSampler: GpuSampler;

    /** Optional name for debugging */
    name = '';

    /**
     * Constructs a new DataTexture.
     *
     * @param data - Raw pixel data
     * @param width - Width of the texture
     * @param height - Height of the texture
     * @param options - Texture options (including format)
     */
    constructor(
        data: DataTextureData | null,
        width: number,
        height: number,
        options: TextureOptions = {},
    ) {
        // Create source with size info
        const src = data !== null 
            ? new Source<DataTextureImage>({ data, width, height })
            : null;
        
        // Create the underlying GpuTexture
        this._gpuTexture = new GpuTexture(d.texture2d(), {
            width,
            height,
            source: src ?? undefined,
            format: options.format ?? 'rgba8unorm',
            generateMipmaps: options.generateMipmaps ?? false,
            flipY: options.flipY ?? false,
            premultiplyAlpha: options.premultiplyAlpha ?? false,
        });
        
        // Create the underlying sampler with defaults for data textures
        this._gpuSampler = new GpuSampler({
            addressModeU: options.wrapS ?? 'clamp-to-edge',
            addressModeV: options.wrapT ?? 'clamp-to-edge',
            magFilter: options.magFilter ?? 'nearest',
            minFilter: options.minFilter ?? 'nearest',
            mipmapFilter: options.mipmapFilter ?? 'nearest',
            maxAnisotropy: options.anisotropy ?? 1,
        });
    }

    // ─── Convenience getters/setters that forward to internals ───

    /** Unique numeric ID */
    get id(): number { return this._gpuTexture.id; }
    
    /** Returns the width of the texture. */
    get width(): number { return this._gpuTexture.width; }
    
    /** Returns the height of the texture. */
    get height(): number { return this._gpuTexture.height; }
    
    /** The data source for this texture. */
    get source(): Source<DataTextureImage> | null { 
        return this._gpuTexture.source as Source<DataTextureImage> | null; 
    }
    
    /** Convenience getter for the source data. */
    get image(): DataTextureImage | null {
        return this._gpuTexture.source?.data as DataTextureImage | null;
    }

    /** The underlying data array */
    get data(): DataTextureData | null {
        const img = this.image;
        return img?.data ?? null;
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
        }
    }

    /**
     * Creates a clone of this texture.
     */
    clone(): DataTexture {
        let clonedData: DataTextureData | null = null;
        if (this.data) {
            // Clone the typed array with same type
            const DataArrayCtor = this.data.constructor as new (buffer: ArrayBufferLike) => DataTextureData;
            clonedData = new DataArrayCtor(this.data.buffer.slice(0));
        }
        
        const tex = new DataTexture(
            clonedData,
            this.width,
            this.height,
            {
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
            }
        );
        tex.name = this.name;
        return tex;
    }

    /**
     * Disposes of the texture and its GPU resources.
     */
    dispose(): void {
        this._gpuTexture.dispose();
        this._gpuSampler.dispose();
    }
}
