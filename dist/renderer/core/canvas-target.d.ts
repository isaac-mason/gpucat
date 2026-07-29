/** Alpha compositing mode for the canvas. Neutral (backend-agnostic) string type. */
export type CanvasAlphaMode = 'opaque' | 'premultiplied';
export type CanvasTargetOptions = {
    /** alpha compositing mode for the canvas. defaults to 'opaque'. */
    alphaMode?: CanvasAlphaMode;
};
/**
 * The HTMLCanvasElement target for the renderer to draw into. Backend-agnostic: it holds the canvas
 * element, its logical size and pixel ratio, and the alpha mode. The graphics context is acquired and
 * owned by the backend, not by this class.
 */
export declare class CanvasTarget {
    /** The canvas element this target wraps. */
    readonly domElement: HTMLCanvasElement;
    /**
     * True when this is the renderer's default (main) canvas target.
     * Set by the renderer after construction; the inspector preview targets are not default.
     * The renderer sets isDefaultCanvasTarget = true on the initial target.
     */
    isDefaultCanvasTarget: boolean;
    /** Width in logical pixels. */
    _width: number;
    /** Height in logical pixels. */
    _height: number;
    /** Pixel ratio for high-DPI displays. */
    _pixelRatio: number;
    /** Alpha compositing mode for the canvas. */
    readonly alphaMode: CanvasAlphaMode;
    constructor(canvas: HTMLCanvasElement, opts?: CanvasTargetOptions);
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
     * Updates domElement.width/height (physical) and fires 'resize'.
     */
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
