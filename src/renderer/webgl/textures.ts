/**
 * textures.ts (webgl) - per-GpuTexture GL texture cache + upload, the GL sibling of
 * `webgpu/textures.ts`.
 *
 * gpucat's neutral `GpuTexture` is the format/size/source source-of-truth (WebGPU-oriented:
 * `format` is a `GPUTextureFormat` string, `viewDimension` is '2d'/'cube'/'2d-array'/'…'). This
 * module maps that onto WebGL2: it creates one `WebGLTexture` per `GpuTexture` (cached in a WeakMap,
 * version-gated exactly like the WebGPU cache tracks `texture.version`), uploads source data through
 * `texImage2D` / `texSubImage2D` (2D), the 6 cube faces, or the array layers, mapping the
 * `GPUTextureFormat` string to a GL `{ internalFormat, format, type }` triple, and generates mipmaps
 * when requested.
 *
 * Filtering / wrap are NOT set here — WebGL2 sampler objects (see `samplers.ts`) carry those, bound
 * per texture unit at draw time, mirroring gpucat's separate texture + sampler model. The one
 * exception is that we set a safe default min-filter on creation so a texture without an explicit
 * sampler still samples (a fresh GL texture defaults to a mipmapped min-filter, which reads as
 * "incomplete" with no mips).
 *
 * Render-target textures (`isRenderTargetTexture`) carry no source data: their GL texture is
 * allocated at the target's size/format by `render-target.ts` (via `ensureAllocated`) and their
 * contents are produced by an FBO render, so `updateTexture` on them only ensures the allocation.
 */

import type { GpuBuffer } from '../../core/gpu-buffer';
import type { GpuTexture } from '../../core/gpu-texture';
import type { TextureRegion } from '../../core/texture-region';
import { hasTypedPartialSource, supportsPartialUpload, withinPartialBudget } from '../core/partial-upload';
import type { ResolvedStorageBufferTexture } from '../../nodes/lib/texture';
import { mergeUpdateRanges } from '../core/update-ranges';

/** GL format triple for a color/depth texture: the sized internal format + upload format + type. */
type GlFormat = {
    /** Sized internal format for texStorage/texImage (e.g. gl.RGBA8, gl.RGBA16F, gl.DEPTH_COMPONENT24). */
    internalFormat: number;
    /** Client format for texImage2D/texSubImage2D uploads (e.g. gl.RGBA, gl.DEPTH_COMPONENT). */
    format: number;
    /** Client component type (e.g. gl.UNSIGNED_BYTE, gl.FLOAT, gl.HALF_FLOAT). */
    type: number;
    /** Whether this is a depth (/stencil) format — those are allocated, never uploaded from source. */
    isDepth: boolean;
};

/**
 * Map a gpucat `GPUTextureFormat` string to a WebGL2 `{ internalFormat, format, type }` triple.
 * Covers the color formats the examples/tests use plus the depth formats render targets request.
 * An unrecognized format throws — WebGL2 must never silently coerce to a wrong internal format.
 */
