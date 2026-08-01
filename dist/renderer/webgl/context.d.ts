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
export declare function createContext(canvas: HTMLCanvasElement | OffscreenCanvas, attrs: WebGL2ContextAttributes): WebGL2RenderingContext;
