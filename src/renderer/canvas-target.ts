export type CanvasTargetOptions = {
    /** alpha compositing mode for the WebGPU canvas context. defaults to 'opaque'. */
    alphaMode?: GPUCanvasAlphaMode;
};

/** The HTMLCanvasElement target for the renderer to draw into. Wraps a canvas and its WebGPU context. */
export class CanvasTarget {
    /** The canvas element this target wraps. */
    readonly domElement: HTMLCanvasElement;

    /**
     * True when this is the renderer's default (main) canvas target.
     * Set by the renderer after construction; the inspector preview targets are not default.
     * The renderer sets isDefaultCanvasTarget = true on the initial target.
     */
    isDefaultCanvasTarget: boolean = false;

    /** Width in logical pixels. */
    _width: number;

    /** Height in logical pixels. */
    _height: number;

    /** Pixel ratio for high-DPI displays. */
    _pixelRatio: number = 1;

    /** Alpha compositing mode for the WebGPU canvas context. */
    readonly alphaMode: GPUCanvasAlphaMode;

    /** Lazily-created WebGPU canvas context. Null until getContext() is called. */
    private _context: GPUCanvasContext | null = null;

    constructor(canvas: HTMLCanvasElement, opts: CanvasTargetOptions = {}) {
        this.domElement = canvas;
        this._width = canvas.width;
        this._height = canvas.height;
        this.alphaMode = opts.alphaMode ?? 'opaque';
    }

    /**
     * Get (or lazily create) the WebGPU canvas context and configure it.
     * Safe to call multiple times — returns the cached context after first call.
     * WebGPURenderer lazily reads the context from the current canvasTarget.
     *
     * @param device the GPUDevice to configure the context with.
     * @param format the preferred canvas format (e.g. 'bgra8unorm').
     * @param alphaMode override for the alpha mode. defaults to the value set in the constructor.
     */
    getContext(device: GPUDevice, format: GPUTextureFormat, alphaMode?: GPUCanvasAlphaMode): GPUCanvasContext {
        if (!this._context) {
            const ctx = this.domElement.getContext('webgpu');
            if (!ctx) {
                throw new Error('[CanvasTarget] Failed to get WebGPU context from canvas.');
            }
            ctx.configure({ device, format, alphaMode: alphaMode ?? this.alphaMode });
            this._context = ctx;
        }
        return this._context;
    }

    /**
     * Unconfigure and release the WebGPU context. Called when the target is disposed
     * or replaced. After this, getContext() will create a fresh context.
     */
    unconfigure(): void {
        if (this._context) {
            this._context.unconfigure();
            this._context = null;
        }
    }

    /**
     * Get the pixel ratio.
     */
    getPixelRatio(): number {
        return this._pixelRatio;
    }

    /**
     * Set the pixel ratio and resize the canvas to match.
     */
    setPixelRatio(value: number): void {
        if (this._pixelRatio === value) return;
        this._pixelRatio = value;
        this.setSize(this._width, this._height);
    }

    /**
     * Returns the drawing buffer size in physical pixels (honors pixel ratio).
     */
    getDrawingBufferSize(): { width: number; height: number } {
        return {
            width: Math.floor(this._width * this._pixelRatio),
            height: Math.floor(this._height * this._pixelRatio),
        };
    }

    /**
     * Returns the size in logical pixels (does not honor pixel ratio).
     */
    getSize(): { width: number; height: number } {
        return { width: this._width, height: this._height };
    }

    /**
     * Set the size of the canvas in logical pixels.
     * Updates domElement.width/height (physical) and fires 'resize'.
     */
    setSize(width: number, height: number, updateStyle: boolean = true): void {
        this._width = width;
        this._height = height;

        this.domElement.width = Math.floor(width * this._pixelRatio);
        this.domElement.height = Math.floor(height * this._pixelRatio);

        if (updateStyle) {
            this.domElement.style.width = `${width}px`;
            this.domElement.style.height = `${height}px`;
        }
    }

    /**
     * Set the drawing buffer size directly (width, height, pixelRatio all at once).
     */
    setDrawingBufferSize(width: number, height: number, pixelRatio: number): void {
        this._width = width;
        this._height = height;
        this._pixelRatio = pixelRatio;

        this.domElement.width = Math.floor(width * pixelRatio);
        this.domElement.height = Math.floor(height * pixelRatio);

        this.setSize(width, height, false);
    }

    /**
     * Dispose this target: unconfigure the GPU context and fire 'dispose'.
     */
    dispose(): void {
        this.unconfigure();
    }
}