function glFormat(gl: WebGL2RenderingContext, format: string): GlFormat {
    switch (format) {
        // 8-bit unorm color.
        case 'rgba8unorm':
        case 'rgba8unorm-srgb':
            return {
                internalFormat: format.endsWith('srgb') ? gl.SRGB8_ALPHA8 : gl.RGBA8,
                format: gl.RGBA,
                type: gl.UNSIGNED_BYTE,
                isDepth: false,
            };
        case 'bgra8unorm':
            // WebGL2 core has no BGRA internal format. Uploading as RGBA8 would silently reorder the
            // B and R channels (wrong colors), so reject rather than corrupt the result.
            throw new Error(
                '[WebGLRenderer] bgra8unorm is not supported on the WebGL2 backend (no BGRA internal format); ' +
                    "use 'rgba8unorm' instead.",
            );
        case 'rg8unorm':
            return { internalFormat: gl.RG8, format: gl.RG, type: gl.UNSIGNED_BYTE, isDepth: false };
        case 'r8unorm':
            return { internalFormat: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, isDepth: false };

        // 16-bit float color.
        case 'rgba16float':
            return { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, isDepth: false };
        case 'rg16float':
            return { internalFormat: gl.RG16F, format: gl.RG, type: gl.HALF_FLOAT, isDepth: false };
        case 'r16float':
            return { internalFormat: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT, isDepth: false };

        // 32-bit float color.
        case 'rgba32float':
            return { internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, isDepth: false };
        case 'rg32float':
            return { internalFormat: gl.RG32F, format: gl.RG, type: gl.FLOAT, isDepth: false };
        case 'r32float':
            return { internalFormat: gl.R32F, format: gl.RED, type: gl.FLOAT, isDepth: false };

        // Integer color (never filterable → texelFetch-only; NEAREST enforced at creation). The
        // client format is the *_INTEGER variant; the type sizes the source typed array's components.
        case 'r8uint':
            return { internalFormat: gl.R8UI, format: gl.RED_INTEGER, type: gl.UNSIGNED_BYTE, isDepth: false };
        case 'rg8uint':
            return { internalFormat: gl.RG8UI, format: gl.RG_INTEGER, type: gl.UNSIGNED_BYTE, isDepth: false };
        case 'rgba8uint':
            return { internalFormat: gl.RGBA8UI, format: gl.RGBA_INTEGER, type: gl.UNSIGNED_BYTE, isDepth: false };
        case 'r8sint':
            return { internalFormat: gl.R8I, format: gl.RED_INTEGER, type: gl.BYTE, isDepth: false };
        case 'rg8sint':
            return { internalFormat: gl.RG8I, format: gl.RG_INTEGER, type: gl.BYTE, isDepth: false };
        case 'rgba8sint':
            return { internalFormat: gl.RGBA8I, format: gl.RGBA_INTEGER, type: gl.BYTE, isDepth: false };
        case 'r16uint':
            return { internalFormat: gl.R16UI, format: gl.RED_INTEGER, type: gl.UNSIGNED_SHORT, isDepth: false };
        case 'rg16uint':
            return { internalFormat: gl.RG16UI, format: gl.RG_INTEGER, type: gl.UNSIGNED_SHORT, isDepth: false };
        case 'rgba16uint':
            return { internalFormat: gl.RGBA16UI, format: gl.RGBA_INTEGER, type: gl.UNSIGNED_SHORT, isDepth: false };
        case 'r16sint':
            return { internalFormat: gl.R16I, format: gl.RED_INTEGER, type: gl.SHORT, isDepth: false };
        case 'rg16sint':
            return { internalFormat: gl.RG16I, format: gl.RG_INTEGER, type: gl.SHORT, isDepth: false };
        case 'rgba16sint':
            return { internalFormat: gl.RGBA16I, format: gl.RGBA_INTEGER, type: gl.SHORT, isDepth: false };
        case 'r32uint':
            return { internalFormat: gl.R32UI, format: gl.RED_INTEGER, type: gl.UNSIGNED_INT, isDepth: false };
        case 'rg32uint':
            return { internalFormat: gl.RG32UI, format: gl.RG_INTEGER, type: gl.UNSIGNED_INT, isDepth: false };
        case 'rgba32uint':
            return { internalFormat: gl.RGBA32UI, format: gl.RGBA_INTEGER, type: gl.UNSIGNED_INT, isDepth: false };
        case 'r32sint':
            return { internalFormat: gl.R32I, format: gl.RED_INTEGER, type: gl.INT, isDepth: false };
        case 'rg32sint':
            return { internalFormat: gl.RG32I, format: gl.RG_INTEGER, type: gl.INT, isDepth: false };
        case 'rgba32sint':
            return { internalFormat: gl.RGBA32I, format: gl.RGBA_INTEGER, type: gl.INT, isDepth: false };

        // Depth / depth-stencil.
        case 'depth16unorm':
            return { internalFormat: gl.DEPTH_COMPONENT16, format: gl.DEPTH_COMPONENT, type: gl.UNSIGNED_SHORT, isDepth: true };
        case 'depth24plus':
            return { internalFormat: gl.DEPTH_COMPONENT24, format: gl.DEPTH_COMPONENT, type: gl.UNSIGNED_INT, isDepth: true };
        case 'depth32float':
            return { internalFormat: gl.DEPTH_COMPONENT32F, format: gl.DEPTH_COMPONENT, type: gl.FLOAT, isDepth: true };
        case 'depth24plus-stencil8':
            return { internalFormat: gl.DEPTH24_STENCIL8, format: gl.DEPTH_STENCIL, type: gl.UNSIGNED_INT_24_8, isDepth: true };
        case 'depth32float-stencil8':
            return {
                internalFormat: gl.DEPTH32F_STENCIL8,
                format: gl.DEPTH_STENCIL,
                type: gl.FLOAT_32_UNSIGNED_INT_24_8_REV,
                isDepth: true,
            };

        default:
            throw new Error(`[WebGLRenderer] texture format '${format}' is not supported on the WebGL2 backend.`);
    }
}

/**
 * Format class relevant to mipmap generation. `gl.generateMipmap` requires the format be both
 * color-renderable and texture-filterable (linear). It errors for integer formats (never
 * filterable), and for float/half-float formats unless the corresponding linear-filter capability is
 * present (half-float linear is core in WebGL2; 32-bit float needs OES_texture_float_linear).
 */
type MipmapClass = 'unorm' | 'float32' | 'float16' | 'integer';

/**
 * Whether a texture format is integer (`…uint`/`…sint`). Integer textures are never
 * texture-filterable in WebGL2 — they must be read with `texelFetch` (nearest); a LINEAR filter makes
 * the sample read as incomplete (black). Used to force NEAREST on upload and to reject a linear
 * sampler paired with one.
 */
export function isIntegerTextureFormat(format: string): boolean {
    return format.endsWith('uint') || format.endsWith('sint');
}

/**
 * Whether a texture format is a depth (/stencil) format. Like integer formats, depth textures are NOT
 * texture-filterable in WebGL2, so their default filter must be NEAREST or a non-comparison read returns 0.
 */
export function isDepthTextureFormat(format: string): boolean {
    return format.startsWith('depth');
}

/**
 * Whether a format is NOT texture-filterable on this device — its default (sampler-object-less) filter
 * must be NEAREST, or a non-comparison `texture()`/`texelFetch()` read renders the texture INCOMPLETE and
 * returns 0. Encodes WebGL2's filterability rule (the analog of three.js's DepthTexture/float-RT defaulting
 * to NearestFilter): integer + depth are never filterable; 32-bit float needs `OES_texture_float_linear`
 * (half-float linear is core). A comparison (shadow) sampler is unaffected — it binds its own sampler object.
 */
function isNonFilterableFormat(gl: WebGL2RenderingContext, format: string): boolean {
    if (isDepthTextureFormat(format)) return true;
    const cls = mipmapClassOf(format);
    if (cls === 'integer') return true;
    if (cls === 'float32') return !gl.getExtension('OES_texture_float_linear');
    return false;
}

function mipmapClassOf(format: string): MipmapClass {
    if (isIntegerTextureFormat(format)) return 'integer';
    if (format.includes('32float')) return 'float32';
    if (format.includes('16float')) return 'float16';
    return 'unorm';
}

/** One-time warn guard so a repeated non-mippable format doesn't spam the console. */
const mipmapWarned = new Set<string>();

/**
 * Whether `gl.generateMipmap` is safe for this texture's format. Integer formats are never
 * filterable; 32-bit float needs OES_texture_float_linear; half-float linear is core in WebGL2. Warns
 * once per format when skipping.
 */
