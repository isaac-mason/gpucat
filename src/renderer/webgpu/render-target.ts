/**
 * render-target.ts (webgpu) - `RenderTarget` attachment allocation and views, the WebGPU sibling of
 * `webgl/render-target.ts`.
 *
 * The two differ in what there is to own, and that difference is the API's, not a decomposition
 * choice: GL needs real framebuffer objects and renderbuffers, so its module carries a cache of them.
 * WebGPU has no framebuffer object at all - a render target IS its textures plus the views bound as
 * attachments - so this module owns no state and operates on the texture cache. What it does own is
 * the knowledge of RenderTarget semantics: when an attachment has to be reallocated, how an MSAA
 * sibling is paired with its resolve target, and how a cube target's six faces are allocated.
 */

import type { GpuTexture } from '../../core/gpu-texture';
import type { RenderTarget } from '../../core/render-target';
import { clearAllocation, createAllocation, setAllocation } from '../core/info';
import { estimatedBytesPerTexel } from '../core/texture-size';
import { releaseGroupsNaming } from './bind-group-cache';
import { setupTextureDispose, type TextureCache, type TextureData, textureAllocations, viewUsage } from './textures';

/** What the device was asked for: every layer and mip level, times the sample count. */
export function allocatedBytes(gpu: GPUTexture): number {
    const perTexel = estimatedBytesPerTexel(gpu.format);
    let bytes = 0;
    for (let level = 0; level < gpu.mipLevelCount; level++) {
        bytes += Math.max(1, gpu.width >> level) * Math.max(1, gpu.height >> level) * perTexel;
    }
    return bytes * gpu.depthOrArrayLayers * gpu.sampleCount;
}

function isDepthFormat(format: GPUTextureFormat): boolean {
    return format.startsWith('depth') || format.startsWith('stencil');
}

/**
 * A target's attachments, filed as `depth` or `render-target`, and a colour attachment's multisampled textures as
 * `msaa`. A multisampled depth is only its multisampled textures, filed as `depth`.
 */
function tallyAttachments(cache: TextureCache, data: TextureData): void {
    const gpu = data.texture;
    const msaa = data.msaaTextures ?? null;
    const msaaBytes = msaa === null ? 0 : msaa.reduce((bytes, texture) => bytes + allocatedBytes(texture), 0);
    if (isDepthFormat(gpu.format)) {
        setAllocation(cache.tally, data.allocation, msaa === null ? allocatedBytes(gpu) : msaaBytes, 'depth', gpu.format);
        return;
    }
    setAllocation(cache.tally, data.allocation, allocatedBytes(gpu), 'render-target', gpu.format);
    if (msaa !== null) {
        data.msaaAllocation ??= createAllocation('texture', 'msaa', data.allocation.label);
        setAllocation(cache.tally, data.msaaAllocation, msaaBytes, 'msaa', gpu.format);
    } else if (data.msaaAllocation) clearAllocation(cache.tally, data.msaaAllocation);
}

/**
 * Default render-attachment view for a render-target color/depth texture.
 * Cached on the TextureData and recreated only when the GPU texture is swapped
 * (setRenderTargetTexture clears it), so attachment resolution doesn't allocate
 * a fresh GPUTextureView every frame.
 */
export function getRenderTargetView(data: TextureData): GPUTextureView {
    if (!data.view) {
        data.view = data.texture.createView({ format: data.viewFormat, usage: viewUsage(data.viewFormat) });
    }
    return data.view;
}

