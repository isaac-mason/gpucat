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
import type { Source } from '../texture/source';
import { createMipmapState, generateMipmaps, type MipmapState } from './mipmap-utils';

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

export function createSwapchainDepthTexture(
    device: GPUDevice,
    width: number,
    height: number,
    sampleCount: number,
    format: GPUTextureFormat = 'depth24plus',
): GPUTexture {
    return device.createTexture({
        size: [width, height],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        sampleCount,
    });
}

export function createSwapchainMsaaTexture(
    device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat,
    sampleCount: number,
): GPUTexture {
    return device.createTexture({
        size: [width, height],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        sampleCount,
    });
}

export function createTextureCache(): TextureCache {
    return {
        textureMap: new WeakMap(),
        samplerCache: new Map(),
        defaultTextures: new Map(),
        mipmapState: null,
        textureCount: 0,
        samplerCount: 0,
    };
}

/**
 * Set up the _onDispose callback on a GpuTexture to destroy its GPU texture.
 * Only sets the callback once (idempotent).
 */
function setupDispose(cache: TextureCache, texture: GpuTexture): void {
    if (texture._onDispose) return;

    texture._onDispose = () => {
        const data = cache.textureMap.get(texture);
        if (data && !data.isDefaultTexture) {
            data.texture.destroy();
            data.msaaTexture?.destroy();
        }
    };
}

/**
 * Get or create mipmap generation state (lazy initialization).
 */
function getMipmapState(cache: TextureCache, device: GPUDevice): MipmapState {
    if (!cache.mipmapState) {
        cache.mipmapState = createMipmapState(device);
    }
    return cache.mipmapState;
}

/**
 * Generate mipmaps for an already-allocated GPU texture tracked in the cache.
 * Used for render-target textures (e.g. CubeRenderTarget) that are not uploaded
 * via updateTexture().
 */
export function generateTextureMipmaps(cache: TextureCache, device: GPUDevice, texture: GpuTexture): void {
    const data = cache.textureMap.get(texture);
    if (!data || data.isDefaultTexture) return;
    if (data.texture.mipLevelCount <= 1) return;

    const isCube = texture.viewDimension === 'cube' || texture.viewDimension === 'cube-array';
    const isArray = texture.viewDimension === '2d-array';

    const mipmapState = getMipmapState(cache, device);
    generateMipmaps(mipmapState, data.texture, isCube, isArray ? texture.depthOrArrayLayers : 0);
}

export function finalizeCubeRenderTargetCapture(
    cache: TextureCache,
    device: GPUDevice,
    renderTarget: CubeRenderTarget,
    activeMipmapLevel: number,
): void {
    if (!renderTarget.texture.generateMipmaps) return;
    if (activeMipmapLevel !== 0) return;
    generateTextureMipmaps(cache, device, renderTarget.texture._gpuTexture);
}

/**
 * Update a texture, checks source version and uploads if needed.
 * Returns the TextureData for the texture.
 */