function canGenerateMipmap(gl: WebGL2RenderingContext, format: string): boolean {
    const cls = mipmapClassOf(format);
    if (cls === 'unorm' || cls === 'float16') return true;
    if (cls === 'float32') {
        if (gl.getExtension('OES_texture_float_linear')) return true;
        if (!mipmapWarned.has(format)) {
            mipmapWarned.add(format);
            console.warn(
                `[WebGLRenderer] skipping generateMipmap for '${format}': 32-bit float linear filtering ` +
                    `(OES_texture_float_linear) is unavailable, so mip generation would error.`,
            );
        }
        return false;
    }
    // integer
    if (!mipmapWarned.has(format)) {
        mipmapWarned.add(format);
        console.warn(`[WebGLRenderer] skipping generateMipmap for integer format '${format}': not texture-filterable.`);
    }
    return false;
}

/** The GL bind target for a GpuTexture's view dimension. */
function glTarget(gl: WebGL2RenderingContext, texture: GpuTexture): number {
    switch (texture.viewDimension) {
        case 'cube':
            return gl.TEXTURE_CUBE_MAP;
        case 'cube-array':
            // WebGL2 core has no cube-array texture target (no GL_TEXTURE_CUBE_MAP_ARRAY).
            throw new Error('[WebGLRenderer] cube-array textures are not supported on the WebGL2 backend.');
        case '2d-array':
            return gl.TEXTURE_2D_ARRAY;
        case '3d':
            return gl.TEXTURE_3D;
        default:
            return gl.TEXTURE_2D;
    }
}

/** Per-GpuTexture GL resources + version tracking (mirrors the WebGPU TextureData). */
export type GlTextureData = {
    /** The GL texture object. */
    texture: WebGLTexture;
    /** GL bind target (TEXTURE_2D / TEXTURE_CUBE_MAP / TEXTURE_2D_ARRAY / TEXTURE_3D). */
    target: number;
    /** The mapped GL format triple. */
    fmt: GlFormat;
    /** `texture.version` at last upload/allocation — the cache-invalidation gate. */
    version: number;
    /** Generation, bumped whenever the GL texture object is (re)created. */
    generation: number;
    /** Whether storage/allocation has been established. */
    allocated: boolean;
    /** Actual GL-allocated dimensions. May lag `texture.width/height` if a re-allocation was skipped
     *  or failed — surfaced in the incomplete-framebuffer diagnostic. 0 until first allocation. */
    allocW: number;
    allocH: number;
    /** GL-allocated layer/face count. Guards the partial path against a layer-count change. */
    allocD: number;
};

/**
 * GL texture backing a read-only storage `GpuBuffer` reinterpreted as rgba32uint (the WebGL `storage()`
 * read-lowering). Cached per `GpuBuffer` so N materials sampling the same buffer share one GL texture,
 * and re-uploaded when `buffer.version` moves — mutate the buffer between frames and the read stays current.
 */
export type GlBufferTextureData = {
    texture: WebGLTexture;
    /** `buffer.version` at last upload — the re-upload gate. */
    version: number;
    /** GL-allocated texel dimensions (a grow re-allocates rather than sub-uploading). */
    width: number;
    height: number;
};

/** Textures state: per-GpuTexture GL data, keyed by GpuTexture identity, plus a disposal set. */
export type GlTexturesState = {
    data: WeakMap<GpuTexture, GlTextureData>;
    /** Storage-buffer-backed GL textures, keyed by the `GpuBuffer` (WebGL storage() read-lowering). */
    bufferData: WeakMap<GpuBuffer, GlBufferTextureData>;
    all: Set<WebGLTexture>;
    /** Cached `gl.MAX_TEXTURE_SIZE`, read once on first storage-buffer upload (validates the texel grid). */
    maxTextureSize?: number;
    /** Cached `gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS`, read once (guards the flat texture-unit assignment). */
    maxTextureUnits?: number;
};

/** Create an empty textures state. */
export function createGlTexturesState(): GlTexturesState {
    return { data: new WeakMap(), bufferData: new WeakMap(), all: new Set() };
}

/**
 * Upload texels `[texelStart, texelStart + texelCount)` of a storage buffer reinterpreted as a
 * `width`-wide grid of `bytesPerTexel`-byte texels (`glFormat` = RED/RG/RGBA_INTEGER to match),
 * sourcing ZERO-COPY `Uint32Array` views over the buffer's own bytes.
 *
 * A linear span is not a rectangle, so it decomposes into at most three uploads: the partial head row,
 * the block of whole rows, and the partial tail row. Head and tail are one row tall, so their row
 * stride is never read; the block's rows are exactly `width` texels and contiguous, which is the unpack
 * default. That keeps every piece expressible as a plain `texSubImage2D` over a subarray view, with no
 * `UNPACK_ROW_LENGTH`/`SKIP_*` window to set and restore (three.js `WebGLTextures` needs that window
 * only because it hands GL the whole source array rather than a view of the span).
 *
 * The caller clamps the span to the texels the buffer actually backs, so the grid's padded tail (the
 * last row when `width` doesn't divide the texel count) is never addressed — those texels stay zeroed,
 * and valid shader indices only reach `totalTexels - 1`.
 */
