/**
 * buffers.ts (webgl) - `GpuBuffer -> WebGLBuffer` cache, the GL sibling of `webgpu/buffers.ts`.
 *
 * Two maps, matching WebGPU's, because there are two genuinely different cases:
 *
 *  - `bufferMap` keys by `GpuBuffer` identity, for anything a GpuBuffer backs: vertex attributes,
 *    indices, transform-feedback IO. One GpuBuffer therefore means exactly one GL buffer, no matter
 *    how many geometries or passes reach it. `webgl/renderer.ts` `readBufferAsync` has always
 *    documented that invariant; before this module there was nothing to enforce it.
 *  - `rawMap` keys by an arbitrary object, for device buffers with no GpuBuffer behind them. Uniform
 *    blocks are the only case: a block is a byte blob packed from many uniform nodes through a
 *    compile-time layout, with no version of its own, so change detection belongs to the caller.
 *
 * Owning the mapping is also what makes release possible. A `GpuBuffer` that reaches the device
 * through a geometry used to be freed only when that geometry was, because no module knew the
 * mapping existed.
 *
 * GL buffers are typeless; the bind target passed here only says how to reach the buffer for this
 * upload. It matters because `ELEMENT_ARRAY_BUFFER` bindings are captured into whatever VAO is bound,
 * so callers must upload with VAO 0 bound (see `prepareGeometry`).
 */
import type { GpuBuffer } from '../../core/gpu-buffer';
import { type RendererInfo } from '../core/info';
type CacheEntry = {
    glBuffer: WebGLBuffer;
    /** `buffer.version` at last upload, the re-upload gate. */
    version: number;
    /** last allocated byte size, the resize guard. */
    byteLength: number;
};
type RawEntry = {
    glBuffer: WebGLBuffer;
    byteLength: number;
};
export type BufferCache = {
    /** GL buffer per `GpuBuffer`, shared across every geometry and pass that reaches it. */
    bufferMap: WeakMap<GpuBuffer, CacheEntry>;
    /** GL buffer per opaque key, for uniform blocks (no backing `GpuBuffer`). */
    rawMap: WeakMap<object, RawEntry>;
    /** Every live GL buffer, for teardown. The maps are weak and cannot be walked. */
    all: Set<WebGLBuffer>;
    bufferCount: number;
    rawCount: number;
    /** Where upload volume is tallied. Held by reference so the frame boundary that zeroes it stays
     *  in one place (the renderer) and every reader sees the same numbers; see `core/info.ts`. */
    info: RendererInfo;
};
export type BufferCacheStats = {
    bufferCount: number;
    rawCount: number;
};
export declare function createBufferCache(info: RendererInfo): BufferCache;
/**
 * GL usage hint from the buffer's declared usage, the analogue of WebGPU's `deriveGPUUsage`.
 *
 * A hint only, never correctness: GL is free to ignore it. Transform-feedback outputs are the case
 * worth getting right, since they are GPU-written and GPU-consumed; a `*_READ` hint there makes the
 * driver stage through host memory on every capture.
 */
export declare function glUsageHint(gl: WebGL2RenderingContext, buffer: GpuBuffer): number;
/**
 * Get (or create) the GL buffer for a `GpuBuffer`, uploading whatever changed since last time.
 *
 * `target` is the bind target to upload through; `name` is a fallback label for the upload breakdown
 * when the buffer carries none. The allocate / partial / full decision is `core/buffer-upload.ts`'s,
 * shared with the WebGPU backend so the rule cannot drift.
 *
 * `usageHint` overrides the hint derived from `buffer.usage`, for the caller that knows better than
 * the declared usage does. Transform feedback is the case: its outputs are GPU-written and
 * GPU-consumed, so they want `DYNAMIC_COPY` whatever they are declared as. WebGPU needs no such
 * escape hatch, because its usage flags are correctness rather than an advisory hint.
 */
export declare function ensureUploaded(gl: WebGL2RenderingContext, cache: BufferCache, buffer: GpuBuffer, target: GLenum, name: string, usageHint?: number): WebGLBuffer;
/** The GL buffer already created for a `GpuBuffer`, or undefined. Never uploads. */
export declare function getUploaded(cache: BufferCache, buffer: GpuBuffer): WebGLBuffer | undefined;
export type UploadRawResult = {
    glBuffer: WebGLBuffer;
    /** True when the GL buffer was newly created or grown, so dependent bindings must be refreshed. */
    created: boolean;
};
/** Identity for a raw write, supplied by callers that have it (uniform blocks do). */
export type RawWriteDetail = {
    material?: string;
    updateType?: string;
    changedBytes?: number;
};
/**
 * Upload one packed uniform block, identified by an arbitrary key.
 *
 * The one case with no `GpuBuffer` to gate on, so this writes unconditionally and change detection
 * stays with the caller. `full` is recorded as false: this path has no concept of ranges and always
 * writes everything, so flagging it would make the full-re-upload signal tautological.
 */
export declare function uploadUniformBlock(gl: WebGL2RenderingContext, cache: BufferCache, key: object, data: ArrayBuffer, detail?: RawWriteDetail): UploadRawResult;
/** The GL buffer for a raw key, or undefined. Never uploads. */
export declare function getRaw(cache: BufferCache, key: object): WebGLBuffer | undefined;
/**
 * Delete every GL buffer this cache holds (called on renderer dispose).
 *
 * The maps are replaced, not just emptied: a `GpuBuffer` outliving its renderer still carries the
 * dispose callback installed here, and finding a stale entry would double-delete and decrement a
 * count that teardown had already zeroed. A fresh map makes that callback a no-op.
 */
export declare function disposeBufferCache(gl: WebGL2RenderingContext, cache: BufferCache): void;
export declare function getBufferCacheStats(cache: BufferCache): BufferCacheStats;
export {};
