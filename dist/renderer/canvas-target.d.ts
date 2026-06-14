export type CanvasTargetOptions = {
    /** alpha compositing mode for the WebGPU canvas context. defaults to 'opaque'. */
    alphaMode?: GPUCanvasAlphaMode;
};
/** The HTMLCanvasElement target for the renderer to draw into. Wraps a canvas and its WebGPU context. */
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
    /** Alpha compositing mode for the WebGPU canvas context. */
    readonly alphaMode: GPUCanvasAlphaMode;
    /** Lazily-created WebGPU canvas context. Null until getContext() is called. */
    private _context;
    constructor(canvas: HTMLCanvasElement, opts?: CanvasTargetOptions);
    /**
     * Get (or lazily create) the WebGPU canvas context and configure it.
     * Safe to call multiple times, returns the cached context after first call.
     * WebGPURenderer lazily reads the context from the current canvasTarget.
     *
     * @param device the GPUDevice to configure the context with.
     * @param format the preferred canvas format (e.g. 'bgra8unorm').
     * @param alphaMode override for the alpha mode. defaults to the value set in the constructor.
     */
    getContext(device: GPUDevice, format: GPUTextureFormat, alphaMode?: GPUCanvasAlphaMode): GPUCanvasContext;
    /**
     * Unconfigure and release the WebGPU context. Called when the target is disposed
     * or replaced. After this, getContext() will create a fresh context.
     */
    unconfigure(): void;
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
     * Dispose this target: unconfigure the GPU context and fire 'dispose'.
     */
    dispose(): void;
}
