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
import type { TextureRegion } from '../../core/texture-region';
import { hasTypedPartialSource, supportsPartialUpload, withinPartialBudget } from '../core/partial-upload';
import {
    createTextureTally,
    createTextureTallyEntry,
    type TextureTally,
    type TextureTallyEntry,
    tallyClearTexture,
    tallySetTexture,
} from '../core/info';
import { bytesPerTexel, gpuTextureBytes } from '../core/texture-size';
import type { Source } from '../../texture/source';
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

export function createTextureCache(): TextureCache {
    return {
        textureMap: new WeakMap(),
        defaultTextures: new Map(),
        mipmapState: null,
        tally: createTextureTally(),
    };
}

/**
 * Set up the _onDispose callback on a GpuTexture to destroy its GPU texture.
 * Only sets the callback once (idempotent).
 */
export function setupTextureDispose(cache: TextureCache, texture: GpuTexture): void {
    if (texture._onDispose) return;

    texture._onDispose = () => {
        const data = cache.textureMap.get(texture);
        if (data && !data.isDefaultTexture) {
            data.texture.destroy();
            data.msaaTexture?.destroy();
        }
        // Stop counting it whether or not it owned its GPU texture; a default-texture entry
        // contributes nothing, so clearing is a no-op there.
        if (data) tallyClearTexture(cache.tally, data.tally);
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

/**
 * Update a texture, checks source version and uploads if needed.
 * Returns the TextureData for the texture.
 */
function uploadPartialRegion(device: GPUDevice, texture: GpuTexture, data: TextureData, r: TextureRegion): void {
    const bpp = bytesPerTexel(texture.format);

    // Level 0 with per-layer/face sources: each layer owns its own buffer. `z` indexes
    // `texture.sources`, which is the face for a cube and the layer for an array.
    if (r.level === 0 && texture.sources.length > 0) {
        const bytesPerRow = texture.width * bpp;
        for (let i = 0; i < r.depth; i++) {
            const layer = r.z + i;
            const source = texture.sources[layer];
            if (!source?.dataReady || !source.data || !isTypedArrayData(source.data)) continue;
            const view = (source.data as { data: ArrayBufferView }).data;
            device.queue.writeTexture(
                { texture: data.texture, mipLevel: 0, origin: { x: r.x, y: r.y, z: layer } },
                view.buffer,
                {
                    // Full-stride rows plus a start offset: the sub-rect is read straight out of the
                    // packed buffer, with no tightly-packed staging copy.
                    offset: view.byteOffset + r.y * bytesPerRow + r.x * bpp,
                    bytesPerRow,
                    rowsPerImage: texture.height,
                },
                [r.width, r.height, 1],
            );
        }
        return;
    }

    // Packed source: level 0 uses `source`, higher levels their explicit mip (also packed, all layers).
    const source = r.level === 0 ? texture.source : texture.mipmaps[r.level - 1];
    if (!source || !source.dataReady || !source.data || !isTypedArrayData(source.data)) return;
    const view = (source.data as { data: ArrayBufferView }).data;
    const levelWidth = r.level === 0 ? texture.width : Math.max(1, source.width);
    const levelHeight = r.level === 0 ? texture.height : Math.max(1, source.height);
    const bytesPerRow = levelWidth * bpp;

    // `rowsPerImage` is the level's FULL height, which is what keeps the inter-layer stride right, so a
    // multi-layer region lands in one write even when it covers only some rows of each layer.
    device.queue.writeTexture(
        { texture: data.texture, mipLevel: r.level, origin: { x: r.x, y: r.y, z: r.z } },
        view.buffer,
        {
            offset: view.byteOffset + (r.z * levelHeight + r.y) * bytesPerRow + r.x * bpp,
            bytesPerRow,
            rowsPerImage: levelHeight,
        },
        [r.width, r.height, r.depth],
    );
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

    // Partial upload: an in-place `packAtIndex`/`addUpdateRegion` queued dirty boxes (no full flag, no
    // resize) → `writeTexture` only those instead of the whole texture. A full flag (`needsUpdate`/grow)
    // or size change takes priority; `> ½` dirty falls through to a full upload.
    //
    // Regions are honoured exactly, sub-rect and mip level included: a full-stride `bytesPerRow` plus a
    // start offset reads the box straight out of the packed source, with no staging copy.
    if (
        data?.initialized &&
        !data.isDefaultTexture &&
        !texture.needsFullUpload &&
        texture.updateRegions.length > 0 &&
        supportsPartialUpload(texture) &&
        !texture.type.type.startsWith('texture_storage_') &&
        data.texture.width === texture.width &&
        data.texture.height === texture.height &&
        data.texture.depthOrArrayLayers === texture.depthOrArrayLayers &&
        hasTypedPartialSource(texture)
    ) {
        if (withinPartialBudget(texture, texture.updateRegions)) {
            for (const r of texture.updateRegions) uploadPartialRegion(device, texture, data, r);
            // Auto-generated mips go stale the moment level 0 moves. (An explicit chain instead gets
            // per-level regions derived at `addUpdateRegion` time, so it is already covered above.)
            if (texture.mipmaps.length === 0 && texture.generateMipmaps && data.texture.mipLevelCount > 1) {
                const isCubeTex = texture.viewDimension === 'cube' || texture.viewDimension === 'cube-array';
                const isArrayTex = texture.viewDimension === '2d-array';
                generateMipmaps(
                    getMipmapState(cache, device),
                    data.texture,
                    isCubeTex,
                    isArrayTex ? texture.depthOrArrayLayers : 0,
                );
            }
            texture.updateRegions.length = 0;
            data.version = texture.version;
            return data;
        }
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
                tally: createTextureTallyEntry(),
            };
            cache.textureMap.set(texture, data);
            tallySetTexture(cache.tally, data.tally, texture.format, gpuTextureBytes(texture));
            setupTextureDispose(cache, texture);
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
                // Never tallied: the placeholder is one shared 1x1 texture, not this texture's storage.
                tally: createTextureTallyEntry(),
            };
            cache.textureMap.set(texture, data);
        }
        return data;
    }

    // First time, was using default, or resized (grow) → (re)create the real GPU texture at the current
    // size. WebGPU textures are immutable-size, so a grow must destroy + recreate before the full upload.
    const sizeChanged =
        !!data && !data.isDefaultTexture && (data.texture.width !== texture.width || data.texture.height !== texture.height);
    if (!data || data.isDefaultTexture || sizeChanged) {
        const gpuTextureResource = createGPUTexture(device, texture);

        if (!data) {
            data = {
                texture: gpuTextureResource,
                version: texture.version,
                generation: texture.version,
                initialized: true,
                isDefaultTexture: false,
                tally: createTextureTallyEntry(),
            };
            cache.textureMap.set(texture, data);
            tallySetTexture(cache.tally, data.tally, texture.format, gpuTextureBytes(texture));
        } else if (data.isDefaultTexture) {
            // Was default, now real, update generation
            data.texture = gpuTextureResource;
            data.generation = texture.version;
            data.isDefaultTexture = false;
            tallySetTexture(cache.tally, data.tally, texture.format, gpuTextureBytes(texture));
        } else {
            // Resize (grow): destroy the old GPU texture and swap in the new (larger) one.
            data.texture.destroy();
            data.texture = gpuTextureResource;
            data.generation = texture.version;
            // Re-tally rather than re-count: the entry already counts as one texture, but its bytes moved.
            tallySetTexture(cache.tally, data.tally, texture.format, gpuTextureBytes(texture));
        }

        // Set up disposal callback to destroy the GPU texture
        setupTextureDispose(cache, texture);
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

    // A full (re)upload supersedes any queued partial regions and clears the full flag.
    texture.updateRegions.length = 0;
    texture.needsFullUpload = false;

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
        const bytesPerPixel = bytesPerTexel(texture.format);
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
    const bytesPerPixel = bytesPerTexel(texture.format);
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
    const bytesPerPixel = bytesPerTexel(texture.format);

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
    const bytesPerPixel = bytesPerTexel(format);
    const data = new Uint8Array(bytesPerPixel);
    data.fill(255); // White / max value

    device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: bytesPerPixel }, [1, 1]);

    cache.defaultTextures.set(format, tex);
    return tex;
}

export function getTextureCacheStats(cache: TextureCache): TextureCacheStats {
    return { textureCount: cache.tally.count };
}

/**
 * Get cached TextureData for a GpuTexture.
 * Returns null if not in cache (call updateTexture first).
 */
export function getTextureData(cache: TextureCache, texture: GpuTexture): TextureData | null {
    return cache.textureMap.get(texture) ?? null;
}
