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
import type { ResolvedStorageBufferTexture } from '../../nodes/lib/texture';
import { collapseUpdateRanges } from '../core/update-ranges';

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

function mipmapClassOf(format: string): MipmapClass {
    if (format.endsWith('uint') || format.endsWith('sint')) return 'integer';
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
};

/** Create an empty textures state. */
export function createGlTexturesState(): GlTexturesState {
    return { data: new WeakMap(), bufferData: new WeakMap(), all: new Set() };
}

/**
 * Upload texel rows `[rowFrom, rowTo]` (inclusive) of a storage buffer reinterpreted as a `width`-wide
 * grid of `bytesPerTexel`-byte texels (`glFormat` = RED/RG/RGBA_INTEGER to match), sourcing a ZERO-COPY
 * `Uint32Array` view over the buffer's own bytes. The grid may be taller than the buffer's exact byte
 * count (`width` need not divide `totalTexels`): the first `fullRows` rows are fully backed, and a padded
 * last row (`remainder` texels < `width`, at `y = fullRows`) is uploaded narrower so the view never reads
 * past the buffer. Padding texels stay zeroed and are never addressed by the shader (valid texel indices
 * only reach `totalTexels - 1`).
 */
function uploadStorageRows(
    gl: WebGL2RenderingContext,
    arr: ArrayBufferView,
    width: number,
    fullRows: number,
    remainder: number,
    rowFrom: number,
    rowTo: number,
    bytesPerTexel: number,
    glFormat: number,
): void {
    const comps = bytesPerTexel / 4; // u32 lanes per texel (r32uint = 1, rg32uint = 2, rgba32uint = 4)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // Full rows within the requested range.
    const fullTo = Math.min(rowTo, fullRows - 1);
    if (fullTo >= rowFrom) {
        const count = fullTo - rowFrom + 1;
        const view = new Uint32Array(arr.buffer, arr.byteOffset + rowFrom * width * bytesPerTexel, count * width * comps);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, rowFrom, width, count, glFormat, gl.UNSIGNED_INT, view);
    }
    // The short last row (if any) when it falls in the requested range — uploaded `remainder` texels wide.
    if (remainder > 0 && rowFrom <= fullRows && rowTo >= fullRows) {
        const view = new Uint32Array(arr.buffer, arr.byteOffset + fullRows * width * bytesPerTexel, remainder * comps);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, fullRows, remainder, 1, glFormat, gl.UNSIGNED_INT, view);
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
 * `width` need not divide the texel count: the last row is padded and uploaded narrower (see
 * {@link uploadStorageRows}). Cached per `GpuBuffer`; re-synced when `buffer.version` moves or ranges are
 * queued — a row-granular partial upload for `packAtIndex`/`addUpdateRange` writes, a full upload for a
 * bare version bump, or a full re-allocation if the texel grid grew. The caller binds it.
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

    // The buffer is a whole number of texels (guarded at compile). `width` may not divide it: `fullRows`
    // rows are fully backed and a `remainder`-wide last row is padded up to `width`.
    const totalTexels = arr.byteLength / bytesPerTexel;
    const fullRows = Math.floor(totalTexels / width);
    const remainder = totalTexels - fullRows * width;

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
        uploadStorageRows(gl, arr, width, fullRows, remainder, 0, height - 1, bytesPerTexel, glFormat);
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
        uploadStorageRows(gl, arr, width, fullRows, remainder, 0, height - 1, bytesPerTexel, glFormat);
        data.width = width;
        data.height = height;
    } else {
        // Same size: prefer a row-granular partial upload when `packAtIndex`/`addUpdateRange` queued
        // dirty ranges. `updateRanges` are flat COMPONENT indices, so the grid width in that unit is
        // width·comps (u32 lanes per texel: r32uint 1, rg32uint 2, rgba32uint 4); clamp the span to
        // `[0, height)`. A bare version bump (no ranges) or a span covering more than half the rows →
        // full. `uploadStorageRows` handles the padded last row inside whatever span it's given.
        const raw = buffer.updateRanges.length > 0 ? collapseUpdateRanges(buffer.updateRanges, width * comps) : null;
        const y0 = raw ? Math.max(0, raw.rowStart) : 0;
        const y1 = raw ? Math.min(height - 1, raw.rowStart + raw.rowCount - 1) : -1;
        if (raw && y1 >= y0 && y1 - y0 + 1 <= height / 2) {
            uploadStorageRows(gl, arr, width, fullRows, remainder, y0, y1, bytesPerTexel, glFormat);
        } else {
            uploadStorageRows(gl, arr, width, fullRows, remainder, 0, height - 1, bytesPerTexel, glFormat);
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
function setDefaultMinFilter(gl: WebGL2RenderingContext, target: number, generateMipmaps: boolean, isInteger: boolean): void {
    // A freshly-created GL texture defaults to a mipmapped min-filter, which reads as "incomplete"
    // when no mips exist. Sampler objects override this at bind time, but set a safe baseline here.
    // Integer textures are NOT filterable — LINEAR makes them incomplete (so even texelFetch reads 0),
    // so they must be NEAREST regardless of the sampler.
    const min = isInteger ? gl.NEAREST : generateMipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, isInteger ? gl.NEAREST : gl.LINEAR);
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

/** Upload only the dirty rows `[y0, y0+rows)` of a 2D source-backed texture via `texSubImage2D`. */
function uploadPartial2D(
    gl: WebGL2RenderingContext,
    texture: GpuTexture,
    data: GlTextureData,
    span: { y0: number; rows: number },
): void {
    const source = texture.source;
    if (!source || !source.data) return;
    const typed = typedArrayOf(source.data) as Uint32Array | null;
    if (!typed) return;
    const { format, type } = data.fmt;
    const width = texture.width;
    // Components per texel, derived from the array so this is format-agnostic (rgba32uint = 4, r32uint = 1).
    const comps = Math.round(typed.length / (width * texture.height));
    const { y0, rows } = span;
    const start = y0 * width * comps;
    const sub = typed.subarray(start, start + rows * width * comps);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, width, rows, format, type, sub as ArrayBufferView);
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

    // Partial upload: an in-place `packAtIndex`/`addUpdateRange` queued dirty texel ranges (no full re-upload
    // and no resize) → re-specify only the covering rows via `texSubImage2D` on the existing GL texture,
    // skipping the delete + full `texImage2D` below. A full flag (`needsUpdate`/grow) or a size change
    // takes priority. `> ½` the texture dirty → fall through to a full upload (fewer, simpler calls).
    if (
        data.allocated &&
        !texture.needsFullUpload &&
        texture.updateRanges.length > 0 &&
        texture.viewDimension === '2d' &&
        !texture.isRenderTargetTexture &&
        data.allocW === texture.width &&
        data.allocH === texture.height
    ) {
        const span = collapseUpdateRanges(texture.updateRanges, texture.width);
        if (span && span.rowCount <= texture.height / 2) {
            gl.bindTexture(data.target, data.texture);
            uploadPartial2D(gl, texture, data, { y0: span.rowStart, rows: span.rowCount });
            texture.updateRanges.length = 0;
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
    setDefaultMinFilter(gl, data.target, texture.generateMipmaps, mipmapClassOf(texture.format) === 'integer');

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

    // A full (re)upload supersedes any queued partial ranges and clears the full flag. Record the
    // allocated size so later in-place stores can take the partial `texSubImage2D` path above.
    texture.updateRanges.length = 0;
    texture.needsFullUpload = false;
    data.allocW = texture.width;
    data.allocH = texture.height;
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
    // TEXTURE_CUBE_MAP immutable storage allocates all 6 faces; each face is then attachable to an FBO
    // via framebufferTexture2D(TEXTURE_CUBE_MAP_POSITIVE_X + face, …) (see render-target.ts).
    const target = data.target === gl.TEXTURE_CUBE_MAP ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
    gl.texStorage2D(target, levels, data.fmt.internalFormat, w, h);
    data.allocW = w;
    data.allocH = h;
}

/**
 * Generate mipmaps for an already-allocated cube render-target texture (mirrors the WebGPU path's
 * `finalizeCubeRenderTargetCapture`): after all six faces are rendered, bind the cube texture and
 * `generateMipmap(TEXTURE_CUBE_MAP)` so a mipped environment map has its lower levels filled. Guards:
 * only when the texture wants mips, its format is mip-generatable, and it has an allocated GL texture.
 */
export function generateCubeMipmaps(gl: WebGL2RenderingContext, state: GlTexturesState, texture: GpuTexture): void {
    if (!texture.generateMipmaps) return;
    if (!canGenerateMipmap(gl, texture.format)) return;
    const data = state.data.get(texture);
    if (!data || !data.allocated) return;
    if (data.target !== gl.TEXTURE_CUBE_MAP) return;
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, data.texture);
    gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
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
