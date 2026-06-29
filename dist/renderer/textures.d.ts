/**
 * textures.ts, GPUTexture/GPUSampler cache and upload helpers.
 *
 * Uses WeakMap-based caching keyed by GpuTexture object.
 * Tracks texture.version for cache invalidation.
 * Samplers are shared/cached by parameter key for efficiency.
 *
 * Flow:
 * 1. `updateTexture()` is called during binding updates (before draw)
 * 2. Checks texture.version, skips if already up to date
 * 3. Creates GPU texture if needed
 * 4. Uploads image data if source.dataReady
 * 5. Updates version tracking (textureData.version = texture.version)
 */
import type { CubeRenderTarget } from '../core/cube-render-target';
import type { GpuSampler } from '../core/gpu-sampler';
import type { GpuTexture } from '../core/gpu-texture';
import type { RenderTarget } from '../core/render-target';
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
export declare function createSwapchainDepthTexture(device: GPUDevice, width: number, height: number, sampleCount: number): GPUTexture;
export declare function createSwapchainMsaaTexture(device: GPUDevice, width: number, height: number, format: GPUTextureFormat, sampleCount: number): GPUTexture;
export declare function createTextureCache(): TextureCache;
/**
 * Generate mipmaps for an already-allocated GPU texture tracked in the cache.
 * Used for render-target textures (e.g. CubeRenderTarget) that are not uploaded
 * via updateTexture().
 */
export declare function generateTextureMipmaps(cache: TextureCache, device: GPUDevice, texture: GpuTexture): void;
export declare function finalizeCubeRenderTargetCapture(cache: TextureCache, device: GPUDevice, renderTarget: CubeRenderTarget, activeMipmapLevel: number): void;
/**
 * Update a texture, checks source version and uploads if needed.
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
 * Default render-attachment view for a render-target color/depth texture.
 * Cached on the TextureData and recreated only when the GPU texture is swapped
 * (setRenderTargetTexture clears it), so attachment resolution doesn't allocate
 * a fresh GPUTextureView every frame.
 */
export declare function getRenderTargetView(data: TextureData): GPUTextureView;
/**
 * Cached view of the multisampled color texture for an MSAA render target.
 * Returns null when the target is not multisampled.
 */
export declare function getRenderTargetMsaaView(data: TextureData): GPUTextureView | null;
/**
 * Set the GPU texture resource for a render target texture.
 * Called by the renderer when creating/resizing render targets.
 *
 * Unlike regular textures which upload source data, render target textures
 * have their GPUTexture created externally and registered here.
 */
export declare function setRenderTargetTexture(cache: TextureCache, texture: GpuTexture, gpuTextureResource: GPUTexture, msaaTexture?: GPUTexture | null): void;
/**
 * Remove a render target texture from the cache.
 * Called when render target is disposed/resized.
 * Does NOT destroy the GPUTexture - caller is responsible for that.
 */
export declare function removeRenderTargetTexture(cache: TextureCache, texture: GpuTexture): void;
export declare function ensureRenderTargetTexturesAllocated(cache: TextureCache, device: GPUDevice, renderTarget: RenderTarget): void;
export {};
