import type { GpuBuffer } from '../../core/gpu-buffer';
import type { Geometry } from '../../geometry/geometry';
import type { StorageNode } from '../../nodes/nodes';
import type { Any } from '../../schema/schema';
import type { RendererInfo } from '../core/info';
import { recordBufferWrite } from '../core/info';

/** the one usage worth reporting, most specific first. A buffer often carries several
 *  flags (`storage` + `vertex`), and the specific one is what identifies it. */
function primaryUsage(buffer: { usage: Set<string> }): string {
    for (const candidate of ['storage', 'index', 'vertex', 'uniform', 'indirect']) {
        if (buffer.usage.has(candidate)) return candidate;
    }
    return 'other';
}
import { BufferUpload, planBufferUpload } from '../core/buffer-upload';

type CacheEntry = { buf: GPUBuffer; version: number };

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

export function createBufferCache(info: RendererInfo): BufferCache {
    return {
        bufferMap: new WeakMap(),
        rawMap: new WeakMap(),
        bufferCount: 0,
        rawCount: 0,
        info,
    };
}

/**
 * Set up the _onDispose callback on a GpuBuffer to destroy its GPU buffer.
 * Only sets the callback once (idempotent).
 */
function setupDispose(cache: BufferCache, buffer: GpuBuffer): void {
    if (buffer._onDispose) return;

    buffer._onDispose = () => {
        const entry = cache.bufferMap.get(buffer);
        if (entry) {
            entry.buf.destroy();
        }
    };
}

/**
 * Derive GPUBufferUsage flags from a GpuBuffer's usage set.
 */
function deriveGPUUsage(buffer: GpuBuffer): GPUBufferUsageFlags {
    let flags = GPUBufferUsage.COPY_DST;

    if (buffer.usage.has('vertex')) flags |= GPUBufferUsage.VERTEX;
    if (buffer.usage.has('index')) flags |= GPUBufferUsage.INDEX;
    if (buffer.usage.has('storage')) flags |= GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
    if (buffer.usage.has('indirect')) flags |= GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE;
    if (buffer.usage.has('uniform')) flags |= GPUBufferUsage.UNIFORM;

    return flags;
}

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
export function ensureUploaded(cache: BufferCache, device: GPUDevice, buffer: GpuBuffer, name: string): GPUBuffer {
    const entry = cache.bufferMap.get(buffer);
    const plan = planBufferUpload(buffer, entry !== undefined, entry?.buf.size ?? 0, entry?.version ?? -1);

    if (plan === BufferUpload.Skip) {
        if (!entry) {
            throw new Error('[gpucat] ensureUploaded: buffer.array is null but GPU buffer was never created');
        }
        return entry.buf;
    }

    // non-null past the plan: Skip is the only outcome for a released array.
    const arr = buffer.array!;
    const usage = primaryUsage(buffer);
    const label = buffer.label ?? name;

    if (plan === BufferUpload.Allocate) {
        entry?.buf.destroy();
        // 4-byte alignment is a device requirement, so the size is decided here, not in the plan.
        const buf = device.createBuffer({ size: alignTo4(arr.byteLength), usage: deriveGPUUsage(buffer) });
        if (!entry) cache.bufferCount++;

        device.queue.writeBuffer(buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        recordBufferWrite(cache.info, arr.byteLength, usage, true, label);
        cache.bufferMap.set(buffer, { buf, version: buffer.version });

        // the allocate path wrote everything, so pending ranges are already covered; dropping them
        // stops the next frame replaying them as a redundant partial write.
        buffer.clearUpdateRanges();
        setupDispose(cache, buffer);
        buffer.onUpload?.();
        return buf;
    }

    const { buf } = entry!;

    if (plan === BufferUpload.Partial) {
        // Ranges are flat component indices and arrive already merged.
        const bytesPerComponent = arr.BYTES_PER_ELEMENT;
        for (const { start, count } of buffer.updateRanges) {
            const byteOffset = start * bytesPerComponent;
            const byteCount = count * bytesPerComponent;
            device.queue.writeBuffer(buf, byteOffset, arr.buffer as ArrayBuffer, arr.byteOffset + byteOffset, byteCount);
            recordBufferWrite(cache.info, byteCount, usage, false, label);
        }
        buffer.clearUpdateRanges();
    } else {
        device.queue.writeBuffer(buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        recordBufferWrite(cache.info, arr.byteLength, usage, true, label);
    }
    entry!.version = buffer.version;
    return buf;
}

/**
 * Return the GPUBuffer for an already-uploaded GpuBuffer, or undefined
 * if it has not been uploaded yet.
 *
 * This is a pure lookup, no data transfer occurs.
 */
export function getUploaded(cache: BufferCache, buffer: GpuBuffer): GPUBuffer | undefined {
    return cache.bufferMap.get(buffer)?.buf;
}

/**
 * Resolve a GpuBuffer from a StorageNode.
 *
 * For named references, lookup order is: `buffers` (per-call override) → `geometry.buffers`.
 * For value references, the buffer is taken from node.value.
 */
export function resolveStorageBuffer(
    node: StorageNode<Any>,
    geometry: Geometry | null,
    buffers: Record<string, GpuBuffer<Any>> | null,
): GpuBuffer {
    if (node.isNamedReference) {
        const name = node.bufferName!;
        const buffer = buffers?.[name] ?? geometry?.buffers.get(name);

        if (!buffer) {
            throw new Error(
                `[gpucat] resolveStorageBuffer: buffer '${name}' not found in compute buffers map or geometry.buffers`,
            );
        }

        return buffer;
    } else {
        const buffer = node.value;
        if (!buffer) {
            throw new Error('[gpucat] resolveStorageBuffer: node.value is null');
        }
        return buffer;
    }
}

// Raw buffers (object-keyed, for UBOs and BufferAttributeNodes)

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
export function uploadUniformBlock(
    cache: BufferCache,
    device: GPUDevice,
    key: object,
    data: ArrayBuffer,
    detail?: RawWriteDetail,
): UploadRawResult {
    let buf = cache.rawMap.get(key);
    const byteLength = alignTo4(data.byteLength);
    const isNew = !buf;
    let created = false;

    if (!buf || buf.size < byteLength) {
        buf?.destroy();
        buf = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        cache.rawMap.set(key, buf);
        created = true;
        if (isNew) {
            cache.rawCount++;
        }
    }

    // raw path: no GpuBuffer, so no label. `full` is FALSE on purpose - this path has
    // no concept of ranges, so it always writes everything, and flagging it would make
    // the "full re-upload" signal tautological exactly where it matters most. Identity
    // comes from `detail`, which the uniform-binding caller fills in.
    device.queue.writeBuffer(buf, 0, data, 0, data.byteLength);
    recordBufferWrite(
        cache.info,
        data.byteLength,
        'uniform',
        false,
        undefined,
        detail?.material,
        detail?.updateType,
        detail?.changedBytes,
    );
    return { buffer: buf, created };
}

/**
 * Get a previously created raw buffer, or undefined.
 * Does NOT upload, use uploadRaw for that.
 */
export function getRaw(cache: BufferCache, key: object): GPUBuffer | undefined {
    return cache.rawMap.get(key);
}

// Stats

/**
 * Returns approximate buffer counts tracked by this cache.
 */
export function getBufferCacheStats(cache: BufferCache): BufferCacheStats {
    return {
        bufferCount: cache.bufferCount,
        rawCount: cache.rawCount,
    };
}

function alignTo4(n: number): number {
    return Math.ceil(n / 4) * 4;
}