function uploadStorageSpan(
    gl: WebGL2RenderingContext,
    arr: ArrayBufferView,
    width: number,
    texelStart: number,
    texelCount: number,
    bytesPerTexel: number,
    glFormat: number,
): void {
    const comps = bytesPerTexel / 4; // u32 lanes per texel (r32uint = 1, rg32uint = 2, rgba32uint = 4)
    const base = arr.byteOffset;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    let texel = texelStart;
    let remaining = texelCount;

    // Head: the partial row the span starts in (skipped when it starts row-aligned).
    const headX = texel % width;
    if (headX !== 0 && remaining > 0) {
        const count = Math.min(width - headX, remaining);
        const view = new Uint32Array(arr.buffer, base + texel * bytesPerTexel, count * comps);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, headX, (texel - headX) / width, count, 1, glFormat, gl.UNSIGNED_INT, view);
        texel += count;
        remaining -= count;
    }

    // Block: every whole row the span covers, in one call.
    const rows = Math.floor(remaining / width);
    if (rows > 0) {
        const view = new Uint32Array(arr.buffer, base + texel * bytesPerTexel, rows * width * comps);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, texel / width, width, rows, glFormat, gl.UNSIGNED_INT, view);
        texel += rows * width;
        remaining -= rows * width;
    }

    // Tail: the partial row the span ends in.
    if (remaining > 0) {
        const view = new Uint32Array(arr.buffer, base + texel * bytesPerTexel, remaining * comps);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, texel / width, remaining, 1, glFormat, gl.UNSIGNED_INT, view);
    }
}

/** GL internal + pixel format for a storage mirror texel of `bytesPerTexel` bytes (u32 lanes). */
function storageTexelFormat(gl: WebGL2RenderingContext, bytesPerTexel: number): { internalFormat: number; glFormat: number } {
    if (bytesPerTexel === 4) return { internalFormat: gl.R32UI, glFormat: gl.RED_INTEGER };
    if (bytesPerTexel === 8) return { internalFormat: gl.RG32UI, glFormat: gl.RG_INTEGER };
    return { internalFormat: gl.RGBA32UI, glFormat: gl.RGBA_INTEGER };
}

/**
 * Resolve (create/upload/re-sync) the GL texture for a read-only storage `GpuBuffer` bound AS an
 * rgba32uint texture, and return it bound-ready. The pixel data is a ZERO-COPY `Uint32Array` view over
 * the buffer's own `ArrayBuffer` — the same bytes seen as `width × height` u32 texels — so nothing is
 * duplicated on the CPU. The grid width is `min(totalTexels, MAX_TEXTURE_SIZE)` (chosen at compile) so
 * `width` need not divide the texel count: the last row is padded and never addressed (see
 * {@link uploadStorageSpan}). Cached per `GpuBuffer`; re-synced when `buffer.version` moves or ranges are
 * queued — one upload run per merged dirty span for `packAtIndex`/`addUpdateRange` writes, a full upload
 * for a bare version bump, or a full re-allocation if the texel grid grew. The caller binds it.
 */
export function updateStorageBufferTexture(
    gl: WebGL2RenderingContext,
    state: GlTexturesState,
    source: ResolvedStorageBufferTexture,
): WebGLTexture {
    const { buffer, width, height, bytesPerTexel } = source;
    const arr = buffer.array;
    if (arr == null) {
        throw new Error(
            '[WebGLRenderer] storage() read-lowering: the storage buffer has no CPU `array` to reinterpret ' +
                '(its data was released after upload); keep it resident to sample it on WebGL2.',
        );
    }
    const { internalFormat, glFormat } = storageTexelFormat(gl, bytesPerTexel);
    const comps = bytesPerTexel / 4; // u32 lanes per texel — the unit for `updateRanges` row math below
    // Validate the texel grid against the real device cap (read once). The compile-time width pick uses
    // this same cap, so `width ≤ MAX`; `height = ceil(totalTexels / width)` can still exceed it for a
    // buffer larger than `MAX²` texels → reject clearly rather than let GL fail opaquely.
    if (state.maxTextureSize == null) state.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const max = state.maxTextureSize;
    if (width > max || height > max) {
        throw new Error(
            `[WebGLRenderer] storage() read-lowering: the buffer needs a ${width}×${height} texel grid, which ` +
                `exceeds this device's MAX_TEXTURE_SIZE=${max}; split or reshape the buffer.`,
        );
    }

    // The buffer is a whole number of texels (guarded at compile). `width` may not divide it, so the
    // grid's last row is partly padding; uploads clamp to `totalTexels` and never touch it.
    const totalTexels = arr.byteLength / bytesPerTexel;

    let data = state.bufferData.get(buffer);
    if (!data) {
        const texture = gl.createTexture();
        if (!texture) throw new Error('[WebGLRenderer] gl.createTexture returned null (storage buffer texture).');
        state.all.add(texture);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        // Allocate the full (possibly padded) grid, then fill from the buffer's bytes.
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, glFormat, gl.UNSIGNED_INT, null);
        // Integer textures are never filterable — NEAREST, clamp; sampled only via texelFetch.
        setDefaultMinFilter(gl, gl.TEXTURE_2D, false, true);
        uploadStorageSpan(gl, arr, width, 0, totalTexels, bytesPerTexel, glFormat);
        data = { texture, version: buffer.version, width, height };
        state.bufferData.set(buffer, data);
        return texture;
    }

    const sizeChanged = data.width !== width || data.height !== height;
    // Clean (version matched, no queued ranges, same size) → the cached texture is already current.
    if (!sizeChanged && data.version === buffer.version && buffer.updateRanges.length === 0) {
        return data.texture;
    }

    gl.bindTexture(gl.TEXTURE_2D, data.texture);
    if (sizeChanged) {
        // Grow/shrink → re-specify the whole mutable texture at the new size (queued ranges are moot).
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, glFormat, gl.UNSIGNED_INT, null);
        uploadStorageSpan(gl, arr, width, 0, totalTexels, bytesPerTexel, glFormat);
        data.width = width;
        data.height = height;
    } else {
        // Same size: upload each merged dirty span when `packAtIndex`/`addUpdateRange` queued ranges.
        // `updateRanges` are flat COMPONENT indices, so each widens to the texels it touches (u32 lanes
        // per texel: r32uint 1, rg32uint 2, rgba32uint 4), clamped to the texels the buffer backs. The
        // spans are kept SEPARATE rather than hulled together: a streaming arena dirties a handful of
        // small, far-apart regions per frame, and one covering span over those is the whole buffer.
        // A bare version bump, or more dirty texels than half the buffer, takes one full upload instead.
        const ranges = buffer.updateRanges;
        mergeUpdateRanges(ranges);
        let dirtyTexels = 0;
        for (const r of ranges) dirtyTexels += Math.ceil((r.start + r.count) / comps) - Math.floor(r.start / comps);

        if (dirtyTexels > 0 && dirtyTexels <= totalTexels / 2) {
            for (const r of ranges) {
                const from = Math.floor(r.start / comps);
                const to = Math.min(totalTexels, Math.ceil((r.start + r.count) / comps));
                if (to > from) uploadStorageSpan(gl, arr, width, from, to - from, bytesPerTexel, glFormat);
            }
        } else {
            uploadStorageSpan(gl, arr, width, 0, totalTexels, bytesPerTexel, glFormat);
        }
    }
    buffer.clearUpdateRanges();
    data.version = buffer.version;
    return data.texture;
}

