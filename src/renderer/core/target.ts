import type { RenderTarget } from '../../core/render-target';
import type { CanvasTarget } from './canvas-target';

/** A bundle, not a texture: it owns its colour count, depth, stencil, samples and store behaviour, so
 *  a pass names one target instead of assembling attachments. */
export type Target = RenderTarget | CanvasTarget;

export function isRenderTarget(target: Target): target is RenderTarget {
    return (target as RenderTarget).isRenderTarget === true;
}

/** A `CanvasTarget` renders to the swapchain, which every backend addresses as a null render target. */
export function renderTargetOf(target: Target): RenderTarget | null {
    return isRenderTarget(target) ? target : null;
}
