import type { CoordinateSystem } from '../../core/coordinate-system';
import type { CubeRenderTarget } from '../../core/cube-render-target';
import { deadAttachment, type RenderTarget } from '../../core/render-target';
import type { CanvasTarget } from './canvas-target';
import type { DeviceBackend } from './device-backend';
import type { CameraRecord, PassDesc, PassEntry, Rect, RenderBundle, ScissorRecord, ViewportRecord, ViewportRect } from './frame';
import { aimNodeFrame } from './node-frame';
import {
    getRenderContext,
    type RenderContext,
    type RenderContextsState,
    type ScissorValue,
    type ViewportValue,
} from './pass-context';
import { formatHasStencil, type PreparedSegment, type RenderPassParams } from './render-types';
import type { Renderer } from './renderer';
import { isRenderTarget, renderTargetOf, type Target } from './target';
import type { View } from './view';

function isCubeRenderTarget(rt: RenderTarget): rt is CubeRenderTarget {
    return (rt as CubeRenderTarget).isCubeRenderTarget === true;
}

/** A camera's projection is built for one clip convention; a pass in the other rebuilds it. */
export function alignCameraToBackend(camera: View | undefined, coordinateSystem: CoordinateSystem): void {
    if (camera === undefined || camera.coordinateSystem === coordinateSystem) return;
    camera.coordinateSystem = coordinateSystem;
    camera.updateProjectionMatrix?.();
}

export function sizeOf(target: Target): { width: number; height: number } {
    return isRenderTarget(target) ? { width: target.width, height: target.height } : target.getDrawingBufferSize();
}

function hasStencil(target: Target): boolean {
    return formatHasStencil(isRenderTarget(target) ? target._depthAttachment?.format : target.depthFormat);
}

/**
 * A target disposed between recording and submit reaches the device as "destroyed texture used in a
 * submit", which surfaces asynchronously from the driver with no way back to the pass that named it.
 * A room swap disposing its targets mid-frame is the case that does this.
 */
function assertNotDisposed(rt: RenderTarget): void {
    const dead = deadAttachment(rt);
    if (dead !== null) {
        throw new Error(`[frame] pass names a disposed render target (attachment '${dead}').`);
    }
}

/** The shared, attachment-shape-keyed half: what every pass of this shape agrees on. */
export function resolvePassContext(state: RenderContextsState, desc: PassDesc): RenderContext {
    const target = desc.target;
    const rt = renderTargetOf(target);
    if (rt !== null) assertNotDisposed(rt);
    const ctx = getRenderContext(state, target, desc.mrt ?? null);

    return ctx;
}

/** Viewport and scissor are physical pixels of the target, so no pixel-ratio scaling applies. */
export function resolvePassParams(desc: PassDesc, out: RenderPassParams): RenderPassParams {
    const target = desc.target;
    const [r, g, b, a] = desc.clear === false || desc.clear === undefined ? target.clearColor : desc.clear;

    const rt = renderTargetOf(target);
    const { width, height } = sizeOf(target);
    const viewport = desc.viewport;

    resolveCubeFace(rt, desc, out);
    out.renderTarget = rt;
    out.canvasTarget = rt === null ? (target as CanvasTarget) : null;
    out.clearColor.r = r;
    out.clearColor.g = g;
    out.clearColor.b = b;
    out.clearColor.a = a;
    out.clearsColor = desc.clear !== false;
    out.clearsDepth = desc.clearDepth !== false;
    out.clearDepthValue = typeof desc.clearDepth === 'number' ? desc.clearDepth : 1;
    out.clearsStencil = desc.clearStencil !== false;
    out.clearStencilValue = typeof desc.clearStencil === 'number' ? desc.clearStencil : 0;
    out.swapchainStencil = hasStencil(target);
    out.passId = desc.label ?? 'render';
    out.width = width;
    out.height = height;
    out.camera = desc.camera ?? null;

    out.viewport = resolveViewport(viewport, width, height, out.passId, out.viewportValue);
    out.scissor = resolveScissor(desc.scissor, width, height, out.scissorValue);

    return out;
}

/**
 * `viewport` into `out`, physical pixels of a `width` x `height` target; whether one is set, undefined being the whole
 * target. One reaching outside the target throws here, naming the pass: WebGPU refuses it later, naming neither.
 */
export function resolveViewport(
    viewport: ViewportRect | undefined,
    width: number,
    height: number,
    passId: string,
    out: ViewportValue,
): boolean {
    if (viewport === undefined) return false;
    const x = viewport.x ?? 0;
    const y = viewport.y ?? 0;
    if (
        x < 0 ||
        y < 0 ||
        viewport.width < 0 ||
        viewport.height < 0 ||
        x + viewport.width > width ||
        y + viewport.height > height
    ) {
        throw new Error(
            `[pass ${passId}] viewport ${x}, ${y} ${viewport.width} x ${viewport.height} reaches outside its ${width} x ${height} target`,
        );
    }
    out.x = x;
    out.y = y;
    out.width = viewport.width;
    out.height = viewport.height;
    out.minDepth = viewport.minDepth ?? 0;
    out.maxDepth = viewport.maxDepth ?? 1;
    return true;
}

