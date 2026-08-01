import {
    isArrayDesc,
    isSizedArrayDesc,
    isStructDesc,
    itemSizeOf,
    typedArrayCtorOf,
    wgslSizeOf,
    u32 as u32Schema,
    type Any,
    type array,
    type Infer,
    type sizedArray,
    type StructDesc,
    type StructSchema,
    type TypedArrayFor,
} from '../schema/schema';
import { layoutStrideOf, packTo, packToView } from '../schema/pack';

/** determines how a buffer's lifecycle is managed */
export enum BufferLifecycle {
    /** Usages are tracked, GPU resources are disposed when usage count hits 0 */
    REF_COUNTED,
    /** User is responsible for calling buffer.dispose() */
    MANUAL,
}

export type GpuTypedArray = Float32Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array;

export type UpdateRange = { start: number; count: number };

/** Derive GPUVertexFormat from typed array type and itemSize */
export function deriveVertexFormat(array: GpuTypedArray, itemSize: number): GPUVertexFormat | undefined {
    if (array instanceof Float32Array) {
        switch (itemSize) {
            case 1:
                return 'float32';
            case 2:
                return 'float32x2';
            case 3:
                return 'float32x3';
            case 4:
                return 'float32x4';
        }
    } else if (array instanceof Int32Array) {
        switch (itemSize) {
            case 1:
                return 'sint32';
            case 2:
                return 'sint32x2';
            case 3:
                return 'sint32x3';
            case 4:
                return 'sint32x4';
        }
    } else if (array instanceof Uint32Array) {
        switch (itemSize) {
            case 1:
                return 'uint32';
            case 2:
                return 'uint32x2';
            case 3:
                return 'uint32x3';
            case 4:
                return 'uint32x4';
        }
    } else if (array instanceof Int16Array) {
        switch (itemSize) {
            case 2:
                return 'sint16x2';
            case 4:
                return 'sint16x4';
        }
    } else if (array instanceof Uint16Array) {
        switch (itemSize) {
            case 2:
                return 'uint16x2';
            case 4:
                return 'uint16x4';
        }
    } else if (array instanceof Int8Array) {
        switch (itemSize) {
            case 2:
                return 'sint8x2';
            case 4:
                return 'sint8x4';
        }
    } else if (array instanceof Uint8Array) {
        switch (itemSize) {
            case 2:
                return 'uint8x2';
            case 4:
                return 'uint8x4';
        }
    }
    return undefined;
}

/**
 * Allowed usages for a GpuBuffer. Multiple usages can be combined.
 */
export type BufferUsage = 'vertex' | 'index' | 'storage' | 'uniform' | 'indirect';

/**
 * Index buffer format - only uint16 or uint32 are valid.
 */
export type IndexFormat = 'uint16' | 'uint32';

/**
 * Get the index format for a buffer's array.
 * Returns undefined if the array is null or not an index buffer array type.
 */
export function getIndexFormat(array: GpuTypedArray | null): IndexFormat | undefined {
    if (array instanceof Uint16Array) return 'uint16';
    if (array instanceof Uint32Array) return 'uint32';
    return undefined;
}

/**
 * Options for creating a GpuBuffer.
 * Provide either `data` (existing TypedArray) or `count` (allocate new array), not both.
 */
