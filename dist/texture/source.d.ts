export type ImageSize = {
    width: number;
    height: number;
    depth?: number;
};
/** Data texture image format - raw typed array with dimensions */
export type DataTextureImage = {
    data: Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array | Float32Array | null;
    width: number;
    height: number;
    depth?: number;
};
export type SourceData = ImageBitmap | HTMLImageElement | HTMLCanvasElement | HTMLVideoElement | OffscreenCanvas | VideoFrame | ImageData | ImageSize | DataTextureImage | null;
/**
 * Represents the data source of a texture.
 *
 * The main purpose of this class is to decouple the data definition from the texture
 * definition so the same data can be used with multiple texture instances.
 */
export declare class Source<out T = SourceData> {
    /** unique numeric ID */
    readonly id: number;
    /** the data definition of a texture, can be an ImageBitmap, HTMLImageElement, canvas, video, or null */
    data: T;
    /** when set to `false`, the engine performs memory allocation but does not transfer data to GPU memory, useful for deferred loading */
    dataReady: boolean;
    /** version number, incremented when `needsUpdate` is set to true, used for dirty checking by the renderer */
    version: number;
    /**
     * Constructs a new Source
     * @param data the data definition (ImageBitmap, HTMLImageElement, etc.)
     */
    constructor(data: T);
    /** when set to `true`, increments the version counter to trigger a GPU upload on the next render */
    set needsUpdate(value: boolean);
    /** returns the width of the source data, or 0 if no data */
    get width(): number;
    /** returns the height of the source data, or 0 if no data */
    get height(): number;
    /** returns the depth of the source data (for 3D textures), or 0 */
    get depth(): number;
}
