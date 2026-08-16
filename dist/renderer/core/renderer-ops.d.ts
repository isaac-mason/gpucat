import type { Vec4 } from 'math';
import type { Camera } from '../../camera/camera';
import type { Object3D } from '../../core/object3d';
import type { RenderTarget } from '../../core/render-target';
import type { InspectorBase } from '../../inspector/inspector-base';
import type { Material } from '../../material/material';
import type { MRTNode } from '../../nodes/nodes';
import type { CanvasTarget } from './canvas-target';
import type { NodeManagerState } from './node-manager';
import type * as RenderContextModule from './pass-context';
import type { RenderContext } from './pass-context';
import * as RenderLists from './render-list';
import type { RenderObject } from './render-object';
import * as RenderObjects from './render-objects';
import type { PreparedRenderObject } from './render-types';
/**
 * Information about a device lost event handed to the renderer's device-lost handler. Kept neutral
 * (`api` names the backend, `reason` is a plain string) so no graphics-API type leaks into core.
 */
export type DeviceLostInfo = {
    /** The API that lost the device (e.g. 'WebGPU'). */
    api: string;
    /** Human-readable message about the loss. */
    message: string;
    /** The reason for the loss, if available. */
    reason: string | null;
    /** The original device-loss event, opaque to core. */
    originalEvent: unknown;
};
/**
 * The neutral state the render-loop orchestration reads and writes. The concrete renderer class owns
 * these fields (identical names) and passes itself in as `r`. Device state (device handle, caches,
 * encoder) lives on the concrete renderer as extra fields the utils never touch.
 */
export interface RendererState {
    /** Whether the renderer has been initialized (device/context created). */
    _initialized: boolean;
    /** Whether the device has been lost (rendering disabled). */
    _isDeviceLost: boolean;
    /** Attached inspector, or null. */
    inspector: InspectorBase | null;
    /** MSAA sample count (0 or 1 = no MSAA). */
    samples: number;
    /** Whether the swapchain depth buffer carries a stencil aspect. */
    stencil: boolean;
    /** User callback fired on device loss. */
    onDeviceLost: ((info: DeviceLostInfo) => void) | null;
    /** Per-pass render context cache. */
    _renderContexts: RenderContextModule.RenderContextsState;
    /** Compute context. */
    _computeContext: RenderContextModule.ComputeContext;
    /** Node manager state (node frame, compute states, ...). */
    _nodes: NodeManagerState;
    /** RenderObject cache. */
    _renderObjects: RenderObjects.RenderObjectsState;
    /** Render list state. */
    _renderLists: RenderLists.RenderListsState;
    /** Render call depth for nested render support (0 = top-level). */
    _renderCallDepth: number;
    /** Clear color for the final composite pass, [r, g, b, a]. */
    clearColor: [number, number, number, number];
    /** When false, render() preserves prior attachment contents instead of clearing. */
    autoClear: boolean;
    /** When true (and autoClear), the stencil buffer is cleared each render. */
    autoClearStencil: boolean;
    /** Value the stencil buffer clears to (0-255). */
    clearStencilValue: number;
    /** Swapchain viewport in LOGICAL pixels [x, y, w, h], or null for full frame. */
    _viewport: Vec4 | null;
    /** Swapchain scissor in LOGICAL pixels [x, y, w, h], or null for full frame. */
    _scissor: Vec4 | null;
    /** Whether the scissor test is enabled. */
    _scissorTest: boolean;
    /** Viewport min depth. */
    _viewportMinDepth: number;
    /** Viewport max depth. */
    _viewportMaxDepth: number;
    /** Current MRT config, or null. */
    mrt: MRTNode | null;
    /** Current render target; null renders to the swapchain. */
    renderTarget: RenderTarget | null;
    /** When set, all meshes render with this material instead of their own. */
    overrideMaterial: Material | null;
    /** Current canvas target; null in headless mode. */
    _canvasTarget: CanvasTarget | null;
}
/**
 * The canvas for the current target — an `HTMLCanvasElement` on a page or an `OffscreenCanvas` in a
 * worker/headless context. Throws only when there is no canvas at all (WebGPU headless mode).
 */
export declare function canvas(r: RendererState): HTMLCanvasElement | OffscreenCanvas;
/**
 * The canvas as a DOM element, for insertion into the page. Throws if the target is an `OffscreenCanvas`
 * (headless/worker) — an OffscreenCanvas is not a DOM node; use {@link canvas} there.
 */
export declare function domElement(r: RendererState): HTMLCanvasElement;
export declare function frameWidth(r: RendererState): number;
export declare function frameHeight(r: RendererState): number;
/** Decode + report a device-loss event: log, set the lost flag, fire the user callback. */
export declare function handleDeviceLost(r: RendererState, info: DeviceLostInfo): void;
/** set the device pixel ratio. call before setSize(). Throws in headless mode. */
export declare function setPixelRatio(r: RendererState, value: number): void;
/**
 * Restrict rendering to a sub-rectangle of the framebuffer, in LOGICAL (CSS) pixels. Accepts a `Vec4`
 * tuple [x, y, width, height] or the individual components. Persists until changed.
 */
export declare function setViewport(r: RendererState, x: number | Vec4, y?: number, width?: number, height?: number, minDepth?: number, maxDepth?: number): void;
/** The current viewport as a `Vec4` [x, y, width, height] in logical px (full frame if none set). */
export declare function getViewport(r: RendererState): Vec4;
/** Set the scissor rectangle in LOGICAL (CSS) pixels, as a `Vec4` tuple or individual components. */
export declare function setScissor(r: RendererState, x: number | Vec4, y?: number, width?: number, height?: number): void;
/** The current scissor rect as a `Vec4` [x, y, width, height] in logical px (full frame if none set). */
export declare function getScissor(r: RendererState): Vec4;
/** Enable or disable the scissor test. When on, draw calls are clipped to the setScissor rect. */
export declare function setScissorTest(r: RendererState, enable: boolean): void;
/**
 * Neutral half of per-object preparation: collect the render list, resolve each RenderObject's
 * identity, run the device-side prepare (compile + pipeline) via the caller-supplied `prepare`
 * callback, then run the node graph's updateBefore (which may trigger a nested render). Returns the
 * drawable objects in order.
 */
export declare function prepareRenderObjects(r: RendererState, scene: Object3D, camera: Camera, passCtx: RenderContext, passId: string, overrideMaterial: Material | null, prepare: (nodes: NodeManagerState, renderObject: RenderObject) => boolean): PreparedRenderObject[];
/**
 * Resolve the active viewport/scissor into the pass context as physical-pixel rects. The source is the
 * target being rendered: a render target carries its own viewport/scissor, otherwise the renderer's
 * swapchain state applies. Values are scaled by the canvas pixelRatio (1 for render targets), floored
 * to integers, and the scissor is clamped to the framebuffer so an over-sized or negative rect can't
 * trip a GPU validation error. The scissor flag is left off when the rect already covers the whole
 * framebuffer (nothing to clip).
 */
export declare function resolveViewportScissor(r: RendererState, passCtx: RenderContext): void;
