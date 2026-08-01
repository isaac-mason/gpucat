import type { StructDef } from '../nodes/lib/core';
import { GpuTexture } from '../core/gpu-texture';
import { GpuSampler } from '../core/gpu-sampler';
import { packTo, packToView, structFieldLayout } from '../schema/pack';
import { Source, type DataTextureImage } from './source';
import * as d from '../schema/schema';
import type { WrapMode, FilterMode, MipmapFilterMode, TextureOptions } from './texture';

/** Valid typed array types for DataTexture */
export type DataTextureData = Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array | Float32Array;

/** JS value shape for writing a struct record: each field mapped to its inferred value type. */
export type StructValue<S extends d.StructSchema> = { [K in keyof S]: d.Infer<S[K]> };

/**
 * A texture created from raw typed array data.
 * 
 * Useful for procedural textures, LUTs, noise textures, heightmaps, etc.
 */
export class DataTexture {
    /** Type flag for runtime checking */
    readonly isDataTexture = true;

    /** The underlying GPU texture resource */
    readonly _gpuTexture: GpuTexture<d.texture2d>;
    
    /** The underlying sampler */
    readonly _gpuSampler: GpuSampler;

    /** Optional name for debugging */
    name = '';

    /**
     * Constructs a new DataTexture.
     *
     * @param data - Raw pixel data
     * @param width - Width of the texture
     * @param height - Height of the texture
     * @param options - Texture options (including format)
     */
    constructor(
        data: DataTextureData | null,
        width: number,
        height: number,
        options: TextureOptions = {},
    ) {
        // Create source with size info
        const src = data !== null 
            ? new Source<DataTextureImage>({ data, width, height })
            : null;
        
        // Derive the shader-facing sample type from the format: integer formats (…uint/…sint) must be
        // typed texture2d<u32>/texture2d<i32> so the GLSL emitter declares usampler2D/isampler2D and
        // textureLoad returns uvec4/ivec4; every other format is float-sampled (texture2d<f32>).
        const format = options.format ?? 'rgba8unorm';
        const sampleType = format.endsWith('uint') ? d.u32 : format.endsWith('sint') ? d.i32 : d.f32;

        // Create the underlying GpuTexture
        this._gpuTexture = new GpuTexture(d.texture2d(sampleType) as d.texture2d, {
            width,
            height,
            source: src ?? undefined,
            format,
            generateMipmaps: options.generateMipmaps ?? false,
            flipY: options.flipY ?? false,
            premultiplyAlpha: options.premultiplyAlpha ?? false,
        });
        
        // Create the underlying sampler with defaults for data textures
        this._gpuSampler = new GpuSampler({
            addressModeU: options.wrapS ?? 'clamp-to-edge',
            addressModeV: options.wrapT ?? 'clamp-to-edge',
            magFilter: options.magFilter ?? 'nearest',
            minFilter: options.minFilter ?? 'nearest',
            mipmapFilter: options.mipmapFilter ?? 'nearest',
            maxAnisotropy: options.anisotropy ?? 1,
        });
    }

    // ─── Convenience getters/setters that forward to internals ───

    /** Unique numeric ID */
    get id(): number { return this._gpuTexture.id; }
    
    /** Returns the width of the texture. */
    get width(): number { return this._gpuTexture.width; }
    
    /** Returns the height of the texture. */
    get height(): number { return this._gpuTexture.height; }
    
    /** The data source for this texture. */
    get source(): Source<DataTextureImage> | null { 
        return this._gpuTexture.source as Source<DataTextureImage> | null; 
    }
    
    /** Convenience getter for the source data. */
    get image(): DataTextureImage | null {
        return this._gpuTexture.source?.data as DataTextureImage | null;
    }

    /** The underlying data array */
    get data(): DataTextureData | null {
        const img = this.image;
        return img?.data ?? null;
    }

    /** Horizontal wrap mode (U direction). */
    get wrapS(): WrapMode { return this._gpuSampler.addressModeU as WrapMode; }
    set wrapS(v: WrapMode) { this._gpuSampler.addressModeU = v; }

    /** Vertical wrap mode (V direction). */
    get wrapT(): WrapMode { return this._gpuSampler.addressModeV as WrapMode; }
    set wrapT(v: WrapMode) { this._gpuSampler.addressModeV = v; }

