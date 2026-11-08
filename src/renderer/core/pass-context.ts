import type { MRTNode } from '../../nodes/lib/mrt';
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
    /** Passes with no MRT node, by attachment shape (`buildAttachmentState`): bounded by the shapes there are. */
    contexts: Map<string, RenderContext>;
    /** Passes with one, by node then shape: JS-only data that goes with its node. */
    mrtContexts: WeakMap<MRTNode, Map<string, RenderContext>>;
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

        // Attachments' shape
        colorFormats: null,
        colorNames: [],
        depthFormat: null,

        // MSAA
        sampleCount: 1,

        // Type flag
        isRenderContext: true,
    };
}

export function createRenderContextsState(): RenderContextsState {
    return { contexts: new Map(), mrtContexts: new WeakMap() };
}

// Cache Key Computation

/** Texture names are in the shape because MRT resolves its outputs by name against this target; the depth format is,
 *  as a pipeline is built for it. */
function buildAttachmentState(target: Target): string {
    if (!isRenderTarget(target)) {
        return `canvas:${target.samples}:${target.depthFormat}`;
    }

    let formats = '';
    for (const texture of target.textures) formats += `${texture.name}:${texture.format},`;

    const depthAttachment = target._depthAttachment;
    const stencil = formatHasStencil(depthAttachment?.format);

    return `${target.textures.length}:${formats}:${target.samples}:${depthAttachment?.format ?? 'none'}:${stencil}`;
}

/** The context of `target`'s attachment shape, made on first need; its fields are the shape, which is the key. */
export function getRenderContext(state: RenderContextsState, target: Target, mrt: MRTNode | null): RenderContext {
    const key = buildAttachmentState(target);
    let byShape = state.contexts;
    if (mrt !== null) {
        let forNode = state.mrtContexts.get(mrt);
        if (forNode === undefined) {
            forNode = new Map();
            state.mrtContexts.set(mrt, forNode);
        }
        byShape = forNode;
    }
    let context = byShape.get(key);
    if (context !== undefined) return context;

    context = createRenderContext();
    context.mrt = mrt;
    if (isRenderTarget(target)) {
        context.colorFormats = target.textures.map((texture) => texture.format);
        context.colorNames = target.textures.map((texture) => texture.name ?? '');
        context.sampleCount = target.samples === 0 ? 1 : target.samples;
        context.depthFormat = target._depthAttachment?.format ?? null;
        context.depth = target._depthAttachment !== null;
        context.stencil = formatHasStencil(target._depthAttachment?.format);
    } else {
        context.colorFormats = null;
        context.colorNames = [];
        context.sampleCount = target.samples === 0 ? 1 : target.samples;
        context.depthFormat = target.depthFormat;
        context.depth = true;
        context.stencil = formatHasStencil(target.depthFormat);
    }
    byShape.set(key, context);
    return context;
}