export function updateTexture(cache: TextureCache, device: GPUDevice, texture: GpuTexture): TextureData {
    let data = cache.textureMap.get(texture);

    // Skip if already initialized and texture version matches
    if (data?.initialized && data.version === texture.version) {
        return data;
    }

    const isCube = texture.viewDimension === 'cube' || texture.viewDimension === 'cube-array';
    const isArray = texture.viewDimension === '2d-array';
    const isStorage = texture.type.type.startsWith('texture_storage_');

    // Storage textures have no source data — their contents are written by a compute
    // pass via textureStore. Create the real GPU texture (with STORAGE_BINDING usage) and
    // skip the source-upload path entirely; never fall back to the default texture.
    // A version bump (e.g. resize via needsUpdate) recreates the GPU texture at the new size.
    if (isStorage) {
        if (data && data.version === texture.version) {
            return data;
        }
        const gpuTextureResource = createGPUTexture(device, texture);
        if (!data) {
            data = {
                texture: gpuTextureResource,
                version: texture.version,
                generation: texture.version,
                initialized: true,
                isDefaultTexture: false,
            };
            cache.textureMap.set(texture, data);
            cache.textureCount++;
            setupDispose(cache, texture);
        } else {
            // Recreate at the new size: destroy the old GPU texture, swap in the new one,
            // and bump generation so dependent bind groups rebuild with the fresh view.
            data.texture.destroy();
            data.texture = gpuTextureResource;
            data.version = texture.version;
            data.generation = texture.version;
        }
        return data;
    }

    // Check if source data is ready
    // For cube textures, check all face sources
    // For array textures, check all layer sources
    // For regular textures, check the single source
    const notReady = isCube
        ? !areCubeSourcesReady(texture)
        : isArray
          ? !areArraySourcesReady(texture)
          : !isSourceReady(texture.source);

    if (notReady) {
        if (!data) {
            const format = texture.format;
            const defaultTex = getDefaultTexture(cache, device, format);
            data = {
                texture: defaultTex,
                version: 0,
                generation: 0,
                initialized: true,
                isDefaultTexture: true,
            };
            cache.textureMap.set(texture, data);
        }
        return data;
    }

    // First time or was using default, create real GPU texture
    if (!data || data.isDefaultTexture) {
        const gpuTextureResource = createGPUTexture(device, texture);

        if (!data) {
            data = {
                texture: gpuTextureResource,
                version: texture.version,
                generation: texture.version,
                initialized: true,
                isDefaultTexture: false,
            };
            cache.textureMap.set(texture, data);
            cache.textureCount++;
        } else {
            // Was default, now real, update generation
            data.texture = gpuTextureResource;
            data.generation = texture.version;
            data.isDefaultTexture = false;
            cache.textureCount++;
        }

        // Set up disposal callback to destroy the GPU texture
        setupDispose(cache, texture);
    }

    // Upload image data
    uploadTextureData(device, texture, data);

    // Mip levels: user-supplied explicit mips take precedence over render-pass generation.
    if (texture.mipmaps.length > 0) {
        uploadExplicitMips(device, texture, data);
    } else if (texture.generateMipmaps && data.texture.mipLevelCount > 1) {
        const mipmapState = getMipmapState(cache, device);
        generateMipmaps(mipmapState, data.texture, isCube, isArray ? texture.depthOrArrayLayers : 0);
    }

    // Update texture version
    data.version = texture.version;
    data.initialized = true;

    return data;
}

/** Check if a single source is ready */
function isSourceReady(source: Source | null): boolean {
    if (!source) return false;
    if (!source.dataReady) return false;
    const data = source.data;
    if (!data) return false;
    // Check for incomplete HTMLImageElement
    if ((data as HTMLImageElement).complete === false) return false;
    return true;
}

/** Check if all cube face sources are ready (6 faces) */
function areCubeSourcesReady(texture: GpuTexture): boolean {
    if (texture.sources.length < 6) return false;
    for (let i = 0; i < 6; i++) {
        if (!isSourceReady(texture.sources[i])) return false;
    }
    return true;
}

/** Check if array texture source is ready (packed source or per-layer sources) */
function areArraySourcesReady(texture: GpuTexture): boolean {
    // Packed source mode: single source contains all layers
    if (texture.source) {
        return isSourceReady(texture.source);
    }
    // Per-layer sources mode
    if (texture.sources.length < texture.depthOrArrayLayers) return false;
    for (let i = 0; i < texture.depthOrArrayLayers; i++) {
        if (!isSourceReady(texture.sources[i])) return false;
    }
    return true;
}

/**
 * Create a GPUTexture for a GpuTexture.
 */
