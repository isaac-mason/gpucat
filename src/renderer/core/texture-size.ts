/**
 * texture-size.ts (renderer core) — how many bytes a texture occupies, decided in one place.
 *
 * Both backends call this. The format vocabulary is WebGPU's `GPUTextureFormat` either way (the WebGL
 * backend translates it at bind time, it does not carry a second vocabulary), so the byte size of a
 * format is a fact about gpucat's own descriptor, not about a device. Same reasoning as
 * `update-ranges.ts`, `partial-upload.ts`, `buffer-upload.ts` and `render-state.ts`.
 *
 * Deliberately an ESTIMATE, in the same spirit as three.js `Info._getTextureMemorySize`: it is a
 * budget figure for a debug panel, not an allocator. Drivers pad rows, pick their own internal
 * layouts, and may keep a staging copy, so treat the number as "which textures are the expensive
 * ones" rather than as the exact resident footprint.
 */

import type { GpuTexture } from '../../core/gpu-texture';

/** Bytes per texel for the uncompressed formats gpucat uses. Unknown formats fall back to 4. */
export function bytesPerTexel(format: GPUTextureFormat): number {
    switch (format) {
        case 'r8unorm':
        case 'r8snorm':
        case 'r8uint':
        case 'r8sint':
            return 1;
        case 'r16uint':
        case 'r16sint':
        case 'r16float':
        case 'rg8unorm':
        case 'rg8snorm':
        case 'rg8uint':
        case 'rg8sint':
            return 2;
        case 'r32uint':
        case 'r32sint':
        case 'r32float':
        case 'rg16uint':
        case 'rg16sint':
        case 'rg16float':
        case 'rgba8unorm':
        case 'rgba8unorm-srgb':
        case 'rgba8snorm':
        case 'rgba8uint':
        case 'rgba8sint':
        case 'bgra8unorm':
        case 'bgra8unorm-srgb':
            return 4;
        case 'rg32uint':
        case 'rg32sint':
        case 'rg32float':
        case 'rgba16uint':
        case 'rgba16sint':
        case 'rgba16float':
            return 8;
        case 'rgba32uint':
        case 'rgba32sint':
        case 'rgba32float':
            return 16;
        default:
            return 4;
    }
}

/**
 * Estimated bytes for a whole texture: every array layer / cube face, summed over the mip chain.
 * Each mip halves both dimensions with a floor of 1, which is the allocation rule both APIs follow.
 */
export function gpuTextureBytes(texture: GpuTexture): number {
    const perTexel = bytesPerTexel(texture.format);
    const layers = Math.max(1, texture.depthOrArrayLayers);
    const mips = Math.max(1, texture.mipLevelCount);

    let bytes = 0;
    for (let level = 0; level < mips; level++) {
        const width = Math.max(1, texture.width >> level);
        const height = Math.max(1, texture.height >> level);
        bytes += width * height * perTexel;
    }
    return bytes * layers;
}
