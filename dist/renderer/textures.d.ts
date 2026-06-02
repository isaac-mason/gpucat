/**
 * textures.ts — GPUTexture/GPUSampler cache and upload helpers.
 *
 * Uses WeakMap-based caching keyed by GpuTexture object.
 * Tracks texture.version for cache invalidation.
 * Samplers are shared/cached by parameter key for efficiency.
 *
 * Flow:
 * 1. `updateTexture()` is called during binding updates (before draw)
 * 2. Checks texture.version — skips if already up to date
 * 3. Creates GPU texture if needed
 * 4. Uploads image data if source.dataReady
 * 5. Updates version tracking (textureData.version = texture.version)
 */
import { GpuSampler } from 'gpucat/dist/core/gpu-sampler';
import { GpuTexture } from 'gpucat/dist/core/gpu-texture';
import { type MipmapState } from 'gpucat/dist/renderer/mipmap-utils';
/** Data stored per Texture in the cache */
export type TextureData = {
    /** The GPU texture resource */
    texture: GPUTexture;
    /** Texture version at last upload — tracks when needsUpdate was set (Three.js aligned) */
    version: number;
    /** Generation — increments when GPU texture object is recreated */
    generation: number;
    /** Whether this texture has been initialized */
    initialized: boolean;
    /** Whether this is a default placeholder texture */
    isDefaultTexture: boolean;
};
/** Data stored per sampler configuration */
type SamplerData = {
    sampler: GPUSampler;
    usedTimes: number;
};
/** Cache for textures and samplers */
export type TextureCache = {
    /** Texture data keyed by GpuTexture object */
    textureMap: WeakMap<GpuTexture, TextureData>;
    /** Sampler cache keyed by parameter string */
    samplerCache: Map<string, SamplerData>;
    /** Default placeholder textures by format */
    defaultTextures: Map<GPUTextureFormat, GPUTexture>;
    /** Mipmap generation state (created lazily on first use) */
    mipmapState: MipmapState | null;
    /** Stats counters */
    textureCount: number;
    samplerCount: number;
};
export type TextureCacheStats = {
    textureCount: number;
    samplerCount: number;
};
export declare function createTextureCache(): TextureCache;
/**
 * Update a texture — checks source version and uploads if needed.
 * Returns the TextureData for the texture.
 */
export declare function updateTexture(cache: TextureCache, device: GPUDevice, texture: GpuTexture): TextureData;
/**
 * Get or create a sampler from Sampler settings.
 */
export declare function getSampler(cache: TextureCache, device: GPUDevice, gpuSampler: GpuSampler): GPUSampler;
export declare function getTextureCacheStats(cache: TextureCache): TextureCacheStats;
/**
 * Get cached TextureData for a GpuTexture.
 * Returns null if not in cache (call updateTexture first).
 */
export declare function getTextureData(cache: TextureCache, texture: GpuTexture): TextureData | null;
/**
 * Set the GPU texture resource for a render target texture.
 * Called by the renderer when creating/resizing render targets.
 *
 * Unlike regular textures which upload source data, render target textures
 * have their GPUTexture created externally and registered here.
 */
export declare function setRenderTargetTexture(cache: TextureCache, texture: GpuTexture, gpuTextureResource: GPUTexture): void;
/**
 * Remove a render target texture from the cache.
 * Called when render target is disposed/resized.
 * Does NOT destroy the GPUTexture - caller is responsible for that.
 */
export declare function removeRenderTargetTexture(cache: TextureCache, texture: GpuTexture): void;
export {};
