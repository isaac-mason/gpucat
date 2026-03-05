/**
 * buffers.ts — GPUBuffer cache and upload helpers.
 *
 * `BufferCache` uses WeakMap-based identity to track GPUBuffers per CPU-side
 * data object. Setting needsUpdate=true on a BufferAttribute triggers a
 * writeBuffer on the next upload() call. Replacing the object entirely
 * also busts the cache (new WeakMap entry).
 */

import type { BufferAttribute, IndexAttribute } from '../scene/geometry.js';
import type { GpuTypedArray, StorageNode, WgslType } from '../nodes/nodes.js';
import type { IndirectStorageBufferAttribute } from '../scene/indirect-storage-buffer-attribute.js';
// ---------------------------------------------------------------------------
// BufferCache — vertex + index buffers
// ---------------------------------------------------------------------------

export class BufferCache {
    private readonly device: GPUDevice;
    private readonly vertexMap: WeakMap<BufferAttribute, GPUBuffer> = new WeakMap();
    private readonly indexMap: WeakMap<IndexAttribute, GPUBuffer> = new WeakMap();

    /** Plain-object-keyed buffers (instance matrices, material UBOs, camera, time). */
    private readonly rawMap: WeakMap<object, GPUBuffer> = new WeakMap();

    /** Storage node buffers — keyed by node identity, version-gated re-upload. */
    private readonly storageMap: WeakMap<StorageNode<WgslType>, { buf: GPUBuffer; version: number }> = new WeakMap();

    /** Indirect draw buffers — keyed by IndirectStorageBufferAttribute identity, version-gated re-upload. */
    private readonly indirectMap: WeakMap<IndirectStorageBufferAttribute, { buf: GPUBuffer; version: number }> = new WeakMap();

    /**
     * Reverse-lookup: maps an IndirectStorageBufferAttribute's Uint32Array to the
     * IndirectStorageBufferAttribute itself. Populated by uploadIndirect. Used by
     * uploadStorage to detect that a StorageNode backed by the same array should
     * reuse the indirect GPUBuffer.
     */
    private readonly dataToIndirect: WeakMap<Uint32Array, IndirectStorageBufferAttribute> = new WeakMap();

    constructor(device: GPUDevice) {
        this.device = device;
    }

    // -----------------------------------------------------------------------
    // Vertex / index buffers
    // -----------------------------------------------------------------------

