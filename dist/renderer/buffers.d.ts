import type { GpuBuffer } from '../core/gpu-buffer';
import type { GpuTypedArray } from '../core/gpu-buffer';
import type { Geometry } from '../geometry/geometry';
import type { StorageNode } from '../nodes/nodes';
import type { Any } from '../schema/schema';
type CacheEntry = {
    buf: GPUBuffer;
    version: number;
};
export type BufferCache = {
    /** All GpuBuffer -> GPUBuffer mappings, regardless of usage. */
    bufferMap: WeakMap<GpuBuffer, CacheEntry>;
    /** Plain-object-keyed buffers (instance matrices, material UBOs, camera, time). */
    rawMap: WeakMap<object, GPUBuffer>;
    /** Mutable stats counters (approximate — tracks allocations, not deallocations) */
    bufferCount: number;
    rawCount: number;
};
export type BufferCacheStats = {
    bufferCount: number;
    rawCount: number;
};
export declare function createBufferCache(): BufferCache;
/**
 * Ensure a GpuBuffer is uploaded to the GPU, creating the GPUBuffer on first
 * use and re-uploading when the version advances or updateRanges are pending.
 *
 * This is the single upload function for all GpuBuffer types (vertex, index,
 * storage, indirect). GPU usage flags are derived from `buffer.usage`.
 */
export declare function ensureUploaded(cache: BufferCache, device: GPUDevice, buffer: GpuBuffer): GPUBuffer;
/**
 * Return the GPUBuffer for an already-uploaded GpuBuffer, or undefined
 * if it has not been uploaded yet.
 *
 * This is a pure lookup — no data transfer occurs.
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
export declare function uploadRaw(cache: BufferCache, device: GPUDevice, key: object, data: GpuTypedArray, usage: GPUBufferUsageFlags): UploadRawResult;
/**
 * Get a previously created raw buffer, or undefined.
 * Does NOT upload — use uploadRaw for that.
 */
export declare function getRaw(cache: BufferCache, key: object): GPUBuffer | undefined;
/**
 * Returns approximate buffer counts tracked by this cache.
 */
export declare function getBufferCacheStats(cache: BufferCache): BufferCacheStats;
export {};
