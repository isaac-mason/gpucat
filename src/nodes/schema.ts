/**
 * schema.ts — WGSL type descriptors following packcat's discriminated union pattern.
 *
 * Import this module as:
 *   import * as d from './schema'
 *
 * Every descriptor has:
 *   - `type`     — discriminant string for type-level narrowing and runtime switching
 *   - `wgslType` — the WGSL type name string
 *
 * For primitives, type === wgslType (e.g. { type: 'f32'; wgslType: 'f32' }).
 * For composites, type is the discriminant ('array', 'struct') and wgslType is computed.
 */

// ---------------------------------------------------------------------------
// Scalar descriptors
// ---------------------------------------------------------------------------

export type F32Desc = {
    readonly type: 'f32';
    readonly wgslType: 'f32';
};

export type I32Desc = {
    readonly type: 'i32';
    readonly wgslType: 'i32';
};

export type U32Desc = {
    readonly type: 'u32';
    readonly wgslType: 'u32';
};

export type BoolDesc = {
    readonly type: 'bool';
    readonly wgslType: 'bool';
};

export type F16Desc = {
    readonly type: 'f16';
    readonly wgslType: 'f16';
};

export type ScalarDesc = F32Desc | I32Desc | U32Desc | BoolDesc | F16Desc;

// ---------------------------------------------------------------------------
// Vec2 descriptors
// ---------------------------------------------------------------------------

export type Vec2fDesc = {
    readonly type: 'vec2f';
    readonly wgslType: 'vec2f';
};

export type Vec2iDesc = {
    readonly type: 'vec2i';
    readonly wgslType: 'vec2i';
};

export type Vec2uDesc = {
    readonly type: 'vec2u';
    readonly wgslType: 'vec2u';
};

export type Vec2boolDesc = {
    readonly type: 'vec2<bool>';
    readonly wgslType: 'vec2<bool>';
};

export type Vec2hDesc = {
    readonly type: 'vec2h';
    readonly wgslType: 'vec2h';
};

export type Vec2Desc = Vec2fDesc | Vec2iDesc | Vec2uDesc | Vec2boolDesc | Vec2hDesc;

// ---------------------------------------------------------------------------
// Vec3 descriptors
// ---------------------------------------------------------------------------

export type Vec3fDesc = {
    readonly type: 'vec3f';
    readonly wgslType: 'vec3f';
};

export type Vec3iDesc = {
    readonly type: 'vec3i';
    readonly wgslType: 'vec3i';
};

export type Vec3uDesc = {
    readonly type: 'vec3u';
    readonly wgslType: 'vec3u';
};

export type Vec3boolDesc = {
    readonly type: 'vec3<bool>';
    readonly wgslType: 'vec3<bool>';
};

export type Vec3hDesc = {
    readonly type: 'vec3h';
    readonly wgslType: 'vec3h';
};

export type Vec3Desc = Vec3fDesc | Vec3iDesc | Vec3uDesc | Vec3boolDesc | Vec3hDesc;

// ---------------------------------------------------------------------------
// Vec4 descriptors
// ---------------------------------------------------------------------------

export type Vec4fDesc = {
    readonly type: 'vec4f';
    readonly wgslType: 'vec4f';
};

export type Vec4iDesc = {
    readonly type: 'vec4i';
    readonly wgslType: 'vec4i';
};

export type Vec4uDesc = {
    readonly type: 'vec4u';
    readonly wgslType: 'vec4u';
};

export type Vec4boolDesc = {
    readonly type: 'vec4<bool>';
    readonly wgslType: 'vec4<bool>';
};

export type Vec4hDesc = {
    readonly type: 'vec4h';
    readonly wgslType: 'vec4h';
};

export type Vec4Desc = Vec4fDesc | Vec4iDesc | Vec4uDesc | Vec4boolDesc | Vec4hDesc;

export type VecDesc = Vec2Desc | Vec3Desc | Vec4Desc;

// ---------------------------------------------------------------------------
// Matrix descriptors — f32
// ---------------------------------------------------------------------------

export type Mat2x2fDesc = { readonly type: 'mat2x2f'; readonly wgslType: 'mat2x2f'; };
export type Mat2x3fDesc = { readonly type: 'mat2x3f'; readonly wgslType: 'mat2x3f'; };
export type Mat2x4fDesc = { readonly type: 'mat2x4f'; readonly wgslType: 'mat2x4f'; };
export type Mat3x2fDesc = { readonly type: 'mat3x2f'; readonly wgslType: 'mat3x2f'; };
export type Mat3x3fDesc = { readonly type: 'mat3x3f'; readonly wgslType: 'mat3x3f'; };
export type Mat3x4fDesc = { readonly type: 'mat3x4f'; readonly wgslType: 'mat3x4f'; };
export type Mat4x2fDesc = { readonly type: 'mat4x2f'; readonly wgslType: 'mat4x2f'; };
export type Mat4x3fDesc = { readonly type: 'mat4x3f'; readonly wgslType: 'mat4x3f'; };
export type Mat4x4fDesc = { readonly type: 'mat4x4f'; readonly wgslType: 'mat4x4f'; };

