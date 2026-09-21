import type { CoordinateSystem } from '../../core/coordinate-system';
import type { CubeRenderTarget } from '../../core/cube-render-target';
import type { RenderTarget } from '../../core/render-target';
import type { CanvasTarget } from './canvas-target';
import type { PassDesc } from './frame';
import { getRenderContext, type RenderContext, type RenderContextsState } from './pass-context';
import type { RenderPassParams } from './render-types';
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
    if (isRenderTarget(target)) {
        return target._depthAttachment?.format.includes('stencil') ?? false;
    }
    return target.depthFormat.includes('stencil');
}

/**
 * A target disposed between recording and submit reaches the device as "destroyed texture used in a
 * submit", which surfaces asynchronously from the driver with no way back to the pass that named it.
 * A room swap disposing its targets mid-frame is the case that does this.
 */
function assertNotDisposed(rt: RenderTarget): void {
    for (const tex of rt.textures) {
        if (tex._gpuTexture.disposed) {
            throw new Error(`[frame] pass names a disposed render target (attachment '${tex.name}').`);
        }
    }
    if (rt._depthAttachment?._gpuTexture.disposed) {
        throw new Error('[frame] pass names a render target whose depth attachment is disposed.');
    }
}

/** Viewport and scissor are physical pixels of the target, so no pixel-ratio scaling applies. */
export function resolvePassContext(state: RenderContextsState, desc: PassDesc): RenderContext {
    const target = desc.target;
    const rt = renderTargetOf(target);
    if (rt !== null) assertNotDisposed(rt);
    const ctx = getRenderContext(state, target, desc.mrt ?? null);
    const { width, height } = sizeOf(target);

    // The backends read the face and level off the target itself, so the desc has to land there.
    if (rt !== null && isCubeRenderTarget(rt)) {
        if (desc.layer !== undefined) rt.activeFace = desc.layer;
        if (desc.mipLevel !== undefined) rt.activeMipmapLevel = desc.mipLevel;
    } else if (desc.layer !== undefined || desc.mipLevel !== undefined) {
        // Accepting these and rendering to face 0 level 0 anyway is how a cube bake silently writes
        // every face on top of itself.
        throw new Error('[frame] layer and mipLevel select a cube face and level; this pass names a target that has neither.');
    }

    ctx.width = width;
    ctx.height = height;
    ctx.camera = desc.camera ?? null;

    const viewport = desc.viewport;
    ctx.viewport = viewport !== undefined;
    if (viewport !== undefined) {
        const v = ctx.viewportValue;
        v.x = viewport.x ?? 0;
        v.y = viewport.y ?? 0;
        v.width = viewport.width;
        v.height = viewport.height;
        v.minDepth = viewport.minDepth ?? 0;
        v.maxDepth = viewport.maxDepth ?? 1;
    }

    const scissor = desc.scissor;
    if (scissor === undefined) {
        ctx.scissor = false;
    } else {
        const s = ctx.scissorValue;
        let x = scissor.x ?? 0;
        let y = scissor.y ?? 0;
        let w = scissor.width;
        let h = scissor.height;
        // Clamp into [0, framebuffer]: pull the origin to 0 and shrink the extent to fit.
        if (x < 0) {
            w += x;
            x = 0;
        }
        if (y < 0) {
            h += y;
            y = 0;
        }
        s.x = x;
        s.y = y;
        s.width = Math.max(0, Math.min(w, width - x));
        s.height = Math.max(0, Math.min(h, height - y));
        // A rect covering the whole framebuffer clips nothing, so skip the call.
        ctx.scissor = !(x === 0 && y === 0 && s.width === width && s.height === height);
    }

    return ctx;
}

export function resolvePassParams(desc: PassDesc): RenderPassParams {
    const target = desc.target;
    const [r, g, b, a] = desc.clear === false || desc.clear === undefined ? target.clearColor : desc.clear;

    const rt = renderTargetOf(target);
    return {
        renderTarget: rt,
        canvasTarget: rt === null ? (target as CanvasTarget) : null,
        clearColor: { r, g, b, a },
        autoClear: desc.clear !== false,
        autoClearDepth: desc.clearDepth !== false,
        clearDepthValue: typeof desc.clearDepth === 'number' ? desc.clearDepth : 1,
        autoClearStencil: desc.clearStencil !== false,
        clearStencilValue: typeof desc.clearStencil === 'number' ? desc.clearStencil : 0,
        swapchainStencil: hasStencil(target),
        passId: desc.label ?? 'render',
    };
}