/** `scissor` clamped into a `width` x `height` target, into `out`; whether it clips anything. */
export function resolveScissor(scissor: Rect | undefined, width: number, height: number, out: ScissorValue): boolean {
    if (scissor === undefined) return false;
    clampScissor(scissor, width, height, out);
    return !coversFramebuffer(out, width, height);
}

/**
 * A camera, viewport or scissor record onto the open pass's `params`, for the draws recorded after it. A new camera
 * takes the backend's clip convention and a render scope of its own, so the camera's uniforms and every render-scope
 * node update run again for it.
 */
export function applyViewRecord(
    renderer: Renderer<DeviceBackend>,
    params: RenderPassParams,
    entry: CameraRecord | ViewportRecord | ScissorRecord,
    coordinateSystem: CoordinateSystem,
): void {
    if (entry.kind === 'camera') {
        if (params.camera === entry.camera) return;
        alignCameraToBackend(entry.camera, coordinateSystem);
        params.camera = entry.camera;
        // the pass's own scope is restored at its end from what `beginPass` kept; this one just replaces it
        renderer._nodes.nodeFrame.beginRender();
        aimNodeFrame(renderer, entry.camera, params.width, params.height);
    } else if (entry.kind === 'viewport') {
        params.viewport = resolveViewport(entry.viewport, params.width, params.height, params.passId, params.viewportValue);
    } else {
        params.scissor = resolveScissor(entry.scissor, params.width, params.height, params.scissorValue);
    }
}

/** Whether a record changes what the draws after it are drawn with, rather than drawing. */
export function isViewRecord(entry: PassEntry): entry is CameraRecord | ViewportRecord | ScissorRecord {
    return entry.kind === 'camera' || entry.kind === 'viewport' || entry.kind === 'scissor';
}

/** The run of draws `start` to `start + count` into `out`, with the camera and rects `params` holds while they draw. */
export function writeSegment(
    out: PreparedSegment,
    bundle: RenderBundle | null,
    start: number,
    count: number,
    params: RenderPassParams,
): void {
    out.bundle = bundle;
    out.start = start;
    out.count = count;
    out.camera = params.camera;
    out.viewport = params.viewport;
    const viewport = params.viewportValue;
    out.viewportValue.x = viewport.x;
    out.viewportValue.y = viewport.y;
    out.viewportValue.width = viewport.width;
    out.viewportValue.height = viewport.height;
    out.viewportValue.minDepth = viewport.minDepth;
    out.viewportValue.maxDepth = viewport.maxDepth;
    out.scissor = params.scissor;
    const scissor = params.scissorValue;
    out.scissorValue.x = scissor.x;
    out.scissorValue.y = scissor.y;
    out.scissorValue.width = scissor.width;
    out.scissorValue.height = scissor.height;
}

/** Six faces with no default among them, so a cube pass names one and no other target may. */
function resolveCubeFace(rt: RenderTarget | null, desc: PassDesc, out: RenderPassParams): void {
    if (rt !== null && isCubeRenderTarget(rt)) {
        if (desc.layer === undefined) {
            throw new Error('[frame] a pass on a cube target names the face it writes: pass `layer: 0..5`.');
        }
        out.layer = desc.layer;
        out.mipLevel = desc.mipLevel ?? 0;
        return;
    }
    if (desc.layer !== undefined || desc.mipLevel !== undefined) {
        throw new Error('[frame] layer and mipLevel select a cube face and level; this pass names a target that has neither.');
    }
    out.layer = 0;
    out.mipLevel = 0;
}

/** Clamps into [0, framebuffer]: the origin is pulled to 0 and the extent shrunk to fit. */
function clampScissor(scissor: Rect, width: number, height: number, out: ScissorValue): void {
    let x = scissor.x ?? 0;
    let y = scissor.y ?? 0;
    let w = scissor.width;
    let h = scissor.height;
    if (x < 0) {
        w += x;
        x = 0;
    }
    if (y < 0) {
        h += y;
        y = 0;
    }
    out.x = x;
    out.y = y;
    out.width = Math.max(0, Math.min(w, width - x));
    out.height = Math.max(0, Math.min(h, height - y));
}

/** A rect covering the whole framebuffer clips nothing, so the scissor call is skipped. */
function coversFramebuffer(s: ScissorValue, width: number, height: number): boolean {
    return s.x === 0 && s.y === 0 && s.width === width && s.height === height;
}
