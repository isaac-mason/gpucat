import * as d from '../schema/schema';
import { Source, type SourceData } from '../texture/source';
import type { RenderTarget } from './render-target';
/** GPU texture dimension from schema type */
export type DimensionOf<D extends d.Texture> = D extends d.texture1d | d.textureStorage1d ? '1d' : D extends d.texture3d | d.textureStorage3d ? '3d' : '2d';
/** View dimension from schema type (for GPUTextureView) */
export type ViewDimensionOf<D extends d.Texture> = D extends d.texture1d | d.textureStorage1d ? '1d' : D extends d.texture2d | d.textureDepth2d | d.textureMultisampled2d | d.textureDepthMultisampled2d | d.textureStorage2d ? '2d' : D extends d.texture2dArray | d.textureDepth2dArray | d.textureStorage2dArray ? '2d-array' : D extends d.textureCube | d.textureDepthCube ? 'cube' : D extends d.textureCubeArray | d.textureDepthCubeArray ? 'cube-array' : D extends d.texture3d | d.textureStorage3d ? '3d' : '2d';
type BaseOptions = {
    format?: GPUTextureFormat;
    usage?: GPUTextureUsageFlags;
    mipLevelCount?: number;
    sampleCount?: number;
    source?: Source | SourceData;
    generateMipmaps?: boolean;
    /**
     * User-supplied mip levels (index 0 = level 1, since level 0 is `source`/`sources`).
     * When non-empty the renderer uploads these verbatim and skips GPU mip generation.
     * Each entry holds the packed data for *all* layers at that level (array/cube),
     * or the single image (2D).
     */
    mipmaps?: (Source | SourceData)[];
    flipY?: boolean;
    premultiplyAlpha?: boolean;
    /** Storage textures only: regenerate mips after a compute write (default true). */
    mipmapsAutoUpdate?: boolean;
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
    faces?: [
        Source | SourceData,
        Source | SourceData,
        Source | SourceData,
        Source | SourceData,
        Source | SourceData,
        Source | SourceData
    ] | (Source | SourceData)[];
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
export type GpuTextureOptions<D extends d.Texture> = D extends d.texture1d | d.textureStorage1d ? Options1D : D extends d.texture2d | d.textureDepth2d | d.textureMultisampled2d | d.textureDepthMultisampled2d | d.textureStorage2d ? Options2D : D extends d.texture2dArray | d.textureDepth2dArray | d.textureStorage2dArray ? Options2DArray : D extends d.textureCube | d.textureDepthCube ? OptionsCube : D extends d.textureCubeArray | d.textureDepthCubeArray ? OptionsCubeArray : D extends d.texture3d | d.textureStorage3d ? Options3D : Options2D;
export declare class GpuTexture<D extends d.Texture = d.Texture> {
    readonly isGpuTexture = true;
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
    /**
     * User-supplied mip levels (index 0 = level 1; level 0 lives in `source`/`sources`).
     * When non-empty the renderer uploads these and skips render-pass mip generation.
     */
    mipmaps: Source[];
    /** Generate mipmaps on upload */
    generateMipmaps: boolean;
    /** Storage textures: regenerate mips after a compute pass writes this texture (if it has mips). */
    mipmapsAutoUpdate: boolean;
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
    /**
     * Render target this texture belongs to (color or depth attachment), or null.
     * Lets the bind path lazily (re)allocate a sampled render target whose own
     * render pass hasn't run this frame — e.g. it was resized between renders.
     */
    renderTarget: RenderTarget | null;
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
/** Create a 2D storage texture (`texture_storage_2d<format, _>`). */
export declare function createStorageTexture<F extends d.StorageTextureFormat = 'rgba8unorm'>(width: number, height: number, format?: F): GpuTexture<d.textureStorage2d<F, 'write'>>;
/** Create a 3D storage texture (`texture_storage_3d<format, _>`). */
export declare function createStorageTexture3d<F extends d.StorageTextureFormat = 'rgba8unorm'>(width: number, height: number, depth: number, format?: F): GpuTexture<d.textureStorage3d<F, 'write'>>;
/** Create a 2D-array storage texture (`texture_storage_2d_array<format, _>`). */
export declare function createStorageTextureArray<F extends d.StorageTextureFormat = 'rgba8unorm'>(width: number, height: number, layers: number, format?: F): GpuTexture<d.textureStorage2dArray<F, 'write'>>;
/** Create a 1D storage texture (`texture_storage_1d<format, _>`). */
export declare function createStorageTexture1d<F extends d.StorageTextureFormat = 'rgba8unorm'>(width: number, format?: F): GpuTexture<d.textureStorage1d<F, 'write'>>;
export {};
