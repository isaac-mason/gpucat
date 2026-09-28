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
export declare class GpuSampler {
    readonly isGpuSampler = true;
    readonly id: number;
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
    _onDispose: (() => void) | null;
    disposed: boolean;
    constructor(options?: GpuSamplerOptions);
    /** Is this a comparison sampler? */
    get isComparison(): boolean;
    /** Settings key for deduplication */
    get settingsKey(): string;
    dispose(): void;
}
/** The factory form; the sampler is settings only, the device resource is the renderer's. */
export declare function createSampler(options?: GpuSamplerOptions): GpuSampler;
