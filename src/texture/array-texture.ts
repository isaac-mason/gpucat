import { GpuSampler } from '../core/gpu-sampler';
import { GpuTexture } from '../core/gpu-texture';
import * as d from '../schema/schema';
import { type DataTextureImage, Source } from './source';
import type { FilterMode, MipmapFilterMode, TextureOptions, WrapMode } from './texture';

// TODO: consider rename to "Texture2DArray" ?

/** Data format for array textures - typed array with width, height, and layer count */
export type ArrayTextureImage = DataTextureImage & { depth: number };

/**
 * A 2D texture array - multiple 2D textures stacked as layers.
 *
 * Each layer has the same dimensions. Sampled using vec2 UV + layer index.
 * Useful for: sprite atlases, terrain splatting, shadow map arrays.
 */
export class ArrayTexture {
    /** Type flag for runtime checking */
    readonly isArrayTexture = true;

    /** The underlying GPU texture resource */
    readonly _gpuTexture: GpuTexture<d.texture2dArray>;

    /** The underlying sampler */
    readonly _gpuSampler: GpuSampler;

    /** Optional name for debugging */
    name = '';

    /**
     * Constructs a new ArrayTexture.
     *
     * @param data - Optional raw data for all layers
     * @param width - Width of each layer
     * @param height - Height of each layer
     * @param depth - Number of layers
     * @param options - Texture options
     */
    constructor(data: DataTextureImage['data'] = null, width = 1, height = 1, depth = 1, options: TextureOptions = {}) {
        // Create source if data provided
        const src = data !== null ? new Source<ArrayTextureImage>({ data, width, height, depth }) : null;

        // Create the underlying GpuTexture
        this._gpuTexture = new GpuTexture(d.texture2dArray(), {
            width,
            height,
            layers: depth,
            source: src ?? undefined,
            format: options.format,
            generateMipmaps: options.generateMipmaps ?? false,
            flipY: options.flipY ?? false,
            premultiplyAlpha: options.premultiplyAlpha ?? false,
        });

        // Create the underlying sampler with defaults for array textures
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
    get id(): number {
        return this._gpuTexture.id;
    }

    /** Returns the width of each layer. */
    get width(): number {
        return this._gpuTexture.width;
    }

    /** Returns the height of each layer. */
    get height(): number {
        return this._gpuTexture.height;
    }

    /** Depth (number of layers) of the texture array */
    get depth(): number {
        return this._gpuTexture.depthOrArrayLayers;
    }

    /** The data source for this texture. */
    get source(): Source<ArrayTextureImage> | null {
        return this._gpuTexture.source as Source<ArrayTextureImage> | null;
    }

    /** Convenience getter for the source data. */
    get image(): ArrayTextureImage | null {
        return this._gpuTexture.source?.data as ArrayTextureImage | null;
    }

    /** Horizontal wrap mode (U direction). */
    get wrapS(): WrapMode {
        return this._gpuSampler.addressModeU as WrapMode;
    }
    set wrapS(v: WrapMode) {
        this._gpuSampler.addressModeU = v;
    }

    /** Vertical wrap mode (V direction). */
    get wrapT(): WrapMode {
        return this._gpuSampler.addressModeV as WrapMode;
    }
    set wrapT(v: WrapMode) {
        this._gpuSampler.addressModeV = v;
    }

    /** Magnification filter. */
    get magFilter(): FilterMode {
        return this._gpuSampler.magFilter as FilterMode;
    }
    set magFilter(v: FilterMode) {
        this._gpuSampler.magFilter = v;
    }

    /** Minification filter. */
    get minFilter(): FilterMode {
        return this._gpuSampler.minFilter as FilterMode;
    }
    set minFilter(v: FilterMode) {
        this._gpuSampler.minFilter = v;
    }

    /** Mipmap filter mode. */
    get mipmapFilter(): MipmapFilterMode {
        return this._gpuSampler.mipmapFilter as MipmapFilterMode;
    }
    set mipmapFilter(v: MipmapFilterMode) {
        this._gpuSampler.mipmapFilter = v;
    }

    /** Anisotropic filtering level. */
    get anisotropy(): number {
        return this._gpuSampler.maxAnisotropy;
    }
    set anisotropy(v: number) {
        this._gpuSampler.maxAnisotropy = v;
    }

    /** WebGPU texture format. */
    get format(): GPUTextureFormat {
        return this._gpuTexture.format;
    }
    set format(v: GPUTextureFormat) {
        this._gpuTexture.format = v;
    }

    /** Whether to auto-generate mipmaps. */
    get generateMipmaps(): boolean {
        return this._gpuTexture.generateMipmaps;
    }
    set generateMipmaps(v: boolean) {
        this._gpuTexture.generateMipmaps = v;
    }

    /**
     * User-provided mip levels (index 0 = level 1; level 0 lives in the layer data).
     * Each entry is a packed all-layers buffer for that level. When non-empty the
     * renderer uploads these and skips auto-generation.
     */
    get mipmaps(): Source[] {
        return this._gpuTexture.mipmaps;
    }
    set mipmaps(v: Source[]) {
        this._gpuTexture.mipmaps = v;
    }

    /** Whether to flip the image vertically when uploading. */
    get flipY(): boolean {
        return this._gpuTexture.flipY;
    }
    set flipY(v: boolean) {
        this._gpuTexture.flipY = v;
    }

    /** Whether to premultiply alpha. */
    get premultiplyAlpha(): boolean {
        return this._gpuTexture.premultiplyAlpha;
    }
    set premultiplyAlpha(v: boolean) {
        this._gpuTexture.premultiplyAlpha = v;
    }

    /** Version for dirty tracking. */
    get version(): number {
        return this._gpuTexture.version;
    }

    /** Set to `true` to trigger a GPU upload on the next render. */
    set needsUpdate(value: boolean) {
        if (value) {
            this._gpuTexture.needsUpdate = true;
            if (this._gpuTexture.source) {
                this._gpuTexture.source.needsUpdate = true;
            }
        }
    }

    /** Track which layers have been modified (forwards to GpuTexture). */
    get layerUpdates(): Set<number> {
        return this._gpuTexture.layerUpdates;
    }

    /** Mark a specific layer as needing update. On next upload, only this layer will be transferred. */
    addLayerUpdate(layerIndex: number): void {
        this._gpuTexture.layerUpdates.add(layerIndex);
    }

    /** Clear the layer update tracking, called by the renderer after upload. */
    clearLayerUpdates(): void {
        this._gpuTexture.layerUpdates.clear();
    }

    /** Creates a clone of this texture. */
    clone(): ArrayTexture {
        const img = this.image;
        const tex = new ArrayTexture(img?.data ?? null, this.width, this.height, this.depth, {
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

    /** Disposes of the texture and its GPU resources. */
    dispose(): void {
        this._gpuTexture.dispose();
        this._gpuSampler.dispose();
    }
}
