import { Source, type SourceData } from './source';
import { GpuTexture } from '../core/gpu-texture';
import { GpuSampler } from '../core/gpu-sampler';
import * as d from '../schema/schema';
/**
 * Cube texture mapping modes.
 * Determines which vector to use for cube texture sampling.
 */
export type CubeTextureMapping = 'reflection' | 'refraction';
export type CubeTextureOptions = {
    wrapS?: GPUAddressMode;
    wrapT?: GPUAddressMode;
    magFilter?: GPUFilterMode;
    minFilter?: GPUFilterMode;
    mipmapFilter?: GPUMipmapFilterMode;
    format?: GPUTextureFormat;
    generateMipmaps?: boolean;
    flipY?: boolean;
    mapping?: CubeTextureMapping;
    /**
     * Face size in pixels (width = height) for a render-only cube with no face
     * images, e.g. a CubeRenderTarget. Ignored when `faces` are provided.
     */
    size?: number;
};
/**
 * A texture for cubemaps (environment maps, skyboxes, etc).
 *
 * Stores 6 faces: +X, -X, +Y, -Y, +Z, -Z.
 * Sampled using a 3D direction vector.
 */
export declare class CubeTexture {
    /** Type flag for runtime checking */
    readonly isCubeTexture = true;
    /** The underlying GPU texture resource */
    readonly _gpuTexture: GpuTexture<d.textureCube>;
    /** The underlying sampler */
    readonly _gpuSampler: GpuSampler;
    /** Optional name for debugging */
    name: string;
    /**
     * Mapping mode - determines default UV vector.
     * - 'reflection': uses reflect(viewDir, normal)
     * - 'refraction': uses refract(viewDir, normal, ior)
     */
    mapping: CubeTextureMapping;
    /**
     * Constructs a new CubeTexture.
     *
     * @param faces - Array of 6 images for cube faces (+X, -X, +Y, -Y, +Z, -Z)
     * @param options - Texture options
     */
    constructor(faces?: [SourceData, SourceData, SourceData, SourceData, SourceData, SourceData] | SourceData[], options?: CubeTextureOptions);
    get id(): number;
    get width(): number;
    get height(): number;
    get size(): number;
    /** Check if all 6 faces are present and ready */
    get isComplete(): boolean;
    /** The 6 face images as SourceData */
    get images(): SourceData[];
    set images(value: SourceData[]);
    /** The 6 face Sources */
    get imageSources(): Source[];
    get wrapS(): GPUAddressMode;
    set wrapS(v: GPUAddressMode);
    get wrapT(): GPUAddressMode;
    set wrapT(v: GPUAddressMode);
    get magFilter(): GPUFilterMode;
    set magFilter(v: GPUFilterMode);
    get minFilter(): GPUFilterMode;
    set minFilter(v: GPUFilterMode);
    get mipmapFilter(): GPUMipmapFilterMode;
    set mipmapFilter(v: GPUMipmapFilterMode);
    get anisotropy(): number;
    set anisotropy(v: number);
    get format(): GPUTextureFormat;
    set format(v: GPUTextureFormat);
    get generateMipmaps(): boolean;
    set generateMipmaps(v: boolean);
    get flipY(): boolean;
    set flipY(v: boolean);
    get premultiplyAlpha(): boolean;
    set premultiplyAlpha(v: boolean);
    get version(): number;
    set needsUpdate(v: boolean);
    clone(): CubeTexture;
    dispose(): void;
}
