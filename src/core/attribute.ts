import { StorageNode } from '../nodes/nodes';

export type GpuTypedArray = Float32Array |
    Int32Array |
    Uint32Array |
    Int16Array |
    Uint16Array |
    Int8Array |
    Uint8Array;

export type UpdateRange = { start: number; count: number; };

/**
 * Base class for buffer attributes. Stores data for vertex attributes, storage buffers, etc.
 */
export class BufferAttribute {
    readonly isBufferAttribute: true = true;

    /** cpu-side typed array. May be null after onUpload releases memory. */
    array: GpuTypedArray | null;

    /** number of data-type components per element (e.g., 3 for vec3). */
    readonly itemSize: number;

    /** number of elements (array.length / itemSize). */
    readonly count: number;

    /** version, compared against renderer's cached version for dirty checking. incremented when needsUpdate is set */
    version: number = 0;

    /** pending partial-upload ranges (flat component indices). */
    readonly updateRanges: UpdateRange[] = [];

    /**
     * Callback executed after the renderer uploads the data to the GPU.
     * Can be used to release CPU memory via `this.array = null`.
     */
    onUpload: (() => void) | null = null;

    /** byte stride between elements. 0 = tightly packed. used for interleaved vertex buffers */
    stride: number = 0;

    /** byte offset within each stride. used for interleaved vertex buffers */
    offset: number = 0;

    /** the GPUVertexFormat for vertex buffers (e.g., 'float32x3'). set explicitly or derived from array type + itemSize */
    format: GPUVertexFormat | undefined;

    constructor(array: GpuTypedArray, itemSize: number, format?: GPUVertexFormat) {
        this.array = array;
        this.itemSize = itemSize;
        this.count = array.length / itemSize;
        this.format = format ?? deriveVertexFormat(array, itemSize);
    }

    set needsUpdate(_: true) {
        this.version++;
    }

    /** registers a dirty range for partial re-upload */
    addUpdateRange(start: number, count: number): void {
        this.updateRanges.push({ start, count });
    }

    /** clears all pending update ranges. called by renderer after upload */
    clearUpdateRanges(): void {
        this.updateRanges.length = 0;
    }
}

/**
 * Buffer attribute for storage buffers.
 */
export class StorageBufferAttribute extends BufferAttribute {
    readonly isStorageBufferAttribute: true = true;

    /**
     * @param array  A typed array, OR a count (number of elements).
     * @param itemSize  Components per element (e.g., 4 for vec4f).
     * @param typeClass  TypedArray constructor if `array` is a count.
     */
    constructor(
        array: GpuTypedArray | number,
        itemSize: number,
        typeClass: new (length: number) => GpuTypedArray = Float32Array
    ) {
        const arr = typeof array === 'number'
            ? new typeClass(array * itemSize)
            : array;
        super(arr, itemSize);
    }
}

export class InstancedBufferAttribute extends BufferAttribute {
    readonly isInstancedBufferAttribute: true = true;

    /**
     * Defines how often a value of this buffer attribute should be repeated.
     * A value of 1 means each value is used for a single instance.
     * A value of 2 means each value is used for two consecutive instances, etc.
     */
    readonly meshPerAttribute: number;

    constructor(array: GpuTypedArray, itemSize: number, meshPerAttribute = 1) {
        super(array, itemSize);
        this.meshPerAttribute = meshPerAttribute;
    }
}

export class StorageInstancedBufferAttribute extends InstancedBufferAttribute {
    readonly isStorageInstancedBufferAttribute: true = true;
    readonly isStorageBufferAttribute: true = true;

    /**
     * @param count number of instances, OR a pre-allocated TypedArray.
     * @param itemSize number of components per instance (ignored if count is a TypedArray).
     * @param typeClass typed array constructor (default Float32Array).
     */
    constructor(
        count: number | GpuTypedArray,
        itemSize: number,
        typeClass: new (length: number) => GpuTypedArray = Float32Array
    ) {
        const array = ArrayBuffer.isView(count)
            ? count as GpuTypedArray
            : new typeClass(count * itemSize);
        super(array, itemSize);
    }
}