/** Get the cached GlTextureData for a GpuTexture (or null if never seen). */
export function getGlTextureData(state: GlTexturesState, texture: GpuTexture): GlTextureData | null {
    return state.data.get(texture) ?? null;
}

/** Set a texture's min-filter so a texture without an explicit sampler object still samples. */
function setDefaultMinFilter(gl: WebGL2RenderingContext, target: number, generateMipmaps: boolean, nonFilterable: boolean): void {
    // A freshly-created GL texture defaults to a mipmapped min-filter, which reads as "incomplete"
    // when no mips exist. Sampler objects override this at bind time, but set a safe baseline here.
    // Integer AND depth textures are NOT texture-filterable in WebGL2 — a LINEAR filter makes them
    // texture-INCOMPLETE, so a non-comparison `texture()`/`texelFetch()` read returns 0 (this is why a
    // depth render target sampled via `.load()`/`.sample()` came back black). They must be NEAREST here.
    // A comparison (shadow) sampler still works: it binds its own sampler object, overriding this.
    const min = nonFilterable ? gl.NEAREST : generateMipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, nonFilterable ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

/** Create (and cache) the GL texture object for a GpuTexture, without uploading. */
function ensureGlTexture(gl: WebGL2RenderingContext, state: GlTexturesState, texture: GpuTexture): GlTextureData {
    let data = state.data.get(texture);
    if (!data) {
        const glTexture = gl.createTexture();
        if (!glTexture) throw new Error('[WebGLRenderer] gl.createTexture returned null.');
        state.all.add(glTexture);
        data = {
            texture: glTexture,
            target: glTarget(gl, texture),
            fmt: glFormat(gl, texture.format),
            version: -1,
            generation: 0,
            allocated: false,
            allocW: 0,
            allocD: 0,
            allocH: 0,
        };
        state.data.set(texture, data);
    }
    return data;
}

/**
 * Number of mip levels to allocate for a texture. Explicit user mip images win (level 0 + supplied
 * levels); else the full chain when auto-generating; else the descriptor's explicit `mipLevelCount`
 * (mirrors the WebGPU path's `createGPUTexture` mip-count logic).
 */
function mipLevelCount(texture: GpuTexture): number {
    if (texture.mipmaps.length > 0) {
        return texture.mipmaps.length + 1;
    }
    if (texture.generateMipmaps) {
        return Math.floor(Math.log2(Math.max(texture.width, texture.height))) + 1;
    }
    return Math.max(1, texture.mipLevelCount);
}

/** Extract a raw typed-array view from a DataTexture-style source, or null. */
function typedArrayOf(sourceData: unknown): ArrayBufferView | null {
    if (sourceData && typeof sourceData === 'object' && 'data' in sourceData) {
        const d = (sourceData as { data: unknown }).data;
        if (ArrayBuffer.isView(d)) return d as ArrayBufferView;
    }
    return null;
}

/** True if the source data is a browser image that copyExternalImage/texImage2D accepts directly. */
function isExternalImage(data: unknown): data is TexImageSource {
    if (!data || typeof data !== 'object') return false;
    return (
        (typeof ImageBitmap !== 'undefined' && data instanceof ImageBitmap) ||
        (typeof HTMLImageElement !== 'undefined' && data instanceof HTMLImageElement) ||
        (typeof HTMLCanvasElement !== 'undefined' && data instanceof HTMLCanvasElement) ||
        (typeof OffscreenCanvas !== 'undefined' && data instanceof OffscreenCanvas) ||
        (typeof HTMLVideoElement !== 'undefined' && data instanceof HTMLVideoElement) ||
        (typeof ImageData !== 'undefined' && data instanceof ImageData)
    );
}

/** Upload the primary 2D source (typed-array DataTexture data or an external image) at level 0. */
function upload2D(gl: WebGL2RenderingContext, texture: GpuTexture, data: GlTextureData): void {
    const source = texture.source;
    if (!source || !source.data) return;
    const { internalFormat, format, type } = data.fmt;
    const w = texture.width;
    const h = texture.height;

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, texture.flipY);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, texture.premultiplyAlpha);

    const typed = typedArrayOf(source.data);
    if (typed) {
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, typed as ArrayBufferView);
    } else if (isExternalImage(source.data)) {
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, format, type, source.data);
    }

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
}

/**
 * Point the unpack window at a sub-rect of a full-width packed buffer.
 *
 * `UNPACK_ROW_LENGTH` / `SKIP_PIXELS` / `SKIP_ROWS` (and the 3D pair `IMAGE_HEIGHT` / `SKIP_IMAGES`) let
 * GL read a box out of the middle of a packed array with no staging copy. They are WebGL2-only, which is
 * why WebGL1-era engines stage a tight copy instead. Row length is in PIXELS, so this stays correct
 * whatever the component count.
 */
function setUnpackWindow(
    gl: WebGL2RenderingContext,
    rowLength: number,
    imageHeight: number,
    skipPixels: number,
    skipRows: number,
    skipImages: number,
): void {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, rowLength);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, imageHeight);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, skipPixels);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, skipRows);
    gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, skipImages);
}

