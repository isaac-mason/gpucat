import { GpuTexture } from '../core/gpu-texture';
import { GpuSampler } from '../core/gpu-sampler';
import { Source, type DataTextureImage } from './source';
import * as d from '../nodes/schema';
import type { WrapMode, FilterMode, MipmapFilterMode, TextureOptions } from './texture';

/** Data format for 3D textures - typed array with width, height, and depth */
export type Texture3DImage = DataTextureImage & { depth: number };

/**
 * A 3D (volume) texture.
 *
 * Sampled using vec3 UVW coordinates. Useful for:
 * - Volume rendering (medical imaging, clouds, fog)
 * - 3D LUTs (color grading)
 * - Signed distance fields
 */
export class Data3DTexture {
    /** Type flag for runtime checking */
    readonly is3DTexture = true;

    /** The underlying GPU texture resource */
    readonly _gpuTexture: GpuTexture<d.texture3d>;
    
    /** The underlying sampler */
    readonly _gpuSampler: GpuSampler;

    /** Optional name for debugging */
    name = '';

    /**
     * Constructs a new Data3DTexture.
     *
     * @param data - Optional raw data for voxels
     * @param width - Width of the texture
     * @param height - Height of the texture
     * @param depth - Depth of the texture
     * @param options - Texture options
     */
    constructor(
        data: DataTextureImage['data'] = null,
        width = 1,
        height = 1,
        depth = 1,
        options: TextureOptions = {},
    ) {
        // Create source if data provided
        const src = data !== null 
            ? new Source<Texture3DImage>({ data, width, height, depth })
            : null;
        
        // Create the underlying GpuTexture
        this._gpuTexture = new GpuTexture(d.texture3d(), {
            width,
            height,
            depth,
            source: src ?? undefined,
            format: options.format,
            generateMipmaps: options.generateMipmaps ?? false,
            flipY: options.flipY ?? false,
            premultiplyAlpha: options.premultiplyAlpha ?? false,
        });
        
        // Create the underlying sampler with defaults for 3D textures
        this._gpuSampler = new GpuSampler({
            addressModeU: options.wrapS ?? 'clamp-to-edge',
            addressModeV: options.wrapT ?? 'clamp-to-edge',
            addressModeW: 'clamp-to-edge',
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
    
    /** Depth of the 3D texture */
    get depth(): number { return this._gpuTexture.depthOrArrayLayers; }
    
    /** The data source for this texture. */
    get source(): Source<Texture3DImage> | null { 
        return this._gpuTexture.source as Source<Texture3DImage> | null; 
    }
    
    /** Convenience getter for the source data. */
    get image(): Texture3DImage | null {
        return this._gpuTexture.source?.data as Texture3DImage | null;
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

    /** Creates a clone of this texture. */
    clone(): Data3DTexture {
        const img = this.image;
        const tex = new Data3DTexture(
            img?.data ?? null, 
            this.width, 
            this.height, 
            this.depth,
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

    /** Disposes of the texture and its GPU resources. */
    dispose(): void {
        this._gpuTexture.dispose();
        this._gpuSampler.dispose();
    }
}
