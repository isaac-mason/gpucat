/**
 * pass-context.ts — GPU pass configuration and caching.
 *
 * Contains context types for both render and compute passes:
 * - RenderContext: Configuration for render passes (framebuffer, clear state, viewport, etc.)
 * - ComputeContext: Configuration for compute passes (currently minimal, used for bind group caching)
 *
 * Aligned with Three.js RenderContext + RenderContexts pattern.
 *
 * Functional pattern: state object + functions.
 */
import type { Camera } from 'gpucat/dist/camera/camera';
import type { RenderTarget } from 'gpucat/dist/core/render-target';
import type { MRTNode } from 'gpucat/dist/nodes/lib/mrt';
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
    /** MRT node if multiple render targets are in use. */
    mrt: MRTNode | null;
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
    /** MSAA sample count (1 = no MSAA). */
    sampleCount: number;
    /** Camera for this render pass (used for uniform updates). */
    camera: Camera | null;
    /** Type flag for runtime checking. */
    readonly isRenderContext: true;
};
/**
 * ComputeContext - Configuration state for compute passes.
 *
 * Analogous to RenderContext for render passes. Currently minimal,
 * but provides a proper cache key for shared bind groups and can be
 * extended with dispatch configuration, timing, etc.
 */
export type ComputeContext = {
    /** Unique identifier for this context. */
    readonly id: number;
    /** Type flag for runtime checking. */
    readonly isComputeContext: true;
};
/**
 * Create a new ComputeContext.
 */
export declare function createComputeContext(): ComputeContext;
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
/**
 * Create a new RenderContext with default values.
 */
export declare function createRenderContext(): RenderContext;
/**
 * Create a new RenderContexts state.
 */
export declare function createRenderContextsState(): RenderContextsState;
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
export declare function getRenderContext(state: RenderContextsState, renderTarget: RenderTarget | null, mrt: MRTNode | null, callDepth: number): RenderContext;
