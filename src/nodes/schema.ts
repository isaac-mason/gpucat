/**
 * schema.ts — WgslDesc type descriptors and d.* descriptor namespace.
 *
 * Import this module as:
 *   import * as d from './schema'
 *
 * Then use d.f32, d.vec3f, d.mat4x4f etc. as WgslDesc descriptors in
 * struct() schemas and Fn() param lists.
 * Parameterised types (arrays, textures) remain functions: d.array(d.vec4f).
 *
 * For buffer packing, see src/utils/buffer-layout.ts:
 *   packStructArray(structDef, items) — packs JS objects into an ArrayBuffer
 *   using correct WGSL std430 alignment.
 */

export type WgslType = string;

export type WgslDesc<T extends WgslType> = { readonly wgslType: T };

export type StructSchema = Record<string, WgslDesc<WgslType>>;

// ---------------------------------------------------------------------------
// Infer<D> — maps a WgslDesc (or StructDef shape) to the JS value type
// ---------------------------------------------------------------------------

/**
 * Maps a WgslDesc descriptor (or StructDef) to the equivalent JS/TS value type.
 *
 * Intended to be used with StructDef<S> from nodes.ts, but works on any
 * object that has a `schema` property (structural match), so schema.ts does
 * not need to import from nodes.ts.
 *
 * @example
 * const Particle = struct('Particle', { pos: d.vec3f, vel: d.vec3f, hp: d.f32 });
 * type ParticleJS = d.Infer<typeof Particle>;
 * // → { pos: [number, number, number]; vel: [number, number, number]; hp: number }
 */
export type Infer<D> =
    // StructDef shape — any object with a `schema: StructSchema` field
    D extends { readonly schema: infer S extends StructSchema }
        ? { [K in keyof S]: Infer<S[K]> }
    // Scalar types
    : D extends WgslDesc<'f32'> | WgslDesc<'i32'> | WgslDesc<'u32'> | WgslDesc<'bool'> | WgslDesc<'f16'>
        ? number
    // vec2
    : D extends WgslDesc<'vec2f'> | WgslDesc<'vec2i'> | WgslDesc<'vec2u'> | WgslDesc<'vec2h'> | WgslDesc<'vec2<bool>'>
        ? [number, number]
    // vec3
    : D extends WgslDesc<'vec3f'> | WgslDesc<'vec3i'> | WgslDesc<'vec3u'> | WgslDesc<'vec3h'> | WgslDesc<'vec3<bool>'>
        ? [number, number, number]
    // vec4
    : D extends WgslDesc<'vec4f'> | WgslDesc<'vec4i'> | WgslDesc<'vec4u'> | WgslDesc<'vec4h'> | WgslDesc<'vec4<bool>'>
        ? [number, number, number, number]
    // mat2x2
    : D extends WgslDesc<'mat2x2f'> | WgslDesc<'mat2x2h'>
        ? [number, number, number, number]
    // mat3x3 (column-major, 9 components but 12 floats due to vec3 column padding — expose as flat 9)
    : D extends WgslDesc<'mat3x3f'> | WgslDesc<'mat3x3h'>
        ? [number, number, number, number, number, number, number, number, number]
    // mat4x4
    : D extends WgslDesc<'mat4x4f'> | WgslDesc<'mat4x4h'>
        ? [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]
    // mat2x3, mat3x2, mat2x4, mat4x2, mat3x4, mat4x3
    : D extends WgslDesc<'mat2x3f'> | WgslDesc<'mat2x3h'>
        ? [number, number, number, number, number, number]
    : D extends WgslDesc<'mat3x2f'> | WgslDesc<'mat3x2h'>
        ? [number, number, number, number, number, number]
    : D extends WgslDesc<'mat2x4f'> | WgslDesc<'mat2x4h'>
        ? [number, number, number, number, number, number, number, number]
    : D extends WgslDesc<'mat4x2f'> | WgslDesc<'mat4x2h'>
        ? [number, number, number, number, number, number, number, number]
    : D extends WgslDesc<'mat3x4f'> | WgslDesc<'mat3x4h'>
        ? [number, number, number, number, number, number, number, number, number, number, number, number]
    : D extends WgslDesc<'mat4x3f'> | WgslDesc<'mat4x3h'>
        ? [number, number, number, number, number, number, number, number, number, number, number, number]
    // SizedArrayDesc (has both isArrayDesc and count)
    : D extends SizedArrayDesc<infer E, number>
        ? Infer<WgslDesc<E>>[]
    // Unsized ArrayDesc
    : D extends ArrayDesc<infer E>
        ? Infer<WgslDesc<E>>[]
    : never;

