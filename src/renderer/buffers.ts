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
     */
    uploadStorage(node: StorageNode<WgslType>): GPUBuffer {
        if (node.data === null) {
            // Released node — GPU buffer must already exist; just return it.
            const entry = this.storageMap.get(node);
            if (!entry) throw new Error('[gpucat] BufferCache.uploadStorage: node has been released before its buffer was created.');
            return entry.buf;
        }

        const byteLength = alignTo4(node.data.byteLength);
        const entry = this.storageMap.get(node);

        // Create buffer if it doesn't exist or is too small.
        if (!entry || entry.buf.size < byteLength) {
            entry?.buf.destroy();
            const buf = this.device.createBuffer({
                size: byteLength,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
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
