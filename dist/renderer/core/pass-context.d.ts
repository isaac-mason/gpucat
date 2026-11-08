import type { MRTNode } from '../../nodes/lib/mrt';
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
    /** Each colour attachment's format, in order; null for the canvas, whose format the backend knows. */
    colorFormats: GPUTextureFormat[] | null;
    /** Each colour attachment's texture name, in order, which MRT resolves its outputs by; empty for the canvas. */
    colorNames: string[];
    /** The depth attachment's format, null for none. */
    depthFormat: GPUTextureFormat | null;
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
    /** Passes with no MRT node, by attachment shape (`buildAttachmentState`): bounded by the shapes there are. */
    contexts: Map<string, RenderContext>;
    /** Passes with one, by node then shape: JS-only data that goes with its node. */
    mrtContexts: WeakMap<MRTNode, Map<string, RenderContext>>;
};
export declare function createRenderContext(): RenderContext;
export declare function createRenderContextsState(): RenderContextsState;
/** The context of `target`'s attachment shape, made on first need; its fields are the shape, which is the key. */
export declare function getRenderContext(state: RenderContextsState, target: Target, mrt: MRTNode | null): RenderContext;