export class IndirectStorageBufferAttribute extends StorageBufferAttribute {
    readonly isIndirectStorageBufferAttribute: true = true;

    /** true → drawIndexedIndirect, false → drawIndirect. */
    readonly indexed: boolean;

    /** Number of packed draw structs in this buffer. */
    readonly drawCount: number;

    /** u32 elements per draw (4 for non-indexed, 5 for indexed). */
    readonly indirectStride: number;

    /** Lazily created flat StorageNode. */
    private _storageNode: StorageNode<'u32'> | null = null;

    /** Lazily created struct-typed StorageNode. */
    private _structStorageNode: StorageNode<string> | null = null;

    /**
     * Constructor:
     *   new IndirectStorageBufferAttribute(indexed)
     *     → single draw, array zero-initialised
     *
     *   new IndirectStorageBufferAttribute(indexed, drawCount: number)
     *     → N draws, array zero-initialised
     *
     *   new IndirectStorageBufferAttribute(indexed, array: Uint32Array)
     *     → array.length must equal drawCount * stride; drawCount inferred
     */
    constructor(
        indexed: boolean,
        arrayOrDrawCount?: Uint32Array | number
    ) {
        const indirectStride = indexed ? 5 : 4;
        let array: Uint32Array;
        let drawCount: number;

        if (arrayOrDrawCount instanceof Uint32Array) {
            if (arrayOrDrawCount.length % indirectStride !== 0) {
                throw new Error(
                    `[gpucat] IndirectStorageBufferAttribute: array.length (${arrayOrDrawCount.length}) must be a multiple of stride (${indirectStride})`
                );
            }
            array = arrayOrDrawCount;
            drawCount = arrayOrDrawCount.length / indirectStride;
        } else {
            drawCount = typeof arrayOrDrawCount === 'number' ? arrayOrDrawCount : 1;
            array = new Uint32Array(drawCount * indirectStride);
        }

        // itemSize=1 (each element is a single u32) — count = total u32 slots
        super(array, 1);

        this.indexed = indexed;
        this.indirectStride = indirectStride;
        this.drawCount = drawCount;
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

export class IndexAttribute {
    readonly isIndexAttribute: true = true;

    array: Uint16Array | Uint32Array;
    format: 'uint16' | 'uint32';
    version: number = 0;

    constructor(array: Uint16Array | Uint32Array) {
        this.array = array;
        this.format = array instanceof Uint16Array ? 'uint16' : 'uint32';
    }

    set needsUpdate(_: true) {
        this.version++;
    }
}

/** derive GPUVertexFormat from typed array type and itemSize */
export function deriveVertexFormat(array: GpuTypedArray, itemSize: number): GPUVertexFormat | undefined {
    if (array instanceof Float32Array) {
        switch (itemSize) {
            case 1: return 'float32';
            case 2: return 'float32x2';
            case 3: return 'float32x3';
            case 4: return 'float32x4';
        }
    } else if (array instanceof Int32Array) {
        switch (itemSize) {
            case 1: return 'sint32';
            case 2: return 'sint32x2';
            case 3: return 'sint32x3';
            case 4: return 'sint32x4';
        }
    } else if (array instanceof Uint32Array) {
        switch (itemSize) {
            case 1: return 'uint32';
            case 2: return 'uint32x2';
            case 3: return 'uint32x3';
            case 4: return 'uint32x4';
        }
    } else if (array instanceof Int16Array) {
        switch (itemSize) {
            case 2: return 'sint16x2';
            case 4: return 'sint16x4';
        }
    } else if (array instanceof Uint16Array) {
        switch (itemSize) {
            case 2: return 'uint16x2';
            case 4: return 'uint16x4';
        }
    } else if (array instanceof Int8Array) {
        switch (itemSize) {
            case 2: return 'sint8x2';
            case 4: return 'sint8x4';
        }
    } else if (array instanceof Uint8Array) {
        switch (itemSize) {
            case 2: return 'uint8x2';
            case 4: return 'uint8x4';
        }
    }
    return undefined;
}

