/**
 * source.ts — Source class for texture data.
 *
 * Aligned with Three.js Source: decouples texture data from texture configuration
 * so the same data can be shared across multiple Texture instances.
 *
 * Usage:
 *   // Multiple textures sharing the same image
 *   const source = new Source(imageBitmap);
 *   const texA = new Texture(source); // linear filtering
 *   const texB = new Texture(source); // nearest filtering
 *   texB.magFilter = 'nearest';
 *
 *   // Update source data (affects all textures using it)
 *   source.data = newImageBitmap;
 *   source.needsUpdate = true;
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Simple image size descriptor (used for render targets) */
export type ImageSize = { width: number; height: number; depth?: number };

/** Supported source data types */
export type SourceData =
    | ImageBitmap
    | HTMLImageElement
    | HTMLCanvasElement
    | HTMLVideoElement
    | OffscreenCanvas
    | VideoFrame
    | ImageData
    | ImageSize
    | null;

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

let _sourceId = 0;

/**
 * Represents the data source of a texture.
 *
 * The main purpose of this class is to decouple the data definition from the texture
 * definition so the same data can be used with multiple texture instances.
 *
 * Three.js aligned.
 */
export class Source {
    /** Type flag for runtime checking */
    readonly isSource = true;

    /** Unique numeric ID */
    readonly id: number;

    /**
     * The data definition of a texture.
     * Can be an ImageBitmap, HTMLImageElement, canvas, video, or null.
     */
    data: SourceData;

    /**
     * When set to `false`, the engine performs memory allocation but does not
     * transfer data to GPU memory. Useful for deferred loading.
     * @default true
     */
    dataReady = true;

    /**
     * Version number, incremented when `needsUpdate` is set to true.
     * Used for dirty checking by the renderer.
     * @readonly
     */
    version = 0;

    /**
     * Constructs a new Source.
     *
     * @param data - The data definition (ImageBitmap, HTMLImageElement, etc.)
     */
    constructor(data: SourceData = null) {
        this.id = _sourceId++;
        this.data = data;
    }

    /**
     * When set to `true`, increments the version counter to trigger
     * a GPU upload on the next render.
     */
    set needsUpdate(value: boolean) {
        if (value === true) this.version++;
    }

    /**
     * Returns the width of the source data, or 0 if no data.
     */
    get width(): number {
        const data = this.data;
        if (!data) return 0;

        if (typeof HTMLVideoElement !== 'undefined' && data instanceof HTMLVideoElement) {
            return data.videoWidth;
        }
        if (typeof VideoFrame !== 'undefined' && data instanceof VideoFrame) {
            return data.displayWidth;
        }
        if ('width' in data) {
            return data.width;
        }
        return 0;
    }

    /**
     * Returns the height of the source data, or 0 if no data.
     */
    get height(): number {
        const data = this.data;
        if (!data) return 0;

        if (typeof HTMLVideoElement !== 'undefined' && data instanceof HTMLVideoElement) {
            return data.videoHeight;
        }
        if (typeof VideoFrame !== 'undefined' && data instanceof VideoFrame) {
            return data.displayHeight;
        }
        if ('height' in data) {
            return data.height;
        }
        return 0;
    }

    /**
     * Returns the depth of the source data (for 3D textures), or 0.
     */
    get depth(): number {
        const data = this.data;
        if (!data) return 0;
        if ('depth' in data && typeof data.depth === 'number') {
            return data.depth;
        }
        return 0;
    }
}
