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
import type { TextureViewRange } from '../../core/gpu-texture-view';
import type { TextureRegion } from '../../core/texture-region';
import { type Allocation, type MemoryTally } from '../core/info';
import { type BindGroupCache } from './bind-group-cache';
import { type BindGroupData } from './bindings';
import { type MipmapState } from './mipmap-utils';
/** Data stored per Texture in the cache */
/** What a render target attachment's allocation was last checked against. */
export type AllocatedLayout = {
    texture: GPUTexture;
    width: number;
    height: number;
    samples: number;
    storage: boolean;
    layers: number;
    mipLevelCount: number;
    format: GPUTextureFormat;
    dimension: string;
};
export type TextureData = {
    /** The GPU texture resource */
    texture: GPUTexture;
    /** Texture version at last upload, tracks when needsUpdate was set */
    version: number;
    /** Generation, increments when GPU texture object is recreated */
    generation: number;
    /**
     * For a render target's attachment, the layout it was last found allocated for, and the GPU texture then: while
     * both hold, it still is (see render-target.ts `isAllocated`).
     */
    allocatedLayout?: AllocatedLayout;
    /** Whether this texture has been initialized */
    initialized: boolean;
    /** Whether this is a default placeholder texture */
    isDefaultTexture: boolean;
    /** the bind groups that have bound it, whose variants its dispose clears: none may bind it again */
    bindGroups?: Set<BindGroupData>;
    /** What this entry currently contributes to `TextureCache.tally`. */
    allocation: Allocation;
    /** `msaaTextures`' contribution, made with the first. */
    msaaAllocation: Allocation | null;
    /**
     * Cached default render-attachment view (render target color/depth).
     * Lazily created by the renderer and cleared whenever `texture` is swapped
     * (see setRenderTargetTexture), so we don't allocate a GPUTextureView per frame.
     */
    view?: GPUTextureView | null;
    /**
     * A multisampled render target's multisampled textures, one per layer: a multisampled texture has one layer and
     * one mip. A pass on a layer draws into its own, so one that keeps what was drawn loads that layer's samples. A
     * colour attachment resolves each into its layer of `texture`, which shaders sample; a depth attachment is never
     * resolved, and its `texture` is the first of them. Undefined for a single-sampled target.
     */
    msaaTextures?: GPUTexture[] | null;
    /** the format a render target allocated in its linear twin is drawn and sampled in (`RenderTargetOptions.storage`);
     *  undefined where views take the texture's own */
    viewFormat?: GPUTextureFormat;
    /** Each of `msaaTextures`' views, made with it. */
    msaaViews?: GPUTextureView[] | null;
    /** The views bindings take of `texture`, by range, dimension and aspect; made for `rangeViewsOf`, and dropped when
     *  `texture` is another allocation. */
    rangeViews?: Map<string, GPUTextureView>;
    rangeViewsOf?: GPUTexture;
};
/**
 * The view a binding takes of `range` of `data`'s texture, made once per range and allocation. `dimension` is the
 * binding's; `depthOnly` binds a combined depth-stencil texture's depth, which is all a sampled binding may see of it.
 */
export declare function rangeView(data: TextureData, range: TextureViewRange, dimension: GPUTextureViewDimension, depthOnly: boolean, storage?: boolean): GPUTextureView;
/**
 * What a view in `format` is used for: undefined, the texture's every usage, for a view in the texture's own format;
 * only drawing and sampling for a render target's sRGB view of its linear storage allocation, which storage can't use.
 */
export declare function viewUsage(format: GPUTextureFormat | undefined): GPUTextureUsageFlags | undefined;
/**
 * The view a pass attaches of `data`'s texture: mip `mipLevel` of layer `layer`, or of a 3D texture the whole mip, whose
 * slice the attachment's `depthSlice` picks. Made once per mip and layer and allocation, in the views bindings take.
 */
export declare function attachmentView(data: TextureData, mipLevel: number, layer: number, is3d: boolean): GPUTextureView;
/** Cache for textures. Samplers live in `samplers.ts`, their own resource module. */
export type TextureCache = {
    /** Texture data keyed by GpuTexture object */
    textureMap: WeakMap<GpuTexture, TextureData>;
    /** Default placeholder textures by format, kept for the renderer's life: bounded by the formats there are. */
    defaultTextures: Map<GPUTextureFormat, GPUTexture>;
    /** Mipmap generation state (created lazily on first use) */
    mipmapState: MipmapState | null;
    /** The backend's memory tally, shared with its buffers. */
    tally: MemoryTally;
    /** The bind group cache, whose entries naming a texture go when it is destroyed. */
    bindGroups: BindGroupCache;
};
export declare function createTextureCache(tally: MemoryTally, bindGroups: BindGroupCache): TextureCache;
/** A fresh entry's allocations: counted as `sampled` until a render target files it as an attachment. */
export declare function textureAllocations(texture: GpuTexture): Pick<TextureData, 'allocation' | 'msaaAllocation'>;
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
export declare function generateTextureMipmaps(cache: TextureCache, device: GPUDevice, texture: GpuTexture, encoder?: GPUCommandEncoder): void;
/**
 * Update a texture, checks source version and uploads if needed.
 * Returns the TextureData for the texture.
 */
export declare function updateTexture(cache: TextureCache, device: GPUDevice, texture: GpuTexture): TextureData;
/** `writeTexture` for WebGPU: a queue write of one box from packed `data`, which copies before returning. */
export declare function writeTextureRegion(cache: TextureCache, device: GPUDevice, texture: GpuTexture, region: TextureRegion, data: ArrayBufferView): void;
/**
 * Tear down the cache (called on renderer dispose).
 *
 * `device.destroy()` releases the GPU objects, so this is about JS state: the placeholder textures and
 * mipmap pipelines are destroyed explicitly because they are shared and not owned by any GpuTexture,
 * and the map is REPLACED rather than emptied so a `GpuTexture` outliving its renderer cannot find a
 * stale entry and destroy through a dead device. The WebGL sibling does the same for the same reason.
 */
export declare function disposeTextureCache(cache: TextureCache): void;
/**
 * Get cached TextureData for a GpuTexture.
 * Returns null if not in cache (call updateTexture first).
 */
export declare function getTextureData(cache: TextureCache, texture: GpuTexture): TextureData | null;