function createGPUTexture(device: GPUDevice, texture: GpuTexture): GPUTexture {
    // Calculate mip level count. Explicit user mipmaps win (level 0 + supplied levels);
    // otherwise derive the full chain when auto-generating, else the descriptor's count.
    const mipLevelCount =
        texture.mipmaps.length > 0
            ? texture.mipmaps.length + 1
            : texture.generateMipmaps
              ? Math.floor(Math.log2(Math.max(texture.width, texture.height))) + 1
              : texture.mipLevelCount;

    // RENDER_ATTACHMENT is forced on so render-pass mipmap generation works. But NOT for single-mip
    // storage textures: some storage formats (e.g. rgba8snorm) aren't renderable, so force-adding it
    // would fail createTexture — and a storage texture with no mips never needs render-pass mip-gen.
    const isStorage = texture.type.type.startsWith('texture_storage_');
    const usage = !isStorage || mipLevelCount > 1 ? texture.usage | GPUTextureUsage.RENDER_ATTACHMENT : texture.usage;

    const gpuTexture = device.createTexture({
        dimension: texture.dimension,
        size: [texture.width, texture.height, texture.depthOrArrayLayers],
        format: texture.format,
        usage,
        mipLevelCount,
        sampleCount: texture.sampleCount,
    });

    return gpuTexture;
}

/**
 * Upload image data to a GPU texture.
 * Routes to the appropriate upload function based on viewDimension.
 */
function uploadTextureData(device: GPUDevice, texture: GpuTexture, data: TextureData): void {
    const viewDim = texture.viewDimension;

    if (viewDim === 'cube' || viewDim === 'cube-array') {
        uploadCubeTextureData(device, texture, data);
        return;
    }

    if (viewDim === '2d-array') {
        uploadArrayTextureData(device, texture, data);
        return;
    }

    // Regular 2D texture - use primary source
    const source = texture.source;
    if (!source || !source.data) return;

    const sourceData = source.data;
    const width = texture.width;
    const height = texture.height;

    // Check if it's typed array data (DataTexture pattern)
    if (isTypedArrayData(sourceData)) {
        const bytesPerPixel = getBytesPerPixel(texture.format);
        const view = sourceData.data;
        device.queue.writeTexture(
            { texture: data.texture },
            view.buffer,
            { offset: view.byteOffset, bytesPerRow: width * bytesPerPixel, rowsPerImage: height },
            [width, height],
        );
    } else if (isExternalImage(sourceData)) {
        // HTMLImageElement, ImageBitmap, Canvas, Video, etc.
        device.queue.copyExternalImageToTexture(
            { source: sourceData, flipY: texture.flipY },
            { texture: data.texture, premultipliedAlpha: texture.premultiplyAlpha },
            [width, height],
        );
    }
}

/** Check if source data is a typed array (from DataTextureImage) */
function isTypedArrayData(data: unknown): data is { data: ArrayBufferView; buffer: ArrayBuffer; byteOffset: number } {
    if (!data || typeof data !== 'object') return false;
    const d = data as { data?: unknown };
    return d.data !== undefined && ArrayBuffer.isView(d.data);
}

/** Check if source data is an external image (copyable to GPU) */
function isExternalImage(
    data: unknown,
): data is ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | HTMLVideoElement | VideoFrame | ImageData {
    if (!data || typeof data !== 'object') return false;
    // Check for known browser types
    return (
        (typeof ImageBitmap !== 'undefined' && data instanceof ImageBitmap) ||
        (typeof HTMLImageElement !== 'undefined' && data instanceof HTMLImageElement) ||
        (typeof HTMLCanvasElement !== 'undefined' && data instanceof HTMLCanvasElement) ||
        (typeof OffscreenCanvas !== 'undefined' && data instanceof OffscreenCanvas) ||
        (typeof HTMLVideoElement !== 'undefined' && data instanceof HTMLVideoElement) ||
        (typeof VideoFrame !== 'undefined' && data instanceof VideoFrame) ||
        (typeof ImageData !== 'undefined' && data instanceof ImageData)
    );
}

/**
 * Upload cube texture data, copies each of the 6 face images to the
 * corresponding array layer of the GPU texture.
 *
 * Face order: +X, -X, +Y, -Y, +Z, -Z (matches sources array).
 */
