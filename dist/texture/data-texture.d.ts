import type { StructDef } from '../nodes/lib/core';
import { GpuTexture } from '../core/gpu-texture';
import { GpuSampler } from '../core/gpu-sampler';
import { Source, type DataTextureImage } from './source';
import * as d from '../schema/schema';
import type { WrapMode, FilterMode, MipmapFilterMode, TextureOptions } from './texture';
/** Valid typed array types for DataTexture */
export type DataTextureData = Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array | Float32Array;
/** JS value shape for writing a struct record: each field mapped to its inferred value type. */
export type StructValue<S extends d.StructSchema> = {
    [K in keyof S]: d.Infer<S[K]>;
};
/**
 * A texture created from raw typed array data.
 *
 * Useful for procedural textures, LUTs, noise textures, heightmaps, etc.
 */
export declare class DataTexture {
    /** Type flag for runtime checking */
    readonly isDataTexture = true;
    /** The underlying GPU texture resource */
    readonly _gpuTexture: GpuTexture<d.texture2d>;
    /** The underlying sampler */
    readonly _gpuSampler: GpuSampler;
    /** Optional name for debugging */
    name: string;
    /**
     * Constructs a new DataTexture.
     *
     * @param data - Raw pixel data
     * @param width - Width of the texture
     * @param height - Height of the texture
     * @param options - Texture options (including format)
     */
    constructor(data: DataTextureData | null, width: number, height: number, options?: TextureOptions);
    /** Unique numeric ID */
    get id(): number;
    /** Returns the width of the texture. */
    get width(): number;
    /** Returns the height of the texture. */
    get height(): number;
    /** The data source for this texture. */
    get source(): Source<DataTextureImage> | null;
    /** Convenience getter for the source data. */
    get image(): DataTextureImage | null;
    /** The underlying data array */
    get data(): DataTextureData | null;
    /** Horizontal wrap mode (U direction). */
    get wrapS(): WrapMode;
    set wrapS(v: WrapMode);
    /** Vertical wrap mode (V direction). */
    get wrapT(): WrapMode;
    set wrapT(v: WrapMode);
    /** Magnification filter. */
    get magFilter(): FilterMode;
    set magFilter(v: FilterMode);
    /** Minification filter. */
    get minFilter(): FilterMode;
    set minFilter(v: FilterMode);
    /** Mipmap filter mode. */
    get mipmapFilter(): MipmapFilterMode;
    set mipmapFilter(v: MipmapFilterMode);
    /** Anisotropic filtering level. */
    get anisotropy(): number;
    set anisotropy(v: number);
    /** WebGPU texture format. */
    get format(): GPUTextureFormat;
    set format(v: GPUTextureFormat);
    /** Whether to auto-generate mipmaps. */
    get generateMipmaps(): boolean;
    set generateMipmaps(v: boolean);
    /** Whether to flip the image vertically when uploading. */
    get flipY(): boolean;
    set flipY(v: boolean);
    /** Whether to premultiply alpha. */
    get premultiplyAlpha(): boolean;
    set premultiplyAlpha(v: boolean);
    /** Version for dirty tracking. */
    get version(): number;
    /** Set to `true` to trigger a GPU upload on the next render. */
    set needsUpdate(value: boolean);
    /**
     * Pack a struct record into record `index` (byte offset `index · texelStride · 16`), encoding
     * `value` into the backing `rgba32uint` data (std430 layout) and flagging a GPU re-upload. The
     * common CPU-side write; pair with `texture(this).load(schema, i)` on the shader side. Allocate via
     * {@link createStructTexture}.
     */
    packAtIndex<S extends d.StructSchema>(schema: StructDef<S>, index: number, value: StructValue<S>): this;
    /**
     * Pack a struct record starting at an explicit TEXEL offset, the low-level primitive under
     * {@link packAtIndex} (a texel is this texture's native addressing unit).
     */
    packAtTexel<S extends d.StructSchema>(schema: StructDef<S>, texel: number, value: StructValue<S>): this;
    /**
     * Bulk write: pack an entire array of struct `values` from record 0, encoding each per `schema`
     * (std430) at its `texelStride`, growing the texture (height only) to hold them all, then flag ONE
     * full re-upload (`needsUpdate` supersedes any queued partial ranges). Parallel to
     * {@link GpuBuffer.pack}.
     */
    pack<S extends d.StructSchema>(schema: StructDef<S>, values: StructValue<S>[]): this;
    /**
     * Queue a partial upload of a texel range so the renderer re-uploads only the covering rows
     * (`texSubImage2D` / `writeTexture`) instead of the whole texture. Auto-called by
     * {@link packAtIndex} / {@link packAtTexel}; call directly if you mutate `.data` by hand. A
     * subsequent `needsUpdate = true` (full re-upload) supersedes any queued ranges.
     */
    addUpdateRange(startTexel: number, countTexels: number): this;
    /**
     * Ensure the backing `rgba32uint` array holds at least `requiredTexels` texels, growing HEIGHT
     * (never width) if needed: reallocate `width × newHeight × 4` u32, copy existing data, swap the
     * source, and bump the version so the renderer re-allocates the GL/GPU texture (via mutable
     * `texImage2D`; DataTextures are not immutable-storage). Keeping width fixed is what lets an
     * already-compiled `load(schema, i)` shader keep addressing correctly across a grow.
     */
    private _ensureTexels;
    /**
     * Creates a clone of this texture.
     */
    clone(): DataTexture;
    /**
     * Disposes of the texture and its GPU resources.
     */
    dispose(): void;
}
/**
 * Allocate a `DataTexture` sized to hold `capacity` records of `schema`, backed by `rgba32uint`
 * (NEAREST). Write records with `tex.packAtIndex(schema, i, value)` (or `tex.pack(schema, values)` in
 * bulk); read them on the shader side with `texture(tex).load(schema, i)`. The struct is laid out
 * std430, one record every `texelStride` texels (16 B each).
 */
export declare function createStructTexture<S extends d.StructSchema>(schema: StructDef<S>, capacity: number, options?: TextureOptions): DataTexture;
