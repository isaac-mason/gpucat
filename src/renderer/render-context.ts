/**
 * render-context.ts — Render pass configuration and caching.
 *
 * Merged from render-context.ts + render-contexts.ts.
 *
 * Aligned with Three.js RenderContext + RenderContexts:
 * - Stores framebuffer configuration (attachments, dimensions, samples)
 * - Stores clear state (color, depth, stencil values)
 * - Stores viewport/scissor state
 * - References render target and camera
 * - Caches render contexts by framebuffer configuration
 *
 * Functional pattern: state object + functions.
 */

import type { Camera } from '../camera/camera';
import type { RenderTarget } from '../core/render-target';
import type { MRTNode } from '../nodes/lib/mrt';

// ---------------------------------------------------------------------------
// RenderContext ID counter
// ---------------------------------------------------------------------------

let renderContextIdCounter = 0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * RGBA clear color value.
 */
export type ClearColorValue = {
    r: number;
    g: number;
    b: number;
    a: number;
};

/**
 * Viewport configuration in physical pixels.
 */
export type ViewportValue = {
    x: number;
    y: number;
    width: number;
    height: number;
    minDepth: number;
    maxDepth: number;
};

/**
 * Scissor rectangle in physical pixels.
 */
export type ScissorValue = {
    x: number;
    y: number;
    width: number;
    height: number;
};

/**
 * RenderContext - Configuration state for a render pass.
 *
 * This is the internal representation of render pass state that gets
 * translated into GPURenderPassDescriptor by the backend.
 *
 * Aligned with Three.js RenderContext structure.
 */
export type RenderContext = {
    /** Unique identifier for this context. */
    readonly id: number;

    // -------------------------------------------------------------------------
    // MRT Configuration
    // -------------------------------------------------------------------------

    /** MRT node if multiple render targets are in use. */
    mrt: MRTNode | null;

    // -------------------------------------------------------------------------
    // Clear State
    // -------------------------------------------------------------------------

    /** Whether to clear color attachment(s). */
    clearColor: boolean;

    /** Color clear value. */
    clearColorValue: ClearColorValue;

    /** Whether to clear depth attachment. */
    clearDepth: boolean;

    /** Depth clear value (0-1, typically 1). */
    clearDepthValue: number;

    /** Whether to clear stencil attachment. */
    clearStencil: boolean;

    /** Stencil clear value. */
    clearStencilValue: number;

    // -------------------------------------------------------------------------
    // Attachment Configuration
    // -------------------------------------------------------------------------

    /** Whether color attachment(s) are present. */
    color: boolean;

    /** Whether depth attachment is present. */
    depth: boolean;

    /** Whether stencil attachment is present. */
    stencil: boolean;

    // -------------------------------------------------------------------------
    // Viewport / Scissor
    // -------------------------------------------------------------------------

    /** Whether a custom viewport is active (not full framebuffer). */
    viewport: boolean;

    /** Viewport value in physical pixels. */
    viewportValue: ViewportValue;

    /** Whether scissor test is active. */
    scissor: boolean;

    /** Scissor rectangle in physical pixels. */
    scissorValue: ScissorValue;

    // -------------------------------------------------------------------------
    // Dimensions
    // -------------------------------------------------------------------------

    /** Framebuffer width in physical pixels. */
    width: number;

    /** Framebuffer height in physical pixels. */
    height: number;

    // -------------------------------------------------------------------------
    // Render Target
    // -------------------------------------------------------------------------

    /** The render target, or null for default framebuffer. */
    renderTarget: RenderTarget | null;

    /** GPU color textures (populated by renderer). */
    textures: GPUTexture[] | null;

    /** GPU depth texture (populated by renderer). */
    depthTexture: GPUTexture | null;

    /** Active cube face for cube render targets (0-5). */
    activeCubeFace: number;

    /** Active mipmap level for render targets. */
    activeMipmapLevel: number;

    // -------------------------------------------------------------------------
    // MSAA
    // -------------------------------------------------------------------------

    /** MSAA sample count (1 = no MSAA). */
    sampleCount: number;

    // -------------------------------------------------------------------------
    // Context References
    // -------------------------------------------------------------------------

    /** Camera for this render pass (used for uniform updates). */
    camera: Camera | null;

    /** Number of objects performing occlusion queries (future use). */
    occlusionQueryCount: number;

    // -------------------------------------------------------------------------
    // Type Flag
    // -------------------------------------------------------------------------

    /** Type flag for runtime checking. */
    readonly isRenderContext: true;
};

/**
 * RenderContextsState - manages render context caching.
 */
