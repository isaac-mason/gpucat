import type { GpuBuffer } from '../core/buffer';
import type { GpuTypedArray } from '../core/buffer';
import type { Geometry } from '../geometry/geometry';
import type { StorageNode } from '../nodes/nodes';
import type { Any } from '../nodes/schema';

type CacheEntry = { buf: GPUBuffer; version: number };

export type BufferCache = {
    /** GPUDevice is needed to create buffers and write data. */
    device: GPUDevice;

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

export function createBufferCache(device: GPUDevice): BufferCache {
    return {
        device,
        bufferMap: new WeakMap(),
        rawMap: new WeakMap(),
        bufferCount: 0,
        rawCount: 0,
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

    if (buffer.usage.has('vertex'))   flags |= GPUBufferUsage.VERTEX;
    if (buffer.usage.has('index'))    flags |= GPUBufferUsage.INDEX;
    if (buffer.usage.has('storage'))  flags |= GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
    if (buffer.usage.has('indirect')) flags |= GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE;
    if (buffer.usage.has('uniform'))  flags |= GPUBufferUsage.UNIFORM;

    return flags;
}

/**
 * Ensure a GpuBuffer is uploaded to the GPU, creating the GPUBuffer on first
 * use and re-uploading when the version advances or updateRanges are pending.
 *
 * This is the single upload function for all GpuBuffer types (vertex, index,
 * storage, indirect). GPU usage flags are derived from `buffer.usage`.
 */
export function ensureUploaded(cache: BufferCache, buffer: GpuBuffer): GPUBuffer {
    const arr = buffer.array;

    // CPU memory was released — return existing GPU buffer.
    if (!arr) {
        const entry = cache.bufferMap.get(buffer);
        if (!entry) {
            throw new Error('[gpucat] ensureUploaded: buffer.array is null but GPU buffer was never created');
        }
        return entry.buf;
    }

    const byteLength = alignTo4(arr.byteLength);
    const entry = cache.bufferMap.get(buffer);

    // Create buffer if it doesn't exist or is too small.
    if (!entry || entry.buf.size < byteLength) {
        entry?.buf.destroy();

        const buf = cache.device.createBuffer({
            size: byteLength,
            usage: deriveGPUUsage(buffer),
        });

        if (!entry) cache.bufferCount++;

        cache.device.queue.writeBuffer(buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        cache.bufferMap.set(buffer, { buf, version: buffer.version });

        setupDispose(cache, buffer);
        buffer.onUpload?.();

        return buf;
    }

    const { buf } = entry;

    if (buffer.updateRanges.length > 0) {
        // Partial upload — ranges are flat component indices; convert to bytes.
        const bytesPerComponent = arr.BYTES_PER_ELEMENT;
        for (const { start, count } of buffer.updateRanges) {
            const byteOffset = start * bytesPerComponent;
            const byteCount = count * bytesPerComponent;
            cache.device.queue.writeBuffer(buf, byteOffset, arr.buffer as ArrayBuffer, arr.byteOffset + byteOffset, byteCount);
        }
        buffer.clearUpdateRanges();
        entry.version = buffer.version;
    } else if (buffer.version !== entry.version) {
        // Full re-upload.
        cache.device.queue.writeBuffer(buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        entry.version = buffer.version;
    }

    return buf;
}

/**
 * Return the GPUBuffer for an already-uploaded GpuBuffer, or undefined
 * if it has not been uploaded yet.
 *
 * This is a pure lookup — no data transfer occurs.
 */
export function getUploaded(cache: BufferCache, buffer: GpuBuffer): GPUBuffer | undefined {
    return cache.bufferMap.get(buffer)?.buf;
}

/**
 * Resolve a GpuBuffer from a StorageNode.
 *
 * For named references, the buffer is resolved from geometry.buffers.
 * For value references, the buffer is taken from node.value.
 */
export function resolveStorageBuffer(node: StorageNode<Any>, geometry: Geometry | null): GpuBuffer {
    if (node.isNamedReference) {
        if (!geometry) {
            throw new Error(
                `[gpucat] resolveStorageBuffer: storage node '${node.bufferName}' is name-based but no geometry was provided`
            );
        }
        const buffer = geometry.buffers.get(node.bufferName!);
        if (!buffer) {
            throw new Error(
                `[gpucat] resolveStorageBuffer: buffer '${node.bufferName}' not found in geometry.buffers`
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

// ---------------------------------------------------------------------------
// Raw buffers (object-keyed, for UBOs and BufferAttributeNodes)
// ---------------------------------------------------------------------------

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
export function uploadRaw(cache: BufferCache, key: object, data: GpuTypedArray, usage: GPUBufferUsageFlags): UploadRawResult {
    let buf = cache.rawMap.get(key);
    const byteLength = alignTo4(data.byteLength);
    const isNew = !buf;
    let created = false;

    if (!buf || buf.size < byteLength) {
        buf?.destroy();
        buf = cache.device.createBuffer({ size: byteLength, usage });
        cache.rawMap.set(key, buf);
        created = true;
        if (isNew) {
            cache.rawCount++;
        }
    }

    cache.device.queue.writeBuffer(buf, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    return { buffer: buf, created };
}

/**
 * Get a previously created raw buffer, or undefined.
 * Does NOT upload — use uploadRaw for that.
 */
export function getRaw(cache: BufferCache, key: object): GPUBuffer | undefined {
    return cache.rawMap.get(key);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

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