// ---------------------------------------------------------------------------
// ArrayDesc — unbounded runtime array
// ---------------------------------------------------------------------------

export type ArrayDesc<E extends WgslType> = WgslDesc<`array<${E}>`> & {
    readonly isArrayDesc: true;
    readonly elementDesc: WgslDesc<E>;
};

export function isArrayDesc(desc: WgslDesc<WgslType>): desc is ArrayDesc<WgslType> {
    return 'isArrayDesc' in desc && (desc as ArrayDesc<WgslType>).isArrayDesc === true;
}

export function array<E extends WgslType>(elementDesc: WgslDesc<E>): ArrayDesc<E> {
    return {
        wgslType: `array<${elementDesc.wgslType}>`,
        isArrayDesc: true,
        elementDesc,
    };
}

// ---------------------------------------------------------------------------
// SizedArrayDesc — fixed-length array for buffer packing (d.arrayOf)
// ---------------------------------------------------------------------------

/**
 * A fixed-length array descriptor. Unlike `array<E>` (runtime-sized), this
 * carries a `count` so `packStructArray` can allocate the correct buffer and
 * `Infer<>` can produce an array type.
 *
 * WGSL emits `array<E, N>`.
 */
export type SizedArrayDesc<E extends WgslType, N extends number = number> =
    ArrayDesc<E> & { readonly count: N };

export function isSizedArrayDesc(desc: WgslDesc<WgslType>): desc is SizedArrayDesc<WgslType> {
    return isArrayDesc(desc) && 'count' in desc;
}

/**
 * Create a fixed-length array descriptor.
 *
 * @example
 * const desc = d.arrayOf(d.vec3f, 100);
 * // desc.wgslType === 'array<vec3f, 100>'
 * // desc.count    === 100
 */
export function arrayOf<E extends WgslType>(elementDesc: WgslDesc<E>, count: number): SizedArrayDesc<E> {
    return {
        wgslType: `array<${elementDesc.wgslType}, ${count}>` as `array<${E}>`,
        isArrayDesc: true,
        elementDesc,
        count,
    };
}

export function itemSizeOf(desc: WgslDesc<WgslType>): number {
    const t = desc.wgslType;
    // Scalars (f16 counts as 1 item, though it's 2 bytes vs f32's 4 bytes)
    if (t === 'f32' || t === 'i32' || t === 'u32' || t === 'bool' || t === 'f16') return 1;
    // vec2
    if (t === 'vec2f' || t === 'vec2i' || t === 'vec2u' || t === 'vec2<bool>' || t === 'vec2h') return 2;
    // vec3
    if (t === 'vec3f' || t === 'vec3i' || t === 'vec3u' || t === 'vec3<bool>' || t === 'vec3h') return 3;
    // vec4
    if (t === 'vec4f' || t === 'vec4i' || t === 'vec4u' || t === 'vec4<bool>' || t === 'vec4h') return 4;
    // mat2x2
    if (t === 'mat2x2f' || t === 'mat2x2h') return 4;
    // mat2x3, mat3x2
    if (t === 'mat2x3f' || t === 'mat3x2f' || t === 'mat2x3h' || t === 'mat3x2h') return 6;
    // mat2x4, mat4x2
    if (t === 'mat2x4f' || t === 'mat4x2f' || t === 'mat2x4h' || t === 'mat4x2h') return 8;
    // mat3x3
    if (t === 'mat3x3f' || t === 'mat3x3h') return 9;
    // mat3x4, mat4x3
    if (t === 'mat3x4f' || t === 'mat4x3f' || t === 'mat3x4h' || t === 'mat4x3h') return 12;
    // mat4x4
    if (t === 'mat4x4f' || t === 'mat4x4h') return 16;
    throw new Error(`[gpucat] itemSizeOf: unsupported type '${t}'. Use S.array() with numeric types only.`);
}

export function typedArrayCtorOf(desc: WgslDesc<WgslType>): new (length: number) => Float32Array | Int32Array | Uint32Array {
    const t = desc.wgslType;
    if (t === 'i32' || t === 'vec2i' || t === 'vec3i' || t === 'vec4i') return Int32Array;
    if (t === 'u32' || t === 'vec2u' || t === 'vec3u' || t === 'vec4u') return Uint32Array;
    return Float32Array;
}

