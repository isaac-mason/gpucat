import {
    type Any,
    type Infer,
    type StructDesc,
    type sizedArray,
    isStructDesc,
    isSizedArrayDesc,
    isArrayDesc,
    isAtomicDesc,
    isBitsDesc,
    isPackedDesc,
} from './schema';

/**
 * A GPU buffer memory-layout standard. gpucat targets exactly three, one per (address space ×
 * shading language) combination it actually uses:
 *
 * - `std430`: WGSL storage-buffer layout (packs tightest).
 * - `wgsl-uniform`: WGSL uniform-buffer layout (like std430 but struct/array elements round to 16).
 * - `std140`: GLSL uniform-buffer layout (like wgsl-uniform, but also pads EVERY matrix
 *                    column to a vec4, including 2-row matrices).
 *
 * (WGSL uniform ≠ std140: they differ only in that mat2 column stride. There is no GLSL storage
 * layout because WebGL2 has no storage buffers, so the fourth combination doesn't exist.)
 *
 * The three collapse to two orthogonal rules; see {@link roundsElementsTo16} and
 * {@link matColumnsAlwaysVec4}.
 */
export type MemoryLayout = 'std430' | 'wgsl-uniform' | 'std140';

/**
 * Whether structs and array elements round their stride up to 16 bytes. True for both uniform
 * layouts (`wgsl-uniform`, `std140`); false for `std430`, which packs tightest.
 */
function roundsElementsTo16(memLayout: MemoryLayout): boolean {
    return memLayout !== 'std430';
}

/**
 * Whether every matrix column is padded to a vec4 (16-byte stride), even for 2-row matrices. True
 * only for GLSL `std140`; WGSL layouts keep a 2-row matrix's columns at vec2 (8-byte) stride. This
 * is the sole layout difference between `wgsl-uniform` and `std140`.
 */
function matColumnsAlwaysVec4(memLayout: MemoryLayout): boolean {
    return memLayout === 'std140';
}

/**
 * Column stride (bytes) for an f32 matrix with the given row count in the given memory layout.
 */
function matColumnStrideF32(rows: number, memLayout: MemoryLayout): number {
    if (matColumnsAlwaysVec4(memLayout)) return 16;
    return rows === 2 ? 8 : 16;
}

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

type LayoutContext = {
    memLayout: MemoryLayout;
    offset: number;
    lines: string[];
};

// Layout Cache

const layoutCache = new WeakMap<Any, Map<MemoryLayout, CompiledLayout>>();

function getLayout<T>(schema: Any, memLayout: MemoryLayout): CompiledLayout<T> {
    let byMemoryLayout = layoutCache.get(schema);
    if (!byMemoryLayout) {
        byMemoryLayout = new Map();
        layoutCache.set(schema, byMemoryLayout);
    }

    let layout = byMemoryLayout.get(memLayout);
    if (!layout) {
        layout = compileLayout(schema, memLayout);
        byMemoryLayout.set(memLayout, layout);
    }

    return layout as CompiledLayout<T>;
}

type BufferSource = ArrayBuffer | ArrayBufferView;

function toDataView(src: BufferSource): DataView {
    if (src instanceof ArrayBuffer) {
        return new DataView(src);
    }
    return new DataView(src.buffer, src.byteOffset, src.byteLength);
}

/**
 * Pack a value into a new ArrayBuffer.
 *
 * @example
 * const buf = pack(Particle, { position: [1, 2, 3], health: 100 });
 * const f32 = new Float32Array(buf);
 */
export function pack<D extends Any>(
    schema: D,
    value: Infer<D>,
    memLayout: MemoryLayout = 'std430',
): ArrayBuffer {
    const layout = getLayout<Infer<D>>(schema, memLayout);
    const buf = new ArrayBuffer(layout.totalSize);
    layout.write(new DataView(buf), 0, value);
    return buf;
}

/**
 * Pack an array of values into a new ArrayBuffer.
 *
 * @example
 * const buf = packArray(Particle, particles);
 * const f32 = new Float32Array(buf);
 */
export function packArray<D extends Any>(
    schema: D,
    items: Infer<D>[],
    memLayout: MemoryLayout = 'std430',
): ArrayBuffer {
    const layout = getLayout<Infer<D>>(schema, memLayout);
    const buf = new ArrayBuffer(layout.stride * items.length);
    const view = new DataView(buf);
    for (let i = 0; i < items.length; i++) {
        layout.write(view, i * layout.stride, items[i]);
    }
    return buf;
}

/**
 * Pack a value into an existing buffer at a byte offset.
 *
 * @example
 * const buf = new ArrayBuffer(1024);
 * packTo(Particle, buf, 0, particle1);
 * packTo(Particle, buf, stride, particle2);
 */
export function packTo<D extends Any>(
    schema: D,
    dest: BufferSource,
    offset: number,
    value: Infer<D>,
    memLayout: MemoryLayout = 'std430',
): void {
    const layout = getLayout<Infer<D>>(schema, memLayout);
    layout.write(toDataView(dest), offset, value);
}