/** The view of layer `layer`'s multisampled texture, or null for a single-sampled target. */
export function getRenderTargetMsaaView(data: TextureData, layer: number): GPUTextureView | null {
    const msaa = data.msaaTextures;
    if (!msaa) return null;
    data.msaaViews ??= msaa.map((texture) => texture.createView());
    return data.msaaViews[layer]!;
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
    msaaTextures: GPUTexture[] | null = null,
): void {
    const existing = cache.textureMap.get(texture);

    if (existing) {
        if (existing.texture !== gpuTextureResource && !existing.isDefaultTexture) {
            releaseGroupsNaming(cache.bindGroups, existing.texture);
            existing.texture.destroy();
        }
        if (existing.msaaTextures) {
            for (const msaa of existing.msaaTextures) {
                if (msaa !== existing.texture && !msaaTextures?.includes(msaa)) msaa.destroy();
            }
        }
        // Update existing entry with new GPU texture (e.g., after resize)
        existing.texture = gpuTextureResource;
        existing.msaaTextures = msaaTextures;
        existing.view = null; // cached attachment views belong to the old textures
        existing.msaaViews = null;
        existing.generation++;
        existing.version = texture.version;
        existing.initialized = true;
        existing.isDefaultTexture = false;
        // Resize swaps the GPU texture under the same entry: same count, different bytes.
        tallyAttachments(cache, existing);
    } else {
        const entry: TextureData = {
            texture: gpuTextureResource,
            msaaTextures,
            version: texture.version,
            generation: 1,
            initialized: true,
            isDefaultTexture: false,
            ...textureAllocations(texture),
        };
        cache.textureMap.set(texture, entry);
        tallyAttachments(cache, entry);
    }

    texture.disposed = false;
    setupTextureDispose(cache, texture);
}

/** `format`'s linear twin where it is sRGB, which a storage binding can take; `format` itself otherwise */
function storageFormatOf(format: GPUTextureFormat): GPUTextureFormat {
    return format.endsWith('-srgb') ? (format.slice(0, -'-srgb'.length) as GPUTextureFormat) : format;
}

/**
 * The allocation an attachment of `renderTarget` takes: its texture's layout, and the target's sample count. A storage
 * target's colour is allocated in the format a storage binding takes, `viewFormat` the one it is drawn and sampled in.
 */
function attachmentShape(renderTarget: RenderTarget, texture: GpuTexture, isDepth: boolean) {
    const storage = renderTarget.storage && !isDepth;
    return {
        width: renderTarget.width,
        height: renderTarget.height,
        layers: texture.depthOrArrayLayers,
        dimension: texture.dimension as GPUTextureDimension,
        // the target's layout sets it on each attachment; a texture's `generateMipmaps` is for sampling, not this
        mipLevelCount: Math.max(1, texture.mipLevelCount),
        format: storage ? storageFormatOf(texture.format) : texture.format,
        viewFormat: texture.format,
        storage,
        samples: renderTarget.samples > 1 ? renderTarget.samples : 1,
    };
}

/** Whether `texture` holds the allocation its target's layout asks for now. */
function isAllocated(cache: TextureCache, renderTarget: RenderTarget, texture: GpuTexture, isDepth: boolean): boolean {
    // A disposed wrapper's cache entry still points at a destroyed GPUTexture whose
    // .width/.height/etc. read back stale-but-present; force reallocation so we never
    // build an attachment/view from a destroyed texture (dispose-then-reuse path).
    if (texture.disposed) return false;
    const data = cache.textureMap.get(texture);
    if (!data || data.isDefaultTexture) return false;
    // the layout last checked against, as three.js keeps a target's last size: a draw sampling the target compares
    // a few fields rather than re-deriving the attachment's whole shape
    const last = data.allocatedLayout;
    if (
        last !== undefined &&
        last.texture === data.texture &&
        last.width === renderTarget.width &&
        last.height === renderTarget.height &&
        last.samples === renderTarget.samples &&
        last.storage === renderTarget.storage &&
        last.layers === texture.depthOrArrayLayers &&
        last.mipLevelCount === texture.mipLevelCount &&
        last.format === texture.format &&
        last.dimension === texture.dimension
    ) {
        return true;
    }
    if (!shapeAllocated(data, renderTarget, texture, isDepth)) return false;
    data.allocatedLayout = {
        texture: data.texture,
        width: renderTarget.width,
        height: renderTarget.height,
        samples: renderTarget.samples,
        storage: renderTarget.storage,
        layers: texture.depthOrArrayLayers,
        mipLevelCount: texture.mipLevelCount,
        format: texture.format,
        dimension: texture.dimension,
    };
    return true;
}

