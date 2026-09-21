import type { RenderTarget } from '../../core/render-target';
import type { CanvasTarget } from './canvas-target';
/** A bundle, not a texture: it owns its colour count, depth, stencil, samples and store behaviour, so
 *  a pass names one target instead of assembling attachments. */
export type Target = RenderTarget | CanvasTarget;
export declare function isRenderTarget(target: Target): target is RenderTarget;
/** A `CanvasTarget` renders to the swapchain, which every backend addresses as a null render target. */
export declare function renderTargetOf(target: Target): RenderTarget | null;