function uploadCubeTextureData(device: GPUDevice, texture: GpuTexture, data: TextureData): void {
    const sources = texture.sources;
    if (sources.length < 6) return;

    const width = texture.width;
    const height = texture.height;

    for (let faceIndex = 0; faceIndex < 6; faceIndex++) {
        const source = sources[faceIndex];
        if (!source.dataReady) continue;

        const faceData = source.data;
        if (!faceData) continue;

        if (isExternalImage(faceData)) {
            device.queue.copyExternalImageToTexture(
                { source: faceData, flipY: texture.flipY },
                {
                    texture: data.texture,
                    premultipliedAlpha: texture.premultiplyAlpha,
                    origin: { x: 0, y: 0, z: faceIndex },
                },
                [width, height],
            );
        }
    }
}

/**
 * Upload array texture data, copies each layer's data to the corresponding
 * array layer of the GPU texture.
 *
 * Supports two modes:
 * 1. Per-layer sources: texture.sources contains one Source per layer
 * 2. Packed source: texture.source contains all layers packed sequentially
 */
function uploadArrayTextureData(device: GPUDevice, texture: GpuTexture, data: TextureData): void {
    const width = texture.width;
    const height = texture.height;
    const bytesPerPixel = getBytesPerPixel(texture.format);
    const layerCount = texture.depthOrArrayLayers;

    // Mode 1: Per-layer sources array
    if (texture.sources.length > 0) {
        for (let layer = 0; layer < texture.sources.length && layer < layerCount; layer++) {
            const source = texture.sources[layer];
            if (!source.dataReady) continue;

            const layerData = source.data;
            if (!layerData) continue;

            if (isTypedArrayData(layerData)) {
                const srcData = (layerData as { data: ArrayBufferView }).data as Uint8Array;
                device.queue.writeTexture(
                    { texture: data.texture, origin: { x: 0, y: 0, z: layer } },
                    srcData.buffer,
                    {
                        offset: srcData.byteOffset,
                        bytesPerRow: width * bytesPerPixel,
                        rowsPerImage: height,
                    },
                    [width, height],
                );
            } else if (isExternalImage(layerData)) {
                device.queue.copyExternalImageToTexture(
                    { source: layerData, flipY: texture.flipY },
                    {
                        texture: data.texture,
                        premultipliedAlpha: texture.premultiplyAlpha,
                        origin: { x: 0, y: 0, z: layer },
                    },
                    [width, height],
                );
            }
        }
        return;
    }

    // Mode 2: Single packed source with all layers
    const source = texture.source;
    if (!source || !source.dataReady) return;

    const sourceData = source.data;
    if (!sourceData || !isTypedArrayData(sourceData)) return;

    const srcData = (sourceData as { data: ArrayBufferView }).data as Uint8Array;

    // Upload all layers in one call
    device.queue.writeTexture(
        { texture: data.texture },
        srcData.buffer,
        {
            offset: srcData.byteOffset,
            bytesPerRow: width * bytesPerPixel,
            rowsPerImage: height,
        },
        [width, height, layerCount],
    );
}

/**
 * Upload user-supplied explicit mip levels (texture.mipmaps), one per level
 * starting at level 1 (level 0 is the primary source, already uploaded).
 *
 * Each mip Source carries its own dimensions. For array/cube textures the data
 * is packed across all layers (depth = layer count), uploaded in a single
 * writeTexture per level; for 2D it's a single image. Sources with no data or
 * not yet ready are skipped (their level keeps whatever was there).
 */
function uploadExplicitMips(device: GPUDevice, texture: GpuTexture, data: TextureData): void {
    const bytesPerPixel = getBytesPerPixel(texture.format);

    for (let i = 0; i < texture.mipmaps.length; i++) {
        const source = texture.mipmaps[i];
        if (!source.dataReady) continue;

        const img = source.data;
        if (!img) continue;

        const mipLevel = i + 1;
        const width = source.width;
        const height = source.height;
        const layers = Math.max(source.depth, 1);

        if (isTypedArrayData(img)) {
            const srcData = (img as { data: ArrayBufferView }).data;
            device.queue.writeTexture(
                { texture: data.texture, mipLevel },
                srcData.buffer,
                {
                    offset: srcData.byteOffset,
                    bytesPerRow: width * bytesPerPixel,
                    rowsPerImage: height,
                },
                [width, height, layers],
            );
        } else if (isExternalImage(img)) {
            device.queue.copyExternalImageToTexture(
                { source: img, flipY: texture.flipY },
                { texture: data.texture, premultipliedAlpha: texture.premultiplyAlpha, mipLevel },
                [width, height],
            );
        }
    }
}