    /** Magnification filter. */
    get magFilter(): FilterMode { return this._gpuSampler.magFilter as FilterMode; }
    set magFilter(v: FilterMode) { this._gpuSampler.magFilter = v; }

    /** Minification filter. */
    get minFilter(): FilterMode { return this._gpuSampler.minFilter as FilterMode; }
    set minFilter(v: FilterMode) { this._gpuSampler.minFilter = v; }

    /** Mipmap filter mode. */
    get mipmapFilter(): MipmapFilterMode { return this._gpuSampler.mipmapFilter as MipmapFilterMode; }
    set mipmapFilter(v: MipmapFilterMode) { this._gpuSampler.mipmapFilter = v; }

    /** Anisotropic filtering level. */
    get anisotropy(): number { return this._gpuSampler.maxAnisotropy; }
    set anisotropy(v: number) { this._gpuSampler.maxAnisotropy = v; }

    /** WebGPU texture format. */
    get format(): GPUTextureFormat { return this._gpuTexture.format; }
    set format(v: GPUTextureFormat) { this._gpuTexture.format = v; }

    /** Whether to auto-generate mipmaps. */
    get generateMipmaps(): boolean { return this._gpuTexture.generateMipmaps; }
    set generateMipmaps(v: boolean) { this._gpuTexture.generateMipmaps = v; }

    /** Whether to flip the image vertically when uploading. */
    get flipY(): boolean { return this._gpuTexture.flipY; }
    set flipY(v: boolean) { this._gpuTexture.flipY = v; }

    /** Whether to premultiply alpha. */
    get premultiplyAlpha(): boolean { return this._gpuTexture.premultiplyAlpha; }
    set premultiplyAlpha(v: boolean) { this._gpuTexture.premultiplyAlpha = v; }

    /** Version for dirty tracking. */
    get version(): number { return this._gpuTexture.version; }

    /** Set to `true` to trigger a GPU upload on the next render. */
    set needsUpdate(value: boolean) {
        if (value) {
            this._gpuTexture.needsUpdate = true;
            if (this._gpuTexture.source) {
                this._gpuTexture.source.needsUpdate = true;
            }
        }
    }

    /**
     * Pack a struct record into record `index` (byte offset `index · texelStride · 16`), encoding
     * `value` into the backing `rgba32uint` data (std430 layout) and flagging a GPU re-upload. The
     * common CPU-side write; pair with `texture(this).load(schema, i)` on the shader side. Allocate via
     * {@link createStructTexture}.
     */
    packAtIndex<S extends d.StructSchema>(schema: StructDef<S>, index: number, value: StructValue<S>): this {
        const { texelStride } = structFieldLayout(schema as unknown as d.StructDesc);
        return this.packAtTexel(schema, index * texelStride, value);
    }

    /**
     * Pack a struct record starting at an explicit TEXEL offset, the low-level primitive under
     * {@link packAtIndex} (a texel is this texture's native addressing unit).
     */
    packAtTexel<S extends d.StructSchema>(schema: StructDef<S>, texel: number, value: StructValue<S>): this {
        const { texelStride } = structFieldLayout(schema as unknown as d.StructDesc);
        // Auto-grow (height only — width is fixed, so a shader compiled against `load(schema, i)` keeps
        // addressing correctly after the texture grows) before writing past the current allocation.
        this._ensureTexels(texel + texelStride);
        const data = this.data;
        if (!data) throw new Error('[DataTexture] packAtTexel(): texture has no backing data array.');
        packTo(schema as unknown as d.Any, data, texel * 16, value as never, 'std430');
        // Partial upload of just this record's texels. If `_ensureTexels` grew the texture it already
        // set `needsUpdate` (full), which takes priority over this range — a grow is one full re-upload.
        this.addUpdateRange(texel, texelStride);
        return this;
    }

