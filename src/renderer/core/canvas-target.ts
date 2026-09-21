import type { DepthTextureFormat } from '../../texture/depth-texture';

/** Alpha compositing mode for the canvas. Neutral (backend-agnostic) string type. */
export type CanvasAlphaMode = 'opaque' | 'premultiplied';

function clamp(value: number, [min, max]: [number, number]): number {
    return Math.min(Math.max(value, min), max);
}

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
export class CanvasTarget {
    /** The canvas this target wraps. An `OffscreenCanvas` is accepted for headless/worker use. */
    readonly canvas: HTMLCanvasElement | OffscreenCanvas;

    /** Width in logical pixels. */
    _width: number;

    /** Height in logical pixels. */
    _height: number;

    /** Pixel ratio for high-DPI displays. */
    _pixelRatio: number = 1;

    /** Alpha compositing mode for the canvas. */
    readonly alphaMode: CanvasAlphaMode;

    /** Swapchain depth(-stencil) format. The backend owns the texture; this is the config for it. */
    readonly depthFormat: DepthTextureFormat;

    /** Swapchain MSAA sample count; 1 = no MSAA. */
    readonly samples: number;

    /** Whether a pass matches the backing store to the canvas's CSS layout size before drawing. */
    readonly autoResize: boolean;

    /** Swapchain colour format, written by the backend when it configures the context. @internal */
    colorFormat = '';

    clearColor: [number, number, number, number];

    /** Clamp applied by `setPixelRatio`, or null when the ratio is unclamped. */
    private readonly _dprRange: [number, number] | null;

    private readonly _resizeListeners: ((event: CanvasResizeEvent) => void)[] = [];

    constructor(canvas: HTMLCanvasElement | OffscreenCanvas, opts: CanvasTargetOptions = {}) {
        this.canvas = canvas;
        this._width = canvas.width;
        this._height = canvas.height;
        this.alphaMode = opts.alphaMode ?? 'opaque';
        this.depthFormat = opts.depthFormat ?? 'depth24plus';
        this.samples = opts.samples ?? 1;
        // A canvas laid out by CSS reports clientWidth; an OffscreenCanvas is sized by the app alone.
        this.autoResize = opts.autoResize ?? 'clientWidth' in canvas;
        this.clearColor = opts.clearColor ?? [0, 0, 0, 1];

        const dpr = opts.dpr;
        this._dprRange = dpr === undefined ? null : typeof dpr === 'number' ? [dpr, dpr] : dpr;
        if (this._dprRange !== null) this._pixelRatio = clamp(this._pixelRatio, this._dprRange);
    }

    /**
     * Subscribe to size changes. Fires immediately with the current size, then after every change.
     * Returns an unsubscribe function. Use it to keep derived render targets in step with the canvas.
     */
    onResize(listener: (event: CanvasResizeEvent) => void): () => void {
        this._resizeListeners.push(listener);
        listener(this._resizeEvent());

        return () => {
            const i = this._resizeListeners.indexOf(listener);
            if (i !== -1) this._resizeListeners.splice(i, 1);
        };
    }

    private _resizeEvent(): CanvasResizeEvent {
        const { width, height } = this.getDrawingBufferSize();
        return { width, height, pixelRatio: this._pixelRatio, target: this };
    }

    private _emitResize(): void {
        if (this._resizeListeners.length === 0) return;
        const event = this._resizeEvent();
        for (const listener of this._resizeListeners) listener(event);
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
        const next = this._dprRange === null ? value : clamp(value, this._dprRange);
        if (this._pixelRatio === next) return;
        this._pixelRatio = next;
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
     * Updates canvas.width/height (physical) and fires 'resize'.
     */
    /** No-op unless the layout size changed. Never writes CSS back, since CSS is what it is reading. */
    syncToClientSize(): void {
        const element = this.canvas as HTMLCanvasElement;
        const width = element.clientWidth;
        const height = element.clientHeight;
        if (width === 0 || height === 0) return;
        if (width === this._width && height === this._height) return;
        this.setSize(width, height, false);
    }

    setSize(width: number, height: number, updateStyle: boolean = true): void {
        this._width = width;
        this._height = height;

        this.canvas.width = Math.floor(width * this._pixelRatio);
        this.canvas.height = Math.floor(height * this._pixelRatio);

        // An OffscreenCanvas has no `.style` (no DOM presentation); guard the CSS-size writes.
        if (updateStyle && 'style' in this.canvas) {
            this.canvas.style.width = `${width}px`;
            this.canvas.style.height = `${height}px`;
        }

        this._emitResize();
    }

    /**
     * Set the drawing buffer size directly (width, height, pixelRatio all at once).
     */
    setDrawingBufferSize(width: number, height: number, pixelRatio: number): void {
        this._width = width;
        this._height = height;
        this._pixelRatio = pixelRatio;

        this.canvas.width = Math.floor(width * pixelRatio);
        this.canvas.height = Math.floor(height * pixelRatio);

        this.setSize(width, height, false);
    }

    /**
     * Dispose this target. The backend owns the graphics context and releases it separately.
     */
    dispose(): void {}
}

/** Holds no device: the backend acquires the canvas context on first use. */
export function createCanvasTarget(canvas: HTMLCanvasElement | OffscreenCanvas, opts: CanvasTargetOptions = {}): CanvasTarget {
    return new CanvasTarget(canvas, opts);
}