/**
 * Get bytes per pixel for a format (simplified, handles common formats).
 */
function getBytesPerPixel(format: GPUTextureFormat): number {
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
            return 4; // Fallback
    }
}

/**
 * Get or create a 1x1 default placeholder texture.
 */
function getDefaultTexture(cache: TextureCache, device: GPUDevice, format: GPUTextureFormat): GPUTexture {
    let tex = cache.defaultTextures.get(format);
    if (tex) return tex;

    tex = device.createTexture({
        size: [1, 1],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // Write white pixel (or neutral value for non-color formats)
    const bytesPerPixel = getBytesPerPixel(format);
    const data = new Uint8Array(bytesPerPixel);
    data.fill(255); // White / max value

    device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: bytesPerPixel }, [1, 1]);

    cache.defaultTextures.set(format, tex);
    return tex;
}

/**
 * Get or create a sampler from Sampler settings.
 */
export function getSampler(cache: TextureCache, device: GPUDevice, gpuSampler: GpuSampler): GPUSampler {
    const key = gpuSampler.settingsKey;

    const data = cache.samplerCache.get(key);
    if (data) {
        data.usedTimes++;
        return data.sampler;
    }

    // WebGPU constraint: anisotropy > 1 requires all filters to be 'linear'
    let { minFilter, magFilter, mipmapFilter, maxAnisotropy } = gpuSampler;
    if (maxAnisotropy > 1) {
        if (minFilter !== 'linear' || magFilter !== 'linear' || mipmapFilter !== 'linear') {
            maxAnisotropy = 1;
        }
    }

    const sampler = device.createSampler({
        magFilter,
        minFilter,
        mipmapFilter,
        addressModeU: gpuSampler.addressModeU,
        addressModeV: gpuSampler.addressModeV,
        addressModeW: gpuSampler.addressModeW,
        maxAnisotropy,
        compare: gpuSampler.compare,
    });

    cache.samplerCache.set(key, { sampler, usedTimes: 1 });
    cache.samplerCount++;

    return sampler;
}

export function getTextureCacheStats(cache: TextureCache): TextureCacheStats {
    return {
        textureCount: cache.textureCount,
        samplerCount: cache.samplerCount,
    };
}

/**
 * Get cached TextureData for a GpuTexture.
 * Returns null if not in cache (call updateTexture first).
 */
export function getTextureData(cache: TextureCache, texture: GpuTexture): TextureData | null {
    return cache.textureMap.get(texture) ?? null;
}

/**
 * Default render-attachment view for a render-target color/depth texture.
 * Cached on the TextureData and recreated only when the GPU texture is swapped
 * (setRenderTargetTexture clears it), so attachment resolution doesn't allocate
 * a fresh GPUTextureView every frame.
 */
export function getRenderTargetView(data: TextureData): GPUTextureView {
    if (!data.view) {
        data.view = data.texture.createView();
    }
    return data.view;
}

/**
 * Cached view of the multisampled color texture for an MSAA render target.
 * Returns null when the target is not multisampled.
 */
export function getRenderTargetMsaaView(data: TextureData): GPUTextureView | null {
    if (!data.msaaTexture) return null;
    if (!data.msaaView) {
        data.msaaView = data.msaaTexture.createView();
    }
    return data.msaaView;
}

/**
 * Set the GPU texture resource for a render target texture.
 * Called by the renderer when creating/resizing render targets.
 *
 * Unlike regular textures which upload source data, render target textures
 * have their GPUTexture created externally and registered here.
 */