export type MatfDesc =
    | Mat2x2fDesc | Mat2x3fDesc | Mat2x4fDesc
    | Mat3x2fDesc | Mat3x3fDesc | Mat3x4fDesc
    | Mat4x2fDesc | Mat4x3fDesc | Mat4x4fDesc;

// ---------------------------------------------------------------------------
// Matrix descriptors — f16
// ---------------------------------------------------------------------------

export type Mat2x2hDesc = { readonly type: 'mat2x2h'; readonly wgslType: 'mat2x2h'; };
export type Mat2x3hDesc = { readonly type: 'mat2x3h'; readonly wgslType: 'mat2x3h'; };
export type Mat2x4hDesc = { readonly type: 'mat2x4h'; readonly wgslType: 'mat2x4h'; };
export type Mat3x2hDesc = { readonly type: 'mat3x2h'; readonly wgslType: 'mat3x2h'; };
export type Mat3x3hDesc = { readonly type: 'mat3x3h'; readonly wgslType: 'mat3x3h'; };
export type Mat3x4hDesc = { readonly type: 'mat3x4h'; readonly wgslType: 'mat3x4h'; };
export type Mat4x2hDesc = { readonly type: 'mat4x2h'; readonly wgslType: 'mat4x2h'; };
export type Mat4x3hDesc = { readonly type: 'mat4x3h'; readonly wgslType: 'mat4x3h'; };
export type Mat4x4hDesc = { readonly type: 'mat4x4h'; readonly wgslType: 'mat4x4h'; };

export type MathDesc =
    | Mat2x2hDesc | Mat2x3hDesc | Mat2x4hDesc
    | Mat3x2hDesc | Mat3x3hDesc | Mat3x4hDesc
    | Mat4x2hDesc | Mat4x3hDesc | Mat4x4hDesc;

export type MatDesc = MatfDesc | MathDesc;

// ---------------------------------------------------------------------------
// Primitive descriptor union
// ---------------------------------------------------------------------------

export type PrimDesc = ScalarDesc | VecDesc | MatDesc;

// ---------------------------------------------------------------------------
// Atomic descriptors
// ---------------------------------------------------------------------------

export type AtomicI32Desc = {
    readonly type: 'atomic';
    readonly wgslType: 'atomic<i32>';
    readonly inner: I32Desc;
};

export type AtomicU32Desc = {
    readonly type: 'atomic';
    readonly wgslType: 'atomic<u32>';
    readonly inner: U32Desc;
};

export type AtomicDesc = AtomicI32Desc | AtomicU32Desc;

// ---------------------------------------------------------------------------
// Struct descriptor — fields uses Record<string, WgslDesc> like packcat
// ---------------------------------------------------------------------------

// Struct schema is a record of field names to descriptors
// Defined with inline type to avoid circular reference
export type StructSchema = { readonly [key: string]: WgslDesc };

export type StructDesc<S extends StructSchema = StructSchema> = {
    readonly type: 'struct';
    readonly wgslType: string;
    readonly name: string;
    readonly fields: S;
};

// ---------------------------------------------------------------------------
// Array descriptors
// ---------------------------------------------------------------------------

export type ArrayDesc = {
    readonly type: 'array';
    readonly wgslType: `array<${string}>`;
    readonly element: WgslDesc;
    readonly length?: undefined;
};

export type SizedArrayDesc = {
    readonly type: 'sized-array';
    readonly wgslType: `array<${string}, ${number}>`;
    readonly element: WgslDesc;
    readonly length: number;
};

// ---------------------------------------------------------------------------
// Texture descriptors
// ---------------------------------------------------------------------------

export type TextureSampleType = 'f32' | 'i32' | 'u32';
export type TextureDimension = '1d' | '2d' | '2d_array' | '3d' | 'cube' | 'cube_array' | 'multisampled_2d';

export type TextureDesc<T extends string = string> = {
    readonly type: 'texture';
    readonly wgslType: T;
    readonly dimension: TextureDimension;
    readonly sampleType: TextureSampleType;
};

export type DepthTextureDimension = '2d' | '2d_array' | 'cube' | 'cube_array' | 'multisampled_2d';

export type DepthTextureDesc<T extends string = string> = {
    readonly type: 'depth-texture';
    readonly wgslType: T;
    readonly dimension: DepthTextureDimension;
};

// ---------------------------------------------------------------------------
// Sampler descriptors
// ---------------------------------------------------------------------------

export type SamplerDesc = {
    readonly type: 'sampler';
    readonly wgslType: 'sampler';
};

