/**
 * textures.ts (webgpu), `GPUTexture` cache and upload helpers. Samplers are their own resource module
 * (`samplers.ts`), mirroring `webgl/`.
 *
 * Uses WeakMap-based caching keyed by GpuTexture object.
 * Tracks texture.version for cache invalidation.
 *
 * Flow:
 * 1. `updateTexture()` is called during binding updates (before draw)
 * 2. Checks texture.version, skips if already up to date
 * 3. Creates GPU texture if needed
 * 4. Uploads image data if source.dataReady
 * 5. Updates version tracking (textureData.version = texture.version)
 */
import type { GpuTexture } from '../../core/gpu-texture';
import { type TextureTally, type TextureTallyEntry } from '../core/info';
import { type MipmapState } from './mipmap-utils';
/** Data stored per Texture in the cache */
export type TextureData = {
    /** The GPU texture resource */
    texture: GPUTexture;
    /** Texture version at last upload, tracks when needsUpdate was set */
    version: number;
    /** Generation, increments when GPU texture object is recreated */
    generation: number;
    /** Whether this texture has been initialized */
    initialized: boolean;
    /** Whether this is a default placeholder texture */
    isDefaultTexture: boolean;
    /** What this entry currently contributes to `TextureCache.tally`. */
    tally: TextureTallyEntry;
    /**
     * Cached default render-attachment view (render target color/depth).
     * Lazily created by the renderer and cleared whenever `texture` is swapped
     * (see setRenderTargetTexture), so we don't allocate a GPUTextureView per frame.
     */
    view?: GPUTextureView | null;
    /**
     * Multisampled color texture for an MSAA render target. When present, `texture`
     * is the single-sample resolve target (the one sampled by shaders) and the pass
     * renders into `msaaTexture`, resolving into `texture`. Undefined for non-MSAA.
     */
    msaaTexture?: GPUTexture | null;
    /** Cached view of `msaaTexture` (see `view`). */
    msaaView?: GPUTextureView | null;
};
/** Cache for textures. Samplers live in `samplers.ts`, their own resource module. */
export type TextureCache = {
    /** Texture data keyed by GpuTexture object */
    textureMap: WeakMap<GpuTexture, TextureData>;
    /** Default placeholder textures by format */
    defaultTextures: Map<GPUTextureFormat, GPUTexture>;
    /** Mipmap generation state (created lazily on first use) */
    mipmapState: MipmapState | null;
    /** Stats counters */
    tally: TextureTally;
};
export type TextureCacheStats = {
    textureCount: number;
};
export declare function createTextureCache(): TextureCache;
/**
 * Set up the _onDispose callback on a GpuTexture to destroy its GPU texture.
 * Only sets the callback once (idempotent).
 */
export declare function setupTextureDispose(cache: TextureCache, texture: GpuTexture): void;
/**
 * Generate mipmaps for an already-allocated GPU texture tracked in the cache.
 * Used for render-target textures (e.g. CubeRenderTarget) that are not uploaded
 * via updateTexture().
 */
export declare function generateTextureMipmaps(cache: TextureCache, device: GPUDevice, texture: GpuTexture): void;
/**
 * Update a texture, checks source version and uploads if needed.
 * Returns the TextureData for the texture.
 */
export declare function updateTexture(cache: TextureCache, device: GPUDevice, texture: GpuTexture): TextureData;
export declare function getTextureCacheStats(cache: TextureCache): TextureCacheStats;
/**
 * Get cached TextureData for a GpuTexture.
 * Returns null if not in cache (call updateTexture first).
 */
export declare function getTextureData(cache: TextureCache, texture: GpuTexture): TextureData | null;
