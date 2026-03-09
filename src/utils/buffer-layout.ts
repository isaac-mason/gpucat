/**
 * buffer-layout.ts — type-safe CPU-side packing of JS objects into ArrayBuffers
 * that match WGSL std430/storage-buffer memory layout.
 *
 * Usage:
 *
 *   import * as d from '../nodes/schema';
 *   import { struct } from '../nodes/nodes';
 *   import { packStructArray, packStruct } from './buffer-layout';
 *
 *   const Particle = struct('Particle', {
 *       position: d.vec3f,
 *       velocity: d.vec3f,
 *       health:   d.f32,
 *   });
 *
 *   type ParticleJS = d.Infer<typeof Particle>;
 *   // → { position: [number, number, number]; velocity: [number, number, number]; health: number }
 *
 *   const buf = packStructArray(Particle, particles);
 *   // → ArrayBuffer sized and laid out correctly for a WGSL storage buffer
 *
 *   // Or create a StorageBufferAttribute directly:
 *   const attr = storageAttributeFromStructArray(Particle, particles);
 */

import {
    type WgslDesc,
    type StructDesc,
    type Infer,
    isStructDesc,
    wgslAlignOf,
    wgslSizeOf,
    wgslStrideOf,
    roundUp,
} from '../nodes/schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Infer the JS value type from a WgslDesc.
 * Re-exported from schema.ts for convenience.
 */
export type InferValue<D extends WgslDesc> = Infer<D>;

// ---------------------------------------------------------------------------
// Internal writer
// ---------------------------------------------------------------------------

/**
 * Write a single JS value into `view` at the given byte `offset`, following
 * the WGSL memory layout rules for `desc`.
 *
 * Returns the number of bytes consumed (= wgslSizeOf(desc)).
 */