/**
 * Restore the unpack window to the GL defaults. These are global state, so leaving a skip set silently
 * corrupts every later upload in the frame. Reset rather than save/restore: `getParameter` is a
 * round-trip, and nothing here depends on a non-default window.
 */
function resetUnpackWindow(gl: WebGL2RenderingContext): void {
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
}

/**
 * Upload one dirty region into the existing GL texture, honouring `x`/`width`, `z` and `level` exactly.
 *
 * This never re-enters `texStorage3D`: array storage is immutable, so the partial path writes into the
 * allocation the full upload already established.
 */
function uploadPartialRegion(gl: WebGL2RenderingContext, texture: GpuTexture, data: GlTextureData, r: TextureRegion): void {
    const { format, type } = data.fmt;
    const dim = texture.viewDimension;

    // Level 0 reads `source` / `sources`; a higher level reads its explicit mip, which is always packed
    // across layers.
    const packed = r.level === 0 ? texture.source : texture.mipmaps[r.level - 1];
    const levelWidth = r.level === 0 ? texture.width : Math.max(1, packed?.width ?? 1);
    const levelHeight = r.level === 0 ? texture.height : Math.max(1, packed?.height ?? 1);

    if (dim === 'cube' || dim === 'cube-array') {
        if (r.level !== 0) return; // explicit cube mips take the full path
        setUnpackWindow(gl, levelWidth, 0, r.x, r.y, 0);
        for (let i = 0; i < r.depth; i++) {
            const face = r.z + i;
            const typed = typedArrayOf(texture.sources[face]?.data);
            if (!typed) continue;
            // A face is a distinct GL bind target here rather than a z offset, but `z` still means the
            // same face index the WebGPU backend passes as `origin.z`. Same meaning, different spelling.
            const target = gl.TEXTURE_CUBE_MAP_POSITIVE_X + face;
            gl.texSubImage2D(target, r.level, r.x, r.y, r.width, r.height, format, type, typed as ArrayBufferView);
        }
        return;
    }

    if (dim === '2d-array') {
        // Per-layer sources: one call per layer, each reading from its own buffer.
        if (r.level === 0 && texture.sources.length > 0) {
            setUnpackWindow(gl, levelWidth, 0, r.x, r.y, 0);
            for (let i = 0; i < r.depth; i++) {
                const layer = r.z + i;
                const typed = typedArrayOf(texture.sources[layer]?.data);
                if (!typed) continue;
                gl.texSubImage3D(
                    gl.TEXTURE_2D_ARRAY, r.level, r.x, r.y, layer, r.width, r.height, 1, format, type,
                    typed as ArrayBufferView,
                );
            }
            return;
        }
        // Packed across layers: SKIP_IMAGES + IMAGE_HEIGHT carry the layer stride, so the whole region
        // goes in one call whatever rows it covers.
        const typed = typedArrayOf(packed?.data);
        if (!typed) return;
        setUnpackWindow(gl, levelWidth, levelHeight, r.x, r.y, r.z);
        gl.texSubImage3D(
            gl.TEXTURE_2D_ARRAY, r.level, r.x, r.y, r.z, r.width, r.height, r.depth, format, type,
            typed as ArrayBufferView,
        );
        return;
    }

    const typed = typedArrayOf(packed?.data);
    if (!typed) return;
    setUnpackWindow(gl, levelWidth, 0, r.x, r.y, 0);
    gl.texSubImage2D(gl.TEXTURE_2D, r.level, r.x, r.y, r.width, r.height, format, type, typed as ArrayBufferView);
}

/** Upload the 6 cube faces (face order +X,-X,+Y,-Y,+Z,-Z) at level 0. */
function uploadCube(gl: WebGL2RenderingContext, texture: GpuTexture, data: GlTextureData): void {
    if (texture.sources.length < 6) return;
    const { internalFormat, format, type } = data.fmt;
    const w = texture.width;
    const h = texture.height;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, texture.flipY);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, texture.premultiplyAlpha);
    for (let face = 0; face < 6; face++) {
        const source = texture.sources[face];
        if (!source?.data) continue;
        const target = gl.TEXTURE_CUBE_MAP_POSITIVE_X + face;
        const typed = typedArrayOf(source.data);
        if (typed) {
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            gl.texImage2D(target, 0, internalFormat, w, h, 0, format, type, typed as ArrayBufferView);
        } else if (isExternalImage(source.data)) {
            gl.texImage2D(target, 0, internalFormat, format, type, source.data);
        }
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
}

/** Upload a 2D array texture — allocate storage, then fill each layer. */
function uploadArray(gl: WebGL2RenderingContext, texture: GpuTexture, data: GlTextureData): void {
    const { internalFormat, format, type } = data.fmt;
    const w = texture.width;
    const h = texture.height;
    const layers = texture.depthOrArrayLayers;
    const levels = mipLevelCount(texture);

    // 2D-array must be allocated via texStorage3D then filled per-layer with texSubImage3D.
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, internalFormat, w, h, layers);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, texture.flipY);

    if (texture.sources.length > 0) {
        for (let layer = 0; layer < texture.sources.length && layer < layers; layer++) {
            const typed = typedArrayOf(texture.sources[layer]?.data);
            if (typed) {
                gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, w, h, 1, format, type, typed as ArrayBufferView);
            } else if (isExternalImage(texture.sources[layer]?.data)) {
                gl.texSubImage3D(
                    gl.TEXTURE_2D_ARRAY,
                    0,
                    0,
                    0,
                    layer,
                    w,
                    h,
                    1,
                    format,
                    type,
                    texture.sources[layer].data as TexImageSource,
                );
            }
        }
    } else if (texture.source) {
        // Packed source: all layers contiguous in one typed array.
        const typed = typedArrayOf(texture.source.data);
        if (typed) {
            gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, w, h, layers, format, type, typed as ArrayBufferView);
        }
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
}