export function isStructDef<S extends StructSchema>(field: WgslDesc<WgslType>): field is { wgslType: string; schema: S } & WgslDesc<string> {
    return 'schema' in field;
}

// ---------------------------------------------------------------------------
// WGSL std430 layout utilities
//
// These implement the alignment and size rules from the WGSL specification
// §13.8 (Memory Layout).  The layout matches both the 'uniform' address space
// (std140 rules) and the 'storage' address space (std430/relaxed rules) for
// the types covered here.  The difference only matters for array strides — for
// uniform buffers the minimum array-element stride is 16 bytes; this
// implementation uses the tighter storage rules (element stride =
// round_up(sizeof, alignof)) which is what you want for storage buffers.
//
// Rules implemented:
//   f16              align=2,  size=2
//   f32/i32/u32/bool align=4,  size=4
//   vec2<T>          align=2*sizeof(T),  size=2*sizeof(T)
//   vec3<T>          align=4*sizeof(T),  size=3*sizeof(T)   ← alignment ≠ size
//   vec4<T>          align=4*sizeof(T),  size=4*sizeof(T)
//   mat C×R          columns are treated as vec<R, T>; size = C * stride(col)
//   struct           align=max(member aligns), size=roundUp(lastOffset+lastSize, structAlign)
//   array<E,N>       stride=roundUp(sizeof(E), alignof(E)), size=N*stride
// ---------------------------------------------------------------------------

/** Round `n` up to the nearest multiple of `align`. */
export function roundUp(n: number, align: number): number {
    return Math.ceil(n / align) * align;
}

/**
 * Return the byte alignment required by `desc` under WGSL memory layout rules.
 *
 * For struct descriptors the alignment is the maximum alignment of all members,
 * rounded up to the next power-of-two (the spec requires struct align to be a
 * power-of-two multiple of 4).
 */
export function wgslAlignOf(desc: WgslDesc<WgslType>): number {
    // Struct shape — any desc with a `schema` property (StructDef duck-type)
    if (isStructDef(desc)) {
        const schema = (desc as { schema: StructSchema }).schema;
        let maxAlign = 4;
        for (const field of Object.values(schema)) {
            maxAlign = Math.max(maxAlign, wgslAlignOf(field));
        }
        return maxAlign;
    }

    const t = desc.wgslType;

    // f16 — 2 bytes
    if (t === 'f16' || t === 'vec2h') return 4;   // vec2h align = 4 (2×2)
    if (t === 'vec3h' || t === 'vec4h') return 8;  // vec3h/vec4h align = 8 (4×2)
    if (t === 'mat2x2h') return 4;
    if (t === 'mat2x3h' || t === 'mat3x2h') return 8;
    if (t === 'mat2x4h' || t === 'mat4x2h') return 8;
    if (t === 'mat3x3h' || t === 'mat3x4h' || t === 'mat4x3h' || t === 'mat4x4h') return 8;

    // Scalars — 4-byte align
    if (t === 'f32' || t === 'i32' || t === 'u32' || t === 'bool') return 4;

    // vec2 — 8-byte align (2 × 4)
    if (t === 'vec2f' || t === 'vec2i' || t === 'vec2u' || t === 'vec2<bool>') return 8;

    // vec3 — 16-byte align (round up to 4 × 4)
    if (t === 'vec3f' || t === 'vec3i' || t === 'vec3u' || t === 'vec3<bool>') return 16;

    // vec4 — 16-byte align (4 × 4)
    if (t === 'vec4f' || t === 'vec4i' || t === 'vec4u' || t === 'vec4<bool>') return 16;

    // Matrices — alignment = alignment of a column vector
    // mat2x2: cols are vec2 → align=8
    if (t === 'mat2x2f') return 8;
    // mat2x3, mat3x3, mat4x3, mat2x4, mat3x4, mat4x4: cols are vec3/vec4 → align=16
    if (t === 'mat2x3f' || t === 'mat3x3f' || t === 'mat4x3f') return 16;
    if (t === 'mat2x4f' || t === 'mat3x4f' || t === 'mat4x4f') return 16;
    // mat3x2, mat4x2: cols are vec2 → align=8
    if (t === 'mat3x2f' || t === 'mat4x2f') return 8;

    throw new Error(`[gpucat] wgslAlignOf: unsupported type '${t}'`);
}

