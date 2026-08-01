/**
 * context.ts (webgl) - WebGL2 context acquisition.
 *
 * A single free device function that acquires the WebGL2 rendering context from a canvas with the
 * requested context attributes. Called by `WebGLRenderer.init()`. WebGL2 is immediate mode — there is
 * no device object or swapchain to configure, so this is the whole of "device bring-up".
 */

/** Context attributes forwarded to `canvas.getContext('webgl2', ...)`. */
export type WebGL2ContextAttributes = {
    alpha: boolean;
    depth: boolean;
    stencil: boolean;
    antialias: boolean;
    /** GPU power-preference hint for context creation. Default: 'default'. */
    powerPreference?: 'default' | 'low-power' | 'high-performance';
    /** Keep the drawing buffer contents between frames (readback after present). Default: false. */
    preserveDrawingBuffer?: boolean;
    /** Fail context creation if a major performance caveat (e.g. software rendering) applies. Default: false. */
    failIfMajorPerformanceCaveat?: boolean;
};

/**
 * Acquire the WebGL2 context for a canvas. Throws a clear error if WebGL2 is unavailable
 * (unsupported environment, or the canvas already has an incompatible context).
 */
export function createContext(canvas: HTMLCanvasElement | OffscreenCanvas, attrs: WebGL2ContextAttributes): WebGL2RenderingContext {
    // `getContext('webgl2', …)` exists on both HTMLCanvasElement and OffscreenCanvas at runtime; cast
    // through HTMLCanvasElement so the single call type-checks across the union.
    const gl = (canvas as HTMLCanvasElement).getContext('webgl2', attrs) as WebGL2RenderingContext | null;
    if (!gl) {
        throw new Error('[WebGLRenderer] WebGL2 is not available in this environment.');
    }

    // Enable float-format support. In WebGL2, float textures (RGBA16F/RGBA32F/…) are sampleable by
    // default but NOT color-renderable as framebuffer attachments without EXT_color_buffer_float —
    // and gpucat's RenderTarget/pass() default to `rgba16float`, so render-to-texture (any HDR /
    // post-processing pass) needs this or the FBO is incomplete. Requesting an extension activates it
    // for the context. Availability is re-checked when a float render target is actually built
    // (render-target.ts `ensureColorRenderable`), which throws a clear error if neither ext is present
    // instead of letting the FBO silently become incomplete.
    gl.getExtension('EXT_color_buffer_float'); // 16F/32F render targets (the FBO-completeness fix)
    gl.getExtension('EXT_color_buffer_half_float'); // half-float render targets (older path / fallback)
    gl.getExtension('OES_texture_float_linear'); // linear filtering of 32-bit-float textures
    gl.getExtension('EXT_float_blend'); // blending into 32-bit-float render targets

    // Enable GPU timer queries so the inspector can report real per-pass GPU times. Missing (Safari,
    // some drivers) → returns null → inspector leaves gpuMs null (CPU-only timing).
    gl.getExtension('EXT_disjoint_timer_query_webgl2');

    return gl;
}