export type SamplerComparisonDesc = {
    readonly type: 'sampler_comparison';
    readonly wgslType: 'sampler_comparison';
};

// ---------------------------------------------------------------------------
// Void descriptor (for control flow nodes)
// ---------------------------------------------------------------------------

export type VoidDesc = {
    readonly type: 'void';
    readonly wgslType: 'void';
};

// ---------------------------------------------------------------------------
// WgslFn descriptor (for function definition nodes)
// ---------------------------------------------------------------------------

export type WgslFnDesc = {
    readonly type: 'wgslfn';
    readonly wgslType: 'wgslfn';
};

// ---------------------------------------------------------------------------
// WgslDesc — the master union of all descriptor types
// ---------------------------------------------------------------------------

export type WgslDesc =
    // Scalars
    | F32Desc
    | I32Desc
    | U32Desc
    | BoolDesc
    | F16Desc
    // Vec2
    | Vec2fDesc
    | Vec2iDesc
    | Vec2uDesc
    | Vec2boolDesc
    | Vec2hDesc
    // Vec3
    | Vec3fDesc
    | Vec3iDesc
    | Vec3uDesc
    | Vec3boolDesc
    | Vec3hDesc
    // Vec4
    | Vec4fDesc
    | Vec4iDesc
    | Vec4uDesc
    | Vec4boolDesc
    | Vec4hDesc
    // Matrices f32
    | Mat2x2fDesc
    | Mat2x3fDesc
    | Mat2x4fDesc
    | Mat3x2fDesc
    | Mat3x3fDesc
    | Mat3x4fDesc
    | Mat4x2fDesc
    | Mat4x3fDesc
    | Mat4x4fDesc
    // Matrices f16
    | Mat2x2hDesc
    | Mat2x3hDesc
    | Mat2x4hDesc
    | Mat3x2hDesc
    | Mat3x3hDesc
    | Mat3x4hDesc
    | Mat4x2hDesc
    | Mat4x3hDesc
    | Mat4x4hDesc
    // Atomics
    | AtomicI32Desc
    | AtomicU32Desc
    // Composites
    | StructDesc
    | ArrayDesc
    | SizedArrayDesc
    // Textures
    | TextureDesc
    | DepthTextureDesc
    // Samplers
    | SamplerDesc
    | SamplerComparisonDesc
    // Void (for control flow nodes)
    | VoidDesc
    // WgslFn (for function definition nodes)
    | WgslFnDesc;

// ---------------------------------------------------------------------------
// WgslType — string-literal union of all WGSL type strings
// ---------------------------------------------------------------------------

export type ScalarType = 'f32' | 'i32' | 'u32' | 'bool' | 'f16';
export type Vec2Type = 'vec2f' | 'vec2i' | 'vec2u' | 'vec2<bool>' | 'vec2h';
export type Vec3Type = 'vec3f' | 'vec3i' | 'vec3u' | 'vec3<bool>' | 'vec3h';
export type Vec4Type = 'vec4f' | 'vec4i' | 'vec4u' | 'vec4<bool>' | 'vec4h';
export type VecType = Vec2Type | Vec3Type | Vec4Type;

export type MatType =
    | 'mat2x2f' | 'mat2x3f' | 'mat2x4f'
    | 'mat3x2f' | 'mat3x3f' | 'mat3x4f'
    | 'mat4x2f' | 'mat4x3f' | 'mat4x4f'
    | 'mat2x2h' | 'mat2x3h' | 'mat2x4h'
    | 'mat3x2h' | 'mat3x3h' | 'mat3x4h'
    | 'mat4x2h' | 'mat4x3h' | 'mat4x4h';

export type PrimType = ScalarType | VecType | MatType;
export type AtomicType = 'atomic<i32>' | 'atomic<u32>';

export type WgslType = PrimType | AtomicType | `array<${string}>` | `array<${string}, ${number}>` | string;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isAtomicDesc(desc: WgslDesc): desc is AtomicDesc {
    return desc.type === 'atomic';
}

export function isStructDesc(desc: WgslDesc): desc is StructDesc {
    return desc.type === 'struct';
}

export function isArrayDesc(desc: WgslDesc): desc is ArrayDesc {
    return desc.type === 'array';
}

export function isSizedArrayDesc(desc: WgslDesc): desc is SizedArrayDesc {
    return desc.type === 'sized-array';
}

export function isTextureDesc(desc: WgslDesc): desc is TextureDesc {
    return desc.type === 'texture';
}

export function isDepthTextureDesc(desc: WgslDesc): desc is DepthTextureDesc {
    return desc.type === 'depth-texture';
}

export function isSamplerDesc(desc: WgslDesc): desc is SamplerDesc {
    return desc.type === 'sampler';
}

export function isSamplerComparisonDesc(desc: WgslDesc): desc is SamplerComparisonDesc {
    return desc.type === 'sampler_comparison';
}

