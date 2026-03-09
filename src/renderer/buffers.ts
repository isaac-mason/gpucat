import type { BufferAttribute, IndexAttribute, IndirectStorageBufferAttribute } from '../core/attribute';
import type { GpuTypedArray, StorageNode } from '../nodes/nodes';
import type { WgslDesc } from '../nodes/schema';

export type BufferCache = {
    /* GPUDevice is needed to create buffers and write data. */
    device: GPUDevice;

    /* vertex/index buffers — keyed by BufferAttribute identity, version-gated re-upload. */
    vertexMap: WeakMap<BufferAttribute, { buf: GPUBuffer; version: number }>;
    indexMap: WeakMap<IndexAttribute, { buf: GPUBuffer; version: number }>;

    /* plain-object-keyed buffers (instance matrices, material UBOs, camera, time). */
    rawMap: WeakMap<object, GPUBuffer>;

    /* storage node buffers — keyed by node identity, version-gated re-upload. */
    storageMap: WeakMap<StorageNode<WgslDesc>, { buf: GPUBuffer; version: number }>;

    /* indirect draw buffers — keyed by IndirectStorageBufferAttribute identity, version-gated re-upload. */
    indirectMap: WeakMap<IndirectStorageBufferAttribute, { buf: GPUBuffer; version: number }>;

    /* map of Uint32Array -> IndirectStorageBufferAttribute. populated by uploadIndirect, used by uploadStorage to detect shared backing arrays */
    dataToIndirect: WeakMap<Uint32Array, IndirectStorageBufferAttribute>;

    /* mutable stats counters (approximate — tracks allocations, not deallocations) */
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
        indirectMap: new WeakMap(),
        dataToIndirect: new WeakMap(),
        vertexCount: 0,
        indexCount: 0,
        storageCount: 0,
        rawCount: 0,
    };
}

/**
 * Get or create a GPUBuffer for a vertex BufferAttribute.
 * Re-uploads when attr.version advances.
 */
