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

import { GpuSampler } from '../core/gpu-sampler';
import { GpuTexture } from '../core/gpu-texture';
import type { Source } from '../texture/source';
import {
    type MipmapState,
    createMipmapState,
    generateMipmaps,
} from './mipmap-utils';

/** Data stored per Texture in the cache */
export type TextureData = {
    /** The GPU texture resource */
    texture: GPUTexture;
    /** Texture version at last upload — tracks when needsUpdate was set */
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
 * Update a texture — checks source version and uploads if needed.
 * Returns the TextureData for the texture.
 */
export function updateTexture(
    cache: TextureCache,
    device: GPUDevice,
    texture: GpuTexture,
): TextureData {
    let data = cache.textureMap.get(texture);

    // Skip if already initialized and texture version matches
    if (data?.initialized && data.version === texture.version) {
        return data;
    }

    const isCube = texture.viewDimension === 'cube' || texture.viewDimension === 'cube-array';
    const isArray = texture.viewDimension === '2d-array';

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

    // First time or was using default — create real GPU texture
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
            // Was default, now real — update generation
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

    // Generate mipmaps if requested and texture has multiple mip levels
    if (texture.generateMipmaps && data.texture.mipLevelCount > 1) {
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
    // Calculate mip level count if generating mipmaps
    const mipLevelCount = texture.generateMipmaps
        ? Math.floor(Math.log2(Math.max(texture.width, texture.height))) + 1
        : texture.mipLevelCount;

    const gpuTexture = device.createTexture({
        dimension: texture.dimension,
        size: [texture.width, texture.height, texture.depthOrArrayLayers],
        format: texture.format,
        usage: texture.usage | GPUTextureUsage.RENDER_ATTACHMENT, // RENDER_ATTACHMENT needed for mipmap generation
        mipLevelCount,
        sampleCount: texture.sampleCount,
    });

    return gpuTexture;
}

/**
 * Upload image data to a GPU texture.
 * Routes to the appropriate upload function based on viewDimension.
 */
function uploadTextureData(
    device: GPUDevice,
    texture: GpuTexture,
    data: TextureData,
): void {
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
            { source: sourceData },
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
function isExternalImage(data: unknown): data is ImageBitmap | HTMLCanvasElement | OffscreenCanvas | HTMLVideoElement | VideoFrame | ImageData {
    if (!data || typeof data !== 'object') return false;
    // Check for known browser types
    return (
        (typeof ImageBitmap !== 'undefined' && data instanceof ImageBitmap) ||
        (typeof HTMLCanvasElement !== 'undefined' && data instanceof HTMLCanvasElement) ||
        (typeof OffscreenCanvas !== 'undefined' && data instanceof OffscreenCanvas) ||
        (typeof HTMLVideoElement !== 'undefined' && data instanceof HTMLVideoElement) ||
        (typeof VideoFrame !== 'undefined' && data instanceof VideoFrame) ||
        (typeof ImageData !== 'undefined' && data instanceof ImageData)
    );
}

/**
 * Upload cube texture data — copies each of the 6 face images to the
 * corresponding array layer of the GPU texture.
 *
 * Face order: +X, -X, +Y, -Y, +Z, -Z (matches sources array).
 */
function uploadCubeTextureData(
    device: GPUDevice,
    texture: GpuTexture,
    data: TextureData,
): void {
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
                { source: faceData },
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
 * Upload array texture data — copies each layer's data to the corresponding
 * array layer of the GPU texture.
 *
 * Supports two modes:
 * 1. Per-layer sources: texture.sources contains one Source per layer
 * 2. Packed source: texture.source contains all layers packed sequentially
 */
function uploadArrayTextureData(
    device: GPUDevice,
    texture: GpuTexture,
    data: TextureData,
): void {
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
                    { source: layerData },
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
 * Get bytes per pixel for a format (simplified — handles common formats).
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

    device.queue.writeTexture(
        { texture: tex },
        data,
        { bytesPerRow: bytesPerPixel },
        [1, 1],
    );

    cache.defaultTextures.set(format, tex);
    return tex;
}

/**
 * Get or create a sampler from Sampler settings.
 */
export function getSampler(
    cache: TextureCache,
    device: GPUDevice,
    gpuSampler: GpuSampler
): GPUSampler {
    const key = gpuSampler.settingsKey;

    let data = cache.samplerCache.get(key);
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
): void {
    const existing = cache.textureMap.get(texture);
    
    if (existing) {
        // Update existing entry with new GPU texture (e.g., after resize)
        existing.texture = gpuTextureResource;
        existing.generation++;
        existing.initialized = true;
        existing.isDefaultTexture = false;
    } else {
        // First time - create new entry
        cache.textureMap.set(texture, {
            texture: gpuTextureResource,
            version: texture.version,
            generation: 1,
            initialized: true,
            isDefaultTexture: false,
        });
        cache.textureCount++;
        setupDispose(cache, texture);
    }
}

/**
 * Remove a render target texture from the cache.
 * Called when render target is disposed/resized.
 * Does NOT destroy the GPUTexture - caller is responsible for that.
 */
export function removeRenderTargetTexture(
    cache: TextureCache,
    texture: GpuTexture,
): void {
    const data = cache.textureMap.get(texture);
    if (data) {
        // Don't destroy - caller handles that
        cache.textureMap.delete(texture);
        cache.textureCount--;
    }
}