export type GpuBufferOptions<T extends Any = Any> = {
    /** Initial data as a TypedArray. Mutually exclusive with `count`. */
    data?: TypedArrayFor<T>;
    /** Number of elements to allocate (creates array of `count * itemSize`). Mutually exclusive with `data`. */
    count?: number;
    /** Allowed usages for this buffer. Defaults to ['vertex']. */
    usage?: BufferUsage | BufferUsage[];
    /** How this buffer's lifecycle is managed. Defaults to MANUAL. */
    lifecycle?: BufferLifecycle;
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
        const element = (schema as array | sizedArray).element;
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
 * const particles = new GpuBuffer(d.array(Particle), { data: new Float32Array(1000 * stride), usage: 'storage' });
 *
 * @example Dual-use buffer (storage + vertex, instanced)
 * const transforms = new GpuBuffer(d.mat4x4f, {
 *     data: new Float32Array(1000 * 16),
 *     usage: ['storage', 'vertex'],
 *     instanced: true,
 * });
 */
export class GpuBuffer<T extends Any = Any> {
    readonly isGpuBuffer = true;
    /** Type descriptor (d.vec3f, d.array(Particle), etc.) */
    readonly schema: T;

    /** Allowed usages */
    readonly usage: Set<BufferUsage>;

    /** How this buffer's lifecycle is managed */
    readonly lifecycle: BufferLifecycle;

    /** Usage count for REF_COUNTED buffers. When this hits 0, GPU resources are disposed. */
    _usages: number = 0;

    /** CPU-side typed array. Can be set to null after onUpload releases memory. */
    array: TypedArrayFor<T> | null;

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

    /** The GPUVertexFormat for vertex buffers (e.g., 'float32x3'). Derived or explicit. */
    readonly format: GPUVertexFormat | undefined;

    /** Set to true after dispose() is called. */
    disposed: boolean = false;

    /** Renderer-set callback to destroy GPU resources when dispose() is called. */
    _onDispose: (() => void) | null = null;

    constructor(schema: T, options: GpuBufferOptions<T> = {}) {
        this.schema = schema;
        this.usage = normalizeUsage(options.usage);
        this.lifecycle = options.lifecycle ?? BufferLifecycle.MANUAL;

        // Derive itemSize from schema
        this.itemSize = schemaItemSize(schema);

        // Handle data vs count
        if (options.data && options.count !== undefined) {
            throw new Error('GpuBuffer: provide either `data` or `count`, not both');
        }

        if (options.data) {
            this.array = options.data;
            this.count = options.data.length / this.itemSize;
        } else if (options.count !== undefined) {
            const ArrayCtor = isStructDesc(schema) ? Float32Array : typedArrayCtorOf(schema);
            this.array = new ArrayCtor(options.count * this.itemSize) as TypedArrayFor<T>;
            this.count = options.count;
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

        // Validate index buffer array type
        if (this.usage.has('index') && this.array) {
            if (!(this.array instanceof Uint16Array) && !(this.array instanceof Uint32Array)) {
                throw new Error('GpuBuffer: index buffers must use Uint16Array or Uint32Array');
            }
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
     * Pack `value` into element `index`, encoding it per `schema` (std430, the storage-buffer layout)
     * into `this.array` and queuing a partial re-upload (`addUpdateRange` + version bump). The common
     * CPU-side write, parallel to {@link DataTexture.packAtIndex}: on WebGPU the renderer `writeBuffer`s
     * just this range; on WebGL2 (where a read-only storage buffer is reinterpreted as an rgba32uint
     * texture) it `texSubImage2D`s just the covering rows.
     *
     * `schema` is the ELEMENT type: `d.mat4x4f` for an `array<mat4x4f>` buffer, or the struct for
     * `array<Struct>`. Its std430 stride must match the buffer's element stride (byteLength / count),
     * else this throws rather than silently misaligning.
     */
    packAtIndex<D extends Any>(schema: D, index: number, value: Infer<D>): this {
        const arr = this.array;
        if (arr == null) {
            throw new Error('[GpuBuffer] packAtIndex(): buffer has no CPU `array` to write into (its data was released after upload).');
        }
        const strideBytes = layoutStrideOf(schema, 'std430');
        const elementStride = arr.byteLength / this.count;
        if (strideBytes !== elementStride) {
            throw new Error(
                `[GpuBuffer] packAtIndex(): schema std430 stride ${strideBytes}B does not match the buffer's element stride ` +
                    `${elementStride}B (${this.count} elements over ${arr.byteLength}B) — pass the element schema whose layout matches the buffer.`,
            );
        }
        return this.packAtByte(schema, index * strideBytes, value);
    }

    /**
     * Pack `value` (encoded per `schema`, std430) at a raw BYTE offset into `this.array`, the low-level
     * primitive under {@link packAtIndex} and the buffer analogue of {@link DataTexture.packAtTexel}.
     * Byte offsets are honest to `pack.ts`/std430 (which address in bytes); `byteOffset` must be a
     * multiple of the array's component size. Queues a partial upload of exactly this element's
     * components; a subsequent `needsUpdate = true` (full re-upload) supersedes queued ranges.
     */
    packAtByte<D extends Any>(schema: D, byteOffset: number, value: Infer<D>): this {
        const arr = this.array;
        if (arr == null) {
            throw new Error('[GpuBuffer] packAtByte(): buffer has no CPU `array` to write into (its data was released after upload).');
        }
        const bytesPerComponent = arr.BYTES_PER_ELEMENT;
        if (byteOffset % bytesPerComponent !== 0) {
            throw new Error(
                `[GpuBuffer] packAtByte(): byteOffset ${byteOffset} is not a multiple of the array's ${bytesPerComponent}-byte component size.`,
            );
        }
        const componentOffset = byteOffset / bytesPerComponent;
        const componentCount = layoutStrideOf(schema, 'std430') / bytesPerComponent;
        packTo(schema, arr, byteOffset, value, 'std430');
        this.addUpdateRange(componentOffset, componentCount);
        this.needsUpdate = true;
        return this;
    }

    /**
     * Bulk write: pack an entire array of `values` from element 0, encoding each per `schema` (std430)
     * at its element stride, then flag ONE full re-upload (`needsUpdate` + cleared partial ranges, a
     * whole-array write supersedes any queued `packAtIndex` ranges on both backends). `schema` is the
     * ELEMENT type; `values.length` must not exceed the buffer's element `count`.
     */
    pack<D extends Any>(schema: D, values: Infer<D>[]): this {
        const arr = this.array;
        if (arr == null) {
            throw new Error('[GpuBuffer] pack(): buffer has no CPU `array` to write into (its data was released after upload).');
        }
        if (values.length > this.count) {
            throw new Error(`[GpuBuffer] pack(): ${values.length} values exceed the buffer's ${this.count}-element capacity.`);
        }
        const strideBytes = layoutStrideOf(schema, 'std430');
        const elementStride = arr.byteLength / this.count;
        if (strideBytes !== elementStride) {
            throw new Error(
                `[GpuBuffer] pack(): schema std430 stride ${strideBytes}B does not match the buffer's element stride ` +
                    `${elementStride}B (${this.count} elements over ${arr.byteLength}B) — pass the element schema whose layout matches the buffer.`,
            );
        }
        const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
        for (let i = 0; i < values.length; i++) {
            packToView(schema, view, i * strideBytes, values[i], 'std430');
        }
        // One full re-upload: drop any queued partial ranges so both backends take the full path.
        this.clearUpdateRanges();
        this.needsUpdate = true;
        return this;
    }

    /**
     * Increment usage count.
     * For REF_COUNTED buffers: tracks usage and can "revive" a disposed buffer.
     * For MANUAL buffers: no-op (lifecycle is user-managed).
     * @returns this for chaining
     */
    increaseUsages(): this {
        if (this.lifecycle !== BufferLifecycle.REF_COUNTED) return this;
        if (this.disposed) {
            // Revive the buffer - it will be re-uploaded on next render
            this.disposed = false;
            this.version++;
        }
        this._usages++;
        return this;
    }

    /**
     * Decrement usage count.
     * For REF_COUNTED buffers: decrements count and disposes GPU resources when it hits 0.
     * For MANUAL buffers: no-op (lifecycle is user-managed).
     */
    decreaseUsages(): void {
        if (this.lifecycle !== BufferLifecycle.REF_COUNTED) return;
        if (this._usages <= 0) {
            throw new Error('decreaseUsages() called but _usages is already 0');
        }
        this._usages--;
        if (this._usages === 0) {
            this._disposeGpuResources();
        }
    }

    /**
     * Internal: dispose GPU resources without clearing CPU data.
     * Used by decreaseUsages() to allow revival.
     */
    private _disposeGpuResources(): void {
        if (this.disposed) return;
        this.disposed = true;
        this._onDispose?.();
        this._onDispose = null;
    }

    /**
     * Dispose of this buffer's resources.
     * For MANUAL buffers: destroys GPU buffer and cleans up CPU-side data.
     * For REF_COUNTED buffers: throws error (use decreaseUsages() instead).
     */
    dispose(): void {
        if (this.lifecycle === BufferLifecycle.REF_COUNTED) {
            throw new Error('dispose() is not valid for REF_COUNTED buffers. Use decreaseUsages() instead.');
        }
        if (this.disposed) return;
        this.disposed = true;
        this._onDispose?.();
        this._onDispose = null;
        this.array = null;
        this.updateRanges.length = 0;
        this.onUpload = null;
    }
}

/**
 * Create a vertex buffer with sensible defaults.
 * - usage: 'vertex'
 * - lifecycle: REF_COUNTED (vertex buffers are typically owned by a Geometry)
 *
 * @example
 * const positions = createVertexBuffer(d.vec3f, new Float32Array([...]));
 */
export function createVertexBuffer<T extends Any>(schema: T, data: TypedArrayFor<T>): GpuBuffer<T> {
    return new GpuBuffer(schema, {
        data,
        usage: 'vertex',
        lifecycle: BufferLifecycle.REF_COUNTED,
    });
}

/**
 * Create a storage buffer with sensible defaults.
 * - usage: 'storage'
 * - lifecycle: MANUAL (storage buffers are often managed directly by user code)
 *
 * @example
 * const particles = createStorageBuffer(d.array(Particle, 1000), new Float32Array(1000 * particleStride));
 */
export function createStorageBuffer<T extends Any>(schema: T, data: TypedArrayFor<T>): GpuBuffer<T> {
    return new GpuBuffer(schema, {
        data,
        usage: 'storage',
        lifecycle: BufferLifecycle.MANUAL,
    });
}

/**
 * Create a uniform buffer with sensible defaults.
 * - usage: 'uniform'
 * - lifecycle: REF_COUNTED
 *
 * @example
 * const uniforms = createUniformBuffer(MyUniforms, new Float32Array([...]));
 */
export function createUniformBuffer<T extends Any>(schema: T, data: TypedArrayFor<T>): GpuBuffer<T> {
    return new GpuBuffer(schema, {
        data,
        usage: 'uniform',
        lifecycle: BufferLifecycle.REF_COUNTED,
    });
}

/**
 * Create an indirect draw buffer with sensible defaults.
 * - usage: ['storage', 'indirect'] (can be written by compute, read by draw)
 * - lifecycle: REF_COUNTED
 *
 * @example
 * const indirectBuffer = createIndirectBuffer(DrawIndirectArgs, new Uint32Array([vertexCount, instanceCount, firstVertex, firstInstance]));
 */
export function createIndirectBuffer<T extends Any>(schema: T, data: TypedArrayFor<T>): GpuBuffer<T> {
    return new GpuBuffer(schema, {
        data,
        usage: ['storage', 'indirect'],
        lifecycle: BufferLifecycle.MANUAL,
    });
}

/**
 * Create an index buffer with sensible defaults.
 * - usage: 'index'
 * - lifecycle: REF_COUNTED (index buffers are typically owned by a Geometry)
 *
 * @example
 * const indices = createIndexBuffer(new Uint16Array([0, 1, 2, 2, 3, 0]));
 */
export function createIndexBuffer(data: Uint16Array | Uint32Array): GpuBuffer<Any> {
    return new GpuBuffer(u32Schema, {
        // Cast is safe: we're storing uint16/uint32 indices, itemSize=1 matches
        data: data as unknown as Uint32Array,
        usage: 'index',
        lifecycle: BufferLifecycle.REF_COUNTED,
    });
}