/**
 * Unpack a value from a buffer.
 *
 * @example
 * const particle = unpack(Particle, buf);
 * const secondParticle = unpack(Particle, buf, stride);
 */
export function unpack<D extends Any>(
    schema: D,
    src: BufferSource,
    offset: number = 0,
    memLayout: MemoryLayout = 'std430',
): Infer<D> {
    const layout = getLayout<Infer<D>>(schema, memLayout);
    return layout.read(toDataView(src), offset);
}

/**
 * Unpack an array of values from a buffer.
 *
 * @example
 * const particles = unpackArray(Particle, buf, 100);
 */
export function unpackArray<D extends Any>(
    schema: D,
    src: BufferSource,
    count: number,
    offset: number = 0,
    memLayout: MemoryLayout = 'std430',
): Infer<D>[] {
    const layout = getLayout<Infer<D>>(schema, memLayout);
    const view = toDataView(src);
    const items: Infer<D>[] = new Array(count);
    for (let i = 0; i < count; i++) {
        items[i] = layout.read(view, offset + i * layout.stride);
    }
    return items;
}

/**
 * Get the byte size of a schema.
 *
 * @example
 * const size = layoutSizeOf(Particle); // 32
 */
export function layoutSizeOf(schema: Any, memLayout: MemoryLayout = 'std430'): number {
    return getLayout(schema, memLayout).totalSize;
}

/**
 * Get the stride (size with tail padding) for array elements.
 *
 * @example
 * const stride = layoutStrideOf(Particle); // 32
 */
export function layoutStrideOf(schema: Any, memLayout: MemoryLayout = 'std430'): number {
    return getLayout(schema, memLayout).stride;
}