function writeValue(
    view: DataView,
    offset: number,
    desc: WgslDesc,
    value: unknown,
    littleEndian = true,
): number {
    // Nested struct
    if (isStructDesc(desc)) {
        const fields = desc.fields;
        const structAlign = wgslAlignOf(desc);
        let fieldOffset = offset;
        const obj = value as Record<string, unknown>;
        for (const [key, fieldDesc] of Object.entries(fields)) {
            const fieldAlign = wgslAlignOf(fieldDesc);
            fieldOffset = roundUp(fieldOffset, fieldAlign);
            writeValue(view, fieldOffset, fieldDesc, obj[key], littleEndian);
            fieldOffset += wgslSizeOf(fieldDesc);
        }
        // Return the full struct size (includes tail padding)
        const rawSize = fieldOffset - offset;
        return roundUp(rawSize, structAlign);
    }

    const t = desc.wgslType;

    // ---- Scalars ----
    if (t === 'f32') {
        view.setFloat32(offset, value as number, littleEndian);
        return 4;
    }
    if (t === 'i32') {
        view.setInt32(offset, value as number, littleEndian);
        return 4;
    }
    if (t === 'u32' || t === 'bool') {
        view.setUint32(offset, (value as number) | 0, littleEndian);
        return 4;
    }
    if (t === 'f16') {
        view.setUint16(offset, f32ToF16Bits(value as number), littleEndian);
        return 2;
    }

    // ---- vec2 variants ----
    if (t === 'vec2f') {
        const v = value as [number, number];
        view.setFloat32(offset,     v[0], littleEndian);
        view.setFloat32(offset + 4, v[1], littleEndian);
        return 8;
    }
    if (t === 'vec2i') {
        const v = value as [number, number];
        view.setInt32(offset,     v[0], littleEndian);
        view.setInt32(offset + 4, v[1], littleEndian);
        return 8;
    }
    if (t === 'vec2u' || t === 'vec2<bool>') {
        const v = value as [number, number];
        view.setUint32(offset,     v[0] | 0, littleEndian);
        view.setUint32(offset + 4, v[1] | 0, littleEndian);
        return 8;
    }
    if (t === 'vec2h') {
        const v = value as [number, number];
        view.setUint16(offset,     f32ToF16Bits(v[0]), littleEndian);
        view.setUint16(offset + 2, f32ToF16Bits(v[1]), littleEndian);
        return 4;
    }

    // ---- vec3 variants (size=12, align=16) ----
    if (t === 'vec3f') {
        const v = value as [number, number, number];
        view.setFloat32(offset,     v[0], littleEndian);
        view.setFloat32(offset + 4, v[1], littleEndian);
        view.setFloat32(offset + 8, v[2], littleEndian);
        return 12; // does NOT write the 4-byte padding; caller handles alignment
    }
    if (t === 'vec3i') {
        const v = value as [number, number, number];
        view.setInt32(offset,     v[0], littleEndian);
        view.setInt32(offset + 4, v[1], littleEndian);
        view.setInt32(offset + 8, v[2], littleEndian);
        return 12;
    }
    if (t === 'vec3u' || t === 'vec3<bool>') {
        const v = value as [number, number, number];
        view.setUint32(offset,     v[0] | 0, littleEndian);
        view.setUint32(offset + 4, v[1] | 0, littleEndian);
        view.setUint32(offset + 8, v[2] | 0, littleEndian);
        return 12;
    }
    if (t === 'vec3h') {
        const v = value as [number, number, number];
        view.setUint16(offset,     f32ToF16Bits(v[0]), littleEndian);
        view.setUint16(offset + 2, f32ToF16Bits(v[1]), littleEndian);
        view.setUint16(offset + 4, f32ToF16Bits(v[2]), littleEndian);
        return 6;
    }

    // ---- vec4 variants ----
    if (t === 'vec4f') {
        const v = value as [number, number, number, number];
        view.setFloat32(offset,      v[0], littleEndian);
        view.setFloat32(offset + 4,  v[1], littleEndian);
        view.setFloat32(offset + 8,  v[2], littleEndian);
        view.setFloat32(offset + 12, v[3], littleEndian);
        return 16;
    }
    if (t === 'vec4i') {
        const v = value as [number, number, number, number];
        view.setInt32(offset,      v[0], littleEndian);
        view.setInt32(offset + 4,  v[1], littleEndian);
        view.setInt32(offset + 8,  v[2], littleEndian);
        view.setInt32(offset + 12, v[3], littleEndian);
        return 16;
    }
    if (t === 'vec4u' || t === 'vec4<bool>') {
        const v = value as [number, number, number, number];
        view.setUint32(offset,      v[0] | 0, littleEndian);
        view.setUint32(offset + 4,  v[1] | 0, littleEndian);
        view.setUint32(offset + 8,  v[2] | 0, littleEndian);
        view.setUint32(offset + 12, v[3] | 0, littleEndian);
        return 16;
    }
    if (t === 'vec4h') {
        const v = value as [number, number, number, number];
        view.setUint16(offset,     f32ToF16Bits(v[0]), littleEndian);
        view.setUint16(offset + 2, f32ToF16Bits(v[1]), littleEndian);
        view.setUint16(offset + 4, f32ToF16Bits(v[2]), littleEndian);
        view.setUint16(offset + 6, f32ToF16Bits(v[3]), littleEndian);
        return 8;
    }

    // ---- Matrices (column-major, columns stored as padded vectors) ----
    // matCxRf: C columns, each R floats, each column padded to align(vecRf)
    if (t === 'mat2x2f') return writeMatF32(view, offset, value as number[], 2, 2, littleEndian);
    if (t === 'mat3x2f') return writeMatF32(view, offset, value as number[], 3, 2, littleEndian);
    if (t === 'mat4x2f') return writeMatF32(view, offset, value as number[], 4, 2, littleEndian);
    if (t === 'mat2x3f') return writeMatF32(view, offset, value as number[], 2, 3, littleEndian);
    if (t === 'mat3x3f') return writeMatF32(view, offset, value as number[], 3, 3, littleEndian);
    if (t === 'mat4x3f') return writeMatF32(view, offset, value as number[], 4, 3, littleEndian);
    if (t === 'mat2x4f') return writeMatF32(view, offset, value as number[], 2, 4, littleEndian);
    if (t === 'mat3x4f') return writeMatF32(view, offset, value as number[], 3, 4, littleEndian);
    if (t === 'mat4x4f') return writeMatF32(view, offset, value as number[], 4, 4, littleEndian);

    throw new Error(`[gpucat] buffer-layout: cannot write unsupported type '${t}'`);
}

/**
 * Write a column-major float matrix of `cols` columns × `rows` rows.
 * `data` is expected in column-major order (matches WGSL/GLSL column-major).
 *
 * Each column is padded to the alignment of vec<rows,f32>:
 *   rows=2 → colStride=8 (vec2f, no padding)
 *   rows=3 → colStride=16 (vec3f padded to vec4f alignment)
 *   rows=4 → colStride=16 (vec4f)
 */
function writeMatF32(
    view: DataView,
    offset: number,
    data: number[],
    cols: number,
    rows: number,
    littleEndian: boolean,
): number {
    const colStride = rows === 2 ? 8 : 16; // vec2 = 8B, vec3/vec4 = 16B
    for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
            view.setFloat32(offset + c * colStride + r * 4, data[c * rows + r] ?? 0, littleEndian);
        }
    }
    return cols * colStride;
}

// ---------------------------------------------------------------------------
// f16 conversion
// ---------------------------------------------------------------------------

/**
 * Convert a 32-bit float to a 16-bit IEEE 754 half-precision bit pattern.
 * This is a pure JS implementation — no WebAssembly required.
 *
 * Note: If your environment has `Float16Array` (available in Chrome 120+),
 * you can use that instead for better performance.
 */
