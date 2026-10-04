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
    /** Allocations for uniform uses that cannot read their block's own buffer. See `allocDynamicUniform`. */
    dynamicUniforms: DynamicUniformBuffers;
};
/**
 * PlayCanvas's `DynamicBuffers`. A uniform block used again in a frame with different bytes cannot rewrite
 * its own buffer (the earlier use would read the write, since every write lands before the frame's
 * submit), so that use takes an aligned allocation here, written into a mapped staging buffer and bound
 * with a dynamic offset. At submit the staging buffers are copied into their GPU buffers by a command
 * buffer placed ahead of the frame's, then remapped for reuse. No allocation is written twice in a frame.
 */
export type DynamicUniformBuffers = {
    /** Free GPU buffers. One returns here as soon as its copy is scheduled: the copy runs before any later pass. */
    gpuBuffers: DynamicGpuBuffer[];
    /** Staging buffers mapped for writing. */
    stagingBuffers: StagingBuffer[];
    /** CPU copies, free again as soon as their submit has written them. */
    cpuStagingBuffers: StagingBuffer[];
    /** Filled, waiting for the submit that copies them. */
    usedBuffers: UsedBuffer[];
    active: UsedBuffer | null;
    /** Submitted, waiting for `mapAsync` before they take allocations again. */
    pendingStagingBuffers: StagingBuffer[];
    /** Mapped staging buffers alive, capped by `MAX_MAPPED_STAGING_BUFFERS`. */
    mappedStagingCount: number;
    /** CPU copies created. */
    cpuStagingCount: number;
    nextBufferId: number;
    destroyed: boolean;
};
/** `id` is what a binding records, so neutral code never holds a GPU type. */
type DynamicGpuBuffer = {
    buffer: GPUBuffer;
    id: number;
};
/** `buffer` is null for a CPU copy, which the submit uploads with a queue write instead of a copy. */
type StagingBuffer = {
    buffer: GPUBuffer | null;
    view: DataView<ArrayBuffer>;
};
type UsedBuffer = {
    gpuBuffer: DynamicGpuBuffer;
    staging: StagingBuffer;
    size: number;
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
 * `writeBuffer` for WebGPU: a queue write, which copies `data` before returning. Offsets and size are
 * bytes, already validated by the caller.
 */
export declare function writeBufferBytes(cache: BufferCache, device: GPUDevice, buffer: GpuBuffer, byteOffset: number, data: ArrayBufferView, dataByteOffset: number, byteSize: number): void;
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
 * Takes an aligned allocation of `size` bytes and returns its offset. It lands in `dynamicUniforms.active`,
 * whose staging view the caller packs into and whose GPU buffer the caller binds at that offset.
 */
export declare function allocDynamicUniform(cache: BufferCache, device: GPUDevice, size: number): number;
/**
 * Resident dynamic uniform buffers and staging (mapped or CPU). Pools only grow until dispose, so these
 * settle at the peak a scene needs; one that climbs frame over frame means allocations are not returning.
 */
export declare function getDynamicUniformStats(cache: BufferCache): {
    gpuBuffers: number;
    stagingBuffers: number;
};
/** The GPU buffer a binding recorded by id, for building the bind group that addresses it. */
export declare function dynamicUniformBuffer(cache: BufferCache, id: number): GPUBuffer;
/**
 * Unmaps every staging buffer filled since the last submit and records their copies into their GPU
 * buffers, in a command buffer the frame submits ahead of its own. Returns null when nothing was written.
 */
export declare function submitDynamicUniforms(cache: BufferCache, device: GPUDevice): GPUCommandBuffer | null;
/** After the submit: remaps the staging buffers it copied from, which resolves once the GPU is done reading them. */
export declare function onDynamicUniformsSubmitted(cache: BufferCache): void;
/** For a frame discarded rather than submitted: its buffers go back unsubmitted, the staging ones still mapped. */
export declare function rewindDynamicUniforms(cache: BufferCache): void;
/**
 * Returns approximate buffer counts tracked by this cache.
 */
export declare function getBufferCacheStats(cache: BufferCache): BufferCacheStats;
export {};
