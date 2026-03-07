export type ImageSize = { width: number; height: number; depth?: number };

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

let _sourceId = 0;

/**
 * Represents the data source of a texture.
 *
 * The main purpose of this class is to decouple the data definition from the texture
 * definition so the same data can be used with multiple texture instances.
 */
export class Source {
    /** unique numeric ID */
    readonly id: number;

    /** the data definition of a texture, can be an ImageBitmap, HTMLImageElement, canvas, video, or null */
    data: SourceData;

    /** when set to `false`, the engine performs memory allocation but does not transfer data to GPU memory, useful for deferred loading */
    dataReady = true;

    /** version number, incremented when `needsUpdate` is set to true, used for dirty checking by the renderer */
    version = 0;

    /**
     * Constructs a new Source
     * @param data the data definition (ImageBitmap, HTMLImageElement, etc.)
     */
    constructor(data: SourceData = null) {
        this.id = _sourceId++;
        this.data = data;
    }

    /** when set to `true`, increments the version counter to trigger a GPU upload on the next render */
    set needsUpdate(value: boolean) {
        if (value === true) this.version++;
    }

    /** returns the width of the source data, or 0 if no data */
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

    /** returns the height of the source data, or 0 if no data */
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

    /** returns the depth of the source data (for 3D textures), or 0 */
    get depth(): number {
        const data = this.data;
        if (!data) return 0;
        if ('depth' in data && typeof data.depth === 'number') {
            return data.depth;
        }
        return 0;
    }
}