/** A struct's per-field byte offsets + its texel stride (for texel-addressed struct storage). */
export type StructFieldLayout = {
    fields: { name: string; type: Any; byteOffset: number; byteSize: number }[];
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
export function structFieldLayout(schema: StructDesc, memLayout: MemoryLayout = 'std430'): StructFieldLayout {
    const fields: StructFieldLayout['fields'] = [];
    let offset = 0;
    for (const [name, fieldSchema] of Object.entries(schema.fields)) {
        offset = roundUp(offset, alignOf(fieldSchema, memLayout));
        fields.push({ name, type: fieldSchema, byteOffset: offset, byteSize: sizeOf(fieldSchema, memLayout) });
        offset += sizeOf(fieldSchema, memLayout);
    }
    const strideBytes = layoutStrideOf(schema, memLayout);
    return { fields, strideBytes, texelStride: Math.ceil(strideBytes / 16) };
}

/**
 * Get the byte alignment of a schema in the given memory layout.
 *
 * @example
 * const align = layoutAlignOf(vec3f, 'std140'); // 16
 */
export function layoutAlignOf(schema: Any, memLayout: MemoryLayout = 'std430'): number {
    return alignOf(schema, memLayout);
}

/**
 * Get the compiled layout for a schema (for advanced use cases).
 */
export function getCompiledLayout<D extends Any>(
    schema: D,
    memLayout: MemoryLayout = 'std430',
): CompiledLayout<Infer<D>> {
    return getLayout<Infer<D>>(schema, memLayout);
}

// Internal: DataView-based pack/unpack (used by bindings.ts)

/** Pack a value into a DataView. */
export function packToView<D extends Any>(
    schema: D,
    view: DataView,
    offset: number,
    value: Infer<D>,
    memLayout: MemoryLayout = 'std430',
): void {
    const layout = getLayout<Infer<D>>(schema, memLayout);
    layout.write(view, offset, value);
}

/** Unpack a value from a DataView. */
export function unpackFromView<D extends Any>(
    schema: D,
    view: DataView,
    offset: number,
    memLayout: MemoryLayout = 'std430',
): Infer<D> {
    const layout = getLayout<Infer<D>>(schema, memLayout);
    return layout.read(view, offset);
}

// Alignment and Size (address-space aware)

function roundUp(n: number, align: number): number {
    return Math.ceil(n / align) * align;
}

/**
 * Get alignment for a schema in the given memory layout.
 * Uniform layouts have stricter rules: structs and arrays round up to 16.
 */
function alignOf(schema: Any, memLayout: MemoryLayout): number {
    // For uniform layouts (wgsl-uniform / std140), structs and array elements need roundUp(16, align).
    if (roundsElementsTo16(memLayout)) {
        if (isStructDesc(schema)) {
            return roundUp(storageAlignOf(schema), 16);
        }
        if (isSizedArrayDesc(schema) || isArrayDesc(schema)) {
            return roundUp(alignOf(schema.element, memLayout), 16);
        }
    }
    // std140: all f32 matrices align to 16 (columns padded to vec4), including 2-row matrices.
    // (f16 matrices aren't part of GLSL std140; they keep their std430 alignment.)
    if (matColumnsAlwaysVec4(memLayout) && !isAtomicDesc(schema)) {
        const t = schema.wgslType as string | undefined;
        if (typeof t === 'string' && /^mat\dx\df$/.test(t)) return 16;
    }
    return storageAlignOf(schema);
}

/**
 * Storage layout alignment (std430).
 */
function storageAlignOf(schema: Any): number {
    if (isPackedDesc(schema) || isBitsDesc(schema)) return 4;
    if (isStructDesc(schema)) {
        let maxAlign = 4;
        for (const field of Object.values(schema.fields)) {
            maxAlign = Math.max(maxAlign, storageAlignOf(field));
        }
        return maxAlign;
    }

    if (isSizedArrayDesc(schema) || isArrayDesc(schema)) {
        return storageAlignOf(schema.element);
    }

    if (isAtomicDesc(schema)) return 4;

    const t = schema.wgslType;

    // f16 types
    if (t === 'f16' || t === 'vec2h') return 4;
    if (t === 'vec3h' || t === 'vec4h') return 8;
    if (t === 'mat2x2h') return 4;
    if (t === 'mat2x3h' || t === 'mat3x2h') return 8;
    if (t === 'mat2x4h' || t === 'mat4x2h') return 8;
    if (t === 'mat3x3h' || t === 'mat3x4h' || t === 'mat4x3h' || t === 'mat4x4h') return 8;

    // Scalars
    if (t === 'f32' || t === 'i32' || t === 'u32' || t === 'bool') return 4;

    // vec2
    if (t === 'vec2f' || t === 'vec2i' || t === 'vec2u' || t === 'vec2<bool>') return 8;

    // vec3/vec4
    if (t === 'vec3f' || t === 'vec3i' || t === 'vec3u' || t === 'vec3<bool>') return 16;
    if (t === 'vec4f' || t === 'vec4i' || t === 'vec4u' || t === 'vec4<bool>') return 16;

    // Matrices f32
    if (t === 'mat2x2f') return 8;
    if (t === 'mat3x2f' || t === 'mat4x2f') return 8;
    if (t === 'mat2x3f' || t === 'mat3x3f' || t === 'mat4x3f') return 16;
    if (t === 'mat2x4f' || t === 'mat3x4f' || t === 'mat4x4f') return 16;

    throw new Error(`[gpucat] alignOf: unsupported type '${t}'`);
}

/**
 * Get size for a schema in the given memory layout.
 */
function sizeOf(schema: Any, memLayout: MemoryLayout): number {
    if (isPackedDesc(schema) || isBitsDesc(schema)) return 4;
    if (isStructDesc(schema)) {
        const structAlign = alignOf(schema, memLayout);
        let offset = 0;
        for (const field of Object.values(schema.fields)) {
            offset = roundUp(offset, alignOf(field, memLayout));
            offset += sizeOf(field, memLayout);
        }
        return roundUp(offset, structAlign);
    }

    if (isSizedArrayDesc(schema)) {
        const elementStride = arrayElementStrideOf(schema.element, memLayout);
        return schema.length * elementStride;
    }

    if (isArrayDesc(schema)) {
        throw new Error('[gpucat] sizeOf: cannot compute size of runtime-sized array');
    }

    if (isAtomicDesc(schema)) return 4;

    const t = schema.wgslType;

    // Scalars
    if (t === 'f16') return 2;
    if (t === 'f32' || t === 'i32' || t === 'u32' || t === 'bool') return 4;

    // vec2
    if (t === 'vec2h') return 4;
    if (t === 'vec2f' || t === 'vec2i' || t === 'vec2u' || t === 'vec2<bool>') return 8;

    // vec3
    if (t === 'vec3h') return 6;
    if (t === 'vec3f' || t === 'vec3i' || t === 'vec3u' || t === 'vec3<bool>') return 12;

    // vec4
    if (t === 'vec4h') return 8;
    if (t === 'vec4f' || t === 'vec4i' || t === 'vec4u' || t === 'vec4<bool>') return 16;

    // Matrices f32 - size = numColumns * column stride. Column stride is address-space
    // dependent: std140 pads every column to 16; std430/wgsl-uniform use 8 for 2-row matrices.
    {
        const m = t.match(/^mat(\d)x(\d)f$/);
        if (m) {
            const cols = parseInt(m[1]!, 10);
            const rows = parseInt(m[2]!, 10);
            return cols * matColumnStrideF32(rows, memLayout);
        }
    }

    // Matrices f16
    if (t === 'mat2x2h') return 2 * 4;   // 2 cols * vec2h stride
    if (t === 'mat3x2h') return 3 * 4;
    if (t === 'mat4x2h') return 4 * 4;
    if (t === 'mat2x3h') return 2 * 8;   // 2 cols * vec3h padded
    if (t === 'mat3x3h') return 3 * 8;
    if (t === 'mat4x3h') return 4 * 8;
    if (t === 'mat2x4h') return 2 * 8;   // 2 cols * vec4h
    if (t === 'mat3x4h') return 3 * 8;
    if (t === 'mat4x4h') return 4 * 8;

    throw new Error(`[gpucat] sizeOf: unsupported type '${t}'`);
}

/**
 * Get stride (size with alignment padding) for array elements.
 */
function strideOf(schema: Any, memLayout: MemoryLayout): number {
    return roundUp(sizeOf(schema, memLayout), alignOf(schema, memLayout));
}

/**
 * Get stride for elements within an array (different from strideOf for uniform arrays).
 * Uniform-layout arrays require 16-byte minimum element stride.
 */
function arrayElementStrideOf(elementSchema: Any, memLayout: MemoryLayout): number {
    const baseStride = strideOf(elementSchema, memLayout);
    if (roundsElementsTo16(memLayout)) {
        return roundUp(baseStride, 16);
    }
    return baseStride;
}

// ---------------------------------------------------------------------------
// Code Generation - Writers
// ---------------------------------------------------------------------------

/**
 * Emit write statements for a schema.
 */
function emitWrites(ctx: LayoutContext, schema: Any, accessor: string): void {
    if (isStructDesc(schema)) {
        emitStructWrites(ctx, schema, accessor);
    } else if (isSizedArrayDesc(schema)) {
        emitArrayWrites(ctx, schema, accessor);
    } else {
        emitPrimitiveWrite(ctx, schema, accessor);
    }
}

function emitStructWrites(ctx: LayoutContext, schema: StructDesc, accessor: string): void {
    for (const [key, fieldSchema] of Object.entries(schema.fields)) {
        ctx.offset = roundUp(ctx.offset, alignOf(fieldSchema, ctx.memLayout));
        emitWrites(ctx, fieldSchema, `${accessor}.${key}`);
    }
    // Struct tail padding
    const structAlign = alignOf(schema, ctx.memLayout);
    ctx.offset = roundUp(ctx.offset, structAlign);
}

function emitArrayWrites(ctx: LayoutContext, schema: sizedArray, accessor: string): void {
    const stride = arrayElementStrideOf(schema.element, ctx.memLayout);
    const startOffset = ctx.offset;

    for (let i = 0; i < schema.length; i++) {
        ctx.offset = startOffset + i * stride;
        emitWrites(ctx, schema.element, `${accessor}[${i}]`);
    }
    // Position after the array (accounts for tail padding of last element)
    ctx.offset = startOffset + schema.length * stride;
}

/** JS expression that packs a logical value (`a` = the value accessor, an array) into a u32,
 *  component 0 in the LOW bits, matching the shader `unpack*` decode. `f16(x)` (in scope) is
 *  float→half bits. */
function packedWriteExpr(packedType: string, a: string): string {
    const u8 = (i: number) => `(Math.round(Math.min(Math.max(${a}[${i}],0),1)*255)&255)`;
    const s8 = (i: number) => `(Math.round(Math.min(Math.max(${a}[${i}],-1),1)*127)&255)`;
    const u16 = (i: number) => `(Math.round(Math.min(Math.max(${a}[${i}],0),1)*65535)&65535)`;
    const s16 = (i: number) => `(Math.round(Math.min(Math.max(${a}[${i}],-1),1)*32767)&65535)`;
    switch (packedType) {
        case 'unorm8x4': return `((${u8(0)}|(${u8(1)}<<8)|(${u8(2)}<<16)|(${u8(3)}<<24))>>>0)`;
        case 'snorm8x4': return `((${s8(0)}|(${s8(1)}<<8)|(${s8(2)}<<16)|(${s8(3)}<<24))>>>0)`;
        case 'half2x16': return `((f16(${a}[0])|(f16(${a}[1])<<16))>>>0)`;
        case 'unorm2x16': return `((${u16(0)}|(${u16(1)}<<16))>>>0)`;
        case 'snorm2x16': return `((${s16(0)}|(${s16(1)}<<16))>>>0)`;
        default: throw new Error(`[gpucat] pack: unknown packed type '${packedType}'`);
    }
}

/** JS expression that unpacks a u32 (`u`) back to the logical array, inverse of {@link packedWriteExpr}.
 *  `f16r(bits)` (in scope) is half→float. Used by CPU readback (`unpackFromView`); the shader decode
 *  path is separate (accessor + GLSL emitter). */
function packedReadExpr(packedType: string, u: string): string {
    switch (packedType) {
        case 'unorm8x4': return `[(${u}&255)/255,((${u}>>>8)&255)/255,((${u}>>>16)&255)/255,((${u}>>>24)&255)/255]`;
        case 'snorm8x4': return `[Math.max((((${u}&255)<<24)>>24)/127,-1),Math.max(((((${u}>>>8)&255)<<24)>>24)/127,-1),Math.max(((((${u}>>>16)&255)<<24)>>24)/127,-1),Math.max(((((${u}>>>24)&255)<<24)>>24)/127,-1)]`;
        case 'half2x16': return `[f16r(${u}&0xFFFF),f16r((${u}>>>16)&0xFFFF)]`;
        case 'unorm2x16': return `[(${u}&0xFFFF)/65535,((${u}>>>16)&0xFFFF)/65535]`;
        case 'snorm2x16': return `[Math.max((((${u}&0xFFFF)<<16)>>16)/32767,-1),Math.max(((((${u}>>>16)&0xFFFF)<<16)>>16)/32767,-1)]`;
        default: throw new Error(`[gpucat] pack: unknown packed type '${packedType}'`);
    }
}

function emitPrimitiveWrite(ctx: LayoutContext, schema: Any, accessor: string): void {
    const t = schema.wgslType;
    const off = ctx.offset;

    if (isPackedDesc(schema)) {
        ctx.lines.push(`v.setUint32(o+${off},${packedWriteExpr(schema.type, accessor)},true);`);
        ctx.offset += 4;
        return;
    }

    if (isBitsDesc(schema)) {
        // Σ ((value.field & mask) << shift), field 0 in the low bits — matching the accessor decode.
        const expr = schema.fields
            .map((f) => {
                const mask = f.width >= 32 ? 0xffffffff : ((1 << f.width) - 1) >>> 0;
                return `((${accessor}.${f.name}&${mask})<<${f.shift})`;
            })
            .join('|');
        ctx.lines.push(`v.setUint32(o+${off},(${expr})>>>0,true);`);
        ctx.offset += 4;
        return;
    }

    // Scalars
    if (t === 'f32') {
        ctx.lines.push(`v.setFloat32(o+${off},${accessor},true);`);
        ctx.offset += 4;
        return;
    }
    if (t === 'i32') {
        ctx.lines.push(`v.setInt32(o+${off},${accessor},true);`);
        ctx.offset += 4;
        return;
    }
    if (t === 'u32' || t === 'bool') {
        ctx.lines.push(`v.setUint32(o+${off},${accessor},true);`);
        ctx.offset += 4;
        return;
    }
    if (t === 'f16') {
        ctx.lines.push(`v.setUint16(o+${off},f16(${accessor}),true);`);
        ctx.offset += 2;
        return;
    }

    // vec2
    if (t === 'vec2f') {
        ctx.lines.push(`v.setFloat32(o+${off},${accessor}[0],true);`);
        ctx.lines.push(`v.setFloat32(o+${off + 4},${accessor}[1],true);`);
        ctx.offset += 8;
        return;
    }
    if (t === 'vec2i') {
        ctx.lines.push(`v.setInt32(o+${off},${accessor}[0],true);`);
        ctx.lines.push(`v.setInt32(o+${off + 4},${accessor}[1],true);`);
        ctx.offset += 8;
        return;
    }
    if (t === 'vec2u' || t === 'vec2<bool>') {
        ctx.lines.push(`v.setUint32(o+${off},${accessor}[0],true);`);
        ctx.lines.push(`v.setUint32(o+${off + 4},${accessor}[1],true);`);
        ctx.offset += 8;
        return;
    }
    if (t === 'vec2h') {
        ctx.lines.push(`v.setUint16(o+${off},f16(${accessor}[0]),true);`);
        ctx.lines.push(`v.setUint16(o+${off + 2},f16(${accessor}[1]),true);`);
        ctx.offset += 4;
        return;
    }

    // vec3
    if (t === 'vec3f') {
        ctx.lines.push(`v.setFloat32(o+${off},${accessor}[0],true);`);
        ctx.lines.push(`v.setFloat32(o+${off + 4},${accessor}[1],true);`);
        ctx.lines.push(`v.setFloat32(o+${off + 8},${accessor}[2],true);`);
        ctx.offset += 12;
        return;
    }
    if (t === 'vec3i') {
        ctx.lines.push(`v.setInt32(o+${off},${accessor}[0],true);`);
        ctx.lines.push(`v.setInt32(o+${off + 4},${accessor}[1],true);`);
        ctx.lines.push(`v.setInt32(o+${off + 8},${accessor}[2],true);`);
        ctx.offset += 12;
        return;
    }
    if (t === 'vec3u' || t === 'vec3<bool>') {
        ctx.lines.push(`v.setUint32(o+${off},${accessor}[0],true);`);
        ctx.lines.push(`v.setUint32(o+${off + 4},${accessor}[1],true);`);
        ctx.lines.push(`v.setUint32(o+${off + 8},${accessor}[2],true);`);
        ctx.offset += 12;
        return;
    }
    if (t === 'vec3h') {
        ctx.lines.push(`v.setUint16(o+${off},f16(${accessor}[0]),true);`);
        ctx.lines.push(`v.setUint16(o+${off + 2},f16(${accessor}[1]),true);`);
        ctx.lines.push(`v.setUint16(o+${off + 4},f16(${accessor}[2]),true);`);
        ctx.offset += 6;
        return;
    }

    // vec4
    if (t === 'vec4f') {
        ctx.lines.push(`v.setFloat32(o+${off},${accessor}[0],true);`);
        ctx.lines.push(`v.setFloat32(o+${off + 4},${accessor}[1],true);`);
        ctx.lines.push(`v.setFloat32(o+${off + 8},${accessor}[2],true);`);
        ctx.lines.push(`v.setFloat32(o+${off + 12},${accessor}[3],true);`);
        ctx.offset += 16;
        return;
    }
    if (t === 'vec4i') {
        ctx.lines.push(`v.setInt32(o+${off},${accessor}[0],true);`);
        ctx.lines.push(`v.setInt32(o+${off + 4},${accessor}[1],true);`);
        ctx.lines.push(`v.setInt32(o+${off + 8},${accessor}[2],true);`);
        ctx.lines.push(`v.setInt32(o+${off + 12},${accessor}[3],true);`);
        ctx.offset += 16;
        return;
    }
    if (t === 'vec4u' || t === 'vec4<bool>') {
        ctx.lines.push(`v.setUint32(o+${off},${accessor}[0],true);`);
        ctx.lines.push(`v.setUint32(o+${off + 4},${accessor}[1],true);`);
        ctx.lines.push(`v.setUint32(o+${off + 8},${accessor}[2],true);`);
        ctx.lines.push(`v.setUint32(o+${off + 12},${accessor}[3],true);`);
        ctx.offset += 16;
        return;
    }
    if (t === 'vec4h') {
        ctx.lines.push(`v.setUint16(o+${off},f16(${accessor}[0]),true);`);
        ctx.lines.push(`v.setUint16(o+${off + 2},f16(${accessor}[1]),true);`);
        ctx.lines.push(`v.setUint16(o+${off + 4},f16(${accessor}[2]),true);`);
        ctx.lines.push(`v.setUint16(o+${off + 6},f16(${accessor}[3]),true);`);
        ctx.offset += 8;
        return;
    }

    // Matrices f32 - column major
    if (t.startsWith('mat') && t.endsWith('f')) {
        emitMatrixWriteF32(ctx, t, accessor);
        return;
    }

    // Matrices f16
    if (t.startsWith('mat') && t.endsWith('h')) {
        emitMatrixWriteF16(ctx, t, accessor);
        return;
    }

    // Atomic
    if (isAtomicDesc(schema)) {
        const inner = schema.inner.wgslType;
        if (inner === 'i32') {
            ctx.lines.push(`v.setInt32(o+${off},${accessor},true);`);
        } else {
            ctx.lines.push(`v.setUint32(o+${off},${accessor},true);`);
        }
        ctx.offset += 4;
        return;
    }

    throw new Error(`[gpucat] emitPrimitiveWrite: unsupported type '${t}'`);
}

function emitMatrixWriteF32(ctx: LayoutContext, t: string, accessor: string): void {
    // matCxRf: C columns, R rows
    const match = t.match(/mat(\d)x(\d)f/);
    if (!match) throw new Error(`Invalid matrix type: ${t}`);
    const cols = parseInt(match[1]!, 10);
    const rows = parseInt(match[2]!, 10);

    // Column stride: std140 pads every column to 16; std430/wgsl-uniform use vec2=8, vec3/4=16.
    const colStride = matColumnStrideF32(rows, ctx.memLayout);

    let off = ctx.offset;
    for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
            const idx = c * rows + r;
            ctx.lines.push(`v.setFloat32(o+${off + r * 4},${accessor}[${idx}],true);`);
        }
        off += colStride;
    }
    ctx.offset = off;
}