export function uploadVertex(cache: BufferCache, attr: BufferAttribute): GPUBuffer {
    const arr = attr.array;
    if (!arr) {
        throw new Error('[gpucat] uploadVertex: attr.array is null');
    }

    let entry = cache.vertexMap.get(attr);
    const byteLength = arr.byteLength;

    if (!entry) {
        const buf = cache.device.createBuffer({
            size: alignTo4(byteLength),
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        cache.vertexCount++;
        cache.device.queue.writeBuffer(buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        cache.vertexMap.set(attr, { buf, version: attr.version });
        return buf;
    }

    if (attr.version !== entry.version) {
        cache.device.queue.writeBuffer(entry.buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        entry.version = attr.version;
    }

    return entry.buf;
}

/**
 * Get or create a GPUBuffer for an IndexAttribute.
 * Re-uploads when attr.version advances.
 */
export function uploadIndex(cache: BufferCache, attr: IndexAttribute): GPUBuffer {
    const arr = attr.array;

    let entry = cache.indexMap.get(attr);
    const byteLength = arr.byteLength;

    if (!entry) {
        const buf = cache.device.createBuffer({
            size: alignTo4(byteLength),
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        cache.indexCount++;
        cache.device.queue.writeBuffer(buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        cache.indexMap.set(attr, { buf, version: attr.version });
        return buf;
    }

    if (attr.version !== entry.version) {
        cache.device.queue.writeBuffer(entry.buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        entry.version = attr.version;
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
 * Get or create a GPUBuffer for a StorageNode. Re-uploads when node.value.version advances
 * (full upload) or when node.value.updateRanges is non-empty (partial upload).
 * Automatically calls node.value.clearUpdateRanges() after a partial upload.
 *
 * Special case: if the node is backed by an IndirectStorageBufferAttribute,
 * the IndirectStorageBufferAttribute's GPUBuffer is returned and registered in storageMap so the
 * compute shader binds to the same buffer that drawIndirect reads.
 */
export function uploadStorage(cache: BufferCache, node: StorageNode<WgslDesc>): GPUBuffer {
    const arr = node.value.array;

    // Primary check: if this StorageNode is backed by an IndirectStorageBufferAttribute,
    // use uploadIndirect to get (or create) the shared STORAGE|INDIRECT|COPY_DST buffer.
    // This must run before the dataToIndirect check because uploadIndirect populates
    // dataToIndirect — and compute dispatches happen before issueDraws, so dataToIndirect
    // would otherwise be empty on the first frame.
    if (node.isIndirectStorageBuffer) {
        const indirectAttr = node.value as IndirectStorageBufferAttribute;
        const indBuf = uploadIndirect(cache, indirectAttr);
        const entry = cache.storageMap.get(node);
        if (!entry || entry.buf !== indBuf) {
            cache.storageMap.set(node, { buf: indBuf, version: node.value.version });
        } else if (node.value.version !== entry.version) {
            entry.version = node.value.version;
        }
        return indBuf;
    }

    // If array is null, CPU memory was released via onUpload — return existing buffer.
    if (!arr) {
        const entry = cache.storageMap.get(node);
        if (!entry) {
            throw new Error('[gpucat] uploadStorage: node.array is null but buffer was never created');
        }
        return entry.buf;
    }

    // Fallback: check if this node's Uint32Array is shared with an
    // IndirectStorageBufferAttribute that was already uploaded (e.g. render ran first).
    if (arr instanceof Uint32Array) {
        const indirect = cache.dataToIndirect.get(arr);
        if (indirect) {
            const indBuf = uploadIndirect(cache, indirect);
            // Register / refresh in storageMap so the compiler can find it.
            let entry = cache.storageMap.get(node);
            if (!entry || entry.buf !== indBuf) {
                cache.storageMap.set(node, { buf: indBuf, version: node.value.version });
            } else if (node.value.version !== entry.version) {
                // version bump from initial seeding — already written by uploadIndirect
                entry.version = node.value.version;
            }
            return indBuf;
        }
    }

    const byteLength = alignTo4(arr.byteLength);
    const entry = cache.storageMap.get(node);

    // Create buffer if it doesn't exist or is too small.
    if (!entry || entry.buf.size < byteLength) {
        entry?.buf.destroy();
        // read_write storage nodes need COPY_SRC so the GPU can read back the
        // buffer contents after a compute dispatch (e.g. for readback or chained
        // compute passes). read-only nodes only need COPY_DST.
        const storageUsage = node.access === 'read_write'
            ? GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
            : GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
        const buf = cache.device.createBuffer({
            size: byteLength,
            usage: storageUsage,
        });
        if (!entry) cache.storageCount++;
        // Full upload on creation.
        cache.device.queue.writeBuffer(buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        cache.storageMap.set(node, { buf, version: node.value.version });

        // Call onUpload after initial upload.
        // Typically used to release CPU memory via `attr.array = null`.
        node.value.onUpload?.();

        return buf;
    }

    const { buf } = entry;

    if (node.value.updateRanges.length > 0) {
        // Partial upload — ranges are flat component indices; convert to bytes.
        const bytesPerComponent = arr.BYTES_PER_ELEMENT;
        for (const { start, count } of node.value.updateRanges) {
            const byteOffset = start * bytesPerComponent;
            const byteCount  = count * bytesPerComponent;
            cache.device.queue.writeBuffer(buf, byteOffset, arr.buffer as ArrayBuffer, arr.byteOffset + byteOffset, byteCount);
        }
        node.value.clearUpdateRanges();
        entry.version = node.value.version;
    } else if (node.value.version !== entry.version) {
        // Full re-upload.
        cache.device.queue.writeBuffer(buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        entry.version = node.value.version;
    }

    return buf;
}

/**
 * Get or create a GPUBuffer for an IndirectStorageBufferAttribute. Re-uploads when
 * indirect.version advances (full upload — buffer is ≤ 20 bytes).
 *
 * Always allocates with STORAGE | INDIRECT | COPY_DST.
 * The STORAGE flag allows a compute shader to write to the buffer directly.
 */
export function uploadIndirect(cache: BufferCache, indirect: IndirectStorageBufferAttribute): GPUBuffer {
    const entry = cache.indirectMap.get(indirect);
    const arr = indirect.array;

    if (!entry) {
        if (!arr) {
            throw new Error('[gpucat] uploadIndirect: indirect.array is null — cannot upload');
        }
        const buf = cache.device.createBuffer({
            size: arr.byteLength, // 16 or 20 — already u32-aligned
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
        });
        cache.device.queue.writeBuffer(buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        cache.indirectMap.set(indirect, { buf, version: indirect.version });

        // Register the data→indirect reverse-lookup so uploadStorage can detect
        // that a StorageNode backed by this Uint32Array should reuse this buffer.
        cache.dataToIndirect.set(arr as Uint32Array, indirect);

        return buf;
    }

    // Buffers may be written by the GPU — skip CPU re-upload unless version
    // was explicitly bumped (e.g. initial seed values).
    if (indirect.version !== entry.version) {
        if (!arr) {
            throw new Error('[gpucat] uploadIndirect: indirect.array is null — cannot re-upload');
        }
        cache.device.queue.writeBuffer(entry.buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        entry.version = indirect.version;
    }

    return entry.buf;
}

/**
 * Return the GPUBuffer for an already-uploaded IndirectStorageBufferAttribute, or undefined
 * if it has not been uploaded yet. Use this to pass the buffer as a bind-group
 * entry for a compute shader that writes the draw arguments.
 */
export function getIndirect(cache: BufferCache, indirect: IndirectStorageBufferAttribute): GPUBuffer | undefined {
    return cache.indirectMap.get(indirect)?.buf;
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