    /**
     * Get or create a GPUBuffer for a vertex BufferAttribute.
     * Re-uploads if needsUpdate is true.
     */
    uploadVertex(attr: BufferAttribute): GPUBuffer {
        let buf = this.vertexMap.get(attr);
        const byteLength = attr.data.byteLength;

        if (!buf) {
            buf = this.device.createBuffer({
                size: alignTo4(byteLength),
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            this.vertexMap.set(attr, buf);
            this.device.queue.writeBuffer(buf, 0, attr.data.buffer as ArrayBuffer, attr.data.byteOffset, attr.data.byteLength);
            attr.needsUpdate = false;
        } else if (attr.needsUpdate) {
            this.device.queue.writeBuffer(buf, 0, attr.data.buffer as ArrayBuffer, attr.data.byteOffset, attr.data.byteLength);
            attr.needsUpdate = false;
        }

        return buf;
    }

    /**
     * Get or create a GPUBuffer for an IndexAttribute.
     * Re-uploads if needsUpdate is true.
     */
    uploadIndex(attr: IndexAttribute): GPUBuffer {
        let buf = this.indexMap.get(attr);
        const byteLength = attr.data.byteLength;

        if (!buf) {
            buf = this.device.createBuffer({
                size: alignTo4(byteLength),
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            });
            this.indexMap.set(attr, buf);
            this.device.queue.writeBuffer(buf, 0, attr.data.buffer as ArrayBuffer, attr.data.byteOffset, attr.data.byteLength);
            attr.needsUpdate = false;
        } else if (attr.needsUpdate) {
            this.device.queue.writeBuffer(buf, 0, attr.data.buffer as ArrayBuffer, attr.data.byteOffset, attr.data.byteLength);
            attr.needsUpdate = false;
        }

        return buf;
    }

    // -----------------------------------------------------------------------
    // Raw buffers — instance matrices, UBOs, etc.
    // -----------------------------------------------------------------------

    /**
     * Get or create a uniform/storage GPUBuffer identified by a JS object key.
     * Always writes `data` to the buffer (caller decides when to call this).
     */
    uploadRaw(key: object, data: GpuTypedArray, usage: GPUBufferUsageFlags): GPUBuffer {
        let buf = this.rawMap.get(key);
        const byteLength = alignTo4(data.byteLength);

        if (!buf || buf.size < byteLength) {
            buf?.destroy();
            buf = this.device.createBuffer({ size: byteLength, usage });
            this.rawMap.set(key, buf);
        }

        this.device.queue.writeBuffer(buf, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
        return buf;
    }

    /**
     * Get a previously created raw buffer, or undefined.
     * Does NOT upload — use uploadRaw for that.
     */
    getRaw(key: object): GPUBuffer | undefined {
        return this.rawMap.get(key);
    }

    /**
     * Ensure a raw buffer of at least `byteLength` bytes exists for `key`.
     * Creates it if absent; does NOT write data.
     */
    ensureRaw(key: object, byteLength: number, usage: GPUBufferUsageFlags): GPUBuffer {
        let buf = this.rawMap.get(key);
        const aligned = alignTo4(byteLength);

        if (!buf || buf.size < aligned) {
            buf?.destroy();
            buf = this.device.createBuffer({ size: aligned, usage });
            this.rawMap.set(key, buf);
        }

        return buf;
    }

    /**
     * Get or create a GPUBuffer for a StorageNode. Re-uploads when node.version advances
     * (full upload) or when node.updateRanges is non-empty (partial upload).
     * Automatically calls node.clearUpdateRanges() after a partial upload.
     *
     * Special case: if the node's data array is the same Uint32Array as an
     * IndirectStorageBufferAttribute (registered via uploadIndirect), the
     * IndirectStorageBufferAttribute's GPUBuffer is returned and registered in storageMap so the
     * compute shader binds to the same buffer that drawIndirect reads.
     */
    uploadStorage(node: StorageNode<WgslType>): GPUBuffer {
        if (node.data === null) {
            // Released node — GPU buffer must already exist; just return it.
            const entry = this.storageMap.get(node);
            if (!entry) throw new Error('[gpucat] BufferCache.uploadStorage: node has been released before its buffer was created.');
            return entry.buf;
        }

        // Primary check: if this StorageNode was created by IndirectStorageBufferAttribute.asStorageNode(),
        // use uploadIndirect to get (or create) the shared STORAGE|INDIRECT|COPY_DST buffer.
        // This must run before the dataToIndirect check because uploadIndirect populates
        // dataToIndirect — and compute dispatches happen before issueDraws, so dataToIndirect
        // would otherwise be empty on the first frame.
        if (node._indirectOwner) {
            const indBuf = this.uploadIndirect(node._indirectOwner);
            const entry = this.storageMap.get(node);
            if (!entry || entry.buf !== indBuf) {
                this.storageMap.set(node, { buf: indBuf, version: node.version });
            } else if (node.version !== entry.version) {
                entry.version = node.version;
            }
            return indBuf;
        }

        // Fallback: check if this node's Uint32Array is shared with an
        // IndirectStorageBufferAttribute that was already uploaded (e.g. render ran first).
        if (node.data instanceof Uint32Array) {
            const indirect = this.dataToIndirect.get(node.data as Uint32Array);
            if (indirect) {
                const indBuf = this.uploadIndirect(indirect);
                // Register / refresh in storageMap so the compiler can find it.
                let entry = this.storageMap.get(node);
                if (!entry || entry.buf !== indBuf) {
                    this.storageMap.set(node, { buf: indBuf, version: node.version });
                } else if (node.version !== entry.version) {
                    // version bump from initial seeding — already written by uploadIndirect
                    entry.version = node.version;
                }
                return indBuf;
            }
        }

        const byteLength = alignTo4(node.data.byteLength);
        const entry = this.storageMap.get(node);

        // Create buffer if it doesn't exist or is too small.
        if (!entry || entry.buf.size < byteLength) {
            entry?.buf.destroy();
            // read_write storage nodes need COPY_SRC so the GPU can read back the
            // buffer contents after a compute dispatch (e.g. for readback or chained
            // compute passes). read-only nodes only need COPY_DST.
            const storageUsage = node.access === 'read_write'
                ? GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
                : GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
            const buf = this.device.createBuffer({
                size: byteLength,
                usage: storageUsage,
            });
            // Full upload on creation.
            this.device.queue.writeBuffer(buf, 0, node.data.buffer as ArrayBuffer, node.data.byteOffset, node.data.byteLength);
            this.storageMap.set(node, { buf, version: node.version });
            return buf;
        }

        const { buf } = entry;

        if (node.updateRanges.length > 0) {
            // Partial upload — ranges are flat component indices; convert to bytes.
            const bytesPerComponent = node.data.BYTES_PER_ELEMENT;
            for (const { start, count } of node.updateRanges) {
                const byteOffset = start * bytesPerComponent;
                const byteCount  = count * bytesPerComponent;
                this.device.queue.writeBuffer(buf, byteOffset, node.data.buffer as ArrayBuffer, node.data.byteOffset + byteOffset, byteCount);
            }
            node.clearUpdateRanges();
            entry.version = node.version;
        } else if (node.version !== entry.version) {
            // Full re-upload.
            this.device.queue.writeBuffer(buf, 0, node.data.buffer as ArrayBuffer, node.data.byteOffset, node.data.byteLength);
            entry.version = node.version;
        }

        return buf;
    }

    /**
     * Get or create a GPUBuffer for an IndirectStorageBufferAttribute. Re-uploads when
     * indirect.version advances (full upload — buffer is ≤ 20 bytes).
     *
     * Always allocates with STORAGE | INDIRECT | COPY_DST, matching Three.js behaviour.
     * The STORAGE flag allows a compute shader to write to the buffer directly.
     */
    uploadIndirect(indirect: IndirectStorageBufferAttribute): GPUBuffer {
        const entry = this.indirectMap.get(indirect);

        if (!entry) {
            const buf = this.device.createBuffer({
                size: indirect.array.byteLength, // 16 or 20 — already u32-aligned
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
            });
            this.device.queue.writeBuffer(buf, 0, indirect.array.buffer as ArrayBuffer, indirect.array.byteOffset, indirect.array.byteLength);
            this.indirectMap.set(indirect, { buf, version: indirect.version });

            // Register the data→indirect reverse-lookup so uploadStorage can detect
            // that a StorageNode backed by this Uint32Array should reuse this buffer.
            this.dataToIndirect.set(indirect.array as Uint32Array, indirect);

            return buf;
        }

        // Buffers may be written by the GPU — skip CPU re-upload unless version
        // was explicitly bumped (e.g. initial seed values).
        if (indirect.version !== entry.version) {
            this.device.queue.writeBuffer(entry.buf, 0, indirect.array.buffer as ArrayBuffer, indirect.array.byteOffset, indirect.array.byteLength);
            entry.version = indirect.version;
        }

        return entry.buf;
    }

    /**
     * Return the GPUBuffer for an already-uploaded IndirectStorageBufferAttribute, or undefined
     * if it has not been uploaded yet. Use this to pass the buffer as a bind-group
     * entry for a compute shader that writes the draw arguments.
     */
    getIndirect(indirect: IndirectStorageBufferAttribute): GPUBuffer | undefined {
        return this.indirectMap.get(indirect)?.buf;
    }

    destroy(): void {
        // WeakMaps don't have iteration — buffers are GC'd with their keys.
        // Explicit destruction of raw buffers would require a separate registry;
        // for now we rely on device loss / page reload to clean up.
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function alignTo4(n: number): number {
    return Math.ceil(n / 4) * 4;
}
