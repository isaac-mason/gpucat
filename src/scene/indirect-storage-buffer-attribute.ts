/**
 * indirect-storage-buffer-attribute.ts
 *
 * Mirrors Three.js's class hierarchy exactly:
 *
 *   BufferAttribute
 *     └─ StorageBufferAttribute       (isStorageBufferAttribute, STORAGE GPU usage)
 *          └─ IndirectStorageBufferAttribute  (isIndirectStorageBufferAttribute,
 *                                              STORAGE | INDIRECT GPU usage)
 *
 * The CPU-side data lives on `.array` (Uint32Array), matching Three.js
 * BufferAttribute.array convention.
 *
 * Two variants:
 *   indexed = false → drawIndirect          4 × u32 (16 bytes) per draw, stride=4
 *   indexed = true  → drawIndexedIndirect   5 × u32 (20 bytes) per draw, stride=5
 *
 * Non-indexed field layout (slot offsets per draw):
 *   [draw*4 + 0] vertexCount
 *   [draw*4 + 1] instanceCount
 *   [draw*4 + 2] firstVertex
 *   [draw*4 + 3] firstInstance
 *
 * Indexed field layout (slot offsets per draw):
 *   [draw*5 + 0] indexCount
 *   [draw*5 + 1] instanceCount
 *   [draw*5 + 2] firstIndex
 *   [draw*5 + 3] baseVertex   (spec: i32, but always >= 0 in gpucat)
 *   [draw*5 + 4] firstInstance
 *
 * @example — single draw, non-indexed
 *   const indirect = new IndirectStorageBufferAttribute(false);
 *   indirect.array[0] = vertexCount;
 *   indirect.array[1] = instanceCount;
 *   indirect.needsUpdate = true;
 *
 * @example — multi-draw (2 draws), indexed
 *   const indirect = new IndirectStorageBufferAttribute(true, 2);
 *   indirect.array[0] = boxIdxCount;  indirect.array[1] = boxInstCount;
 *   indirect.array[2] = 0;            indirect.array[3] = 0;  indirect.array[4] = 0;
 *   indirect.array[5] = sphIdxCount;  indirect.array[6] = sphInstCount;
 *   indirect.array[7] = boxIdxCount;  indirect.array[8] = boxVertCount;  indirect.array[9] = sphFirstInst;
 *   indirect.needsUpdate = true;
 */

import { StorageBufferAttribute } from './geometry.js';
import { StorageNode } from '../nodes/nodes.js';
import type { StructDef, StructInstance, StructSchema } from '../nodes/nodes.js';

// ---------------------------------------------------------------------------
// IndirectStorageBufferAttribute
// ---------------------------------------------------------------------------

export class IndirectStorageBufferAttribute extends StorageBufferAttribute {
    readonly isIndirectStorageBufferAttribute: true = true;

    /** true → drawIndexedIndirect, false → drawIndirect. */
    readonly indexed: boolean;

    /** Number of packed draw structs in this buffer. */
    readonly drawCount: number;

    /** u32 elements per draw (4 for non-indexed, 5 for indexed). */
    readonly stride: number;

    /**
     * When true, the renderer allocates the GPUBuffer with
     * STORAGE | INDIRECT | COPY_DST so a compute shader can write to it.
     * Must be set before the first frame — changing it after the buffer has
     * been created has no effect.
     * Default: false.
     */
    readonly computeWritable: boolean;

    /** Lazily created flat StorageNode (only when computeWritable=true). */
    private _storageNode: StorageNode<'u32'> | null = null;

    /** Lazily created struct-typed StorageNode. */
    private _structStorageNode: StorageNode<string> | null = null;

