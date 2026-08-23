import { type Any, type Infer, type StructDesc } from './schema';
/**
 * A GPU buffer memory-layout standard. gpucat targets:
 *
 * - `std430`: WGSL layout (packs tightest). Used for BOTH storage and uniform on the WebGPU backend —
 *              a struct has ONE layout regardless of address space (see the hardening plan). Uniform
 *              validity (a member after a struct/array on a 16-byte boundary, etc.) is the author's
 *              responsibility via `d.align`, enforced by the layout validator; the synthetic UBO block
 *              wrapper the WGSL emitter generates applies the block-level 16-alignment itself.
 * - `wgsl-uniform`: alias of `std430` (retained as a name for the WGSL uniform data path). It no longer
 *              auto-rounds struct/array elements to 16 — that would give a shared struct two divergent
 *              layouts; the author pins alignment with `d.align` instead.
 * - `std140`: GLSL uniform-buffer layout (WebGL). Rounds struct/array elements to 16 (inherent to
 *              std140) AND pads every matrix column to a vec4, including 2-row matrices.
 *
 * There is no GLSL storage layout because WebGL2 has no storage buffers.
 *
 * See {@link roundsElementsTo16} and {@link matColumnsAlwaysVec4}.
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
/** A struct's per-field byte offsets + its texel stride (for texel-addressed struct storage). */
export type StructFieldLayout = {
    fields: {
        name: string;
        type: Any;
        byteOffset: number;
        byteSize: number;
    }[];
    /** Struct stride in bytes (size with tail padding). */
    strideBytes: number;
    /** Struct stride rounded up to whole 16-byte texels (`ceil(strideBytes / 16)`). */
    texelStride: number;
};
/**
 * Compute a flat struct's per-field byte offsets + texel stride in the given layout. Mirrors the
 * offset walk in {@link emitStructWrites} (align each field, record offset, advance by size). Used
 * by the structured-texture `load`/`store` accessor to place fields in `rgba32uint` texels.
 */
export declare function structFieldLayout(schema: StructDesc, memLayout?: MemoryLayout): StructFieldLayout;
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
