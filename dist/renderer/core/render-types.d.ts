import type { RenderTarget } from '../../core/render-target';
import type { CanvasTarget } from './canvas-target';
import type { RenderBundle } from './frame';
import type { RenderObject } from './render-object';
/**
 * An opaque texture/attachment handle. Neutral core code may hold and pass these around but never
 * inspects them — the concrete type (a `GPUTexture` for WebGPU, a WebGLTexture-ish handle for a
 * future WebGL2 backend) lives entirely inside the renderer. Kept as `unknown` so no device type
 * name leaks into `render/core`.
 */
export type BackendTexture = unknown;
/**
 * A render object that survived preparation (compiled + pipeline built), paired with the render list
 * item that produced it. `executeRenderPass` consumes these in order to issue draws. Neutral: it only
 * references the language-agnostic `RenderObject`/`RenderItem`; the device payload lives in a
 * side table keyed by `renderObject`.
 */
export type PreparedRenderObject = RenderObject;
/**
 * Neutral, per-render swapchain/attachment inputs the renderer needs to resolve attachments and drive
 * the pass. Bundled so the render-loop orchestration owns this plain data. `clearColor` is the
 * resolved [r,g,b,a] for the pass.
 */
export type RenderPassParams = {
    renderTarget: RenderTarget | null;
    /** The canvas this pass draws to when `renderTarget` is null. Each one owns its own attachments. */
    canvasTarget: CanvasTarget | null;
    clearColor: {
        r: number;
        g: number;
        b: number;
        a: number;
    };
    autoClear: boolean;
    /** False preserves depth even when `autoClear` clears colour. */
    autoClearDepth: boolean;
    /** Depth the attachment clears to. 0 with a 'greater' depth compare is reversed-Z. */
    clearDepthValue: number;
    autoClearStencil: boolean;
    clearStencilValue: number;
    /** Whether the swapchain depth format carries a stencil aspect (used only when renderTarget is null). */
    swapchainStencil: boolean;
    passId: string;
};
/**
 * A contiguous run of prepared objects, and the bundle it came from if any. WebGPU records a device
 * bundle per run so it can `executeBundles` instead of re-encoding; WebGL ignores these, because the
 * flat prepared list already is the replay.
 */
export type PreparedSegment = {
    bundle: RenderBundle | null;
    start: number;
    count: number;
};
