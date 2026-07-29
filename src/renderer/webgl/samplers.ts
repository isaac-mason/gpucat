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

/** GL min-filter for a (min, mipmap) filter pair, respecting whether mipmaps are actually present. */
function glMinFilter(gl: WebGL2RenderingContext, min: GPUFilterMode, mip: GPUMipmapFilterMode, hasMips: boolean): number {
    if (!hasMips) return min === 'nearest' ? gl.NEAREST : gl.LINEAR;
    if (min === 'nearest') {
        return mip === 'nearest' ? gl.NEAREST_MIPMAP_NEAREST : gl.NEAREST_MIPMAP_LINEAR;
    }
    return mip === 'nearest' ? gl.LINEAR_MIPMAP_NEAREST : gl.LINEAR_MIPMAP_LINEAR;
}

function glMagFilter(gl: WebGL2RenderingContext, mag: GPUFilterMode): number {
    return mag === 'nearest' ? gl.NEAREST : gl.LINEAR;
}

function glWrap(gl: WebGL2RenderingContext, mode: GPUAddressMode): number {
    switch (mode) {
        case 'repeat':
            return gl.REPEAT;
        case 'mirror-repeat':
            return gl.MIRRORED_REPEAT;
        default:
            return gl.CLAMP_TO_EDGE;
    }
}

/** GL compare function for a shadow (comparison) sampler. */
function glCompareFunc(gl: WebGL2RenderingContext, compare: GPUCompareFunction): number {
    switch (compare) {
        case 'never':
            return gl.NEVER;
        case 'less':
            return gl.LESS;
        case 'equal':
            return gl.EQUAL;
        case 'less-equal':
            return gl.LEQUAL;
        case 'greater':
            return gl.GREATER;
        case 'not-equal':
            return gl.NOTEQUAL;
        case 'greater-equal':
            return gl.GEQUAL;
        default:
            return gl.ALWAYS;
    }
}

/** Sampler state: GL sampler objects keyed by GpuSampler settingsKey, plus a disposal set. */
export type GlSamplersState = {
    cache: Map<string, WebGLSampler>;
    all: Set<WebGLSampler>;
};

/** Create an empty samplers state. */
export function createGlSamplersState(): GlSamplersState {
    return { cache: new Map(), all: new Set() };
}

/**
 * Get (or create + cache) the GL sampler object for a GpuSampler, keyed by its settingsKey.
 *
 * `hasMips` selects between a mipmapped and a base-level min-filter — a sampler paired with a
 * non-mipmapped texture must not request a mipmapped min-filter (the sample would read as
 * incomplete). Two GL samplers can therefore back one GpuSampler (one mipmapped, one not), so the
 * cache key folds `hasMips` in.
 */
export function getGlSampler(
    gl: WebGL2RenderingContext,
    state: GlSamplersState,
    gpuSampler: GpuSampler,
    hasMips: boolean,
): WebGLSampler {
    const key = `${gpuSampler.settingsKey}|mips=${hasMips}`;
    const existing = state.cache.get(key);
    if (existing) return existing;

    const sampler = gl.createSampler();
    if (!sampler) throw new Error('[WebGLRenderer] gl.createSampler returned null.');

    gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, glMinFilter(gl, gpuSampler.minFilter, gpuSampler.mipmapFilter, hasMips));
    gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, glMagFilter(gl, gpuSampler.magFilter));
    gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, glWrap(gl, gpuSampler.addressModeU));
    gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, glWrap(gl, gpuSampler.addressModeV));
    gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_R, glWrap(gl, gpuSampler.addressModeW));

    // Comparison (shadow) sampler: enable ref-vs-texture compare and set the function.
    if (gpuSampler.compare) {
        gl.samplerParameteri(sampler, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
        gl.samplerParameteri(sampler, gl.TEXTURE_COMPARE_FUNC, glCompareFunc(gl, gpuSampler.compare));
    }

    // Anisotropy via the standard extension, when available and requested.
    if (gpuSampler.maxAnisotropy > 1) {
        const ext = gl.getExtension('EXT_texture_filter_anisotropic');
        if (ext) gl.samplerParameterf(sampler, ext.TEXTURE_MAX_ANISOTROPY_EXT, gpuSampler.maxAnisotropy);
    }

    state.cache.set(key, sampler);
    state.all.add(sampler);
    return sampler;
}

/** Delete all GL sampler objects (called on renderer dispose). */
export function disposeGlSamplers(gl: WebGL2RenderingContext, state: GlSamplersState): void {
    for (const s of state.all) gl.deleteSampler(s);
    state.all.clear();
    state.cache.clear();
}

/** Number of GL sampler objects currently cached. */
export function getGlSamplersStats(state: GlSamplersState): { samplerCount: number } {
    return { samplerCount: state.all.size };
}
