import type { CoordinateSystem } from '../../core/coordinate-system';
import type { CubeRenderTarget } from '../../core/cube-render-target';
import { deadAttachment, type RenderTarget } from '../../core/render-target';
import type { CanvasTarget } from './canvas-target';
import type { PassDesc, Rect } from './frame';
import { getRenderContext, type RenderContext, type RenderContextsState, type ScissorValue } from './pass-context';
import { formatHasStencil, type RenderPassParams } from './render-types';
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

    out.viewport = viewport !== undefined;
    out.viewportValue.x = viewport?.x ?? 0;
    out.viewportValue.y = viewport?.y ?? 0;
    out.viewportValue.width = viewport?.width ?? 0;
    out.viewportValue.height = viewport?.height ?? 0;
    out.viewportValue.minDepth = viewport?.minDepth ?? 0;
    out.viewportValue.maxDepth = viewport?.maxDepth ?? 1;

    if (desc.scissor === undefined) {
        out.scissor = false;
    } else {
        clampScissor(desc.scissor, width, height, out.scissorValue);
        out.scissor = !coversFramebuffer(out.scissorValue, width, height);
    }

    return out;
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