function emitMatrixWriteF16(ctx: LayoutContext, t: string, accessor: string): void {
    const match = t.match(/mat(\d)x(\d)h/);
    if (!match) throw new Error(`Invalid matrix type: ${t}`);
    const cols = parseInt(match[1]!, 10);
    const rows = parseInt(match[2]!, 10);

    // Column stride for f16: vec2h=4, vec3h/4h=8
    const colStride = rows === 2 ? 4 : 8;

    let off = ctx.offset;
    for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
            const idx = c * rows + r;
            ctx.lines.push(`v.setUint16(o+${off + r * 2},f16(${accessor}[${idx}]),true);`);
        }
        off += colStride;
    }
    ctx.offset = off;
}

// ---------------------------------------------------------------------------
// Code Generation - Readers
// ---------------------------------------------------------------------------

/**
 * Emit read expression for a schema. Returns a JS expression string.
 */
function emitReads(ctx: LayoutContext, schema: Any): string {
    if (isStructDesc(schema)) {
        return emitStructRead(ctx, schema);
    } else if (isSizedArrayDesc(schema)) {
        return emitArrayRead(ctx, schema);
    } else {
        return emitPrimitiveRead(ctx, schema);
    }
}

function emitStructRead(ctx: LayoutContext, schema: StructDesc): string {
    const fields: string[] = [];
    for (const [key, fieldSchema] of Object.entries(schema.fields)) {
        ctx.offset = roundUp(ctx.offset, alignOf(fieldSchema, ctx.memLayout));
        const valueExpr = emitReads(ctx, fieldSchema);
        fields.push(`${key}:${valueExpr}`);
    }
    // Struct tail padding
    const structAlign = alignOf(schema, ctx.memLayout);
    ctx.offset = roundUp(ctx.offset, structAlign);
    return `{${fields.join(',')}}`;
}

