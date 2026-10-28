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
    /**
     * Name this sampler reads under in emitted shader source. Unlabelled samplers are named after
     * what distinguishes them — `linearSampler`, `nearestSampler` — since settings are what they
     * dedupe on and several textures share one.
     */
    label?: string;
};

/**
 * Declarative sampler settings.
 *
 * Does NOT hold the GPU resource - that's managed by the renderer's cache.
 * The settingsKey is used for deduplication (multiple GpuSampler instances
 * with the same settings share one GPUSampler).
 */
export class GpuSampler {
    readonly isGpuSampler = true;
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

    /** Name used for the emitted shader binding; see GpuSamplerOptions.label. */
    label: string | undefined;

    /** Renderer-set callback to clean up cache entry */
    _onDispose: (() => void) | null = null;

    /** `settingsKey` as last built, and the settings it was built from, in its order */
    private _settingsKey = '';
    private readonly _keyedSettings: unknown[] = [];

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
        this.label = options.label;
    }

    /** Is this a comparison sampler? */
    get isComparison(): boolean {
        return this.compare !== undefined;
    }

    /** Settings key for deduplication */
    get settingsKey(): string {
        // read per draw: built again only once a setting differs from those it was last built from
        const kept = this._keyedSettings;
        if (
            kept.length === 0 ||
            kept[0] !== this.minFilter ||
            kept[1] !== this.magFilter ||
            kept[2] !== this.mipmapFilter ||
            kept[3] !== this.addressModeU ||
            kept[4] !== this.addressModeV ||
            kept[5] !== this.addressModeW ||
            kept[6] !== this.maxAnisotropy ||
            kept[7] !== this.lodMinClamp ||
            kept[8] !== this.lodMaxClamp ||
            kept[9] !== this.compare
        ) {
            kept[0] = this.minFilter;
            kept[1] = this.magFilter;
            kept[2] = this.mipmapFilter;
            kept[3] = this.addressModeU;
            kept[4] = this.addressModeV;
            kept[5] = this.addressModeW;
            kept[6] = this.maxAnisotropy;
            kept[7] = this.lodMinClamp;
            kept[8] = this.lodMaxClamp;
            kept[9] = this.compare;
            const base =
                `${this.minFilter}-${this.magFilter}-${this.mipmapFilter}-` +
                `${this.addressModeU}-${this.addressModeV}-${this.addressModeW}-` +
                `${this.maxAnisotropy}-${this.lodMinClamp}-${this.lodMaxClamp}`;
            this._settingsKey = this.compare ? `${base}-cmp-${this.compare}` : base;
        }
        return this._settingsKey;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this._onDispose?.();
        this._onDispose = null;
    }
}

/** The factory form; the sampler is settings only, the device resource is the renderer's. */
export function createSampler(options: GpuSamplerOptions = {}): GpuSampler {
    return new GpuSampler(options);
}
