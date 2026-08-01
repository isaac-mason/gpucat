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
import type { StorageBufferTextureSource } from '../../nodes/lib/texture';
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
export declare function createGlTexturesState(): GlTexturesState;
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
export declare function updateStorageBufferTexture(gl: WebGL2RenderingContext, state: GlTexturesState, source: StorageBufferTextureSource): WebGLTexture;
/** Get the cached GlTextureData for a GpuTexture (or null if never seen). */
export declare function getGlTextureData(state: GlTexturesState, texture: GpuTexture): GlTextureData | null;
/**
 * Ensure a GpuTexture's GL texture exists, is allocated at its current size/format, and (for
 * source-backed textures) has its data uploaded. Version-gated: a no-op once `data.version` matches
 * `texture.version`. Returns the cache entry.
 *
 * Render-target textures (`isRenderTargetTexture`) carry no source; their storage is (re)established
 * here at the current size and their pixels are filled by an FBO render — so this only creates +
 * allocates them (via `texImage2D`/`texStorage` with a null/absent source), never uploads.
 */
export declare function updateTexture(gl: WebGL2RenderingContext, state: GlTexturesState, texture: GpuTexture): GlTextureData;
/**
 * Generate mipmaps for an already-allocated cube render-target texture (mirrors the WebGPU path's
 * `finalizeCubeRenderTargetCapture`): after all six faces are rendered, bind the cube texture and
 * `generateMipmap(TEXTURE_CUBE_MAP)` so a mipped environment map has its lower levels filled. Guards:
 * only when the texture wants mips, its format is mip-generatable, and it has an allocated GL texture.
 */
export declare function generateCubeMipmaps(gl: WebGL2RenderingContext, state: GlTexturesState, texture: GpuTexture): void;
/** Delete all GL textures (called on renderer dispose). */
export declare function disposeGlTextures(gl: WebGL2RenderingContext, state: GlTexturesState): void;
/** Number of GL textures currently allocated. */
export declare function getGlTexturesStats(state: GlTexturesState): {
    textureCount: number;
};
export {};