export function setRenderTargetTexture(
    cache: TextureCache,
    texture: GpuTexture,
    gpuTextureResource: GPUTexture,
    msaaTexture: GPUTexture | null = null,
): void {
    const existing = cache.textureMap.get(texture);

    if (existing) {
        if (existing.texture !== gpuTextureResource && !existing.isDefaultTexture) {
            existing.texture.destroy();
        }
        if (existing.msaaTexture && existing.msaaTexture !== msaaTexture) {
            existing.msaaTexture.destroy();
        }
        // Update existing entry with new GPU texture (e.g., after resize)
        existing.texture = gpuTextureResource;
        existing.msaaTexture = msaaTexture;
        existing.view = null; // cached attachment views belong to the old textures
        existing.msaaView = null;
        existing.generation++;
        existing.version = texture.version;
        existing.initialized = true;
        existing.isDefaultTexture = false;
    } else {
        // First time - create new entry
        cache.textureMap.set(texture, {
            texture: gpuTextureResource,
            msaaTexture,
            version: texture.version,
            generation: 1,
            initialized: true,
            isDefaultTexture: false,
        });
        cache.textureCount++;
    }

    texture.disposed = false;
    setupDispose(cache, texture);
}

/**
 * Remove a render target texture from the cache.
 * Called when render target is disposed/resized.
 * Does NOT destroy the GPUTexture - caller is responsible for that.
 */
export function removeRenderTargetTexture(cache: TextureCache, texture: GpuTexture): void {
    const data = cache.textureMap.get(texture);
    if (data) {
        // Don't destroy - caller handles that
        cache.textureMap.delete(texture);
        cache.textureCount--;
    }
}

function hasRenderTargetTextureAllocation(
    cache: TextureCache,
    texture: GpuTexture,
    width: number,
    height: number,
    format: GPUTextureFormat,
    sampleCount: number,
    mipLevelCount: number,
): boolean {
    // A disposed wrapper's cache entry still points at a destroyed GPUTexture whose
    // .width/.height/etc. read back stale-but-present; force reallocation so we never
    // build an attachment/view from a destroyed texture (dispose-then-reuse path).
    if (texture.disposed) return false;

    const data = cache.textureMap.get(texture);
    if (!data || data.isDefaultTexture) return false;

    const gpu = data.texture;
    return (
        gpu.width === width &&
        gpu.height === height &&
        gpu.format === format &&
        gpu.sampleCount === sampleCount &&
        gpu.mipLevelCount === mipLevelCount
    );
}

/**
 * Check the multisampled sibling of a render-target color texture matches the
 * desired sample count: present and sized correctly when `sampleCount > 1`,
 * absent when the target is single-sample.
 */
function hasMatchingMsaaAllocation(
    cache: TextureCache,
    texture: GpuTexture,
    width: number,
    height: number,
    format: GPUTextureFormat,
    sampleCount: number,
): boolean {
    const msaa = cache.textureMap.get(texture)?.msaaTexture;
    if (sampleCount <= 1) return !msaa;
    return !!msaa && msaa.width === width && msaa.height === height && msaa.format === format && msaa.sampleCount === sampleCount;
}

