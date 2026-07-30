/**
 * samplers.ts (webgl) - per-GpuSampler GL sampler-object cache, the GL sibling of the WebGPU
 * `samplerCache`.
 *
 * WebGL2 has real sampler objects (`createSampler` + `samplerParameteri`), so gpucat's separate
 * texture + sampler model survives intact: a sampler object is bound to a texture unit alongside the
 * combined-sampler texture at draw time (`bindSampler(unit, glSampler)`), exactly as WebGPU binds a
 * GPUSampler into a bind group. We map gpucat's WebGPU-vocabulary `GpuSampler` fields
 * (`minFilter`/`magFilter`/`mipmapFilter`, `addressModeU/V/W`, `compare`, `maxAnisotropy`) onto the
 * GL sampler parameters.
 *
 * Value-keyed (by `GpuSampler.settingsKey`) like the WebGPU `samplerCache`, so identical sampler
 * settings share one GL sampler object.
 */
import type { GpuSampler } from '../../core/gpu-sampler';
/** Sampler state: GL sampler objects keyed by GpuSampler settingsKey, plus a disposal set. */
export type GlSamplersState = {
    cache: Map<string, WebGLSampler>;
    all: Set<WebGLSampler>;
    /**
     * Cached anisotropy support, resolved once on first use: null = not yet probed, then either the
     * driver's max anisotropy level (ext present) or 0 (ext absent → anisotropy unavailable).
     */
    maxAnisotropy: number | null;
};
/** Create an empty samplers state. */
export declare function createGlSamplersState(): GlSamplersState;
/**
 * Get (or create + cache) the GL sampler object for a GpuSampler, keyed by its settingsKey.
 *
 * `hasMips` selects between a mipmapped and a base-level min-filter — a sampler paired with a
 * non-mipmapped texture must not request a mipmapped min-filter (the sample would read as
 * incomplete). Two GL samplers can therefore back one GpuSampler (one mipmapped, one not), so the
 * cache key folds `hasMips` in.
 */
export declare function getGlSampler(gl: WebGL2RenderingContext, state: GlSamplersState, gpuSampler: GpuSampler, hasMips: boolean): WebGLSampler;
/** Delete all GL sampler objects (called on renderer dispose). */
export declare function disposeGlSamplers(gl: WebGL2RenderingContext, state: GlSamplersState): void;
/** Number of GL sampler objects currently cached. */
export declare function getGlSamplersStats(state: GlSamplersState): {
    samplerCount: number;
};