/** Upload a 3D texture — allocate immutable storage, then fill the volume at level 0. */
function upload3D(gl: WebGL2RenderingContext, texture: GpuTexture, data: GlTextureData): void {
    const { internalFormat, format, type } = data.fmt;
    const w = texture.width;
    const h = texture.height;
    const depth = texture.depthOrArrayLayers;
    const levels = mipLevelCount(texture);

    if (texture.mipmaps.length > 0) {
        // Per-level 3D mip upload isn't wired here; texStorage3D + a single level-0 fill is the
        // supported path. (No current caller supplies explicit 3D mips.)
        throw new Error('[WebGLRenderer] explicit mipmaps for 3D textures are not supported on the WebGL2 backend.');
    }

    // 3D storage is immutable; allocate then fill with texSubImage3D. Filterable formats only for
    // auto-mip generation (handled by the caller via canGenerateMipmap).
    gl.texStorage3D(gl.TEXTURE_3D, levels, internalFormat, w, h, depth);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, texture.flipY);

    const typed = typedArrayOf(texture.source?.data);
    if (typed) {
        gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, w, h, depth, format, type, typed as ArrayBufferView);
    } else if (isExternalImage(texture.source?.data)) {
        // A single external image only covers one depth slice; upload it at slice 0.
        gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, w, h, 1, format, type, texture.source!.data as TexImageSource);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
}

/**
 * Upload user-supplied explicit mip levels (`texture.mipmaps`), one per level starting at level 1
 * (level 0 is the primary source, already uploaded). Mirrors the WebGPU `uploadExplicitMips`. Each mip
 * Source carries its own dimensions. For 2D-array/cube the data is packed across layers; for 2D it's a
 * single image. Sources with no/not-ready data are skipped (their level keeps whatever was there).
 */
function uploadExplicitMips(gl: WebGL2RenderingContext, texture: GpuTexture, data: GlTextureData): void {
    const { format, type } = data.fmt;
    const dim = texture.viewDimension;

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, texture.flipY);

    for (let i = 0; i < texture.mipmaps.length; i++) {
        const source = texture.mipmaps[i];
        if (!source?.data) continue;
        const level = i + 1;
        const w = source.width;
        const h = source.height;
        const typed = typedArrayOf(source.data);
        const external = isExternalImage(source.data);
        if (!typed && !external) continue;

        if (dim === '2d-array') {
            const layers = Math.max(source.depth, 1);
            if (typed) {
                gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, level, 0, 0, 0, w, h, layers, format, type, typed as ArrayBufferView);
            }
            // texStorage3D (immutable) allocated the levels; external-image per-level array upload is
            // not expressible in a single call and has no current caller.
        } else if (dim === 'cube') {
            // One face image per Source is ambiguous for cube mips; not supported.
            throw new Error('[WebGLRenderer] explicit mipmaps for cube textures are not supported on the WebGL2 backend.');
        } else {
            const { internalFormat } = data.fmt;
            if (typed) {
                gl.texImage2D(gl.TEXTURE_2D, level, internalFormat, w, h, 0, format, type, typed as ArrayBufferView);
            } else if (external) {
                gl.texImage2D(gl.TEXTURE_2D, level, internalFormat, format, type, source.data as TexImageSource);
            }
        }
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
}

/**
 * Ensure a GpuTexture's GL texture exists, is allocated at its current size/format, and (for
 * source-backed textures) has its data uploaded. Version-gated: a no-op once `data.version` matches
 * `texture.version`. Returns the cache entry.
 *
 * Render-target textures (`isRenderTargetTexture`) carry no source; their storage is (re)established
 * here at the current size and their pixels are filled by an FBO render — so this only creates +
 * allocates them (via `texImage2D`/`texStorage` with a null/absent source), never uploads.
 */
