/**
 * samplers.ts (webgpu) - per-GpuSampler `GPUSampler` cache, the WebGPU sibling of `webgl/samplers.ts`.
 *
 * Value-keyed by `GpuSampler.settingsKey`, so identical sampler settings share one `GPUSampler`. The
 * WebGL sibling keys on `settingsKey` PLUS whether the paired texture has mips, because a GL sampler
 * carries the mipmapped-vs-base min-filter choice and a mipmapped min-filter against a non-mipmapped
 * texture reads as incomplete. WebGPU has no such coupling, so one entry per settings key is enough:
 * that is an earned signature difference, not drift.
 *
 * Samplers are not disposed individually. They are shared by settings rather than owned by any one
 * `GpuSampler`, so there is nothing to hang a per-object release on; the whole cache goes at renderer
 * teardown.
 */
import type { GpuSampler } from '../../core/gpu-sampler';
/** Data stored per sampler configuration. */
type SamplerData = {
    sampler: GPUSampler;
    usedTimes: number;
};
export type SamplerCache = {
    /** Sampler data keyed by `GpuSampler.settingsKey`. */
    cache: Map<string, SamplerData>;
};
export declare function createSamplerCache(): SamplerCache;
/**
 * Get (or create) the `GPUSampler` for a `GpuSampler`'s settings.
 *
 * WebGPU rejects `maxAnisotropy > 1` unless all three filters are 'linear'; rather than throw, the
 * anisotropy is dropped, since it is a quality hint and the sampler still filters correctly without
 * it. The WebGL sibling makes the same call for the same reason when the anisotropy extension is
 * missing.
 */
export declare function getSampler(device: GPUDevice, state: SamplerCache, gpuSampler: GpuSampler): GPUSampler;
/**
 * The already-created sampler for a settings key, or null. For bind-group rebuilds, which bind what
 * `getSampler` put in the cache and must not create one as a side effect.
 */
export declare function peekSampler(state: SamplerCache, settingsKey: string): GPUSampler | null;
/** Drop every cached sampler (called on renderer dispose). `GPUSampler` has no explicit destroy. */
export declare function disposeSamplerCache(state: SamplerCache): void;
/** Number of distinct sampler configurations currently cached. */
export declare function getSamplerCacheStats(state: SamplerCache): {
    samplerCount: number;
};
export {};