    /**
     * Constructor:
     *   new IndirectStorageBufferAttribute(indexed)
     *     → single draw, array zero-initialised
     *
     *   new IndirectStorageBufferAttribute(indexed, drawCount: number, options?)
     *     → N draws, array zero-initialised
     *
     *   new IndirectStorageBufferAttribute(indexed, array: Uint32Array, options?)
     *     → array.length must equal drawCount * stride; drawCount inferred
     */
    constructor(
        indexed: boolean,
        arrayOrDrawCount?: Uint32Array | number,
        options?: { computeWritable?: boolean },
    ) {
        const stride = indexed ? 5 : 4;
        let array: Uint32Array;
        let drawCount: number;

        if (arrayOrDrawCount instanceof Uint32Array) {
            if (arrayOrDrawCount.length % stride !== 0) {
                throw new Error(
                    `[gpucat] IndirectStorageBufferAttribute: array.length (${arrayOrDrawCount.length}) must be a multiple of stride (${stride})`,
                );
            }
            array     = arrayOrDrawCount;
            drawCount = arrayOrDrawCount.length / stride;
        } else {
            drawCount = typeof arrayOrDrawCount === 'number' ? arrayOrDrawCount : 1;
            array     = new Uint32Array(drawCount * stride);
        }

        // itemSize=1 (each element is a single u32) — count = total u32 slots
        super(array, 1);

        this.indexed         = indexed;
        this.stride          = stride;
        this.drawCount       = drawCount;
        this.computeWritable = options?.computeWritable ?? false;
    }

    // -----------------------------------------------------------------------
    // Typed array accessor — convenience alias consistent with the old .data API
    // -----------------------------------------------------------------------

    /**
     * The raw Uint32Array backing this buffer.
     * Same as `.array` — provided so callers that used the old IndirectBuffer.data
     * API can migrate more easily. `.array` is the canonical name.
     */
    get data(): Uint32Array {
        return this.array as Uint32Array;
    }

    // -----------------------------------------------------------------------
    // asStorageNode — compute-shader integration
    // -----------------------------------------------------------------------

    /**
     * Return a StorageNode<'u32'> backed by this buffer's Uint32Array.
     *
     * Only valid when computeWritable=true. The returned node is cached — every
     * call returns the same instance. Pass it to a ComputeNode's storage array
     * so the compute shader can write the draw arguments (e.g. instanceCount).
     *
     * The renderer ensures the same GPUBuffer (with STORAGE | INDIRECT | COPY_DST)
     * is used for both the compute binding and the drawIndexedIndirect call.
     */
    asStorageNode(): StorageNode<'u32'>;

    /**
     * Return a StructInstance backed by this buffer's Uint32Array, typed as the
     * given StructDef.
     *
     * Only valid when computeWritable=true. The returned instance is cached — every
     * call returns the same underlying StorageNode (accessible as `instance.$node`).
     */
    asStorageNode<S extends StructSchema>(structDef: StructDef<S>): StructInstance<S>;

    asStorageNode<S extends StructSchema>(structDef?: StructDef<S>): StorageNode<'u32'> | StructInstance<S> {
        if (!this.computeWritable) {
            throw new Error('[gpucat] IndirectStorageBufferAttribute.asStorageNode() requires computeWritable=true');
        }

        if (structDef !== undefined) {
            if (!this._structStorageNode) {
                this._structStorageNode = new StorageNode<string>(
                    structDef.wgslType,
                    structDef.wgslType,
                    this.array as Uint32Array,
                    'read_write',
                );
                this._structStorageNode._indirectOwner = this;
            }
            return structDef.instantiate(this._structStorageNode as unknown as StorageNode<string> & { type: string });
        }

        if (!this._storageNode) {
            this._storageNode = new StorageNode<'u32'>(
                'u32',
                'array<u32>',
                this.array as Uint32Array,
                'read_write',
            );
            this._storageNode._indirectOwner = this;
        }
        return this._storageNode;
    }

    /**
     * Internal: return the cached StorageNode if it exists, without creating one.
     * Returns the struct-typed node if present, otherwise the flat array<u32> node.
     * Used by BufferCache to detect shared-buffer indirect nodes.
     */
    get _cachedStorageNode(): StorageNode<string> | StorageNode<'u32'> | null {
        return this._structStorageNode ?? this._storageNode;
    }
}
