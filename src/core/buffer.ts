import { isArrayDesc, isSizedArrayDesc, isStructDesc, itemSizeOf, typedArrayCtorOf, wgslSizeOf, type Any, type ArrayDesc, type SizedArrayDesc, type StructDesc, type StructSchema } from '../nodes/schema';

export type GpuTypedArray = Float32Array |
    Int32Array |
    Uint32Array |
    Int16Array |
    Uint16Array |
    Int8Array |
    Uint8Array;

export type UpdateRange = { start: number; count: number; };

/** Derive GPUVertexFormat from typed array type and itemSize */
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

/**
 * Allowed usages for a GpuBuffer. Multiple usages can be combined.
 */
export type BufferUsage = 'vertex' | 'index' | 'storage' | 'uniform' | 'indirect';

/**
 * Options for creating a GpuBuffer.
 */
export type GpuBufferOptions = {
    /** Initial data (TypedArray) or element count (number) */
    data?: GpuTypedArray | number;
    /** Allowed usages for this buffer. Defaults to ['vertex']. */
    usage?: BufferUsage | BufferUsage[];
    /** For vertex buffers: byte stride between elements (0 = tightly packed) */
    stride?: number;
    /** For vertex buffers: byte offset within each element */
    offset?: number;
    /** For vertex buffers: whether this is per-instance data */
    instanced?: boolean;
    /** TypedArray constructor when data is a count. Defaults to Float32Array. */
    arrayType?: new (length: number) => GpuTypedArray;
};

function normalizeUsage(usage?: BufferUsage | BufferUsage[]): Set<BufferUsage> {
    if (!usage) return new Set(['vertex']);
    if (Array.isArray(usage)) return new Set(usage);
    return new Set([usage]);
}

/**
 * Return the number of f32-sized slots occupied by one element of `schema`.
 * For primitive/vector/matrix types this is the same as `itemSizeOf`.
 * For struct types it is `wgslSizeOf(element) / 4` (byte size divided by 4).
 * For array types, returns the item size of the element type.
 */
function schemaItemSize(schema: Any): number {
    if (isArrayDesc(schema) || isSizedArrayDesc(schema)) {
        const element = (schema as ArrayDesc | SizedArrayDesc).element;
        return schemaItemSize(element);
    }
    if (isStructDesc(schema)) return wgslSizeOf(schema as StructDesc<StructSchema>) / 4;
    return itemSizeOf(schema);
}

/**
 * Unified buffer class for vertex attributes, storage buffers, index buffers, etc.
 *
 * Replaces BufferAttribute, StorageBufferAttribute, InstancedBufferAttribute,
 * StorageInstancedBufferAttribute, and IndirectStorageBufferAttribute.
 *
 * @example Vertex buffer
 * const positions = new GpuBuffer(d.vec3f, { data: positionArray, usage: 'vertex' });
 *
 * @example Storage buffer
 * const particles = new GpuBuffer(d.array(Particle), { data: 1000, usage: 'storage' });
 *
 * @example Dual-use buffer (storage + vertex, instanced)
 * const transforms = new GpuBuffer(d.mat4x4f, {
 *     data: 1000,
 *     usage: ['storage', 'vertex'],
 *     instanced: true,
 * });
 */
export class GpuBuffer<T extends Any = Any> {
    /** Type descriptor (d.vec3f, d.array(Particle), etc.) */
    readonly schema: T;

    /** Allowed usages */
    readonly usage: Set<BufferUsage>;

    /** CPU-side typed array. May be null after onUpload releases memory. */
    array: GpuTypedArray | null;

    /** Number of elements */
    readonly count: number;

    /** Components per element (e.g., 3 for vec3f) */
    readonly itemSize: number;

    /** Version for dirty tracking. Incremented when needsUpdate is set. */
    version: number = 0;

    /** Pending partial-upload ranges (flat component indices). */
    readonly updateRanges: UpdateRange[] = [];

    /** Callback after GPU upload (e.g., release CPU memory via `this.array = null`). */
    onUpload: (() => void) | null = null;

    /** Byte stride between elements. 0 = tightly packed. Used for interleaved vertex buffers. */
    readonly stride: number;

    /** Byte offset within each stride. Used for interleaved vertex buffers. */
    readonly offset: number;

    /** The GPUVertexFormat for vertex buffers (e.g., 'float32x3'). Derived or explicit. */
    readonly format: GPUVertexFormat | undefined;

    /** Whether this is per-instance data (for vertex buffers). */
    readonly instanced: boolean;

    /** Set to true after dispose() is called. */
    disposed: boolean = false;

    constructor(schema: T, options: GpuBufferOptions = {}) {
        this.schema = schema;
        this.usage = normalizeUsage(options.usage);
        this.stride = options.stride ?? 0;
        this.offset = options.offset ?? 0;
        this.instanced = options.instanced ?? false;

        // Derive itemSize from schema
        this.itemSize = schemaItemSize(schema);

        // Create or use provided array
        const ArrayCtor = options.arrayType ?? (isStructDesc(schema) ? Float32Array : typedArrayCtorOf(schema));
        if (typeof options.data === 'number') {
            this.array = new ArrayCtor(options.data * this.itemSize);
            this.count = options.data;
        } else if (options.data) {
            this.array = options.data;
            this.count = options.data.length / this.itemSize;
        } else {
            this.array = null;
            this.count = 0;
        }

        // Derive vertex format from array type + itemSize
        if (this.usage.has('vertex') && this.array) {
            this.format = deriveVertexFormat(this.array, this.itemSize);
        } else {
            this.format = undefined;
        }
    }

    /** Mark buffer as needing re-upload */
    set needsUpdate(_: true) {
        this.version++;
    }

    /** Register a dirty range for partial re-upload */
    addUpdateRange(start: number, count: number): void {
        this.updateRanges.push({ start, count });
    }

    /** Clear pending update ranges (called by renderer after upload) */
    clearUpdateRanges(): void {
        this.updateRanges.length = 0;
    }

    /**
     * Dispose of this buffer's CPU-side resources.
     * Sets array to null and marks the buffer as disposed.
     * GPU-side resources (GPUBuffer) are managed by BufferCache via WeakMap GC.
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.array = null;
        this.updateRanges.length = 0;
        this.onUpload = null;
    }
}
