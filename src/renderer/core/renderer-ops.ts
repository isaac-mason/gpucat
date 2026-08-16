import type { Vec4 } from 'math';
import type { Camera } from '../../camera/camera';
import type { Object3D } from '../../core/object3d';
import type { RenderTarget } from '../../core/render-target';
import type { InspectorBase } from '../../inspector/inspector-base';
import type { Material } from '../../material/material';
import type { MRTNode } from '../../nodes/nodes';
import type { CanvasTarget } from './canvas-target';
import type { NodeManagerState } from './node-manager';
import * as NodeManager from './node-manager';
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

/** True when the value is an `OffscreenCanvas` — a non-DOM canvas usable off the main thread. */
function isOffscreenCanvas(c: HTMLCanvasElement | OffscreenCanvas): c is OffscreenCanvas {
    // `OffscreenCanvas` may be undefined in older environments; guard before the `instanceof`.
    return typeof OffscreenCanvas !== 'undefined' && c instanceof OffscreenCanvas;
}

/**
 * The canvas for the current target — an `HTMLCanvasElement` on a page or an `OffscreenCanvas` in a
 * worker/headless context. Throws only when there is no canvas at all (WebGPU headless mode).
 */
export function canvas(r: RendererState): HTMLCanvasElement | OffscreenCanvas {
    if (!r._canvasTarget) {
        throw new Error('[Renderer] no canvas: renderer was created in headless mode. Render to a RenderTarget instead.');
    }
    return r._canvasTarget.canvas;
}

/**
 * The canvas as a DOM element, for insertion into the page. Throws if the target is an `OffscreenCanvas`
 * (headless/worker) — an OffscreenCanvas is not a DOM node; use {@link canvas} there.
 */
export function domElement(r: RendererState): HTMLCanvasElement {
    const c = canvas(r);
    if (isOffscreenCanvas(c)) {
        throw new Error(
            '[Renderer] domElement is an OffscreenCanvas and is not a DOM element. Use `renderer.canvas` (and readRenderTargetPixels for output) in worker/headless contexts.',
        );
    }
    return c;
}

export function frameWidth(r: RendererState): number {
    if (r.renderTarget) return r.renderTarget.width;
    if (r._canvasTarget) return canvas(r).width || 1;
    return 1;
}

export function frameHeight(r: RendererState): number {
    if (r.renderTarget) return r.renderTarget.height;
    if (r._canvasTarget) return canvas(r).height || 1;
    return 1;
}

/** Decode + report a device-loss event: log, set the lost flag, fire the user callback. */
export function handleDeviceLost(r: RendererState, info: DeviceLostInfo): void {
    console.error(
        `[WebGPURenderer] WebGPU Device Lost:\n` + `  Message: ${info.message}\n` + `  Reason: ${info.reason ?? 'unknown'}`,
    );

    r._isDeviceLost = true;
    r.onDeviceLost?.(info);
}

/** set the device pixel ratio. call before setSize(). Throws in headless mode. */
export function setPixelRatio(r: RendererState, value: number): void {
    if (!r._canvasTarget) {
        throw new Error('[WebGPURenderer] setPixelRatio is not available in headless mode.');
    }
    r._canvasTarget.setPixelRatio(value);
}

/**
 * Restrict rendering to a sub-rectangle of the framebuffer, in LOGICAL (CSS) pixels. Accepts a `Vec4`
 * tuple [x, y, width, height] or the individual components. Persists until changed.
 */
export function setViewport(r: RendererState, x: number | Vec4, y = 0, width = 0, height = 0, minDepth = 0, maxDepth = 1): void {
    // Vec4 form [x, y, width, height] keeps the full-depth range; use the numeric form to set minDepth/maxDepth.
    if (Array.isArray(x)) {
        r._viewport = [x[0], x[1], x[2], x[3]];
        r._viewportMinDepth = 0;
        r._viewportMaxDepth = 1;
    } else {
        r._viewport = [x, y, width, height];
        r._viewportMinDepth = minDepth;
        r._viewportMaxDepth = maxDepth;
    }
}

/** The current viewport as a `Vec4` [x, y, width, height] in logical px (full frame if none set). */
export function getViewport(r: RendererState): Vec4 {
    if (r._viewport) return [...r._viewport];
    const w = r._canvasTarget?.getSize().width ?? 0;
    const h = r._canvasTarget?.getSize().height ?? 0;
    return [0, 0, w, h];
}

/** Set the scissor rectangle in LOGICAL (CSS) pixels, as a `Vec4` tuple or individual components. */
export function setScissor(r: RendererState, x: number | Vec4, y = 0, width = 0, height = 0): void {
    // Vec4 form is [x, y, width, height].
    r._scissor = Array.isArray(x) ? [x[0], x[1], x[2], x[3]] : [x, y, width, height];
}

