import type { GpuBuffer } from '../../core/gpu-buffer';
import type { Geometry } from '../../geometry/geometry';
import type { StorageNode } from '../../nodes/nodes';
import type { Any } from '../../schema/schema';
import type { RendererInfo } from '../core/info';
type CacheEntry = {
    buf: GPUBuffer;
    version: number;
};
export type BufferCache = {
    /** All GpuBuffer -> GPUBuffer mappings, regardless of usage. */
    bufferMap: WeakMap<GpuBuffer, CacheEntry>;
    /** Plain-object-keyed buffers (instance matrices, material UBOs, camera, time). */
    rawMap: WeakMap<object, GPUBuffer>;
    /** Mutable stats counters (approximate, tracks allocations, not deallocations) */
    bufferCount: number;
    rawCount: number;
    /** Where upload volume is tallied. Held by reference rather than counted locally so the
     *  frame boundary that zeroes it stays in ONE place (the renderer), and so every reader
     *  sees the same numbers — see `renderer/core/info.ts`. */
    info: RendererInfo;
};
export type BufferCacheStats = {
    bufferCount: number;
    rawCount: number;
};
export declare function createBufferCache(info: RendererInfo): BufferCache;
/**
 * Ensure a GpuBuffer is uploaded to the GPU, creating the GPUBuffer on first
 * use and re-uploading when the version advances or updateRanges are pending.
 *
 * This is the single upload function for all GpuBuffer types (vertex, index,
 * storage, indirect). GPU usage flags are derived from `buffer.usage`.
 */
/** `name` identifies the buffer in the per-frame upload breakdown. Required, not optional: every
 *  call site knows what it is binding, and a name is call-site knowledge - the same buffer can be
 *  bound under different attribute names, so it cannot live on the buffer. */
export declare function ensureUploaded(cache: BufferCache, device: GPUDevice, buffer: GpuBuffer, name: string): GPUBuffer;
/**
 * Return the GPUBuffer for an already-uploaded GpuBuffer, or undefined
 * if it has not been uploaded yet.
 *
 * This is a pure lookup, no data transfer occurs.
 */
export declare function getUploaded(cache: BufferCache, buffer: GpuBuffer): GPUBuffer | undefined;
/**
 * Resolve a GpuBuffer from a StorageNode.
 *
 * For named references, lookup order is: `buffers` (per-call override) → `geometry.buffers`.
 * For value references, the buffer is taken from node.value.
 */
export declare function resolveStorageBuffer(node: StorageNode<Any>, geometry: Geometry | null, buffers: Record<string, GpuBuffer<Any>> | null): GpuBuffer;
/**
 * Result of uploadRaw - includes buffer and whether it was newly created.
 */
export type UploadRawResult = {
    buffer: GPUBuffer;
    /** True if the buffer was newly created (requires bind group rebuild) */
    created: boolean;
};
/**
 * Get or create a uniform/storage GPUBuffer identified by a JS object key.
 * Always writes `data` to the buffer (caller decides when to call this).
 * Returns both the buffer and whether it was newly created/resized.
 */
/** identity for a raw write, supplied by callers that have it (uniform blocks do). */
export type RawWriteDetail = {
    material?: string;
    updateType?: string;
    changedBytes?: number;
};
/**
 * Upload one packed uniform block, identified by an arbitrary key.
 *
 * The one case with no `GpuBuffer` to gate on: a block is a byte blob packed from many uniform nodes
 * through a compile-time layout, double-buffered so the binding can diff it, with no version of its
 * own. Change detection is the caller's (`packAndCompare`), so this writes unconditionally.
 *
 * `ArrayBuffer`, not a typed array, so anything carrying a version cannot be passed here - those go
 * through `ensureUploaded`.
 */
export declare function uploadUniformBlock(cache: BufferCache, device: GPUDevice, key: object, data: ArrayBuffer, detail?: RawWriteDetail): UploadRawResult;
/**
 * Get a previously created raw buffer, or undefined.
 * Does NOT upload, use uploadRaw for that.
 */
export declare function getRaw(cache: BufferCache, key: object): GPUBuffer | undefined;
/**
 * Tear down the cache (called on renderer dispose).
 *
 * `device.destroy()` releases the GPU buffers, so this resets JS state: the maps are REPLACED rather
 * than emptied so a `GpuBuffer` outliving its renderer cannot find a stale entry and destroy through a
 * dead device. The WebGL sibling does the same.
 */
export declare function disposeBufferCache(cache: BufferCache): void;
/**
 * Returns approximate buffer counts tracked by this cache.
 */
export declare function getBufferCacheStats(cache: BufferCache): BufferCacheStats;
export {};