export function updateTexture(gl: WebGL2RenderingContext, state: GlTexturesState, texture: GpuTexture): GlTextureData {
    const data = ensureGlTexture(gl, state, texture);

    if (data.allocated && data.version === texture.version) return data;

    // Partial upload: an in-place `packAtIndex`/`addUpdateRegion` queued dirty boxes (no full re-upload
    // and no resize) → re-specify only those via `texSubImage2D` on the existing GL texture, skipping the
    // delete + full `texImage2D` below. A full flag (`needsUpdate`/grow) or a size change takes priority.
    // `> ½` the texture dirty → fall through to a full upload (fewer, simpler calls).
    //
    // Regions are honoured exactly, sub-rect and mip level included, via the WebGL2 unpack window
    // (UNPACK_ROW_LENGTH / SKIP_PIXELS / SKIP_ROWS) reading the box out of the packed source in place.
    if (
        data.allocated &&
        !texture.needsFullUpload &&
        texture.updateRegions.length > 0 &&
        supportsPartialUpload(texture) &&
        hasTypedPartialSource(texture) &&
        !texture.isRenderTargetTexture &&
        data.allocW === texture.width &&
        data.allocH === texture.height &&
        data.allocD === texture.depthOrArrayLayers
    ) {
        if (withinPartialBudget(texture, texture.updateRegions)) {
            gl.bindTexture(data.target, data.texture);
            for (const r of texture.updateRegions) uploadPartialRegion(gl, texture, data, r);
            resetUnpackWindow(gl);
            // Auto-generated mips go stale the moment level 0 moves. (An explicit chain instead gets
            // per-level regions derived at `addUpdateRegion` time, so it is already covered above.)
            if (
                texture.mipmaps.length === 0 &&
                texture.generateMipmaps &&
                !data.fmt.isDepth &&
                canGenerateMipmap(gl, texture.format)
            ) {
                gl.generateMipmap(data.target);
            }
            texture.updateRegions.length = 0;
            data.version = texture.version;
            return data;
        }
    }

    // Re-allocation (a resize or format change bumped `texture.version` on an already-allocated
    // texture): render-target storage is immutable (`texStorage2D`), so it can't be re-specified on the
    // same GL object — a second `texStorage2D` errors with INVALID_OPERATION and leaves the OLD size in
    // place, giving a size-mismatched FBO attachment (FRAMEBUFFER_INCOMPLETE_ATTACHMENT on strict
    // drivers). Delete the stale GL texture and mint a fresh one so the new storage is specified cleanly.
    // (This is the path a resized PassNode render target — e.g. a 4× rgba16float MRT pass — takes.)
    if (data.allocated) {
        gl.deleteTexture(data.texture);
        state.all.delete(data.texture);
        const fresh = gl.createTexture();
        if (!fresh) throw new Error('[WebGLRenderer] gl.createTexture returned null.');
        state.all.add(fresh);
        data.texture = fresh;
        data.allocated = false;
    }

    // A format change (rare) would need a new GL format triple; refresh it defensively.
    data.fmt = glFormat(gl, texture.format);
    data.target = glTarget(gl, texture);

    gl.bindTexture(data.target, data.texture);
    setDefaultMinFilter(gl, data.target, texture.generateMipmaps, isNonFilterableFormat(gl, texture.format));

    const dim = texture.viewDimension;

    if (texture.isRenderTargetTexture) {
        // Render-target color/depth: allocate storage only (no source). The FBO render fills it.
        allocateRenderTargetStorage(gl, texture, data);
    } else if (dim === 'cube' || dim === 'cube-array') {
        uploadCube(gl, texture, data);
    } else if (dim === '2d-array') {
        uploadArray(gl, texture, data);
    } else if (dim === '3d') {
        upload3D(gl, texture, data);
    } else {
        upload2D(gl, texture, data);
    }

    // Mip levels: user-supplied explicit mips take precedence over auto-generation (mirrors WebGPU).
    if (!texture.isRenderTargetTexture && !data.fmt.isDepth && texture.mipmaps.length > 0) {
        uploadExplicitMips(gl, texture, data);
    } else if (
        texture.generateMipmaps &&
        !texture.isRenderTargetTexture &&
        !data.fmt.isDepth &&
        canGenerateMipmap(gl, texture.format)
    ) {
        gl.generateMipmap(data.target);
    }

    // A full (re)upload supersedes any queued partial regions and clears the full flag. Record the
    // allocated size so later in-place stores can take the partial `texSubImage2D` path above.
    texture.updateRegions.length = 0;
    texture.needsFullUpload = false;
    data.allocW = texture.width;
    data.allocH = texture.height;
    data.allocD = texture.depthOrArrayLayers;
    data.version = texture.version;
    data.generation++;
    data.allocated = true;
    return data;
}

/**
 * Allocate GL storage for a render-target color/depth texture at the target's size, with no upload.
 * Uses `texStorage2D` (immutable storage — attachable to an FBO and sampleable) for 2D targets, and
 * `texStorage2D(TEXTURE_CUBE_MAP, …)` for a cube render target (all 6 faces allocated at once — a
 * CubeRenderTarget renders each face and samples the result as an environment map).
 */
function allocateRenderTargetStorage(gl: WebGL2RenderingContext, texture: GpuTexture, data: GlTextureData): void {
    const w = texture.width;
    const h = texture.height;
    const levels = mipLevelCount(texture);
    if (data.target === gl.TEXTURE_CUBE_MAP) {
        // Immutable storage allocates all 6 faces at once; each face is then attachable to an FBO
        // via framebufferTexture2D(TEXTURE_CUBE_MAP_POSITIVE_X + face, ...) (see render-target.ts).
        gl.texStorage2D(gl.TEXTURE_CUBE_MAP, levels, data.fmt.internalFormat, w, h);
    } else if (levels > 1) {
        // Mipmapped 2D target: immutable storage for the whole chain.
        gl.texStorage2D(gl.TEXTURE_2D, levels, data.fmt.internalFormat, w, h);
    } else {
        // Single-level 2D target: MUTABLE `texImage2D`, matching three.js's render-target allocation.
        // Some drivers (notably Chrome/ANGLE-on-Metal) return FRAMEBUFFER_UNSUPPORTED for an immutable
        // `texStorage2D` color attachment; `texImage2D` is the broadly-compatible path.
        gl.texImage2D(gl.TEXTURE_2D, 0, data.fmt.internalFormat, w, h, 0, data.fmt.format, data.fmt.type, null);
    }
    data.allocW = w;
    data.allocH = h;
}

/**
 * Generate mipmaps for an already-allocated render-target color texture once the render pass that
 * writes it has finished. Binds the texture at its view-dimension target (2D, cube, or 2D-array — the
 * storage was allocated with a full mip chain when `generateMipmaps` is set, see
 * `allocateRenderTargetStorage`) and calls `gl.generateMipmap`, filling the lower levels. Called from
 * the renderer's render-finish step for any render-target color texture whose `generateMipmaps` is
 * true. Guards: only when the texture wants mips, its format is mip-generatable, and it has an
 * allocated GL texture.
 */
export function generateRenderTargetMipmaps(gl: WebGL2RenderingContext, state: GlTexturesState, texture: GpuTexture): void {
    if (!texture.generateMipmaps) return;
    if (!canGenerateMipmap(gl, texture.format)) return;
    const data = state.data.get(texture);
    if (!data || !data.allocated) return;
    gl.bindTexture(data.target, data.texture);
    gl.generateMipmap(data.target);
}

/** Delete all GL textures (called on renderer dispose). */
export function disposeGlTextures(gl: WebGL2RenderingContext, state: GlTexturesState): void {
    for (const tex of state.all) gl.deleteTexture(tex);
    state.all.clear();
}

/** Number of GL textures currently allocated. */
export function getGlTexturesStats(state: GlTexturesState): { textureCount: number } {
    return { textureCount: state.all.size };
}