function emitArrayRead(ctx: LayoutContext, schema: sizedArray): string {
    const elements: string[] = [];
    const stride = arrayElementStrideOf(schema.element, ctx.memLayout);
    const startOffset = ctx.offset;

    for (let i = 0; i < schema.length; i++) {
        ctx.offset = startOffset + i * stride;
        elements.push(emitReads(ctx, schema.element));
    }
    // Position after the array
    ctx.offset = startOffset + schema.length * stride;
    return `[${elements.join(',')}]`;
}

function emitPrimitiveRead(ctx: LayoutContext, schema: Any): string {
    const t = schema.wgslType;
    const off = ctx.offset;

    if (isPackedDesc(schema)) {
        ctx.offset += 4;
        return packedReadExpr(schema.type, `v.getUint32(o+${off},true)`);
    }

    if (isBitsDesc(schema)) {
        ctx.offset += 4;
        const u = `v.getUint32(o+${off},true)`;
        const parts = schema.fields
            .map((f) => {
                const mask = f.width >= 32 ? 0xffffffff : ((1 << f.width) - 1) >>> 0;
                return `${f.name}:(((${u})>>>${f.shift})&${mask})>>>0`;
            })
            .join(',');
        return `{${parts}}`;
    }

    // Scalars
    if (t === 'f32') {
        ctx.offset += 4;
        return `v.getFloat32(o+${off},true)`;
    }
    if (t === 'i32') {
        ctx.offset += 4;
        return `v.getInt32(o+${off},true)`;
    }
    if (t === 'u32' || t === 'bool') {
        ctx.offset += 4;
        return `v.getUint32(o+${off},true)`;
    }
    if (t === 'f16') {
        ctx.offset += 2;
        return `f16r(v.getUint16(o+${off},true))`;
    }

    // vec2
    if (t === 'vec2f') {
        ctx.offset += 8;
        return `[v.getFloat32(o+${off},true),v.getFloat32(o+${off + 4},true)]`;
    }
    if (t === 'vec2i') {
        ctx.offset += 8;
        return `[v.getInt32(o+${off},true),v.getInt32(o+${off + 4},true)]`;
    }
    if (t === 'vec2u' || t === 'vec2<bool>') {
        ctx.offset += 8;
        return `[v.getUint32(o+${off},true),v.getUint32(o+${off + 4},true)]`;
    }
    if (t === 'vec2h') {
        ctx.offset += 4;
        return `[f16r(v.getUint16(o+${off},true)),f16r(v.getUint16(o+${off + 2},true))]`;
    }

    // vec3
    if (t === 'vec3f') {
        ctx.offset += 12;
        return `[v.getFloat32(o+${off},true),v.getFloat32(o+${off + 4},true),v.getFloat32(o+${off + 8},true)]`;
    }
    if (t === 'vec3i') {
        ctx.offset += 12;
        return `[v.getInt32(o+${off},true),v.getInt32(o+${off + 4},true),v.getInt32(o+${off + 8},true)]`;
    }
    if (t === 'vec3u' || t === 'vec3<bool>') {
        ctx.offset += 12;
        return `[v.getUint32(o+${off},true),v.getUint32(o+${off + 4},true),v.getUint32(o+${off + 8},true)]`;
    }
    if (t === 'vec3h') {
        ctx.offset += 6;
        return `[f16r(v.getUint16(o+${off},true)),f16r(v.getUint16(o+${off + 2},true)),f16r(v.getUint16(o+${off + 4},true))]`;
    }

    // vec4
    if (t === 'vec4f') {
        ctx.offset += 16;
        return `[v.getFloat32(o+${off},true),v.getFloat32(o+${off + 4},true),v.getFloat32(o+${off + 8},true),v.getFloat32(o+${off + 12},true)]`;
    }
    if (t === 'vec4i') {
        ctx.offset += 16;
        return `[v.getInt32(o+${off},true),v.getInt32(o+${off + 4},true),v.getInt32(o+${off + 8},true),v.getInt32(o+${off + 12},true)]`;
    }
    if (t === 'vec4u' || t === 'vec4<bool>') {
        ctx.offset += 16;
        return `[v.getUint32(o+${off},true),v.getUint32(o+${off + 4},true),v.getUint32(o+${off + 8},true),v.getUint32(o+${off + 12},true)]`;
    }
    if (t === 'vec4h') {
        ctx.offset += 8;
        return `[f16r(v.getUint16(o+${off},true)),f16r(v.getUint16(o+${off + 2},true)),f16r(v.getUint16(o+${off + 4},true)),f16r(v.getUint16(o+${off + 6},true))]`;
    }

    // Matrices f32
    if (t.startsWith('mat') && t.endsWith('f')) {
        return emitMatrixReadF32(ctx, t);
    }

    // Matrices f16
    if (t.startsWith('mat') && t.endsWith('h')) {
        return emitMatrixReadF16(ctx, t);
    }

    // Atomic
    if (isAtomicDesc(schema)) {
        ctx.offset += 4;
        const inner = schema.inner.wgslType;
        if (inner === 'i32') {
            return `v.getInt32(o+${off},true)`;
        } else {
            return `v.getUint32(o+${off},true)`;
        }
    }

    throw new Error(`[gpucat] emitPrimitiveRead: unsupported type '${t}'`);
}

