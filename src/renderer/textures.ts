/**
 * textures.ts — GPUTexture/GPUSampler cache and upload helpers.
 *
 * Three.js aligned: Uses WeakMap-based caching keyed by Texture object.
 * Tracks texture.version for cache invalidation (Three.js pattern).
 * Samplers are shared/cached by parameter key for efficiency.
 *
 * Flow (aligned with Three.js Textures.js + WebGPUTextureUtils.js):
 * 1. `updateTexture()` is called during binding updates (before draw)
 * 2. Checks texture.version — skips if already up to date
 * 3. Creates GPU texture if needed
 * 4. Uploads image data if source.dataReady
 * 5. Updates version tracking (textureData.version = texture.version)
 */

import type { Texture } from '../texture/texture';
import type { DataTexture } from '../texture/data-texture';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
    /** GPUDevice for creating resources */
    device: GPUDevice;

    /** Texture data keyed by Texture object */
    textureMap: WeakMap<Texture, TextureData>;

    /** Sampler cache keyed by parameter string */
    samplerCache: Map<string, SamplerData>;

    /** Default placeholder textures by format */
    defaultTextures: Map<GPUTextureFormat, GPUTexture>;

    /** Stats counters */
    textureCount: number;
    samplerCount: number;
};

export type TextureCacheStats = {
    textureCount: number;
    samplerCount: number;
};

// ---------------------------------------------------------------------------
// Cache creation
// ---------------------------------------------------------------------------

export function createTextureCache(device: GPUDevice): TextureCache {
    return {
        device,
        textureMap: new WeakMap(),
        samplerCache: new Map(),
        defaultTextures: new Map(),
        textureCount: 0,
        samplerCount: 0,
    };
}

// ---------------------------------------------------------------------------
// Texture operations
// ---------------------------------------------------------------------------

/**
 * Update a texture — checks source version and uploads if needed.
 * Three.js aligned: called during binding updates before draw.
 *
 * Returns the TextureData for the texture.
 */
export function updateTexture(
    cache: TextureCache,
    texture: Texture,
): TextureData {
    let data = cache.textureMap.get(texture);
    const source = texture.source;

    // Skip if already initialized and texture version matches (Three.js aligned)
    if (data?.initialized && data.version === texture.version) {
        return data;
    }

    const image = source.data;

    // No image data yet or not ready — use default placeholder
    if (!image || !source.dataReady || (image as HTMLImageElement).complete === false) {
        if (!data) {
            const format = texture.format ?? 'rgba8unorm';
            const defaultTex = getDefaultTexture(cache, format);
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
        const gpuTexture = createGPUTexture(cache, texture);

        if (!data) {
            data = {
                texture: gpuTexture,
                version: texture.version,
                generation: texture.version,
                initialized: true,
                isDefaultTexture: false,
            };
            cache.textureMap.set(texture, data);
            cache.textureCount++;
        } else {
            // Was default, now real — update generation
            data.texture = gpuTexture;
            data.generation = texture.version;
            data.isDefaultTexture = false;
            cache.textureCount++;
        }
    }

    // Upload image data
    uploadTextureData(cache, texture, data);

    // Update texture version (Three.js aligned: textureData.version = texture.version)
    data.version = texture.version;
    data.initialized = true;

    return data;
}

/**
 * Create a GPUTexture for a Texture.
 */
function createGPUTexture(cache: TextureCache, texture: Texture): GPUTexture {
    const width = texture.width;
    const height = texture.height;
    const format = texture.format ?? 'rgba8unorm';

    // Calculate mip level count if generating mipmaps
    const mipLevelCount = texture.generateMipmaps
        ? Math.floor(Math.log2(Math.max(width, height))) + 1
        : 1;

    const gpuTexture = cache.device.createTexture({
        size: [width, height],
        format,
        usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT, // Needed for mipmap generation
        mipLevelCount,
    });

    return gpuTexture;
}

/**
 * Upload image data to a GPU texture.
 */
function uploadTextureData(
    cache: TextureCache,
    texture: Texture,
    data: TextureData,
): void {
    const image = texture.image;
    if (!image) return;

    const width = texture.width;
    const height = texture.height;

    // Check if it's a DataTexture with raw array data
    if ('isDataTexture' in texture && (texture as DataTexture).data) {
        const dataTexture = texture as DataTexture;
        const format = texture.format ?? 'rgba8unorm';
        const bytesPerPixel = getBytesPerPixel(format);

        const srcData = dataTexture.data!;
        cache.device.queue.writeTexture(
            { texture: data.texture },
            srcData.buffer,
            { offset: srcData.byteOffset, bytesPerRow: width * bytesPerPixel, rowsPerImage: height },
            [width, height],
        );
    } else {
        // HTMLImageElement, ImageBitmap, Canvas, Video, etc.
        cache.device.queue.copyExternalImageToTexture(
            {
                source: image as ImageBitmap | HTMLCanvasElement | OffscreenCanvas | HTMLVideoElement | VideoFrame | ImageData,
            },
            {
                texture: data.texture,
                premultipliedAlpha: texture.premultiplyAlpha,
            },
            [width, height],
        );
    }

    // TODO: Generate mipmaps if texture.generateMipmaps is true
    // This requires a compute or render pass — for now we just use mip level 0
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

// ---------------------------------------------------------------------------
// Default textures
// ---------------------------------------------------------------------------

/**
 * Get or create a 1x1 default placeholder texture.
 * Three.js aligned: uses white pixel for color textures.
 */
export function getDefaultTexture(cache: TextureCache, format: GPUTextureFormat): GPUTexture {
    let tex = cache.defaultTextures.get(format);
    if (tex) return tex;

    tex = cache.device.createTexture({
        size: [1, 1],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // Write white pixel (or neutral value for non-color formats)
    const bytesPerPixel = getBytesPerPixel(format);
    const data = new Uint8Array(bytesPerPixel);
    data.fill(255); // White / max value

    cache.device.queue.writeTexture(
        { texture: tex },
        data,
        { bytesPerRow: bytesPerPixel },
        [1, 1],
    );

    cache.defaultTextures.set(format, tex);
    return tex;
}

// ---------------------------------------------------------------------------
// Sampler operations
// ---------------------------------------------------------------------------

/**
 * Compute a cache key for sampler parameters.
 * Three.js aligned: concatenates all sampler properties.
 */
function computeSamplerKey(texture: Texture): string {
    return `${texture.minFilter}-${texture.magFilter}-${texture.mipmapFilter}-${texture.wrapS}-${texture.wrapT}-${texture.anisotropy}`;
}

/**
 * Get or create a sampler for a texture's sampling parameters.
 * Samplers are shared/cached by parameter key.
 */
export function getSampler(cache: TextureCache, texture: Texture): GPUSampler {
    const key = computeSamplerKey(texture);

    let data = cache.samplerCache.get(key);
    if (data) {
        data.usedTimes++;
        return data.sampler;
    }

    const sampler = cache.device.createSampler({
        magFilter: texture.magFilter,
        minFilter: texture.minFilter,
        mipmapFilter: texture.mipmapFilter,
        addressModeU: texture.wrapS,
        addressModeV: texture.wrapT,
        maxAnisotropy: texture.anisotropy,
    });

    cache.samplerCache.set(key, { sampler, usedTimes: 1 });
    cache.samplerCount++;

    return sampler;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function getTextureCacheStats(cache: TextureCache): TextureCacheStats {
    return {
        textureCount: cache.textureCount,
        samplerCount: cache.samplerCount,
    };
}
