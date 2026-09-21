import type { DepthTextureFormat } from '../../texture/depth-texture';
/** Alpha compositing mode for the canvas. Neutral (backend-agnostic) string type. */
export type CanvasAlphaMode = 'opaque' | 'premultiplied';
export type CanvasTargetOptions = {
    /** alpha compositing mode for the canvas. defaults to 'opaque'. */
    alphaMode?: CanvasAlphaMode;
    /**
     * Depth(-stencil) format for the swapchain's depth attachment, e.g. 'depth32float' for higher
     * precision or 'depth24plus-stencil8' for a stencil aspect. Defaults to 'depth24plus'.
     */
    depthFormat?: DepthTextureFormat;
    /** MSAA sample count for the swapchain. 0 or 1 = no MSAA. Defaults to 1. */
    samples?: number;
    /**
     * Match the backing store to the canvas's CSS layout size at the start of each pass. Defaults to
     * true for a DOM canvas and false for an `OffscreenCanvas`, which has no layout to read.
     */
    autoResize?: boolean;
    /** Clear colour used by a pass that clears without naming one. Default [0, 0, 0, 1]. */
    clearColor?: [number, number, number, number];
    /**
     * Device pixel ratio policy. A number pins it; a `[min, max]` tuple clamps whatever is passed to
     * `setPixelRatio`, so a caller can forward `devicePixelRatio` without tracking limits itself.
     * Omitted leaves the ratio unclamped.
     */
    dpr?: number | [number, number];
};
/** Fired after the canvas buffer size or pixel ratio changes. */
export type CanvasResizeEvent = {
    /** Physical pixel width, equal to `canvas.width`. */
    width: number;
    /** Physical pixel height, equal to `canvas.height`. */
    height: number;
    pixelRatio: number;
    target: CanvasTarget;
};
/**
 * The HTMLCanvasElement target for the renderer to draw into. Backend-agnostic: it holds the canvas
 * element, its logical size and pixel ratio, and the alpha mode. The graphics context is acquired and
 * owned by the backend, not by this class.
 */
export declare class CanvasTarget {
    /** The canvas this target wraps. An `OffscreenCanvas` is accepted for headless/worker use. */
    readonly canvas: HTMLCanvasElement | OffscreenCanvas;
    /** Width in logical pixels. */
    _width: number;
    /** Height in logical pixels. */
    _height: number;
    /** Pixel ratio for high-DPI displays. */
    _pixelRatio: number;
    /** Alpha compositing mode for the canvas. */
    readonly alphaMode: CanvasAlphaMode;
    /** Swapchain depth(-stencil) format. The backend owns the texture; this is the config for it. */
    readonly depthFormat: DepthTextureFormat;
    /** Swapchain MSAA sample count; 1 = no MSAA. */
    readonly samples: number;
    /** Whether a pass matches the backing store to the canvas's CSS layout size before drawing. */
    readonly autoResize: boolean;
    /** Swapchain colour format, written by the backend when it configures the context. @internal */
    colorFormat: string;
    clearColor: [number, number, number, number];
    /** Clamp applied by `setPixelRatio`, or null when the ratio is unclamped. */
    private readonly _dprRange;
    private readonly _resizeListeners;
    constructor(canvas: HTMLCanvasElement | OffscreenCanvas, opts?: CanvasTargetOptions);
    /**
     * Subscribe to size changes. Fires immediately with the current size, then after every change.
     * Returns an unsubscribe function. Use it to keep derived render targets in step with the canvas.
     */
    onResize(listener: (event: CanvasResizeEvent) => void): () => void;
    private _resizeEvent;
    private _emitResize;
    /**
     * Get the pixel ratio.
     */
    getPixelRatio(): number;
    /**
     * Set the pixel ratio and resize the canvas to match.
     */
    setPixelRatio(value: number): void;
    /**
     * Returns the drawing buffer size in physical pixels (honors pixel ratio).
     */
    getDrawingBufferSize(): {
        width: number;
        height: number;
    };
    /**
     * Returns the size in logical pixels (does not honor pixel ratio).
     */
    getSize(): {
        width: number;
        height: number;
    };
    /**
     * Set the size of the canvas in logical pixels.
     * Updates canvas.width/height (physical) and fires 'resize'.
     */
    /** No-op unless the layout size changed. Never writes CSS back, since CSS is what it is reading. */
    syncToClientSize(): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    /**
     * Set the drawing buffer size directly (width, height, pixelRatio all at once).
     */
    setDrawingBufferSize(width: number, height: number, pixelRatio: number): void;
    /**
     * Dispose this target. The backend owns the graphics context and releases it separately.
     */
    dispose(): void;
}
/** Holds no device: the backend acquires the canvas context on first use. */
export declare function createCanvasTarget(canvas: HTMLCanvasElement | OffscreenCanvas, opts?: CanvasTargetOptions): CanvasTarget;
