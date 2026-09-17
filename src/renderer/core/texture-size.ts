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

/** Levels in a full mip chain down to 1x1, for a texture of this size. */
export function fullMipChainLength(width: number, height: number): number {
    return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

/**
 * Mip levels a texture actually allocates.
 *
 * Explicit user mip images win (level 0 plus the supplied levels), else the full chain when
 * auto-generating, else the descriptor's own count floored at 1. Shared because the answer decides
 * both how much storage a backend allocates and how many levels the size estimate sums, and those two
 * must not disagree.
 */
export function mipLevelCountFor(texture: GpuTexture): number {
    if (texture.mipmaps.length > 0) return texture.mipmaps.length + 1;
    if (texture.generateMipmaps) return fullMipChainLength(texture.width, texture.height);
    return Math.max(1, texture.mipLevelCount);
}

/**
 * Estimated bytes for a whole texture: every array layer / cube face, summed over the mip chain.
 * Each mip halves both dimensions with a floor of 1, which is the allocation rule both APIs follow.
 *
 * The chain length comes from `mipLevelCountFor`, not the raw `mipLevelCount`: an auto-mipmapped
 * texture allocates a full chain while its descriptor still reads 1, and summing the descriptor would
 * undercount every atlas by a third.
 */
export function gpuTextureBytes(texture: GpuTexture): number {
    const perTexel = bytesPerTexel(texture.format);
    const layers = Math.max(1, texture.depthOrArrayLayers);
    const mips = mipLevelCountFor(texture);

    let bytes = 0;
    for (let level = 0; level < mips; level++) {
        const width = Math.max(1, texture.width >> level);
        const height = Math.max(1, texture.height >> level);
        bytes += width * height * perTexel;
    }
    return bytes * layers;
}
