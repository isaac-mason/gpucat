import * as d from '../schema/schema';
import { Source, type SourceData } from '../texture/source';
/** GPU texture dimension from schema type */
export type DimensionOf<D extends d.Texture> = D extends d.texture1d ? '1d' : D extends d.texture3d ? '3d' : '2d';
/** View dimension from schema type (for GPUTextureView) */
export type ViewDimensionOf<D extends d.Texture> = D extends d.texture1d ? '1d' : D extends d.texture2d | d.textureDepth2d | d.textureMultisampled2d | d.textureDepthMultisampled2d ? '2d' : D extends d.texture2dArray | d.textureDepth2dArray ? '2d-array' : D extends d.textureCube | d.textureDepthCube ? 'cube' : D extends d.textureCubeArray | d.textureDepthCubeArray ? 'cube-array' : D extends d.texture3d ? '3d' : '2d';
type BaseOptions = {
    format?: GPUTextureFormat;
    usage?: GPUTextureUsageFlags;
    mipLevelCount?: number;
    sampleCount?: number;
    source?: Source | SourceData;
    generateMipmaps?: boolean;
    flipY?: boolean;
    premultiplyAlpha?: boolean;
};
type Options2D = BaseOptions & {
    width: number;
    height: number;
};
type Options2DArray = BaseOptions & {
    width: number;
    height: number;
    layers: number;
    sources?: (Source | SourceData)[];
};
type OptionsCube = BaseOptions & {
    size: number;
    faces?: [Source | SourceData, Source | SourceData, Source | SourceData, Source | SourceData, Source | SourceData, Source | SourceData] | (Source | SourceData)[];
};
type OptionsCubeArray = BaseOptions & {
    size: number;
    cubeCount: number;
    faces?: (Source | SourceData)[];
};
type Options3D = BaseOptions & {
    width: number;
    height: number;
    depth: number;
};
type Options1D = BaseOptions & {
    width: number;
};
/** Map schema type → options type */
export type GpuTextureOptions<D extends d.Texture> = D extends d.texture1d ? Options1D : D extends d.texture2d | d.textureDepth2d | d.textureMultisampled2d | d.textureDepthMultisampled2d ? Options2D : D extends d.texture2dArray | d.textureDepth2dArray ? Options2DArray : D extends d.textureCube | d.textureDepthCube ? OptionsCube : D extends d.textureCubeArray | d.textureDepthCubeArray ? OptionsCubeArray : D extends d.texture3d ? Options3D : Options2D;
export declare class GpuTexture<D extends d.Texture = d.Texture> {
    /** Unique ID */
    readonly id: number;
    /** Schema type descriptor, source of truth for WGSL type */
    readonly type: D;
    /** GPU texture dimension ('1d', '2d', '3d') */
    readonly dimension: DimensionOf<D>;
    /** View dimension for createView() */
    readonly viewDimension: ViewDimensionOf<D>;
    width: number;
    height: number;
    depthOrArrayLayers: number;
    format: GPUTextureFormat;
    usage: GPUTextureUsageFlags;
    mipLevelCount: number;
    sampleCount: number;
    /** Primary source (for 2D/3D) */
    source: Source | null;
    /** Per-layer/face sources (for array/cube textures) */
    sources: Source[];
    /** Generate mipmaps on upload */
    generateMipmaps: boolean;
    /** Flip Y on upload (for image sources) */
    flipY: boolean;
    /** Premultiply alpha on upload */
    premultiplyAlpha: boolean;
    /** Version number, incremented when needsUpdate is set */
    version: number;
    /** Mark texture as needing re-upload */
    set needsUpdate(_: true);
    /** Track which layers need updating (for 2D array textures) */
    readonly layerUpdates: Set<number>;
    /**
     * Whether this texture is a render target (managed by RenderTarget system).
     * When true, the renderer skips source data upload - the GPU texture is
     * created and managed by RenderTarget.
     */
    isRenderTargetTexture: boolean;
    /** Renderer-set callback to destroy GPU resources */
    _onDispose: (() => void) | null;
    /** Set to true after dispose() */
    disposed: boolean;
    constructor(type: D, options: GpuTextureOptions<D>);
    /** For cube textures: the size (width = height) */
    get size(): number;
    /** For 2D array: number of layers */
    get layers(): number;
    /** For 3D: depth */
    get depth(): number;
    /** For cube array: number of cubes */
    get cubeCount(): number;
    /** Is this a depth texture? */
    get isDepth(): boolean;
    /** Is all source data ready for upload? */
    get isComplete(): boolean;
    dispose(): void;
}
export {};