export function ensureRenderTargetTexturesAllocated(cache: TextureCache, device: GPUDevice, renderTarget: RenderTarget): void {
    if (renderTarget.isCubeRenderTarget) {
        ensureCubeRenderTargetTexturesAllocated(cache, device, renderTarget as CubeRenderTarget);
        return;
    }

    const { width, height } = renderTarget;
    const sampleCount = renderTarget.samples > 1 ? renderTarget.samples : 1;

    // Color attachments are sampled by shaders, so the cached `texture` is always the
    // single-sample resolve target; MSAA adds a multisampled sibling rendered into and
    // resolved from. Depth is kept at the pass sample count (all attachments must match).
    // NB: don't seed this from `textures.length === 0` — a depth-only target (count: 0)
    // has no color textures yet is fully allocated via its depth texture; seeding true
    // there would reallocate the depth every frame and destroy the one just rendered into.
    let needsAllocation = false;
    for (const tex of renderTarget.textures) {
        if (
            !hasRenderTargetTextureAllocation(cache, tex._gpuTexture, width, height, tex.format, 1, 1) ||
            !hasMatchingMsaaAllocation(cache, tex._gpuTexture, width, height, tex.format, sampleCount)
        ) {
            needsAllocation = true;
            break;
        }
    }

    if (!needsAllocation && renderTarget.depthTexture) {
        needsAllocation = !hasRenderTargetTextureAllocation(
            cache,
            renderTarget.depthTexture._gpuTexture,
            width,
            height,
            renderTarget.depthTexture.format,
            sampleCount,
            1,
        );
    }

    if (!needsAllocation) return;

    // Don't release (delete) the cache entries here: setRenderTargetTexture()
    // destroys the old GPU texture and bumps `generation` monotonically, which is
    // what bind-group change detection relies on to rebuild views. Deleting the
    // entry first would reset generation back to 1, so a bind group sampling this
    // target would keep a view of the destroyed texture (-> "destroyed texture
    // used in a submit").
    for (const tex of renderTarget.textures) {
        const resolveTexture = device.createTexture({
            size: [width, height],
            format: tex.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
            sampleCount: 1,
        });

        // RENDER_ATTACHMENT-only multisampled texture; it is rendered into and resolved
        // into resolveTexture, never sampled, so it needs no TEXTURE_BINDING/COPY_SRC.
        const msaaTexture =
            sampleCount > 1
                ? device.createTexture({
                      size: [width, height],
                      format: tex.format,
                      usage: GPUTextureUsage.RENDER_ATTACHMENT,
                      sampleCount,
                      mipLevelCount: 1,
                  })
                : null;

        setRenderTargetTexture(cache, tex._gpuTexture, resolveTexture, msaaTexture);
    }

    if (renderTarget.depthTexture) {
        const gpuDepthTexture = device.createTexture({
            size: [width, height],
            format: renderTarget.depthTexture.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            sampleCount,
        });
        setRenderTargetTexture(cache, renderTarget.depthTexture._gpuTexture, gpuDepthTexture);
    }
}

function ensureCubeRenderTargetTexturesAllocated(cache: TextureCache, device: GPUDevice, renderTarget: CubeRenderTarget): void {
    const cubeMipCount = renderTarget.texture.generateMipmaps ? Math.floor(Math.log2(renderTarget.size)) + 1 : 1;

    const cubeReady = hasRenderTargetTextureAllocation(
        cache,
        renderTarget.texture._gpuTexture,
        renderTarget.size,
        renderTarget.size,
        renderTarget.texture.format,
        1,
        cubeMipCount,
    );

    const depthReady =
        !renderTarget.depthTexture ||
        hasRenderTargetTextureAllocation(
            cache,
            renderTarget.depthTexture._gpuTexture,
            renderTarget.size,
            renderTarget.size,
            renderTarget.depthTexture.format,
            1,
            1,
        );

    if (cubeReady && depthReady) return;

    // See note in ensureRenderTargetTexturesAllocated: let setRenderTargetTexture()
    // destroy the old GPU texture and bump generation rather than releasing the
    // cache entry, so bind groups sampling this target are rebuilt on realloc.
    const colorTex = device.createTexture({
        dimension: '2d',
        size: [renderTarget.size, renderTarget.size, 6],
        format: renderTarget.texture.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        mipLevelCount: cubeMipCount,
        sampleCount: 1,
    });
    setRenderTargetTexture(cache, renderTarget.texture._gpuTexture, colorTex);

    if (renderTarget.depthTexture) {
        const depthTex = device.createTexture({
            size: [renderTarget.size, renderTarget.size],
            format: renderTarget.depthTexture.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            sampleCount: 1,
        });
        setRenderTargetTexture(cache, renderTarget.depthTexture._gpuTexture, depthTex);
    }
}