    /**
     * Bulk write: pack an entire array of struct `values` from record 0, encoding each per `schema`
     * (std430) at its `texelStride`, growing the texture (height only) to hold them all, then flag ONE
     * full re-upload (`needsUpdate` supersedes any queued partial ranges). Parallel to
     * {@link GpuBuffer.pack}.
     */
    pack<S extends d.StructSchema>(schema: StructDef<S>, values: StructValue<S>[]): this {
        const { texelStride } = structFieldLayout(schema as unknown as d.StructDesc);
        this._ensureTexels(values.length * texelStride);
        const data = this.data;
        if (!data) throw new Error('[DataTexture] pack(): texture has no backing data array.');
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let i = 0; i < values.length; i++) {
            packToView(schema as unknown as d.Any, view, i * texelStride * 16, values[i] as never, 'std430');
        }
        // A whole-array write is one full re-upload — supersedes any queued partial ranges.
        this.needsUpdate = true;
        return this;
    }

    /**
     * Queue a partial upload of a texel range so the renderer re-uploads only the covering rows
     * (`texSubImage2D` / `writeTexture`) instead of the whole texture. Auto-called by
     * {@link packAtIndex} / {@link packAtTexel}; call directly if you mutate `.data` by hand. A
     * subsequent `needsUpdate = true` (full re-upload) supersedes any queued ranges.
     */
    addUpdateRange(startTexel: number, countTexels: number): this {
        this._gpuTexture.addUpdateRange(startTexel, countTexels);
        if (this._gpuTexture.source) this._gpuTexture.source.needsUpdate = true;
        return this;
    }

    /**
     * Ensure the backing `rgba32uint` array holds at least `requiredTexels` texels, growing HEIGHT
     * (never width) if needed: reallocate `width × newHeight × 4` u32, copy existing data, swap the
     * source, and bump the version so the renderer re-allocates the GL/GPU texture (via mutable
     * `texImage2D`; DataTextures are not immutable-storage). Keeping width fixed is what lets an
     * already-compiled `load(schema, i)` shader keep addressing correctly across a grow.
     */
    private _ensureTexels(requiredTexels: number): void {
        const width = this.width;
        if (requiredTexels <= width * this.height) return;
        const newHeight = Math.ceil(requiredTexels / width);
        const newData = new Uint32Array(width * newHeight * 4);
        const old = this.data;
        if (old) newData.set(old as Uint32Array);
        const img = this.image;
        if (img) {
            img.data = newData;
            img.height = newHeight;
        }
        this._gpuTexture.height = newHeight;
        // needsUpdate (below in storeAt) bumps the version; set here too so a bare grow re-uploads.
        this.needsUpdate = true;
    }

    /**
     * Creates a clone of this texture.
     */
    clone(): DataTexture {
        let clonedData: DataTextureData | null = null;
        if (this.data) {
            // Clone the typed array with same type
            const DataArrayCtor = this.data.constructor as new (buffer: ArrayBufferLike) => DataTextureData;
            clonedData = new DataArrayCtor(this.data.buffer.slice(0));
        }
        
        const tex = new DataTexture(
            clonedData,
            this.width,
            this.height,
            {
                wrapS: this.wrapS,
                wrapT: this.wrapT,
                magFilter: this.magFilter,
                minFilter: this.minFilter,
                mipmapFilter: this.mipmapFilter,
                anisotropy: this.anisotropy,
                format: this.format,
                generateMipmaps: this.generateMipmaps,
                flipY: this.flipY,
                premultiplyAlpha: this.premultiplyAlpha,
            }
        );
        tex.name = this.name;
        return tex;
    }

    /**
     * Disposes of the texture and its GPU resources.
     */
    dispose(): void {
        this._gpuTexture.dispose();
        this._gpuSampler.dispose();
    }
}

/**
 * Allocate a `DataTexture` sized to hold `capacity` records of `schema`, backed by `rgba32uint`
 * (NEAREST). Write records with `tex.packAtIndex(schema, i, value)` (or `tex.pack(schema, values)` in
 * bulk); read them on the shader side with `texture(tex).load(schema, i)`. The struct is laid out
 * std430, one record every `texelStride` texels (16 B each).
 */
export function createStructTexture<S extends d.StructSchema>(
    schema: StructDef<S>,
    capacity: number,
    options: TextureOptions = {},
): DataTexture {
    const { texelStride } = structFieldLayout(schema as unknown as d.StructDesc);
    const totalTexels = Math.max(1, capacity * texelStride);
    // 2-D wrap so huge capacities fit under max texture dimension; the load accessor maps each
    // texel index to (x, y) with this same width, so records may straddle a row boundary safely.
    const width = Math.max(1, Math.min(totalTexels, 2048));
    const height = Math.ceil(totalTexels / width);
    const data = new Uint32Array(width * height * 4);
    return new DataTexture(data, width, height, {
        ...options,
        format: 'rgba32uint',
        magFilter: 'nearest',
        minFilter: 'nearest',
    });
}
