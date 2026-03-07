/**
 * render-context.ts — Render pass configuration state container.
 *
 * Aligned with Three.js RenderContext:
 * - Stores framebuffer configuration (attachments, dimensions, samples)
 * - Stores clear state (color, depth, stencil values)
 * - Stores viewport/scissor state
 * - References render target and camera
 *
 * Unlike Three.js, we use a functional pattern:
 * - Pure type definition
 * - Factory function for creation
 * - Explicit update functions
 */

import type { Camera } from '../camera/camera';
import type { RenderTarget } from '../core/render-target';
import type { MRTNode } from '../nodes/nodes';

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

// ---------------------------------------------------------------------------
// Update Helpers
// ---------------------------------------------------------------------------

/**
 * Reset clear state to defaults (clear everything).
 */
export function resetClearState(context: RenderContext): void {
    context.clearColor = true;
    context.clearColorValue = { r: 0, g: 0, b: 0, a: 1 };
    context.clearDepth = true;
    context.clearDepthValue = 1;
    context.clearStencil = true;
    context.clearStencilValue = 0;
}

/**
 * Set viewport from x, y, width, height values.
 */
export function setViewport(
    context: RenderContext,
    x: number,
    y: number,
    width: number,
    height: number,
    minDepth = 0,
    maxDepth = 1,
): void {
    context.viewport = true;
    context.viewportValue.x = x;
    context.viewportValue.y = y;
    context.viewportValue.width = width;
    context.viewportValue.height = height;
    context.viewportValue.minDepth = minDepth;
    context.viewportValue.maxDepth = maxDepth;
}

/**
 * Set scissor rectangle.
 */
export function setScissor(
    context: RenderContext,
    x: number,
    y: number,
    width: number,
    height: number,
): void {
    context.scissor = true;
    context.scissorValue.x = x;
    context.scissorValue.y = y;
    context.scissorValue.width = width;
    context.scissorValue.height = height;
}

/**
 * Clear viewport (use full framebuffer).
 */
export function clearViewport(context: RenderContext): void {
    context.viewport = false;
}

/**
 * Clear scissor (no scissor test).
 */
export function clearScissor(context: RenderContext): void {
    context.scissor = false;
}