/**
 * Return the byte *size* (not alignment) of `desc`.
 *
 * For vec3 types, size=12 while alignment=16.
 * For structs, size is rounded up to the struct's alignment (tail padding).
 */
export function wgslSizeOf(desc: WgslDesc<WgslType>): number {
    // Struct shape
    if (isStructDef(desc)) {
        const schema = (desc as { schema: StructSchema }).schema;
        const structAlign = wgslAlignOf(desc);
        let offset = 0;
        for (const field of Object.values(schema)) {
            const fieldAlign = wgslAlignOf(field);
            const fieldSize  = wgslSizeOf(field);
            offset = roundUp(offset, fieldAlign) + fieldSize;
        }
        return roundUp(offset, structAlign);
    }

    const t = desc.wgslType;

    if (t === 'f16') return 2;
    if (t === 'f32' || t === 'i32' || t === 'u32' || t === 'bool') return 4;

    // vec2
    if (t === 'vec2f' || t === 'vec2i' || t === 'vec2u' || t === 'vec2<bool>') return 8;
    if (t === 'vec2h') return 4;

    // vec3 — size=12, align=16
    if (t === 'vec3f' || t === 'vec3i' || t === 'vec3u' || t === 'vec3<bool>') return 12;
    if (t === 'vec3h') return 6;

    // vec4
    if (t === 'vec4f' || t === 'vec4i' || t === 'vec4u' || t === 'vec4<bool>') return 16;
    if (t === 'vec4h') return 8;

    // Matrices — each column occupies stride(col) bytes (column padded to col align)
    // mat2x2f: 2 cols of vec2f (8 bytes each) → 16
    if (t === 'mat2x2f') return 2 * 8;
    if (t === 'mat2x2h') return 2 * 4;
    // mat3x2f: 3 cols of vec2f → 24
    if (t === 'mat3x2f') return 3 * 8;
    if (t === 'mat3x2h') return 3 * 4;
    // mat4x2f: 4 cols of vec2f → 32
    if (t === 'mat4x2f') return 4 * 8;
    if (t === 'mat4x2h') return 4 * 4;
    // mat2x3f: 2 cols of vec3f; each col padded to vec4 (16 bytes) → 32
    if (t === 'mat2x3f') return 2 * 16;
    if (t === 'mat2x3h') return 2 * 8;
    // mat3x3f: 3 cols of vec3f (each 16) → 48
    if (t === 'mat3x3f') return 3 * 16;
    if (t === 'mat3x3h') return 3 * 8;
    // mat4x3f: 4 cols of vec3f (each 16) → 64
    if (t === 'mat4x3f') return 4 * 16;
    if (t === 'mat4x3h') return 4 * 8;
    // mat2x4f: 2 cols of vec4f (16 bytes each) → 32
    if (t === 'mat2x4f') return 2 * 16;
    if (t === 'mat2x4h') return 2 * 8;
    // mat3x4f: 3 cols of vec4f → 48
    if (t === 'mat3x4f') return 3 * 16;
    if (t === 'mat3x4h') return 3 * 8;
    // mat4x4f: 4 cols of vec4f → 64
    if (t === 'mat4x4f') return 4 * 16;
    if (t === 'mat4x4h') return 4 * 8;

    throw new Error(`[gpucat] wgslSizeOf: unsupported type '${t}'`);
}

/**
 * Return the byte stride between consecutive elements of an array whose element
 * type is `desc`.  Under WGSL storage-buffer rules this equals:
 *   roundUp(sizeof(E), alignof(E))
 */
export function wgslStrideOf(desc: WgslDesc<WgslType>): number {
    return roundUp(wgslSizeOf(desc), wgslAlignOf(desc));
}

// ---------------------------------------------------------------------------
// WgslDesc descriptors — plain objects, use as d.f32, d.vec3f, d.mat4x4f etc.
// ---------------------------------------------------------------------------

export const f32:    WgslDesc<'f32'>    = { wgslType: 'f32' };
export const i32:    WgslDesc<'i32'>    = { wgslType: 'i32' };
export const u32:    WgslDesc<'u32'>    = { wgslType: 'u32' };
export const bool:   WgslDesc<'bool'>   = { wgslType: 'bool' };