function emitMatrixReadF32(ctx: LayoutContext, t: string): string {
    const match = t.match(/mat(\d)x(\d)f/);
    if (!match) throw new Error(`Invalid matrix type: ${t}`);
    const cols = parseInt(match[1]!, 10);
    const rows = parseInt(match[2]!, 10);

    const colStride = matColumnStrideF32(rows, ctx.memLayout);
    const elements: string[] = [];

    let off = ctx.offset;
    for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
            elements.push(`v.getFloat32(o+${off + r * 4},true)`);
        }
        off += colStride;
    }
    ctx.offset = off;
    return `[${elements.join(',')}]`;
}

function emitMatrixReadF16(ctx: LayoutContext, t: string): string {
    const match = t.match(/mat(\d)x(\d)h/);
    if (!match) throw new Error(`Invalid matrix type: ${t}`);
    const cols = parseInt(match[1]!, 10);
    const rows = parseInt(match[2]!, 10);

    const colStride = rows === 2 ? 4 : 8;
    const elements: string[] = [];

    let off = ctx.offset;
    for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
            elements.push(`f16r(v.getUint16(o+${off + r * 2},true))`);
        }
        off += colStride;
    }
    ctx.offset = off;
    return `[${elements.join(',')}]`;
}

// ---------------------------------------------------------------------------
// f16 conversion helpers (injected into generated code)
// ---------------------------------------------------------------------------

