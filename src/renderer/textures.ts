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
import type { CubeTexture } from '../texture/cube-texture';
import {
    type MipmapState,
    createMipmapState,
    generateMipmaps,
} from './mipmap-utils';

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
    /** Texture data keyed by Texture object */
    textureMap: WeakMap<Texture, TextureData>;

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

// ---------------------------------------------------------------------------
// Cache creation
// ---------------------------------------------------------------------------

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
 * Set up the _onDispose callback on a Texture to destroy its GPU texture.
 * Only sets the callback once (idempotent).
 */
function setupDispose(cache: TextureCache, texture: Texture): void {
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
    device: GPUDevice,
    texture: Texture,
): TextureData {
    let data = cache.textureMap.get(texture);
    const source = texture.source;

    // Skip if already initialized and texture version matches (Three.js aligned)
    if (data?.initialized && data.version === texture.version) {
        return data;
    }

    const image = source.data;
    const isCube = 'isCubeTexture' in texture && texture.isCubeTexture === true;

    // No image data yet or not ready — use default placeholder.
    // For cube textures, check isComplete (all 6 faces present and ready).
    const notReady = isCube
        ? !(texture as unknown as CubeTexture).isComplete
        : !image || !source.dataReady || (image as HTMLImageElement).complete === false;

    if (notReady) {
        if (!data) {
            const format = texture.format ?? 'rgba8unorm';
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
        const gpuTexture = createGPUTexture(device, texture);

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

        // Set up disposal callback to destroy the GPU texture
        setupDispose(cache, texture);
    }

    // Upload image data
    uploadTextureData(device, texture, data);

    // Generate mipmaps if requested and texture has multiple mip levels
    if (texture.generateMipmaps && data.texture.mipLevelCount > 1) {
        const mipmapState = getMipmapState(cache, device);
        const isCube = 'isCubeTexture' in texture && texture.isCubeTexture === true;
        generateMipmaps(mipmapState, data.texture, isCube);
    }

    // Update texture version (Three.js aligned: textureData.version = texture.version)
    data.version = texture.version;
    data.initialized = true;

    return data;
}

/**
 * Create a GPUTexture for a Texture.
 */
function createGPUTexture(device: GPUDevice, texture: Texture): GPUTexture {
    const width = texture.width;
    const height = texture.height;
    const format = texture.format ?? 'rgba8unorm';
    const isCube = 'isCubeTexture' in texture && texture.isCubeTexture === true;

    // Calculate mip level count if generating mipmaps
    const mipLevelCount = texture.generateMipmaps
        ? Math.floor(Math.log2(Math.max(width, height))) + 1
        : 1;

    const gpuTexture = device.createTexture({
        // Cube textures use dimension '2d' (the default) with 6 array layers.
        // The cube view dimension is set when creating the texture view, not here.
        size: [width, height, isCube ? 6 : 1],
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
    device: GPUDevice,
    texture: Texture,
    data: TextureData,
): void {
    const isCube = 'isCubeTexture' in texture && texture.isCubeTexture === true;

    if (isCube) {
        uploadCubeTextureData(device, texture as unknown as CubeTexture, data);
        return;
    }

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
        device.queue.writeTexture(
            { texture: data.texture },
            srcData.buffer,
            { offset: srcData.byteOffset, bytesPerRow: width * bytesPerPixel, rowsPerImage: height },
            [width, height],
        );
    } else {
        // HTMLImageElement, ImageBitmap, Canvas, Video, etc.
        device.queue.copyExternalImageToTexture(
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
}

/**
 * Upload cube texture data — copies each of the 6 face images to the
 * corresponding array layer of the GPU texture.
 *
 * Face order: +X, -X, +Y, -Y, +Z, -Z (matches CubeTexture.imageSources).
 */
function uploadCubeTextureData(
    device: GPUDevice,
    texture: CubeTexture,
    data: TextureData,
): void {
    const faces = texture.imageSources;
    if (faces.length !== 6) return;

    const width = texture.width;
    const height = texture.height;

    for (let faceIndex = 0; faceIndex < 6; faceIndex++) {
        const face = faces[faceIndex];
        if (!face.dataReady) continue;

        const faceImage = face.data;
        if (!faceImage) continue;

        device.queue.copyExternalImageToTexture(
            {
                source: faceImage as ImageBitmap | HTMLCanvasElement | OffscreenCanvas | HTMLVideoElement | VideoFrame | ImageData,
            },
            {
                texture: data.texture,
                premultipliedAlpha: texture.premultiplyAlpha,
                origin: { x: 0, y: 0, z: faceIndex },
            },
            [width, height],
        );
    }
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
export function getDefaultTexture(cache: TextureCache, device: GPUDevice, format: GPUTextureFormat): GPUTexture {
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

// ---------------------------------------------------------------------------
// Sampler operations
// ---------------------------------------------------------------------------

/**
 * Get or create a sampler from SamplerNode settings.
 * Uses the SamplerNode's settingsKey for caching.
 */
export function getSamplerFromNode(
    cache: TextureCache,
    device: GPUDevice,
    samplerNode: {
        settingsKey: string;
        minFilter: GPUFilterMode;
        magFilter: GPUFilterMode;
        mipmapFilter: GPUMipmapFilterMode;
        addressModeU: GPUAddressMode;
        addressModeV: GPUAddressMode;
        addressModeW: GPUAddressMode;
        maxAnisotropy: number;
        compare?: GPUCompareFunction;
    }
): GPUSampler {
    const key = samplerNode.settingsKey;

    let data = cache.samplerCache.get(key);
    if (data) {
        data.usedTimes++;
        return data.sampler;
    }

    // WebGPU constraint: anisotropy > 1 requires all filters to be 'linear'
    let { minFilter, magFilter, mipmapFilter, maxAnisotropy } = samplerNode;
    if (maxAnisotropy > 1) {
        if (minFilter !== 'linear' || magFilter !== 'linear' || mipmapFilter !== 'linear') {
            maxAnisotropy = 1;
        }
    }

    const sampler = device.createSampler({
        magFilter,
        minFilter,
        mipmapFilter,
        addressModeU: samplerNode.addressModeU,
        addressModeV: samplerNode.addressModeV,
        addressModeW: samplerNode.addressModeW,
        maxAnisotropy,
        compare: samplerNode.compare,
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