// Half-precision float (requires `enable f16;` directive and `shader-f16` device feature)
export const f16:    WgslDesc<'f16'>    = { wgslType: 'f16' };

export const vec2f:  WgslDesc<'vec2f'>  = { wgslType: 'vec2f' };
export const vec3f:  WgslDesc<'vec3f'>  = { wgslType: 'vec3f' };
export const vec4f:  WgslDesc<'vec4f'>  = { wgslType: 'vec4f' };
export const vec2i:  WgslDesc<'vec2i'>  = { wgslType: 'vec2i' };
export const vec3i:  WgslDesc<'vec3i'>  = { wgslType: 'vec3i' };
export const vec4i:  WgslDesc<'vec4i'>  = { wgslType: 'vec4i' };
export const vec2u:  WgslDesc<'vec2u'>  = { wgslType: 'vec2u' };
export const vec3u:  WgslDesc<'vec3u'>  = { wgslType: 'vec3u' };
export const vec4u:  WgslDesc<'vec4u'>  = { wgslType: 'vec4u' };

// Half-precision vectors (requires `enable f16;` directive and `shader-f16` device feature)
export const vec2h:  WgslDesc<'vec2h'>  = { wgslType: 'vec2h' };
export const vec3h:  WgslDesc<'vec3h'>  = { wgslType: 'vec3h' };
export const vec4h:  WgslDesc<'vec4h'>  = { wgslType: 'vec4h' };

export const mat2x2f: WgslDesc<'mat2x2f'> = { wgslType: 'mat2x2f' };
export const mat2x3f: WgslDesc<'mat2x3f'> = { wgslType: 'mat2x3f' };
export const mat2x4f: WgslDesc<'mat2x4f'> = { wgslType: 'mat2x4f' };
export const mat3x2f: WgslDesc<'mat3x2f'> = { wgslType: 'mat3x2f' };
export const mat3x3f: WgslDesc<'mat3x3f'> = { wgslType: 'mat3x3f' };
export const mat3x4f: WgslDesc<'mat3x4f'> = { wgslType: 'mat3x4f' };
export const mat4x2f: WgslDesc<'mat4x2f'> = { wgslType: 'mat4x2f' };
export const mat4x3f: WgslDesc<'mat4x3f'> = { wgslType: 'mat4x3f' };
export const mat4x4f: WgslDesc<'mat4x4f'> = { wgslType: 'mat4x4f' };

// Half-precision matrices (requires `enable f16;` directive and `shader-f16` device feature)
export const mat2x2h: WgslDesc<'mat2x2h'> = { wgslType: 'mat2x2h' };
export const mat2x3h: WgslDesc<'mat2x3h'> = { wgslType: 'mat2x3h' };
export const mat2x4h: WgslDesc<'mat2x4h'> = { wgslType: 'mat2x4h' };
export const mat3x2h: WgslDesc<'mat3x2h'> = { wgslType: 'mat3x2h' };
export const mat3x3h: WgslDesc<'mat3x3h'> = { wgslType: 'mat3x3h' };
export const mat3x4h: WgslDesc<'mat3x4h'> = { wgslType: 'mat3x4h' };
export const mat4x2h: WgslDesc<'mat4x2h'> = { wgslType: 'mat4x2h' };
export const mat4x3h: WgslDesc<'mat4x3h'> = { wgslType: 'mat4x3h' };
export const mat4x4h: WgslDesc<'mat4x4h'> = { wgslType: 'mat4x4h' };

// ---------------------------------------------------------------------------
// Texture type descriptors
// ---------------------------------------------------------------------------

/** Texture sample type for generic textures */
export type TextureSampleType = 'f32' | 'i32' | 'u32';

/** Texture descriptor with dimension and sample type info */
export type TextureDesc<T extends string = string> = WgslDesc<T> & {
    readonly isTextureDesc: true;
    readonly dimension: '1d' | '2d' | '2d_array' | '3d' | 'cube' | 'cube_array' | 'multisampled_2d';
    readonly sampleType: TextureSampleType;
};

export function isTextureDesc(desc: WgslDesc<WgslType>): desc is TextureDesc {
    return 'isTextureDesc' in desc && (desc as TextureDesc).isTextureDesc === true;
}

