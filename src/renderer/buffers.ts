import type { GpuBuffer } from '../core/buffer';
import type { GpuTypedArray } from '../core/buffer';
import type { Geometry } from '../geometry/geometry';
import type { StorageNode } from '../nodes/nodes';
import type { Any } from '../nodes/schema';

export type BufferCache = {
    /** GPUDevice is needed to create buffers and write data. */
    device: GPUDevice;

    /** Vertex buffers — keyed by GpuBuffer identity, version-gated re-upload. */
    vertexMap: WeakMap<GpuBuffer, { buf: GPUBuffer; version: number }>;

    /** Index buffers — keyed by GpuBuffer identity, version-gated re-upload. */
    indexMap: WeakMap<GpuBuffer, { buf: GPUBuffer; version: number }>;

    /** Plain-object-keyed buffers (instance matrices, material UBOs, camera, time). */
    rawMap: WeakMap<object, GPUBuffer>;

    /** Storage buffers — keyed by GpuBuffer identity, version-gated re-upload. */
    storageMap: WeakMap<GpuBuffer, { buf: GPUBuffer; version: number }>;

    /** Mutable stats counters (approximate — tracks allocations, not deallocations) */
    vertexCount: number;
    indexCount: number;
    storageCount: number;
    rawCount: number;
};

export type BufferCacheStats = {
    vertexCount: number;
    indexCount: number;
    storageCount: number;
    rawCount: number;
};

export function createBufferCache(device: GPUDevice): BufferCache {
    return {
        device,
        vertexMap: new WeakMap(),
        indexMap: new WeakMap(),
        rawMap: new WeakMap(),
        storageMap: new WeakMap(),
        vertexCount: 0,
        indexCount: 0,
        storageCount: 0,
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
        // Check vertex map
        const vertexEntry = cache.vertexMap.get(buffer);
        if (vertexEntry) {
            vertexEntry.buf.destroy();
        }

        // Check index map
        const indexEntry = cache.indexMap.get(buffer);
        if (indexEntry) {
            indexEntry.buf.destroy();
        }

        // Check storage map (also used by indirect buffers)
        const storageEntry = cache.storageMap.get(buffer);
        if (storageEntry) {
            storageEntry.buf.destroy();
        }
    };
}

/**
 * Get or create a GPUBuffer for a vertex GpuBuffer.
 * Re-uploads when buffer.version advances.
 */