/** The current scissor rect as a `Vec4` [x, y, width, height] in logical px (full frame if none set). */
export function getScissor(r: RendererState): Vec4 {
    if (r._scissor) return [...r._scissor];
    const w = r._canvasTarget?.getSize().width ?? 0;
    const h = r._canvasTarget?.getSize().height ?? 0;
    return [0, 0, w, h];
}

/** Enable or disable the scissor test. When on, draw calls are clipped to the setScissor rect. */
export function setScissorTest(r: RendererState, enable: boolean): void {
    r._scissorTest = enable;
}

/**
 * Neutral half of per-object preparation: collect the render list, resolve each RenderObject's
 * identity, run the device-side prepare (compile + pipeline) via the caller-supplied `prepare`
 * callback, then run the node graph's updateBefore (which may trigger a nested render). Returns the
 * drawable objects in order.
 */
export function prepareRenderObjects(
    r: RendererState,
    scene: Object3D,
    camera: Camera,
    passCtx: RenderContext,
    passId: string,
    overrideMaterial: Material | null,
    prepare: (nodes: NodeManagerState, renderObject: RenderObject) => boolean,
): PreparedRenderObject[] {
    const inspector = r.inspector;
    if (inspector) inspector.perf.start('collectRenderList');
    const renderList = RenderLists.collectRenderList(r._renderLists, scene, camera, overrideMaterial);
    if (inspector) inspector.perf.end('collectRenderList');

    const preparedObjects: PreparedRenderObject[] = [];

    for (const items of [renderList.opaque, renderList.transparent]) {
        for (const item of items) {
            if (!item.mesh || !item.material || !item.geometry) continue;

            const renderObject = RenderObjects.getRenderObject(
                r._renderObjects,
                item.mesh,
                item.material,
                scene,
                camera,
                passCtx,
                passId,
            );

            if (!prepare(r._nodes, renderObject)) continue;

            if (inspector) inspector.perf.start('updateBefore');
            NodeManager.updateBefore(r._nodes, renderObject);
            if (inspector) inspector.perf.end('updateBefore');

            preparedObjects.push({ renderObject, item });
        }
    }

    return preparedObjects;
}

/**
 * Resolve the active viewport/scissor into the pass context as physical-pixel rects. The source is the
 * target being rendered: a render target carries its own viewport/scissor, otherwise the renderer's
 * swapchain state applies. Values are scaled by the canvas pixelRatio (1 for render targets), floored
 * to integers, and the scissor is clamped to the framebuffer so an over-sized or negative rect can't
 * trip a GPU validation error. The scissor flag is left off when the rect already covers the whole
 * framebuffer (nothing to clip).
 */
export function resolveViewportScissor(r: RendererState, passCtx: RenderContext): void {
    const rt = r.renderTarget;
    // Vec4 [x, y, width, height] rects; a render target's depth range is the full 0..1.
    const viewport = rt ? rt.viewport : r._viewport;
    const scissor = rt ? rt.scissor : r._scissor;
    const scissorTest = rt ? rt.scissorTest : r._scissorTest;
    const minDepth = rt ? 0 : r._viewportMinDepth;
    const maxDepth = rt ? 1 : r._viewportMaxDepth;
    const pr = rt ? 1 : (r._canvasTarget?.getPixelRatio() ?? 1);
    const fbW = passCtx.width;
    const fbH = passCtx.height;

    if (viewport) {
        const vv = passCtx.viewportValue;
        vv.x = Math.floor(viewport[0] * pr);
        vv.y = Math.floor(viewport[1] * pr);
        vv.width = Math.floor(viewport[2] * pr);
        vv.height = Math.floor(viewport[3] * pr);
        vv.minDepth = minDepth;
        vv.maxDepth = maxDepth;
        passCtx.viewport = true;
    } else {
        passCtx.viewport = false;
    }

    if (scissorTest && scissor) {
        const sv = passCtx.scissorValue;
        let x = Math.floor(scissor[0] * pr);
        let y = Math.floor(scissor[1] * pr);
        let w = Math.floor(scissor[2] * pr);
        let h = Math.floor(scissor[3] * pr);
        // Clamp into [0, framebuffer]: pull the origin to 0 and shrink the extent to fit.
        if (x < 0) {
            w += x;
            x = 0;
        }
        if (y < 0) {
            h += y;
            y = 0;
        }
        w = Math.max(0, Math.min(w, fbW - x));
        h = Math.max(0, Math.min(h, fbH - y));
        sv.x = x;
        sv.y = y;
        sv.width = w;
        sv.height = h;
        // A rect covering the whole framebuffer clips nothing — skip the call.
        passCtx.scissor = !(x === 0 && y === 0 && w === fbW && h === fbH);
    } else {
        passCtx.scissor = false;
    }
}
