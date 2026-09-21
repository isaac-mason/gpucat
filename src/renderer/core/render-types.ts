import type { RenderTarget } from '../../core/render-target';
import type { CanvasTarget } from './canvas-target';
import type { RenderBundle } from './frame';
import type { ScissorValue, ViewportValue } from './pass-context';
import type { RenderObject } from './render-object';
import type { View } from './view';

/**
 * A render object that survived preparation (compiled + pipeline built), paired with the render list
 * item that produced it. The draw loop consumes these in order. Neutral: it only
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
    clearColor: { r: number; g: number; b: number; a: number };
    clearsColor: boolean;
    /** False preserves depth even when `clearsColor` clears colour. */
    clearsDepth: boolean;
    /** Depth the attachment clears to. 0 with a 'greater' depth compare is reversed-Z. */
    clearDepthValue: number;
    clearsStencil: boolean;
    clearStencilValue: number;
    /** Whether the swapchain depth format carries a stencil aspect (used only when renderTarget is null). */
    swapchainStencil: boolean;
    passId: string;

    /** Framebuffer width in physical pixels. */
    width: number;
    /** Framebuffer height in physical pixels. */
    height: number;
    camera: View | null;
    /** Whether a custom viewport is active (not the full framebuffer). */
    viewport: boolean;
    /** Viewport rect in physical pixels; meaningless unless `viewport`. */
    viewportValue: ViewportValue;
    /** Whether the scissor test is active; false when the rect covers the whole framebuffer. */
    scissor: boolean;
    /** Scissor rect in physical pixels, clamped to the framebuffer; meaningless unless `scissor`. */
    scissorValue: ScissorValue;
    /** Cube face this pass writes, 0 for every other kind of target. */
    layer: number;
    /** Mip level this pass writes, 0 unless the target is a cube with mips. */
    mipLevel: number;
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

/** Whether a depth format carries a stencil aspect. `stencil8` is stencil-only and still counts. */
export function formatHasStencil(format: GPUTextureFormat | undefined): boolean {
    return format !== undefined && format.includes('stencil');
}

/** A pass's own struct, filled in place by `resolvePassParams` so a steady-state frame allocates none. */
export function createPassParams(): RenderPassParams {
    return {
        renderTarget: null,
        canvasTarget: null,
        clearColor: { r: 0, g: 0, b: 0, a: 1 },
        clearsColor: true,
        clearsDepth: true,
        clearDepthValue: 1,
        clearsStencil: true,
        clearStencilValue: 0,
        swapchainStencil: false,
        passId: 'render',
        width: 0,
        height: 0,
        camera: null,
        viewport: false,
        viewportValue: { x: 0, y: 0, width: 0, height: 0, minDepth: 0, maxDepth: 1 },
        scissor: false,
        scissorValue: { x: 0, y: 0, width: 0, height: 0 },
        layer: 0,
        mipLevel: 0,
    };
}