export function uploadVertex(cache: BufferCache, buffer: GpuBuffer): GPUBuffer {
    const arr = buffer.array;
    if (!arr) {
        // CPU memory was released — return existing GPU buffer
        const entry = cache.vertexMap.get(buffer);
        if (!entry) {
            throw new Error('[gpucat] uploadVertex: buffer.array is null but GPU buffer was never created');
        }
        return entry.buf;
    }

    let entry = cache.vertexMap.get(buffer);
    const byteLength = arr.byteLength;

    if (!entry) {
        // Determine GPU usage flags based on buffer usage
        let usage = GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST;
        if (buffer.usage.has('storage')) {
            usage |= GPUBufferUsage.STORAGE;
        }

        const buf = cache.device.createBuffer({
            size: alignTo4(byteLength),
            usage,
        });
        cache.vertexCount++;
        cache.device.queue.writeBuffer(buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        cache.vertexMap.set(buffer, { buf, version: buffer.version });

        setupDispose(cache, buffer);
        buffer.onUpload?.();
        return buf;
    }

    if (buffer.version !== entry.version) {
        cache.device.queue.writeBuffer(entry.buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        entry.version = buffer.version;
    }

    return entry.buf;
}

/**
 * Get or create a GPUBuffer for an index GpuBuffer.
 * Re-uploads when buffer.version advances.
 */
export function uploadIndex(cache: BufferCache, buffer: GpuBuffer): GPUBuffer {
    const arr = buffer.array;
    if (!arr) {
        // CPU memory was released — return existing GPU buffer
        const entry = cache.indexMap.get(buffer);
        if (!entry) {
            throw new Error('[gpucat] uploadIndex: buffer.array is null but GPU buffer was never created');
        }
        return entry.buf;
    }

    let entry = cache.indexMap.get(buffer);
    const byteLength = arr.byteLength;

    if (!entry) {
        const buf = cache.device.createBuffer({
            size: alignTo4(byteLength),
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        cache.indexCount++;
        cache.device.queue.writeBuffer(buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        cache.indexMap.set(buffer, { buf, version: buffer.version });

        setupDispose(cache, buffer);
        buffer.onUpload?.();
        return buf;
    }

    if (buffer.version !== entry.version) {
        cache.device.queue.writeBuffer(entry.buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        entry.version = buffer.version;
    }

    return entry.buf;
}

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
        // Only increment count for genuinely new buffers, not resizes
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

/**
 * Resolve a GpuBuffer from a StorageNode.
 *
 * For named references, the buffer is resolved from geometry.buffers.
 * For value references, the buffer is taken from node.value.
 */
function resolveStorageBuffer(node: StorageNode<Any>, geometry: Geometry | null): GpuBuffer {
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

/**
 * Get or create a GPUBuffer for a StorageNode.
 *
 * Re-uploads when buffer.version advances (full upload) or when buffer.updateRanges
 * is non-empty (partial upload). Automatically calls buffer.clearUpdateRanges() after
 * a partial upload.
 *
 * For named references, the buffer is resolved from geometry.buffers.
 * For value references, the buffer is taken from node.value.
 *
 * @param cache - The buffer cache
 * @param node - The storage node
 * @param geometry - The geometry for name-based resolution (null for compute-only)
 */
export function uploadStorage(
    cache: BufferCache,
    node: StorageNode<Any>,
    geometry: Geometry | null
): GPUBuffer {
    const buffer = resolveStorageBuffer(node, geometry);

    // Validate usage
    if (!buffer.usage.has('storage')) {
        const name = node.bufferName ?? '(value)';
        throw new Error(`[gpucat] uploadStorage: buffer '${name}' does not have 'storage' usage`);
    }

    const arr = buffer.array;

    // If array is null, CPU memory was released via onUpload — return existing buffer.
    if (!arr) {
        const entry = cache.storageMap.get(buffer);
        if (!entry) {
            throw new Error('[gpucat] uploadStorage: buffer.array is null but GPU buffer was never created');
        }
        return entry.buf;
    }

    const byteLength = alignTo4(arr.byteLength);
    const entry = cache.storageMap.get(buffer);

    // Create buffer if it doesn't exist or is too small.
    if (!entry || entry.buf.size < byteLength) {
        entry?.buf.destroy();

        // Build GPU usage flags from GpuBuffer usage set
        let usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
        if (node.access === 'read_write') {
            usage |= GPUBufferUsage.COPY_SRC;
        }
        if (buffer.usage.has('indirect')) {
            usage |= GPUBufferUsage.INDIRECT;
        }
        if (buffer.usage.has('vertex')) {
            usage |= GPUBufferUsage.VERTEX;
        }

        const buf = cache.device.createBuffer({
            size: byteLength,
            usage,
        });
        if (!entry) cache.storageCount++;

        // Full upload on creation.
        cache.device.queue.writeBuffer(buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        cache.storageMap.set(buffer, { buf, version: buffer.version });

        setupDispose(cache, buffer);

        // Call onUpload after initial upload.
        // Typically used to release CPU memory via `buffer.array = null`.
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
 * Get or create a GPUBuffer for an indirect draw buffer.
 * Re-uploads when buffer.version advances.
 *
 * The buffer must have 'indirect' usage. It will be created with
 * STORAGE | INDIRECT | COPY_DST so compute shaders can write to it.
 */
export function uploadIndirect(cache: BufferCache, buffer: GpuBuffer): GPUBuffer {
    if (!buffer.usage.has('indirect')) {
        throw new Error('[gpucat] uploadIndirect: buffer does not have indirect usage');
    }

    const arr = buffer.array;

    // If array is null, CPU memory was released — return existing buffer.
    if (!arr) {
        const entry = cache.storageMap.get(buffer);
        if (!entry) {
            throw new Error('[gpucat] uploadIndirect: buffer.array is null but GPU buffer was never created');
        }
        return entry.buf;
    }

    const entry = cache.storageMap.get(buffer);

    if (!entry) {
        const buf = cache.device.createBuffer({
            size: arr.byteLength, // 16 or 20 — already u32-aligned
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
        });
        cache.device.queue.writeBuffer(buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        cache.storageMap.set(buffer, { buf, version: buffer.version });
        cache.storageCount++;

        setupDispose(cache, buffer);

        return buf;
    }

    // Buffers may be written by the GPU — skip CPU re-upload unless version
    // was explicitly bumped (e.g. initial seed values).
    if (buffer.version !== entry.version) {
        cache.device.queue.writeBuffer(entry.buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        entry.version = buffer.version;
    }

    return entry.buf;
}

/**
 * Return the GPUBuffer for an already-uploaded indirect buffer, or undefined
 * if it has not been uploaded yet.
 */
export function getIndirect(cache: BufferCache, buffer: GpuBuffer): GPUBuffer | undefined {
    return cache.storageMap.get(buffer)?.buf;
}

/**
 * Returns approximate buffer counts tracked by this cache.
 * Vertex/index/storage counts track allocations, not deallocations.
 */
export function getBufferCacheStats(cache: BufferCache): BufferCacheStats {
    return {
        vertexCount: cache.vertexCount,
        indexCount: cache.indexCount,
        storageCount: cache.storageCount,
        rawCount: cache.rawCount,
    };
}

function alignTo4(n: number): number {
    return Math.ceil(n / 4) * 4;
}
