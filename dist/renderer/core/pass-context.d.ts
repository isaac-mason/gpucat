import type { RenderTarget } from '../../core/render-target';
import type { MRTNode } from '../../nodes/lib/mrt';
import type { CanvasTarget } from './canvas-target';
import type { BackendTexture } from './render-types';
import { type Target } from './target';
import type { View } from './view';
/** Physical pixels, so no pixel-ratio scaling applies. */
export type ViewportValue = {
    x: number;
    y: number;
    width: number;
    height: number;
    minDepth: number;
    maxDepth: number;
};
/** Physical pixels, so no pixel-ratio scaling applies. */
export type ScissorValue = {
    x: number;
    y: number;
    width: number;
    height: number;
};
/** What a backend turns into a `GPURenderPassDescriptor`, or into framebuffer and GL state. */
export type RenderContext = {
    /** Unique identifier for this context. */
    readonly id: number;
    /** MRT node if multiple render targets are in use. */
    mrt: MRTNode | null;
    /** Whether color attachment(s) are present. */
    color: boolean;
    /** Whether depth attachment is present. */
    depth: boolean;
    /** Whether stencil attachment is present. */
    stencil: boolean;
    /** Whether a custom viewport is active (not full framebuffer). */
    viewport: boolean;
    /** Viewport value in physical pixels. */
    viewportValue: ViewportValue;
    /** Whether scissor test is active. */
    scissor: boolean;
    /** Scissor rectangle in physical pixels. */
    scissorValue: ScissorValue;
    /** Framebuffer width in physical pixels. */
    width: number;
    /** Framebuffer height in physical pixels. */
    height: number;
    /** The render target, or null when the pass draws to a canvas. */
    renderTarget: RenderTarget | null;
    /** The canvas target, or null when the pass draws to a render target. */
    canvasTarget: CanvasTarget | null;
    /** Backend color texture handles (populated by renderer). Opaque to core. */
    textures: BackendTexture[] | null;
    /** Backend depth texture handle (populated by renderer). Opaque to core. */
    depthTexture: BackendTexture | null;
    /** MSAA sample count (1 = no MSAA). */
    sampleCount: number;
    /** Camera for this render pass (used for uniform updates). */
    camera: View | null;
    /** Type flag for runtime checking. */
    readonly isRenderContext: true;
};
/** A compute pass's identity, which is all a shared bind group needs to be keyed by. */
export type ComputeContext = {
    /** Unique identifier for this context. */
    readonly id: number;
    /** Type flag for runtime checking. */
    readonly isComputeContext: true;
};
export declare function createComputeContext(): ComputeContext;
/**
 * RenderContextsState - manages render context caching.
 */
export type RenderContextsState = {
    /** Keyed by attachment shape and MRT id; see `buildCacheKey`. */
    contexts: Map<string, RenderContext>;
};
export declare function createRenderContext(): RenderContext;
export declare function createRenderContextsState(): RenderContextsState;
/** Refreshed on every access: a target can be resized or reallocated under a key that has not changed. */
export declare function getRenderContext(state: RenderContextsState, target: Target, mrt: MRTNode | null): RenderContext;
