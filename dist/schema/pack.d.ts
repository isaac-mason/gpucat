import { type Any, type Infer } from './schema';
/**
 * A GPU buffer memory-layout standard. gpucat targets exactly three, one per (address space ×
 * shading language) combination it actually uses:
 *
 * - `std430`       — WGSL storage-buffer layout (packs tightest).
 * - `wgsl-uniform` — WGSL uniform-buffer layout (like std430 but struct/array elements round to 16).
 * - `std140`       — GLSL uniform-buffer layout (like wgsl-uniform, but also pads EVERY matrix
 *                    column to a vec4 — including 2-row matrices).
 *
 * (WGSL uniform ≠ std140: they differ only in that mat2 column stride. There is no GLSL storage
 * layout because WebGL2 has no storage buffers, so the fourth combination doesn't exist.)
 *
 * The three collapse to two orthogonal rules — see {@link roundsElementsTo16} and
 * {@link matColumnsAlwaysVec4}.
 */
export type MemoryLayout = 'std430' | 'wgsl-uniform' | 'std140';
export type CompiledLayout<T = unknown> = {
    /** Size of one element in bytes */
    totalSize: number;
    /** Stride for array elements (size with tail padding) */
    stride: number;
    /** Generated write function */
    write: (view: DataView, offset: number, value: T) => void;
    /** Generated read function */
    read: (view: DataView, offset: number) => T;
};
type BufferSource = ArrayBuffer | ArrayBufferView;
/**
 * Pack a value into a new ArrayBuffer.
 *
 * @example
 * const buf = pack(Particle, { position: [1, 2, 3], health: 100 });
 * const f32 = new Float32Array(buf);
 */
export declare function pack<D extends Any>(schema: D, value: Infer<D>, memLayout?: MemoryLayout): ArrayBuffer;
/**
 * Pack an array of values into a new ArrayBuffer.
 *
 * @example
 * const buf = packArray(Particle, particles);
 * const f32 = new Float32Array(buf);
 */
export declare function packArray<D extends Any>(schema: D, items: Infer<D>[], memLayout?: MemoryLayout): ArrayBuffer;
/**
 * Pack a value into an existing buffer at a byte offset.
 *
 * @example
 * const buf = new ArrayBuffer(1024);
 * packTo(Particle, buf, 0, particle1);
 * packTo(Particle, buf, stride, particle2);
 */
export declare function packTo<D extends Any>(schema: D, dest: BufferSource, offset: number, value: Infer<D>, memLayout?: MemoryLayout): void;
/**
 * Unpack a value from a buffer.
 *
 * @example
 * const particle = unpack(Particle, buf);
 * const secondParticle = unpack(Particle, buf, stride);
 */
export declare function unpack<D extends Any>(schema: D, src: BufferSource, offset?: number, memLayout?: MemoryLayout): Infer<D>;
/**
 * Unpack an array of values from a buffer.
 *
 * @example
 * const particles = unpackArray(Particle, buf, 100);
 */
export declare function unpackArray<D extends Any>(schema: D, src: BufferSource, count: number, offset?: number, memLayout?: MemoryLayout): Infer<D>[];
/**
 * Get the byte size of a schema.
 *
 * @example
 * const size = layoutSizeOf(Particle); // 32
 */
export declare function layoutSizeOf(schema: Any, memLayout?: MemoryLayout): number;
/**
 * Get the stride (size with tail padding) for array elements.
 *
 * @example
 * const stride = layoutStrideOf(Particle); // 32
 */
export declare function layoutStrideOf(schema: Any, memLayout?: MemoryLayout): number;
/**
 * Get the byte alignment of a schema in the given memory layout.
 *
 * @example
 * const align = layoutAlignOf(vec3f, 'std140'); // 16
 */
export declare function layoutAlignOf(schema: Any, memLayout?: MemoryLayout): number;
/**
 * Get the compiled layout for a schema (for advanced use cases).
 */
export declare function getCompiledLayout<D extends Any>(schema: D, memLayout?: MemoryLayout): CompiledLayout<Infer<D>>;
/** Pack a value into a DataView. */
export declare function packToView<D extends Any>(schema: D, view: DataView, offset: number, value: Infer<D>, memLayout?: MemoryLayout): void;
/** Unpack a value from a DataView. */
export declare function unpackFromView<D extends Any>(schema: D, view: DataView, offset: number, memLayout?: MemoryLayout): Infer<D>;
export {};