/** Whether the GPU textures `data` holds have the shape `renderTarget`'s layout asks of `texture` now. */
function shapeAllocated(data: TextureData, renderTarget: RenderTarget, texture: GpuTexture, isDepth: boolean): boolean {
    const shape = attachmentShape(renderTarget, texture, isDepth);
    const multisampled = shape.samples > 1;
    const msaa = data.msaaTextures;
    if (multisampled !== !!msaa) return false;
    if (msaa && (msaa.length !== shape.layers || msaa[0]!.width !== shape.width || msaa[0]!.height !== shape.height)) {
        return false;
    }
    if (msaa && msaa[0]!.sampleCount !== shape.samples) return false;
    // a multisampled depth is only its multisampled textures
    if (multisampled && isDepth) return msaa![0]!.format === shape.format;
    const gpu = data.texture;
    return (
        gpu.width === shape.width &&
        gpu.height === shape.height &&
        gpu.depthOrArrayLayers === shape.layers &&
        gpu.dimension === shape.dimension &&
        gpu.format === shape.format &&
        gpu.sampleCount === 1 &&
        gpu.mipLevelCount === shape.mipLevelCount
    );
}

/** Allocates `texture` as an attachment of `renderTarget`: its layout, and a multisampled texture per layer. */
function allocateAttachment(
    cache: TextureCache,
    device: GPUDevice,
    renderTarget: RenderTarget,
    texture: GpuTexture,
    isDepth: boolean,
): void {
    const shape = attachmentShape(renderTarget, texture, isDepth);
    const msaaTextures =
        shape.samples > 1
            ? Array.from({ length: shape.layers }, () =>
                  device.createTexture({
                      size: [shape.width, shape.height],
                      format: shape.format,
                      // a multisampled depth stays readable as `texture_depth_multisampled_2d`
                      usage: isDepth
                          ? GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
                          : GPUTextureUsage.RENDER_ATTACHMENT,
                      sampleCount: shape.samples,
                  }),
              )
            : null;
    // A multisampled depth is never resolved, so its multisampled textures are all there is of it.
    const gpu =
        msaaTextures !== null && isDepth
            ? msaaTextures[0]!
            : device.createTexture({
                  dimension: shape.dimension,
                  size: [shape.width, shape.height, shape.layers],
                  format: shape.format,
                  usage: isDepth
                      ? GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
                      : GPUTextureUsage.RENDER_ATTACHMENT |
                        GPUTextureUsage.TEXTURE_BINDING |
                        GPUTextureUsage.COPY_SRC |
                        GPUTextureUsage.COPY_DST |
                        (shape.storage ? GPUTextureUsage.STORAGE_BINDING : 0),
                  viewFormats: shape.viewFormat !== shape.format ? [shape.viewFormat] : [],
                  mipLevelCount: shape.mipLevelCount,
                  sampleCount: 1,
              });
    setRenderTargetTexture(cache, texture, gpu, msaaTextures);
    // drawn and sampled through its sRGB view; a storage binding takes the allocation's own format
    cache.textureMap.get(texture)!.viewFormat = shape.viewFormat !== shape.format ? shape.viewFormat : undefined;
}

/**
 * Allocates every attachment of `renderTarget` its layout asks for and doesn't hold. Each attachment is checked on its
 * own: a cube's colour and depth, or a target whose depth is shared with another, reallocate apart.
 */
export function ensureRenderTargetTexturesAllocated(cache: TextureCache, device: GPUDevice, renderTarget: RenderTarget): void {
    // Don't release (delete) the cache entries here: setRenderTargetTexture()
    // destroys the old GPU texture and bumps `generation` monotonically, which is
    // what bind-group change detection relies on to rebuild views. Deleting the
    // entry first would reset generation back to 1, so a bind group sampling this
    // target would keep a view of the destroyed texture (-> "destroyed texture
    // used in a submit").
    for (const tex of renderTarget.textures) {
        if (!isAllocated(cache, renderTarget, tex._gpuTexture, false)) {
            allocateAttachment(cache, device, renderTarget, tex._gpuTexture, false);
        }
    }
    const depth = renderTarget._depthAttachment;
    if (depth && !isAllocated(cache, renderTarget, depth._gpuTexture, true)) {
        allocateAttachment(cache, device, renderTarget, depth._gpuTexture, true);
    }
}
