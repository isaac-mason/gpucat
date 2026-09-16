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
export declare function bytesPerTexel(format: GPUTextureFormat): number;
/**
 * Estimated bytes for a whole texture: every array layer / cube face, summed over the mip chain.
 * Each mip halves both dimensions with a floor of 1, which is the allocation rule both APIs follow.
 */
export declare function gpuTextureBytes(texture: GpuTexture): number;
