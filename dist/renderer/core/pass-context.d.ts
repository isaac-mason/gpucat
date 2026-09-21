import type { RenderTarget } from '../../core/render-target';
import type { MRTNode } from '../../nodes/lib/mrt';
import type { CanvasTarget } from './canvas-target';
import { type Target } from './target';
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
/**
 * One per attachment shape, shared by every pass of that shape, which is what makes it a pipeline and
 * bind-group key. Only what `buildCacheKey` covers may live here: anything that differs between two
 * passes of the same shape belongs on `RenderPassParams`, which is allocated per pass.
 */
export type RenderContext = {
    readonly id: number;
    mrt: MRTNode | null;
    color: boolean;
    depth: boolean;
    stencil: boolean;
    /** Identity, which the key does not cover; read only for the formats and textures, which it does. */
    renderTarget: RenderTarget | null;
    canvasTarget: CanvasTarget | null;
    /** 1 = no MSAA. */
    sampleCount: number;
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