// 2D textures (most common)
export const texture2d = (sampleType: TextureSampleType = 'f32'): TextureDesc<`texture_2d<${TextureSampleType}>`> => ({
    wgslType: `texture_2d<${sampleType}>`,
    isTextureDesc: true,
    dimension: '2d',
    sampleType,
});

// 1D textures
export const texture1d = (sampleType: TextureSampleType = 'f32'): TextureDesc<`texture_1d<${TextureSampleType}>`> => ({
    wgslType: `texture_1d<${sampleType}>`,
    isTextureDesc: true,
    dimension: '1d',
    sampleType,
});

// 3D textures
export const texture3d = (sampleType: TextureSampleType = 'f32'): TextureDesc<`texture_3d<${TextureSampleType}>`> => ({
    wgslType: `texture_3d<${sampleType}>`,
    isTextureDesc: true,
    dimension: '3d',
    sampleType,
});

// Cube textures
export const textureCube = (sampleType: TextureSampleType = 'f32'): TextureDesc<`texture_cube<${TextureSampleType}>`> => ({
    wgslType: `texture_cube<${sampleType}>`,
    isTextureDesc: true,
    dimension: 'cube',
    sampleType,
});

// 2D array textures
export const texture2dArray = (sampleType: TextureSampleType = 'f32'): TextureDesc<`texture_2d_array<${TextureSampleType}>`> => ({
    wgslType: `texture_2d_array<${sampleType}>`,
    isTextureDesc: true,
    dimension: '2d_array',
    sampleType,
});

// Cube array textures
export const textureCubeArray = (sampleType: TextureSampleType = 'f32'): TextureDesc<`texture_cube_array<${TextureSampleType}>`> => ({
    wgslType: `texture_cube_array<${sampleType}>`,
    isTextureDesc: true,
    dimension: 'cube_array',
    sampleType,
});

// Multisampled 2D textures
export const textureMultisampled2d = (sampleType: TextureSampleType = 'f32'): TextureDesc<`texture_multisampled_2d<${TextureSampleType}>`> => ({
    wgslType: `texture_multisampled_2d<${sampleType}>`,
    isTextureDesc: true,
    dimension: 'multisampled_2d',
    sampleType,
});

// Depth textures (no sample type parameter)
export type DepthTextureDesc<T extends string = string> = WgslDesc<T> & {
    readonly isTextureDesc: true;
    readonly isDepthTexture: true;
    readonly dimension: '2d' | '2d_array' | 'cube' | 'cube_array' | 'multisampled_2d';
};

export const textureDepth2d = (): DepthTextureDesc<'texture_depth_2d'> => ({
    wgslType: 'texture_depth_2d',
    isTextureDesc: true,
    isDepthTexture: true,
    dimension: '2d',
});

export const textureDepth2dArray = (): DepthTextureDesc<'texture_depth_2d_array'> => ({
    wgslType: 'texture_depth_2d_array',
    isTextureDesc: true,
    isDepthTexture: true,
    dimension: '2d_array',
});

export const textureDepthCube = (): DepthTextureDesc<'texture_depth_cube'> => ({
    wgslType: 'texture_depth_cube',
    isTextureDesc: true,
    isDepthTexture: true,
    dimension: 'cube',
});

export const textureDepthCubeArray = (): DepthTextureDesc<'texture_depth_cube_array'> => ({
    wgslType: 'texture_depth_cube_array',
    isTextureDesc: true,
    isDepthTexture: true,
    dimension: 'cube_array',
});

export const textureDepthMultisampled2d = (): DepthTextureDesc<'texture_depth_multisampled_2d'> => ({
    wgslType: 'texture_depth_multisampled_2d',
    isTextureDesc: true,
    isDepthTexture: true,
    dimension: 'multisampled_2d',
});

// ---------------------------------------------------------------------------
// Sampler type descriptors
// ---------------------------------------------------------------------------

export type SamplerDesc<T extends 'sampler' | 'sampler_comparison' = 'sampler'> = WgslDesc<T> & {
    readonly isSamplerDesc: true;
    readonly comparison: boolean;
};

export const samplerDesc = (): SamplerDesc<'sampler'> => ({
    wgslType: 'sampler',
    isSamplerDesc: true,
    comparison: false,
});

export const samplerComparisonDesc = (): SamplerDesc<'sampler_comparison'> => ({
    wgslType: 'sampler_comparison',
    isSamplerDesc: true,
    comparison: true,
});
