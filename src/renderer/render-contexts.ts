/**
 * render-contexts.ts — RenderContext caching and management.
 *
 * Aligned with Three.js RenderContexts:
 * - Caches render contexts by framebuffer configuration
 * - Reuses contexts with the same attachment state
 * - Key based on: format, type, samples, depth/stencil, MRT, call depth
 *
 * Functional pattern: state object + functions.
 */

import type { RenderTarget } from './render-target';
import type { MRTNode } from '../nodes/nodes';
import { createRenderContext, type RenderContext } from './render-context';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * RenderContexts state - manages render context caching.
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
// Factory
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Configuration Updates
// ---------------------------------------------------------------------------

/**
 * Set default clear values.
 */
export function setDefaultClearValues(
    state: RenderContextsState,
    clearDepth: number,
    clearStencil: number,
): void {
    state.defaultClearDepth = clearDepth;
    state.defaultClearStencil = clearStencil;
}

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

/**
 * Clear all cached contexts.
 */
export function disposeRenderContexts(state: RenderContextsState): void {
    state.contexts.clear();
}
