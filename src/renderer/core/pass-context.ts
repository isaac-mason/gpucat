import type { RenderTarget } from '../../core/render-target';
import type { MRTNode } from '../../nodes/lib/mrt';
import type { CanvasTarget } from './canvas-target';
import type { BackendTexture } from './render-types';
import { isRenderTarget, type Target } from './target';
import type { View } from './view';

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

        // Clear state

        // Attachments
        color: true,
        depth: true,
        stencil: false,

        // Viewport/scissor
        viewport: false,
        viewportValue: { x: 0, y: 0, width: 0, height: 0, minDepth: 0, maxDepth: 1 },
        scissor: false,
        scissorValue: { x: 0, y: 0, width: 0, height: 0 },

        // Dimensions
        width: 0,
        height: 0,

        // Render target
        renderTarget: null,
        canvasTarget: null,
        textures: null,
        depthTexture: null,

        // MSAA
        sampleCount: 1,

        // Context
        camera: null,

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
    const stencil = depthAttachment !== null && depthAttachment.format.includes('stencil');

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
        context.stencil = target._depthAttachment !== null && target._depthAttachment.format.includes('stencil');
    } else {
        context.renderTarget = null;
        context.canvasTarget = target;
        context.sampleCount = target.samples === 0 ? 1 : target.samples;
        context.depth = true;
        context.stencil = target.depthFormat.includes('stencil');
    }

    return context;
}
