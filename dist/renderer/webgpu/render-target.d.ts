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
import { type TextureCache, type TextureData } from './textures';
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
export declare function ensureRenderTargetTexturesAllocated(cache: TextureCache, device: GPUDevice, renderTarget: RenderTarget): void;