/**
 * Convert f32 to f16 bits.
 */
function f32ToF16Bits(value: number): number {
    const f32 = new Float32Array(1);
    const u32 = new Uint32Array(f32.buffer);
    f32[0] = value;
    const bits = u32[0]!;

    const sign = (bits >> 31) & 0x1;
    const exp32 = (bits >> 23) & 0xff;
    const mant32 = bits & 0x7fffff;

    let exp16: number;
    let mant16: number;

    if (exp32 === 0) {
        exp16 = 0;
        mant16 = 0;
    } else if (exp32 === 0xff) {
        exp16 = 0x1f;
        mant16 = mant32 ? 0x200 : 0;
    } else {
        const newExp = exp32 - 127 + 15;
        if (newExp >= 0x1f) {
            exp16 = 0x1f;
            mant16 = 0;
        } else if (newExp <= 0) {
            exp16 = 0;
            mant16 = 0;
        } else {
            exp16 = newExp;
            mant16 = mant32 >> 13;
        }
    }

    return (sign << 15) | (exp16 << 10) | mant16;
}

/**
 * Convert f16 bits to f32.
 */
function f16BitsToF32(bits: number): number {
    const sign = (bits >> 15) & 0x1;
    const exp16 = (bits >> 10) & 0x1f;
    const mant16 = bits & 0x3ff;

    let exp32: number;
    let mant32: number;

    if (exp16 === 0) {
        if (mant16 === 0) {
            exp32 = 0;
            mant32 = 0;
        } else {
            // Subnormal
            let e = -1;
            let m = mant16;
            while ((m & 0x400) === 0) {
                m <<= 1;
                e -= 1;
            }
            exp32 = 127 - 15 + e + 1;
            mant32 = (m & 0x3ff) << 13;
        }
    } else if (exp16 === 0x1f) {
        exp32 = 0xff;
        mant32 = mant16 ? 0x400000 : 0;
    } else {
        exp32 = exp16 - 15 + 127;
        mant32 = mant16 << 13;
    }

    const u32 = new Uint32Array(1);
    const f32 = new Float32Array(u32.buffer);
    u32[0] = (sign << 31) | (exp32 << 23) | mant32;
    return f32[0]!;
}

// ---------------------------------------------------------------------------
// Layout Compilation
// ---------------------------------------------------------------------------

function compileLayout<T>(schema: Any, memLayout: MemoryLayout): CompiledLayout<T> {
    // Generate writer
    const writeCtx: LayoutContext = { memLayout, offset: 0, lines: [] };
    emitWrites(writeCtx, schema, 'd');

    const totalSize = sizeOf(schema, memLayout);
    const stride = strideOf(schema, memLayout);

    const writeCode = `return function(v,o,d){${writeCtx.lines.join('')}}`;

    // Generate reader
    const readCtx: LayoutContext = { memLayout, offset: 0, lines: [] };
    const readExpr = emitReads(readCtx, schema);
    const readCode = `return function(v,o){return ${readExpr}}`;

    // Compile functions with f16 helpers in scope
    const write = new Function('f16', writeCode)(f32ToF16Bits) as (
        view: DataView,
        offset: number,
        value: T,
    ) => void;

    const read = new Function('f16r', readCode)(f16BitsToF32) as (
        view: DataView,
        offset: number,
    ) => T;

    return { totalSize, stride, write, read };
}
