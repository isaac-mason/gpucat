import type { InspectorBase } from '../../inspector/inspector-base';
import type { CanvasTarget } from '../core/canvas-target';
import type { NodeManagerState } from '../core/node-manager';
import type { RenderContext } from '../core/pass-context';
import type { PreparedRenderObject, RenderPassParams } from '../core/render-types';
import type { BindGroupLayoutCache } from './bind-group-layout';
import * as Bindings from './bindings';
import * as Buffers from './buffers';
import * as Geometries from './geometries';
import type * as Pipelines from './pipelines';
import * as RenderObjectGpu from './render-object-gpu';
import * as Textures from './textures';
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
export type SwapchainState = {
    canvasTarget: CanvasTarget | null;
    samples: number;
    depthFormat: GPUTextureFormat;
    /** Swapchain depth texture (recreated on resize). */
    depthTexture: GPUTexture | null;
    depthTextureView: GPUTextureView | null;
    /** MSAA color texture (null when samples <= 1). */
    msaaTexture: GPUTexture | null;
    msaaTextureView: GPUTextureView | null;
};
/** Create the initial (empty) swapchain state for the given sample count + depth format. */
export declare function createSwapchainState(samples: number, depthFormat: GPUTextureFormat): SwapchainState;
/**
 * (Re)create the swapchain depth and (optional) MSAA textures and cache their views. The views
 * are stable until the next resize, so attachment resolution reuses them rather than calling
 * createView() every frame.
 */
export declare function recreateSwapchainTextures(device: GPUDevice, sc: SwapchainState, format: GPUTextureFormat, width: number, height: number): void;
/**
 * Manually clear the current framebuffer (color and/or depth and/or stencil). Resolves the
 * attachments for `params` with autoClear=true so they come back as 'clear', then overrides each
 * load op per the color/depth/stencil flags, and submits a single empty render pass.
 */
export declare function clear(contexts: WeakMap<CanvasTarget, GPUCanvasContext>, device: GPUDevice, textures: Textures.TextureCache, sc: SwapchainState, format: GPUTextureFormat, params: RenderPassParams, color: boolean, depth: boolean, stencil: boolean): void;
/**
 * Resolve attachments and run the whole inner draw loop into the current command stream (created by
 * the top-level frame, reused by nested renders). Calls neutral update helpers per object.
 */
export declare function executeRenderPass(contexts: WeakMap<CanvasTarget, GPUCanvasContext>, device: GPUDevice, bindings: Bindings.BindingsState, geometries: Geometries.GeometriesState, buffers: Buffers.BufferCache, textures: Textures.TextureCache, renderObjectGpu: RenderObjectGpu.RenderObjectGpuCache, sc: SwapchainState, format: GPUTextureFormat, encoder: GPUCommandEncoder, nodes: NodeManagerState, passCtx: RenderContext, prepared: PreparedRenderObject[], params: RenderPassParams, inspector: InspectorBase | null): void;
/**
 * Release all device resources: the canvas context, swapchain textures, default placeholder
 * textures + samplers, mipmap state, pipeline caches, and (unless the device was pre-created) the
 * device itself. After this the renderer is unusable.
 */
export declare function disposeDevice(contexts: WeakMap<CanvasTarget, GPUCanvasContext>, device: GPUDevice | null, deviceProvided: boolean, textures: Textures.TextureCache, pipelines: Pipelines.PipelinesState, bindGroupLayoutCache: BindGroupLayoutCache, sc: SwapchainState): void;
