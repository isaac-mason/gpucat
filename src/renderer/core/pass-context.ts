import type { RenderTarget } from '../../core/render-target';
import type { MRTNode } from '../../nodes/lib/mrt';
import type { CanvasTarget } from './canvas-target';
import { formatHasStencil } from './render-types';
import { isRenderTarget, type Target } from './target';

// RenderContext ID counter

let renderContextIdCounter = 0;

// Types

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

// ComputeContext

let computeContextIdCounter = 0;

/** A compute pass's identity, which is all a shared bind group needs to be keyed by. */
export type ComputeContext = {
    /** Unique identifier for this context. */
    readonly id: number;

    /** Type flag for runtime checking. */
    readonly isComputeContext: true;
};

export function createComputeContext(): ComputeContext {
    return {
        id: computeContextIdCounter++,
        isComputeContext: true,
    };
}

/**
 * RenderContextsState - manages render context caching.
 */
export type RenderContextsState = {
    /** Keyed by attachment shape and MRT id; see `buildCacheKey`. */
    contexts: Map<string, RenderContext>;
};

export function createRenderContext(): RenderContext {
    return {
        id: renderContextIdCounter++,

        // MRT
        mrt: null,

        // Attachments
        color: true,
        depth: true,
        stencil: false,

        // Render target
        renderTarget: null,
        canvasTarget: null,

        // MSAA
        sampleCount: 1,

        // Type flag
        isRenderContext: true,
    };
}

export function createRenderContextsState(): RenderContextsState {
    return { contexts: new Map() };
}

// Cache Key Computation

/** Texture names are in the shape because MRT resolves its outputs by name against this target. */
function buildAttachmentState(target: Target): string {
    if (!isRenderTarget(target)) {
        return `canvas:${target.samples}:${target.depthFormat}`;
    }

    let formats = '';
    for (const texture of target.textures) formats += `${texture.name}:${texture.format},`;

    const depthAttachment = target._depthAttachment;
    const stencil = formatHasStencil(depthAttachment?.format);

    return `${target.textures.length}:${formats}:${target.samples}:${depthAttachment !== null}:${stencil}`;
}

function buildMrtState(mrt: MRTNode | null): string {
    if (mrt === null) {
        return 'default';
    }
    return String(mrt.id);
}

function buildCacheKey(target: Target, mrt: MRTNode | null): string {
    return `${buildAttachmentState(target)}-${buildMrtState(mrt)}`;
}

/** Refreshed on every access: a target can be resized or reallocated under a key that has not changed. */
export function getRenderContext(state: RenderContextsState, target: Target, mrt: MRTNode | null): RenderContext {
    const cacheKey = buildCacheKey(target, mrt);

    let context = state.contexts.get(cacheKey);

    if (context === undefined) {
        context = createRenderContext();
        context.mrt = mrt;
        state.contexts.set(cacheKey, context);
    }

    if (isRenderTarget(target)) {
        context.renderTarget = target;
        context.canvasTarget = null;
        context.sampleCount = target.samples === 0 ? 1 : target.samples;
        context.depth = target._depthAttachment !== null;
        context.stencil = formatHasStencil(target._depthAttachment?.format);
    } else {
        context.renderTarget = null;
        context.canvasTarget = target;
        context.sampleCount = target.samples === 0 ? 1 : target.samples;
        context.depth = true;
        context.stencil = formatHasStencil(target.depthFormat);
    }

    return context;
}
