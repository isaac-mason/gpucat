let _samplerId = 0;

export type GpuSamplerOptions = {
    minFilter?: GPUFilterMode;
    magFilter?: GPUFilterMode;
    mipmapFilter?: GPUMipmapFilterMode;
    addressModeU?: GPUAddressMode;
    addressModeV?: GPUAddressMode;
    addressModeW?: GPUAddressMode;
    maxAnisotropy?: number;
    compare?: GPUCompareFunction;
    lodMinClamp?: number;
    lodMaxClamp?: number;
};

/**
 * Declarative sampler settings.
 * 
 * Does NOT hold the GPU resource - that's managed by the renderer's cache.
 * The settingsKey is used for deduplication (multiple GpuSampler instances
 * with the same settings share one GPUSampler).
 */
export class GpuSampler {
    readonly id = _samplerId++;
    
    minFilter: GPUFilterMode;
    magFilter: GPUFilterMode;
    mipmapFilter: GPUMipmapFilterMode;
    addressModeU: GPUAddressMode;
    addressModeV: GPUAddressMode;
    addressModeW: GPUAddressMode;
    maxAnisotropy: number;
    lodMinClamp: number;
    lodMaxClamp: number;
    
    /** For comparison samplers (shadow mapping) */
    compare?: GPUCompareFunction;
    
    /** Renderer-set callback to clean up cache entry */
    _onDispose: (() => void) | null = null;
    
    disposed = false;
    
    constructor(options: GpuSamplerOptions = {}) {
        this.minFilter = options.minFilter ?? 'linear';
        this.magFilter = options.magFilter ?? 'linear';
        this.mipmapFilter = options.mipmapFilter ?? 'linear';
        this.addressModeU = options.addressModeU ?? 'clamp-to-edge';
        this.addressModeV = options.addressModeV ?? 'clamp-to-edge';
        this.addressModeW = options.addressModeW ?? 'clamp-to-edge';
        this.maxAnisotropy = options.maxAnisotropy ?? 1;
        this.lodMinClamp = options.lodMinClamp ?? 0;
        this.lodMaxClamp = options.lodMaxClamp ?? 32;
        this.compare = options.compare;
    }
    
    /** Is this a comparison sampler? */
    get isComparison(): boolean {
        return this.compare !== undefined;
    }
    
    /** Settings key for deduplication */
    get settingsKey(): string {
        const base = `${this.minFilter}-${this.magFilter}-${this.mipmapFilter}-` +
                     `${this.addressModeU}-${this.addressModeV}-${this.addressModeW}-` +
                     `${this.maxAnisotropy}-${this.lodMinClamp}-${this.lodMaxClamp}`;
        return this.compare ? `${base}-cmp-${this.compare}` : base;
    }
    
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this._onDispose?.();
        this._onDispose = null;
    }
}