export type RenderContextsState = {
    /**
     * Cache of render contexts keyed by configuration string.
     * Key format: `{attachmentState}-{mrtId}-{callDepth}`
     */
    contexts: Map<string, RenderContext>;

    /**
     * Default clear values from renderer settings.
     */
    defaultClearDepth: number;
    defaultClearStencil: number;
};

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

/**
 * Create a new RenderContext with default values.
 */
export function createRenderContext(): RenderContext {
    return {
        id: renderContextIdCounter++,

        // MRT
        mrt: null,

        // Clear state
        clearColor: true,
        clearColorValue: { r: 0, g: 0, b: 0, a: 1 },
        clearDepth: true,
        clearDepthValue: 1,
        clearStencil: true,
        clearStencilValue: 0,

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
        textures: null,
        depthTexture: null,
        activeCubeFace: 0,
        activeMipmapLevel: 0,

        // MSAA
        sampleCount: 1,

        // Context
        camera: null,
        occlusionQueryCount: 0,

        // Type flag
        isRenderContext: true,
    };
}

/**
 * Create a new RenderContexts state.
 */
export function createRenderContextsState(): RenderContextsState {
    return {
        contexts: new Map(),
        defaultClearDepth: 1,
        defaultClearStencil: 0,
    };
}

// ---------------------------------------------------------------------------
// Cache Key Computation
// ---------------------------------------------------------------------------

/**
 * Compute a cache key for the render context.
 * Used by the backend to cache render pass descriptors.
 *
 * The key is based on the texture IDs, cube face, and mip level.
 */
export function getRenderContextCacheKey(context: RenderContext): number {
    const { textures, activeCubeFace, activeMipmapLevel } = context;

    // Simple hash combining texture state
    let hash = activeCubeFace * 1000 + activeMipmapLevel;

    if (textures) {
        for (let i = 0; i < textures.length; i++) {
            // Use label hash or index as proxy for texture identity
            hash = hash * 31 + i;
        }
    }

    return hash;
}

/**
 * Build the attachment state portion of the cache key.
 *
 * For default framebuffer, returns 'default'.
 * For render targets, returns: `{count}:{format}:{type}:{samples}:{depth}:{stencil}`
 */
function buildAttachmentState(renderTarget: RenderTarget | null): string {
    if (renderTarget === null) {
        return 'default';
    }

    const format = renderTarget.colorFormat;
    const count = renderTarget.textures.length;
    const samples = renderTarget.samples;
    const depth = renderTarget.depthFormat !== null;
    const stencil = false; // TODO: Add stencil support to RenderTarget

    return `${count}:${format}:${samples}:${depth}:${stencil}`;
}

/**
 * Build the MRT state portion of the cache key.
 */
function buildMrtState(mrt: MRTNode | null): string {
    if (mrt === null) {
        return 'default';
    }
    return String(mrt.id);
}

/**
 * Build the full cache key for a render context.
 */
function buildCacheKey(
    renderTarget: RenderTarget | null,
    mrt: MRTNode | null,
    callDepth: number,
): string {
    const attachmentState = buildAttachmentState(renderTarget);
    const mrtState = buildMrtState(mrt);
    return `${attachmentState}-${mrtState}-${callDepth}`;
}

// ---------------------------------------------------------------------------
// Context Retrieval
// ---------------------------------------------------------------------------

/**
 * Get or create a RenderContext for the given configuration.
 *
 * Aligned with Three.js RenderContexts.get():
 * - Returns cached context if configuration matches
 * - Creates new context if not found
 * - Updates dynamic values (clear values, sample count) on each access
 *
 * @param state - The RenderContexts state
 * @param renderTarget - The render target, or null for default framebuffer
 * @param mrt - The MRT node, or null
 * @param callDepth - Nesting depth for recursive render calls
 * @returns The render context for this configuration
 */
export function getRenderContext(
    state: RenderContextsState,
    renderTarget: RenderTarget | null,
    mrt: MRTNode | null,
    callDepth: number,
): RenderContext {
    const cacheKey = buildCacheKey(renderTarget, mrt, callDepth);

    let context = state.contexts.get(cacheKey);

    if (context === undefined) {
        context = createRenderContext();
        context.mrt = mrt;
        state.contexts.set(cacheKey, context);
    }

    // Update dynamic values on each access
    if (renderTarget !== null) {
        context.sampleCount = renderTarget.samples === 0 ? 1 : renderTarget.samples;
        context.depth = renderTarget.depthFormat !== null;
    }

    context.clearDepthValue = state.defaultClearDepth;
    context.clearStencilValue = state.defaultClearStencil;

    return context;
}
