import { type Any, type Infer, type TypedArrayFor } from '../schema/schema';
/** determines how a buffer's lifecycle is managed */
export declare enum BufferLifecycle {
    /** Usages are tracked, GPU resources are disposed when usage count hits 0 */
    REF_COUNTED = 0,
    /** User is responsible for calling buffer.dispose() */
    MANUAL = 1
}
export type GpuTypedArray = Float32Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array;
export type UpdateRange = {
    start: number;
    count: number;
};
/** Derive GPUVertexFormat from typed array type and itemSize */
export declare function deriveVertexFormat(array: GpuTypedArray, itemSize: number): GPUVertexFormat | undefined;
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
export declare function getIndexFormat(array: GpuTypedArray | null): IndexFormat | undefined;
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
export declare class GpuBuffer<T extends Any = Any> {
    readonly isGpuBuffer = true;
    /** Type descriptor (d.vec3f, d.array(Particle), etc.) */
    readonly schema: T;
    /** Allowed usages */
    readonly usage: Set<BufferUsage>;
    /** How this buffer's lifecycle is managed */
    readonly lifecycle: BufferLifecycle;
    /** Usage count for REF_COUNTED buffers. When this hits 0, GPU resources are disposed. */
    _usages: number;
    /** CPU-side typed array. Can be set to null after onUpload releases memory. */
    array: TypedArrayFor<T> | null;
    /** Number of elements */
    readonly count: number;
    /** Components per element (e.g., 3 for vec3f) */
    readonly itemSize: number;
    /** Version for dirty tracking. Incremented when needsUpdate is set. */
    version: number;
    /** Pending partial-upload ranges (flat component indices). */
    readonly updateRanges: UpdateRange[];
    /** Callback after GPU upload (e.g., release CPU memory via `this.array = null`). */
    onUpload: (() => void) | null;
    /** The GPUVertexFormat for vertex buffers (e.g., 'float32x3'). Derived or explicit. */
    readonly format: GPUVertexFormat | undefined;
    /** Set to true after dispose() is called. */
    disposed: boolean;
    /** Renderer-set callback to destroy GPU resources when dispose() is called. */
    _onDispose: (() => void) | null;
    constructor(schema: T, options?: GpuBufferOptions<T>);
    /** Mark buffer as needing re-upload */
    set needsUpdate(_: true);
    /** Register a dirty range for partial re-upload */
    addUpdateRange(start: number, count: number): void;
    /** Clear pending update ranges (called by renderer after upload) */
    clearUpdateRanges(): void;
    /**
     * Pack `value` into element `index`, encoding it per `schema` (std430 — the storage-buffer layout)
     * into `this.array` and queuing a partial re-upload (`addUpdateRange` + version bump). The common
     * CPU-side write, parallel to {@link DataTexture.packAtIndex}: on WebGPU the renderer `writeBuffer`s
     * just this range; on WebGL2 (where a read-only storage buffer is reinterpreted as an rgba32uint
     * texture) it `texSubImage2D`s just the covering rows.
     *
     * `schema` is the ELEMENT type — `d.mat4x4f` for an `array<mat4x4f>` buffer, or the struct for
     * `array<Struct>`. Its std430 stride must match the buffer's element stride (byteLength / count),
     * else this throws rather than silently misaligning.
     */
    packAtIndex<D extends Any>(schema: D, index: number, value: Infer<D>): this;
    /**
     * Pack `value` (encoded per `schema`, std430) at a raw BYTE offset into `this.array` — the low-level
     * primitive under {@link packAtIndex} and the buffer analogue of {@link DataTexture.packAtTexel}.
     * Byte offsets are honest to `pack.ts`/std430 (which address in bytes); `byteOffset` must be a
     * multiple of the array's component size. Queues a partial upload of exactly this element's
     * components; a subsequent `needsUpdate = true` (full re-upload) supersedes queued ranges.
     */
    packAtByte<D extends Any>(schema: D, byteOffset: number, value: Infer<D>): this;
    /**
     * Bulk write: pack an entire array of `values` from element 0, encoding each per `schema` (std430)
     * at its element stride, then flag ONE full re-upload (`needsUpdate` + cleared partial ranges — a
     * whole-array write supersedes any queued `packAtIndex` ranges on both backends). `schema` is the
     * ELEMENT type; `values.length` must not exceed the buffer's element `count`.
     */
    pack<D extends Any>(schema: D, values: Infer<D>[]): this;
    /**
     * Increment usage count.
     * For REF_COUNTED buffers: tracks usage and can "revive" a disposed buffer.
     * For MANUAL buffers: no-op (lifecycle is user-managed).
     * @returns this for chaining
     */
    increaseUsages(): this;
    /**
     * Decrement usage count.
     * For REF_COUNTED buffers: decrements count and disposes GPU resources when it hits 0.
     * For MANUAL buffers: no-op (lifecycle is user-managed).
     */
    decreaseUsages(): void;
    /**
     * Internal: dispose GPU resources without clearing CPU data.
     * Used by decreaseUsages() to allow revival.
     */
    private _disposeGpuResources;
    /**
     * Dispose of this buffer's resources.
     * For MANUAL buffers: destroys GPU buffer and cleans up CPU-side data.
     * For REF_COUNTED buffers: throws error (use decreaseUsages() instead).
     */
    dispose(): void;
}
/**
 * Create a vertex buffer with sensible defaults.
 * - usage: 'vertex'
 * - lifecycle: REF_COUNTED (vertex buffers are typically owned by a Geometry)
 *
 * @example
 * const positions = createVertexBuffer(d.vec3f, new Float32Array([...]));
 */
export declare function createVertexBuffer<T extends Any>(schema: T, data: TypedArrayFor<T>): GpuBuffer<T>;
/**
 * Create a storage buffer with sensible defaults.
 * - usage: 'storage'
 * - lifecycle: MANUAL (storage buffers are often managed directly by user code)
 *
 * @example
 * const particles = createStorageBuffer(d.array(Particle, 1000), new Float32Array(1000 * particleStride));
 */
export declare function createStorageBuffer<T extends Any>(schema: T, data: TypedArrayFor<T>): GpuBuffer<T>;
/**
 * Create a uniform buffer with sensible defaults.
 * - usage: 'uniform'
 * - lifecycle: REF_COUNTED
 *
 * @example
 * const uniforms = createUniformBuffer(MyUniforms, new Float32Array([...]));
 */
export declare function createUniformBuffer<T extends Any>(schema: T, data: TypedArrayFor<T>): GpuBuffer<T>;
/**
 * Create an indirect draw buffer with sensible defaults.
 * - usage: ['storage', 'indirect'] (can be written by compute, read by draw)
 * - lifecycle: REF_COUNTED
 *
 * @example
 * const indirectBuffer = createIndirectBuffer(DrawIndirectArgs, new Uint32Array([vertexCount, instanceCount, firstVertex, firstInstance]));
 */
export declare function createIndirectBuffer<T extends Any>(schema: T, data: TypedArrayFor<T>): GpuBuffer<T>;
/**
 * Create an index buffer with sensible defaults.
 * - usage: 'index'
 * - lifecycle: REF_COUNTED (index buffers are typically owned by a Geometry)
 *
 * @example
 * const indices = createIndexBuffer(new Uint16Array([0, 1, 2, 2, 3, 0]));
 */
export declare function createIndexBuffer(data: Uint16Array | Uint32Array): GpuBuffer<Any>;