// Legacy alias
export function isStructDef(desc: WgslDesc): desc is StructDesc {
    return isStructDesc(desc);
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

export function atomic(inner: I32Desc): AtomicI32Desc;
export function atomic(inner: U32Desc): AtomicU32Desc;
export function atomic(inner: I32Desc | U32Desc): AtomicDesc {
    if (inner.type === 'i32') {
        return { type: 'atomic', wgslType: 'atomic<i32>', inner };
    }
    return { type: 'atomic', wgslType: 'atomic<u32>', inner };
}

export function struct<S extends Record<string, WgslDesc>, Name extends string>(
    name: Name,
    fields: S,
): { readonly type: 'struct'; readonly wgslType: Name; readonly name: Name; readonly fields: S } {
    return { type: 'struct', wgslType: name, name, fields };
}

export function array<E extends WgslDesc>(element: E): { readonly type: 'array'; readonly wgslType: `array<${E['wgslType']}>`; readonly element: E; readonly length?: undefined } {
    return { type: 'array', wgslType: `array<${element.wgslType}>`, element };
}

export function arrayOf<E extends WgslDesc, N extends number>(element: E, length: N): { readonly type: 'sized-array'; readonly wgslType: `array<${E['wgslType']}, ${N}>`; readonly element: E; readonly length: N } {
    return { type: 'sized-array', wgslType: `array<${element.wgslType}, ${length}>`, element, length };
}

// ---------------------------------------------------------------------------
// Texture factory functions
// ---------------------------------------------------------------------------

export const texture2d = (sampleType: TextureSampleType = 'f32'): TextureDesc<`texture_2d<${TextureSampleType}>`> => ({
    type: 'texture', wgslType: `texture_2d<${sampleType}>`, dimension: '2d', sampleType,
});

export const texture1d = (sampleType: TextureSampleType = 'f32'): TextureDesc<`texture_1d<${TextureSampleType}>`> => ({
    type: 'texture', wgslType: `texture_1d<${sampleType}>`, dimension: '1d', sampleType,
});

export const texture3d = (sampleType: TextureSampleType = 'f32'): TextureDesc<`texture_3d<${TextureSampleType}>`> => ({
    type: 'texture', wgslType: `texture_3d<${sampleType}>`, dimension: '3d', sampleType,
});

export const textureCube = (sampleType: TextureSampleType = 'f32'): TextureDesc<`texture_cube<${TextureSampleType}>`> => ({
    type: 'texture', wgslType: `texture_cube<${sampleType}>`, dimension: 'cube', sampleType,
});

export const texture2dArray = (sampleType: TextureSampleType = 'f32'): TextureDesc<`texture_2d_array<${TextureSampleType}>`> => ({
    type: 'texture', wgslType: `texture_2d_array<${sampleType}>`, dimension: '2d_array', sampleType,
});

export const textureCubeArray = (sampleType: TextureSampleType = 'f32'): TextureDesc<`texture_cube_array<${TextureSampleType}>`> => ({
    type: 'texture', wgslType: `texture_cube_array<${sampleType}>`, dimension: 'cube_array', sampleType,
});

export const textureMultisampled2d = (sampleType: TextureSampleType = 'f32'): TextureDesc<`texture_multisampled_2d<${TextureSampleType}>`> => ({
    type: 'texture', wgslType: `texture_multisampled_2d<${sampleType}>`, dimension: 'multisampled_2d', sampleType,
});

export const textureDepth2d = (): DepthTextureDesc<'texture_depth_2d'> => ({
    type: 'depth-texture', wgslType: 'texture_depth_2d', dimension: '2d',
});

export const textureDepth2dArray = (): DepthTextureDesc<'texture_depth_2d_array'> => ({
    type: 'depth-texture', wgslType: 'texture_depth_2d_array', dimension: '2d_array',
});

export const textureDepthCube = (): DepthTextureDesc<'texture_depth_cube'> => ({
    type: 'depth-texture', wgslType: 'texture_depth_cube', dimension: 'cube',
});

export const textureDepthCubeArray = (): DepthTextureDesc<'texture_depth_cube_array'> => ({
    type: 'depth-texture', wgslType: 'texture_depth_cube_array', dimension: 'cube_array',
});

export const textureDepthMultisampled2d = (): DepthTextureDesc<'texture_depth_multisampled_2d'> => ({
    type: 'depth-texture', wgslType: 'texture_depth_multisampled_2d', dimension: 'multisampled_2d',
});

// ---------------------------------------------------------------------------
// Sampler factory functions
// ---------------------------------------------------------------------------

export const samplerDesc = (): SamplerDesc => ({
    type: 'sampler', wgslType: 'sampler',
});

export const samplerComparisonDesc = (): SamplerComparisonDesc => ({
    type: 'sampler_comparison', wgslType: 'sampler_comparison',
});

// ---------------------------------------------------------------------------
// Infer<D> — maps a descriptor to its JS value type
// ---------------------------------------------------------------------------

export type Infer<D extends WgslDesc> =
    // Struct — match structurally
    D extends { readonly type: 'struct'; readonly fields: infer S extends Record<string, WgslDesc> }
        ? { [K in keyof S]: Infer<S[K]> }
    // Atomic
    : D extends AtomicDesc
        ? number
    // Scalars
    : D extends F32Desc | I32Desc | U32Desc | BoolDesc | F16Desc
        ? number
    // Vec2
    : D extends Vec2Desc
        ? [number, number]
    // Vec3
    : D extends Vec3Desc
        ? [number, number, number]
    // Vec4
    : D extends Vec4Desc
        ? [number, number, number, number]
    // Mat2x2
    : D extends Mat2x2fDesc | Mat2x2hDesc
        ? [number, number, number, number]
    // Mat3x3
    : D extends Mat3x3fDesc | Mat3x3hDesc
        ? [number, number, number, number, number, number, number, number, number]
    // Mat4x4
    : D extends Mat4x4fDesc | Mat4x4hDesc
        ? [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]
    // Mat2x3, Mat3x2
    : D extends Mat2x3fDesc | Mat2x3hDesc | Mat3x2fDesc | Mat3x2hDesc
        ? [number, number, number, number, number, number]
    // Mat2x4, Mat4x2
    : D extends Mat2x4fDesc | Mat2x4hDesc | Mat4x2fDesc | Mat4x2hDesc
        ? [number, number, number, number, number, number, number, number]
    // Mat3x4, Mat4x3
    : D extends Mat3x4fDesc | Mat3x4hDesc | Mat4x3fDesc | Mat4x3hDesc
        ? [number, number, number, number, number, number, number, number, number, number, number, number]
    // SizedArray — match structurally
    : D extends { readonly type: 'sized-array'; readonly element: infer E extends WgslDesc }
        ? Infer<E>[]
    // Array — match structurally
    : D extends { readonly type: 'array'; readonly element: infer E extends WgslDesc }
        ? Infer<E>[]
    : never;

// ---------------------------------------------------------------------------
// DescElement / DescFields — type utilities for Node<D> method signatures
// ---------------------------------------------------------------------------

export type DescElement<D extends WgslDesc> =
    D extends { readonly type: 'array'; readonly element: infer E extends WgslDesc } ? E :
    D extends { readonly type: 'sized-array'; readonly element: infer E extends WgslDesc } ? E :
    never;

export type DescFields<D extends WgslDesc> =
    D extends { readonly type: 'struct'; readonly fields: infer S extends Record<string, WgslDesc> } ? S : never;

// ---------------------------------------------------------------------------
// WGSL std430 layout utilities
// ---------------------------------------------------------------------------

export function roundUp(n: number, align: number): number {
    return Math.ceil(n / align) * align;
}

export function wgslAlignOf(desc: WgslDesc): number {
    if (isStructDesc(desc)) {
        let maxAlign = 4;
        for (const field of Object.values(desc.fields)) {
            maxAlign = Math.max(maxAlign, wgslAlignOf(field));
        }
        return maxAlign;
    }

    if (isAtomicDesc(desc)) return 4;

    const t = desc.wgslType;

    if (t === 'f16' || t === 'vec2h') return 4;
    if (t === 'vec3h' || t === 'vec4h') return 8;
    if (t === 'mat2x2h') return 4;
    if (t === 'mat2x3h' || t === 'mat3x2h') return 8;
    if (t === 'mat2x4h' || t === 'mat4x2h') return 8;
    if (t === 'mat3x3h' || t === 'mat3x4h' || t === 'mat4x3h' || t === 'mat4x4h') return 8;

    if (t === 'f32' || t === 'i32' || t === 'u32' || t === 'bool') return 4;
    if (t === 'vec2f' || t === 'vec2i' || t === 'vec2u' || t === 'vec2<bool>') return 8;
    if (t === 'vec3f' || t === 'vec3i' || t === 'vec3u' || t === 'vec3<bool>') return 16;
    if (t === 'vec4f' || t === 'vec4i' || t === 'vec4u' || t === 'vec4<bool>') return 16;
    if (t === 'mat2x2f') return 8;
    if (t === 'mat2x3f' || t === 'mat3x3f' || t === 'mat4x3f') return 16;
    if (t === 'mat2x4f' || t === 'mat3x4f' || t === 'mat4x4f') return 16;
    if (t === 'mat3x2f' || t === 'mat4x2f') return 8;

    throw new Error(`[gpucat] wgslAlignOf: unsupported type '${t}'`);
}

export function wgslSizeOf(desc: WgslDesc): number {
    if (isStructDesc(desc)) {
        const structAlign = wgslAlignOf(desc);
        let offset = 0;
        for (const field of Object.values(desc.fields)) {
            offset = roundUp(offset, wgslAlignOf(field)) + wgslSizeOf(field);
        }
        return roundUp(offset, structAlign);
    }

    if (isAtomicDesc(desc)) return 4;

    const t = desc.wgslType;

    if (t === 'f16') return 2;
    if (t === 'f32' || t === 'i32' || t === 'u32' || t === 'bool') return 4;

    if (t === 'vec2f' || t === 'vec2i' || t === 'vec2u' || t === 'vec2<bool>') return 8;
    if (t === 'vec2h') return 4;

    if (t === 'vec3f' || t === 'vec3i' || t === 'vec3u' || t === 'vec3<bool>') return 12;
    if (t === 'vec3h') return 6;

    if (t === 'vec4f' || t === 'vec4i' || t === 'vec4u' || t === 'vec4<bool>') return 16;
    if (t === 'vec4h') return 8;

    if (t === 'mat2x2f') return 2 * 8;
    if (t === 'mat2x2h') return 2 * 4;
    if (t === 'mat3x2f') return 3 * 8;
    if (t === 'mat3x2h') return 3 * 4;
    if (t === 'mat4x2f') return 4 * 8;
    if (t === 'mat4x2h') return 4 * 4;
    if (t === 'mat2x3f') return 2 * 16;
    if (t === 'mat2x3h') return 2 * 8;
    if (t === 'mat3x3f') return 3 * 16;
    if (t === 'mat3x3h') return 3 * 8;
    if (t === 'mat4x3f') return 4 * 16;
    if (t === 'mat4x3h') return 4 * 8;
    if (t === 'mat2x4f') return 2 * 16;
    if (t === 'mat2x4h') return 2 * 8;
    if (t === 'mat3x4f') return 3 * 16;
    if (t === 'mat3x4h') return 3 * 8;
    if (t === 'mat4x4f') return 4 * 16;
    if (t === 'mat4x4h') return 4 * 8;

    throw new Error(`[gpucat] wgslSizeOf: unsupported type '${t}'`);
}

export function wgslStrideOf(desc: WgslDesc): number {
    return roundUp(wgslSizeOf(desc), wgslAlignOf(desc));
}

// ---------------------------------------------------------------------------
// Buffer packing helpers
// ---------------------------------------------------------------------------

export function itemSizeOf(desc: WgslDesc): number {
    const t = desc.wgslType;
    if (t === 'f32' || t === 'i32' || t === 'u32' || t === 'bool' || t === 'f16') return 1;
    if (t === 'vec2f' || t === 'vec2i' || t === 'vec2u' || t === 'vec2<bool>' || t === 'vec2h') return 2;
    if (t === 'vec3f' || t === 'vec3i' || t === 'vec3u' || t === 'vec3<bool>' || t === 'vec3h') return 3;
    if (t === 'vec4f' || t === 'vec4i' || t === 'vec4u' || t === 'vec4<bool>' || t === 'vec4h') return 4;
    if (t === 'mat2x2f' || t === 'mat2x2h') return 4;
    if (t === 'mat2x3f' || t === 'mat3x2f' || t === 'mat2x3h' || t === 'mat3x2h') return 6;
    if (t === 'mat2x4f' || t === 'mat4x2f' || t === 'mat2x4h' || t === 'mat4x2h') return 8;
    if (t === 'mat3x3f' || t === 'mat3x3h') return 9;
    if (t === 'mat3x4f' || t === 'mat4x3f' || t === 'mat3x4h' || t === 'mat4x3h') return 12;
    if (t === 'mat4x4f' || t === 'mat4x4h') return 16;
    throw new Error(`[gpucat] itemSizeOf: unsupported type '${t}'`);
}

export function typedArrayCtorOf(desc: WgslDesc): new (length: number) => Float32Array | Int32Array | Uint32Array {
    const t = desc.wgslType;
    if (t === 'i32' || t === 'vec2i' || t === 'vec3i' || t === 'vec4i') return Int32Array;
    if (t === 'u32' || t === 'vec2u' || t === 'vec3u' || t === 'vec4u') return Uint32Array;
    return Float32Array;
}

// ---------------------------------------------------------------------------
// Primitive descriptor singletons
// ---------------------------------------------------------------------------

export const f32:  F32Desc  = { type: 'f32',  wgslType: 'f32'  };
export const i32:  I32Desc  = { type: 'i32',  wgslType: 'i32'  };
export const u32:  U32Desc  = { type: 'u32',  wgslType: 'u32'  };
export const bool: BoolDesc = { type: 'bool', wgslType: 'bool' };
export const f16:  F16Desc  = { type: 'f16',  wgslType: 'f16'  };

export const vec2f: Vec2fDesc = { type: 'vec2f', wgslType: 'vec2f' };
export const vec3f: Vec3fDesc = { type: 'vec3f', wgslType: 'vec3f' };
export const vec4f: Vec4fDesc = { type: 'vec4f', wgslType: 'vec4f' };
export const vec2i: Vec2iDesc = { type: 'vec2i', wgslType: 'vec2i' };
export const vec3i: Vec3iDesc = { type: 'vec3i', wgslType: 'vec3i' };
export const vec4i: Vec4iDesc = { type: 'vec4i', wgslType: 'vec4i' };
export const vec2u: Vec2uDesc = { type: 'vec2u', wgslType: 'vec2u' };
export const vec3u: Vec3uDesc = { type: 'vec3u', wgslType: 'vec3u' };
export const vec4u: Vec4uDesc = { type: 'vec4u', wgslType: 'vec4u' };
export const vec2h: Vec2hDesc = { type: 'vec2h', wgslType: 'vec2h' };
export const vec3h: Vec3hDesc = { type: 'vec3h', wgslType: 'vec3h' };
export const vec4h: Vec4hDesc = { type: 'vec4h', wgslType: 'vec4h' };

export const mat2x2f: Mat2x2fDesc = { type: 'mat2x2f', wgslType: 'mat2x2f' };
export const mat2x3f: Mat2x3fDesc = { type: 'mat2x3f', wgslType: 'mat2x3f' };
export const mat2x4f: Mat2x4fDesc = { type: 'mat2x4f', wgslType: 'mat2x4f' };
export const mat3x2f: Mat3x2fDesc = { type: 'mat3x2f', wgslType: 'mat3x2f' };
export const mat3x3f: Mat3x3fDesc = { type: 'mat3x3f', wgslType: 'mat3x3f' };
export const mat3x4f: Mat3x4fDesc = { type: 'mat3x4f', wgslType: 'mat3x4f' };
export const mat4x2f: Mat4x2fDesc = { type: 'mat4x2f', wgslType: 'mat4x2f' };
export const mat4x3f: Mat4x3fDesc = { type: 'mat4x3f', wgslType: 'mat4x3f' };
export const mat4x4f: Mat4x4fDesc = { type: 'mat4x4f', wgslType: 'mat4x4f' };

export const mat2x2h: Mat2x2hDesc = { type: 'mat2x2h', wgslType: 'mat2x2h' };
export const mat2x3h: Mat2x3hDesc = { type: 'mat2x3h', wgslType: 'mat2x3h' };
export const mat2x4h: Mat2x4hDesc = { type: 'mat2x4h', wgslType: 'mat2x4h' };
export const mat3x2h: Mat3x2hDesc = { type: 'mat3x2h', wgslType: 'mat3x2h' };
export const mat3x3h: Mat3x3hDesc = { type: 'mat3x3h', wgslType: 'mat3x3h' };
export const mat3x4h: Mat3x4hDesc = { type: 'mat3x4h', wgslType: 'mat3x4h' };
export const mat4x2h: Mat4x2hDesc = { type: 'mat4x2h', wgslType: 'mat4x2h' };
export const mat4x3h: Mat4x3hDesc = { type: 'mat4x3h', wgslType: 'mat4x3h' };
export const mat4x4h: Mat4x4hDesc = { type: 'mat4x4h', wgslType: 'mat4x4h' };

export const sampler: SamplerDesc = { type: 'sampler', wgslType: 'sampler' };
export const samplerComparison: SamplerComparisonDesc = { type: 'sampler_comparison', wgslType: 'sampler_comparison' };

export const voidDesc: VoidDesc = { type: 'void', wgslType: 'void' };

export const wgslfn: WgslFnDesc = { type: 'wgslfn', wgslType: 'wgslfn' };

// ---------------------------------------------------------------------------
// Lookup descriptor by WGSL type string
// ---------------------------------------------------------------------------

const WGSL_TYPE_TO_DESC: Record<string, WgslDesc> = {
    'f32': f32, 'i32': i32, 'u32': u32, 'bool': bool, 'f16': f16,
    'vec2f': vec2f, 'vec3f': vec3f, 'vec4f': vec4f,
    'vec2i': vec2i, 'vec3i': vec3i, 'vec4i': vec4i,
    'vec2u': vec2u, 'vec3u': vec3u, 'vec4u': vec4u,
    'vec2h': vec2h, 'vec3h': vec3h, 'vec4h': vec4h,
    'vec2<bool>': { type: 'vec2<bool>', wgslType: 'vec2<bool>' } as Vec2Desc,
    'vec3<bool>': { type: 'vec3<bool>', wgslType: 'vec3<bool>' } as Vec3Desc,
    'vec4<bool>': { type: 'vec4<bool>', wgslType: 'vec4<bool>' } as Vec4Desc,
    'mat2x2f': mat2x2f, 'mat2x3f': mat2x3f, 'mat2x4f': mat2x4f,
    'mat3x2f': mat3x2f, 'mat3x3f': mat3x3f, 'mat3x4f': mat3x4f,
    'mat4x2f': mat4x2f, 'mat4x3f': mat4x3f, 'mat4x4f': mat4x4f,
    'mat2x2h': mat2x2h, 'mat2x3h': mat2x3h, 'mat2x4h': mat2x4h,
    'mat3x2h': mat3x2h, 'mat3x3h': mat3x3h, 'mat3x4h': mat3x4h,
    'mat4x2h': mat4x2h, 'mat4x3h': mat4x3h, 'mat4x4h': mat4x4h,
    'sampler': sampler, 'sampler_comparison': samplerComparison,
    'void': voidDesc,
};

export function descFromWgslType(wgslType: string): WgslDesc {
    const desc = WGSL_TYPE_TO_DESC[wgslType];
    if (desc) return desc;
    // For custom types (structs, arrays, textures), return a generic descriptor
    return { type: 'string', wgslType } as unknown as WgslDesc;
}

// ---------------------------------------------------------------------------
// Descriptor-based swizzle helpers (runtime)
// ---------------------------------------------------------------------------

const VEC_ELEMENT_DESC: Record<string, ScalarDesc> = {
    vec2f: f32, vec3f: f32, vec4f: f32,
    vec2i: i32, vec3i: i32, vec4i: i32,
    vec2u: u32, vec3u: u32, vec4u: u32,
    vec2h: f16, vec3h: f16, vec4h: f16,
    vec2: f32, vec3: f32, vec4: f32,
    'vec2<bool>': bool, 'vec3<bool>': bool, 'vec4<bool>': bool,
};

const VEC2_DESC: Record<string, Vec2Desc> = {
    f32: vec2f, i32: vec2i, u32: vec2u, f16: vec2h, bool: { type: 'vec2<bool>', wgslType: 'vec2<bool>' },
};

const VEC3_DESC: Record<string, Vec3Desc> = {
    f32: vec3f, i32: vec3i, u32: vec3u, f16: vec3h, bool: { type: 'vec3<bool>', wgslType: 'vec3<bool>' },
};

const VEC4_DESC: Record<string, Vec4Desc> = {
    f32: vec4f, i32: vec4i, u32: vec4u, f16: vec4h, bool: { type: 'vec4<bool>', wgslType: 'vec4<bool>' },
};

const SCALAR_DESC: Record<string, ScalarDesc> = { f32, i32, u32, bool, f16 };

export function vecElementDescOrSelf(desc: WgslDesc): WgslDesc {
    const elem = VEC_ELEMENT_DESC[desc.wgslType];
    return elem ?? desc;
}

export function vec2DescOf(desc: WgslDesc): Vec2Desc {
    const elem = VEC_ELEMENT_DESC[desc.wgslType] ?? SCALAR_DESC[desc.wgslType];
    return VEC2_DESC[elem?.wgslType ?? 'f32'] ?? vec2f;
}

export function vec3DescOf(desc: WgslDesc): Vec3Desc {
    const elem = VEC_ELEMENT_DESC[desc.wgslType] ?? SCALAR_DESC[desc.wgslType];
    return VEC3_DESC[elem?.wgslType ?? 'f32'] ?? vec3f;
}

export function vec4DescOf(desc: WgslDesc): Vec4Desc {
    const elem = VEC_ELEMENT_DESC[desc.wgslType] ?? SCALAR_DESC[desc.wgslType];
    return VEC4_DESC[elem?.wgslType ?? 'f32'] ?? vec4f;
}

// ---------------------------------------------------------------------------
// Arithmetic result descriptor helpers (runtime)
// ---------------------------------------------------------------------------

const MAT_TYPES_SET = new Set([
    'mat2x2f', 'mat2x3f', 'mat2x4f', 'mat3x2f', 'mat3x3f', 'mat3x4f', 'mat4x2f', 'mat4x3f', 'mat4x4f',
    'mat2x2h', 'mat2x3h', 'mat2x4h', 'mat3x2h', 'mat3x3h', 'mat3x4h', 'mat4x2h', 'mat4x3h', 'mat4x4h',
]);

const VEC_TYPES_SET = new Set(Object.keys(VEC_ELEMENT_DESC));
const SCALAR_TYPES_SET = new Set(['f32', 'i32', 'u32', 'bool', 'f16']);

export function mulResultDesc(a: WgslDesc, b: WgslDesc): WgslDesc {
    if (MAT_TYPES_SET.has(a.wgslType)) return VEC_TYPES_SET.has(b.wgslType) ? b : a;
    if (SCALAR_TYPES_SET.has(b.wgslType)) return a;
    if (SCALAR_TYPES_SET.has(a.wgslType)) return b;
    return a;
}

export function arithResultDesc(a: WgslDesc, b: WgslDesc): WgslDesc {
    if (SCALAR_TYPES_SET.has(a.wgslType)) return SCALAR_TYPES_SET.has(b.wgslType) ? a : b;
    return a;
}
