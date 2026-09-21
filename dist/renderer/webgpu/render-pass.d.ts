import type { InspectorBase } from '../../inspector/inspector-base';
import type { CanvasTarget } from '../core/canvas-target';
import type { DrawOptions } from '../core/frame';
import type { RendererInfo } from '../core/info';
import type { NodeManagerState } from '../core/node-manager';
import type { RenderContext } from '../core/pass-context';
import type { PreparedRenderObject, PreparedSegment, RenderPassParams } from '../core/render-types';
import type { BackendState } from './backend-state';
/**
 * Get (or lazily create + configure) the WebGPU canvas context for a canvas target. Safe to call
 * repeatedly; the context is cached per canvas target after first acquisition. The context is
 * acquired from `canvasTarget.canvas.getContext('webgpu')` and configured against `device` with
 * the given `format` and alpha mode (defaults to the canvas target's `alphaMode`).
 */
export declare function getContext(contexts: WeakMap<CanvasTarget, GPUCanvasContext>, device: GPUDevice, canvasTarget: CanvasTarget, format: GPUTextureFormat, alphaMode?: GPUCanvasAlphaMode): GPUCanvasContext;
/**
 * Re-`configure()` the cached WebGPU context for a canvas target against the current device/format.
 * Safari/WebKit clears a context's configuration whenever the canvas backing store is resized (any
 * `canvas.width`/`canvas.height` write), so the next `getCurrentTexture()` throws "canvas is not
 * configured". Called from the resize path to restore it. No-op when the context hasn't been acquired
 * yet (`getContext()` will configure on first use) and a portable no-op on Chrome, which keeps the
 * configuration across resizes.
 */
export declare function reconfigureContext(contexts: WeakMap<CanvasTarget, GPUCanvasContext>, device: GPUDevice, canvasTarget: CanvasTarget, format: GPUTextureFormat, alphaMode?: GPUCanvasAlphaMode): void;
/**
 * Unconfigure and release the WebGPU context for a canvas target. Called from `dispose()` for the
 * swapchain canvas target. After this, `getContext()` creates a fresh context.
 */
export declare function releaseContext(contexts: WeakMap<CanvasTarget, GPUCanvasContext>, canvasTarget: CanvasTarget): void;
/**
 * Swapchain state owned by the renderer: the canvas target, sample count, depth format, and the
 * depth/msaa attachment textures (+ their cached views). Read when resolving swapchain
 * (renderTarget === null) attachments and recreated on `resize`.
 */
/** One canvas target's own depth and MSAA attachments, sized and sampled to that target. */
export type CanvasAttachments = {
    /** Backing-store size this target's context was last configured against. */
    configuredWidth: number;
    configuredHeight: number;
    /** Swapchain depth texture (recreated on resize). */
    depthTexture: GPUTexture | null;
    depthTextureView: GPUTextureView | null;
    /** MSAA color texture (null when samples <= 1). */
    msaaTexture: GPUTexture | null;
    msaaTextureView: GPUTextureView | null;
};
export type SwapchainState = {
    /** Every canvas this renderer has allocated attachments for, so `dispose` can reach all of them. */
    targets: Set<CanvasTarget>;
    /** Per-target attachments, because a frame may draw to several canvases of differing size. */
    byTarget: WeakMap<CanvasTarget, CanvasAttachments>;
};
/**
 * The swapchain's own depth and MSAA attachments. These belong to the swapchain, not to any
 * `RenderTarget`, so they live beside `SwapchainState` rather than in `render-target.ts`.
 */
export declare function createSwapchainDepthTexture(device: GPUDevice, width: number, height: number, sampleCount: number, format?: GPUTextureFormat): GPUTexture;
export declare function createSwapchainMsaaTexture(device: GPUDevice, width: number, height: number, format: GPUTextureFormat, sampleCount: number): GPUTexture;
export declare function createSwapchainState(): SwapchainState;
export declare function attachmentsFor(sc: SwapchainState, target: CanvasTarget): CanvasAttachments;
export declare function samplesFor(target: CanvasTarget): number;
export declare function depthFormatFor(target: CanvasTarget): GPUTextureFormat;
/**
 * (Re)create the swapchain depth and (optional) MSAA textures and cache their views. The views
 * are stable until the next resize, so attachment resolution reuses them rather than calling
 * createView() every frame.
 */
export declare function recreateSwapchainTextures(device: GPUDevice, sc: SwapchainState, format: GPUTextureFormat, width: number, height: number, target: CanvasTarget): void;
type ResolvedAttachments = {
    colorAttachments: GPURenderPassColorAttachment[];
    depthAttachment: GPURenderPassDepthStencilAttachment | undefined;
};
/**
 * Build GPU color and depth attachments, dispatching on the target kind. Shared by `executeRenderPass`
 * and `clear()` (which then overrides the load ops for the manual clear).
 */
export declare function resolveAttachments(b: BackendState, params: RenderPassParams): ResolvedAttachments;
/** Begin the GPU render pass, issue all draw calls, and end the pass. */
/** What the draw loop needs: a bundle encoder offers the same surface as a pass encoder. */
export type DrawEncoder = GPURenderPassEncoder | GPURenderBundleEncoder;
export type PassScope = {
    gpuPass: GPURenderPassEncoder;
    currentSets: CurrentSets;
};
/** The draw loop's own scope, which a bundle recording satisfies with a bundle encoder. */
export type DrawScope = {
    gpuPass: DrawEncoder;
    currentSets: CurrentSets;
};
export declare function beginPass(encoder: GPUCommandEncoder, passCtx: RenderContext, colorAttachments: GPURenderPassColorAttachment[], depthAttachment: GPURenderPassDepthStencilAttachment | undefined, passId: string, inspector: InspectorBase | null): PassScope;
export declare function endPass(scope: PassScope): void;
export declare function encodeDraws(b: BackendState, nodes: NodeManagerState, passCtx: RenderContext, preparedObjects: readonly PreparedRenderObject[], preparedOpts: readonly (DrawOptions | null)[], count: number, inspector: InspectorBase | null, info: RendererInfo, scope: PassScope, segments: readonly PreparedSegment[]): void;
/**
 * Release all device resources: the canvas context, swapchain textures, default placeholder
 * textures + samplers, mipmap state, pipeline caches, and (unless the device was pre-created) the
 * device itself. After this the renderer is unusable.
 */
export declare function disposeDevice(b: BackendState, deviceProvided: boolean): void;
type CurrentSets = {
    bindingGroups: number[];
    attributes: (GPUBuffer | null)[];
    index: GPUBuffer | null;
    pipeline: GPURenderPipeline | null;
    stencilRef: number | null;
};
export {};