export function f32ToF16Bits(value: number): number {
    const f32 = new Float32Array(1);
    const u32 = new Uint32Array(f32.buffer);
    f32[0] = value;
    const bits = u32[0]!;

    const sign    = (bits >> 31) & 0x1;
    const exp32   = (bits >> 23) & 0xff;
    const mant32  = bits & 0x7fffff;

    let exp16: number;
    let mant16: number;

    if (exp32 === 0) {
        // Zero or subnormal — flush to zero
        exp16 = 0;
        mant16 = 0;
    } else if (exp32 === 0xff) {
        // Infinity or NaN
        exp16 = 0x1f;
        mant16 = mant32 ? 0x200 : 0; // preserve NaN-ness
    } else {
        const exp = exp32 - 127 + 15;
        if (exp >= 31) {
            // Overflow → infinity
            exp16 = 0x1f;
            mant16 = 0;
        } else if (exp <= 0) {
            // Underflow — try to represent as subnormal
            const shift = 14 - exp32 + 127;
            exp16 = 0;
            mant16 = shift <= 24 ? ((mant32 | 0x800000) >> shift) : 0;
        } else {
            exp16 = exp;
            mant16 = mant32 >> 13;
        }
    }

    return (sign << 15) | (exp16 << 10) | mant16;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pack a single JS struct object into an `ArrayBuffer` sized according to
 * the struct's WGSL memory layout (std430 / storage-buffer rules).
 *
 * @param structDef - A `StructDesc` (from `struct()` in schema.ts or nodes.ts).
 * @param value     - A JS object whose fields match `Infer<typeof structDef>`.
 *
 * @example
 * const Particle = struct('Particle', { pos: d.vec3f, hp: d.f32 });
 * const buf = packStruct(Particle, { pos: [1, 2, 3], hp: 100 });
 * device.queue.writeBuffer(gpuBuffer, 0, buf);
 */
export function packStruct<D extends StructDesc>(
    structDef: D,
    value: Infer<D>,
): ArrayBuffer {
    const size = wgslSizeOf(structDef);
    const buf  = new ArrayBuffer(size);
    const view = new DataView(buf);
    writeValue(view, 0, structDef, value);
    return buf;
}

/**
 * Pack an array of JS struct objects into a single `ArrayBuffer` sized for
 * a WGSL `array<S, N>` (storage-buffer rules).
 *
 * Each element is written at stride = `roundUp(sizeof(S), alignof(S))`,
 * which guarantees correct alignment for every element in the array.
 *
 * @param structDef - A `StructDesc` (from `struct()` in schema.ts or nodes.ts).
 * @param items     - Array of JS objects matching `Infer<typeof structDef>`.
 *
 * @example
 * import * as d from '../nodes/schema';
 * import { struct, StorageBufferAttribute } from '../nodes/nodes';
 * import { packStructArray } from './buffer-layout';
 *
 * const Particle = struct('Particle', {
 *     position: d.vec3f,
 *     velocity: d.vec3f,
 *     health:   d.f32,
 * });
 *
 * type ParticleJS = d.Infer<typeof Particle>;
 *
 * function makeParticle(): ParticleJS {
 *     return {
 *         position: [Math.random(), 2, Math.random()],
 *         velocity: [0, 9.8, 0],
 *         health:   100,
 *     };
 * }
 *
 * const buf  = packStructArray(Particle, Array.from({ length: 100 }, makeParticle));
 * const attr = new StorageBufferAttribute(new Uint8Array(buf), 1);
 */
export function packStructArray<D extends StructDesc>(
    structDef: D,
    items: Infer<D>[],
): ArrayBuffer {
    const stride   = wgslStrideOf(structDef);
    const buf      = new ArrayBuffer(stride * items.length);
    const view     = new DataView(buf);
    for (let i = 0; i < items.length; i++) {
        writeValue(view, i * stride, structDef, items[i]);
    }
    return buf;
}

/**
 * Write an array of JS struct objects into an **existing** `ArrayBuffer` at
 * the given byte `byteOffset`.  Useful for sub-range updates.
 *
 * Does not resize the buffer — throws if there is not enough space.
 *
 * @param structDef   - StructDesc from `struct()`.
 * @param items       - JS objects to write.
 * @param dest        - Target ArrayBuffer.
 * @param byteOffset  - Byte offset within `dest` to start writing. Default 0.
 */
export function writeStructArray<D extends StructDesc>(
    structDef: D,
    items: Infer<D>[],
    dest: ArrayBuffer,
    byteOffset = 0,
): void {
    const stride = wgslStrideOf(structDef);
    const needed = byteOffset + stride * items.length;
    if (needed > dest.byteLength) {
        throw new RangeError(
            `[gpucat] writeStructArray: buffer too small. Need ${needed} bytes, have ${dest.byteLength}.`,
        );
    }
    const view = new DataView(dest);
    for (let i = 0; i < items.length; i++) {
        writeValue(view, byteOffset + i * stride, structDef, items[i]);
    }
}
