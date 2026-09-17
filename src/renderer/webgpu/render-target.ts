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

import type { CubeRenderTarget } from '../../core/cube-render-target';
import type { GpuTexture } from '../../core/gpu-texture';
import type { RenderTarget } from '../../core/render-target';
import { createTextureTallyEntry, tallyClearTexture, tallySetTexture } from '../core/info';
import { fullMipChainLength, gpuTextureBytes } from '../core/texture-size';
import { setupTextureDispose, type TextureCache, type TextureData } from './textures';

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
        // Resize swaps the GPU texture under the same entry: same count, different bytes.
        tallySetTexture(cache.tally, existing.tally, texture.format, gpuTextureBytes(texture));
    } else {
        // First time - create new entry
        cache.textureMap.set(texture, {
            texture: gpuTextureResource,
            msaaTexture,
            version: texture.version,
            generation: 1,
            initialized: true,
            isDefaultTexture: false,
            tally: createTextureTallyEntry(),
        });
        const entry = cache.textureMap.get(texture)!;
        tallySetTexture(cache.tally, entry.tally, texture.format, gpuTextureBytes(texture));
    }

    texture.disposed = false;
    setupTextureDispose(cache, texture);
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
        tallyClearTexture(cache.tally, data.tally);
        cache.textureMap.delete(texture);
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

    if (!needsAllocation && renderTarget._depthAttachment) {
        needsAllocation = !hasRenderTargetTextureAllocation(
            cache,
            renderTarget._depthAttachment._gpuTexture,
            width,
            height,
            renderTarget._depthAttachment.format,
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

    if (renderTarget._depthAttachment) {
        const gpuDepthTexture = device.createTexture({
            size: [width, height],
            format: renderTarget._depthAttachment.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            sampleCount,
        });
        setRenderTargetTexture(cache, renderTarget._depthAttachment._gpuTexture, gpuDepthTexture);
    }
}

function ensureCubeRenderTargetTexturesAllocated(cache: TextureCache, device: GPUDevice, renderTarget: CubeRenderTarget): void {
    const cubeMipCount = renderTarget.texture.generateMipmaps ? fullMipChainLength(renderTarget.size, renderTarget.size) : 1;

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
        !renderTarget._depthAttachment ||
        hasRenderTargetTextureAllocation(
            cache,
            renderTarget._depthAttachment._gpuTexture,
            renderTarget.size,
            renderTarget.size,
            renderTarget._depthAttachment.format,
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

    if (renderTarget._depthAttachment) {
        const depthTex = device.createTexture({
            size: [renderTarget.size, renderTarget.size],
            format: renderTarget._depthAttachment.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            sampleCount: 1,
        });
        setRenderTargetTexture(cache, renderTarget._depthAttachment._gpuTexture, depthTex);
    }
}
