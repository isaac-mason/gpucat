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

export const f32: f32 = { type: 'f32',  wgslType: 'f32'  };

export type f32 = {
    readonly type: 'f32';
    readonly wgslType: 'f32';
};

export const i32: i32 = { type: 'i32',  wgslType: 'i32'  };

export type i32 = {
    readonly type: 'i32';
    readonly wgslType: 'i32';
};
export const u32: u32 = { type: 'u32',  wgslType: 'u32'  };

export type u32 = {
    readonly type: 'u32';
    readonly wgslType: 'u32';
};

export const bool: bool = { type: 'bool', wgslType: 'bool' };

export type bool = {
    readonly type: 'bool';
    readonly wgslType: 'bool';
};

export const f16: f16 = { type: 'f16',  wgslType: 'f16'  };

export type f16 = {
    readonly type: 'f16';
    readonly wgslType: 'f16';
};

export type ScalarDesc = f32 | i32 | u32 | bool | f16;

// ---------------------------------------------------------------------------
// Vec2 descriptors
// ---------------------------------------------------------------------------

export type vec2f = { readonly type: 'vec2f'; readonly wgslType: 'vec2f'; };
export const vec2f: vec2f = { type: 'vec2f', wgslType: 'vec2f' };

export type vec2i = { readonly type: 'vec2i'; readonly wgslType: 'vec2i'; };
export const vec2i: vec2i = { type: 'vec2i', wgslType: 'vec2i' };

export type vec2u = { readonly type: 'vec2u'; readonly wgslType: 'vec2u'; };
export const vec2u: vec2u = { type: 'vec2u', wgslType: 'vec2u' };

export type vec2bool = { readonly type: 'vec2<bool>'; readonly wgslType: 'vec2<bool>'; };
export const vec2bool: vec2bool = { type: 'vec2<bool>', wgslType: 'vec2<bool>' };

export type vec2h = { readonly type: 'vec2h'; readonly wgslType: 'vec2h'; };
export const vec2h: vec2h = { type: 'vec2h', wgslType: 'vec2h' };

export type Vec2Desc = vec2f | vec2i | vec2u | vec2bool | vec2h;

// ---------------------------------------------------------------------------
// Vec3 descriptors
// ---------------------------------------------------------------------------

export type vec3f = { readonly type: 'vec3f'; readonly wgslType: 'vec3f'; };
export const vec3f: vec3f = { type: 'vec3f', wgslType: 'vec3f' };

export type vec3i = { readonly type: 'vec3i'; readonly wgslType: 'vec3i'; };
export const vec3i: vec3i = { type: 'vec3i', wgslType: 'vec3i' };

export type vec3u = { readonly type: 'vec3u'; readonly wgslType: 'vec3u'; };
export const vec3u: vec3u = { type: 'vec3u', wgslType: 'vec3u' };

export type vec3bool = { readonly type: 'vec3<bool>'; readonly wgslType: 'vec3<bool>'; };
export const vec3bool: vec3bool = { type: 'vec3<bool>', wgslType: 'vec3<bool>' };

export type vec3h = { readonly type: 'vec3h'; readonly wgslType: 'vec3h'; };
export const vec3h: vec3h = { type: 'vec3h', wgslType: 'vec3h' };

export type Vec3Desc = vec3f | vec3i | vec3u | vec3bool | vec3h;

// ---------------------------------------------------------------------------
// Vec4 descriptors
// ---------------------------------------------------------------------------

export type vec4f = { readonly type: 'vec4f'; readonly wgslType: 'vec4f'; };
export const vec4f: vec4f = { type: 'vec4f', wgslType: 'vec4f' };

export type vec4i = { readonly type: 'vec4i'; readonly wgslType: 'vec4i'; };
export const vec4i: vec4i = { type: 'vec4i', wgslType: 'vec4i' };

export type vec4u = { readonly type: 'vec4u'; readonly wgslType: 'vec4u'; };
export const vec4u: vec4u = { type: 'vec4u', wgslType: 'vec4u' };

export type vec4bool = { readonly type: 'vec4<bool>'; readonly wgslType: 'vec4<bool>'; };
export const vec4bool: vec4bool = { type: 'vec4<bool>', wgslType: 'vec4<bool>' };

export type vec4h = { readonly type: 'vec4h'; readonly wgslType: 'vec4h'; };
export const vec4h: vec4h = { type: 'vec4h', wgslType: 'vec4h' };

export type Vec4Desc = vec4f | vec4i | vec4u | vec4bool | vec4h;

export type anyVec = Vec2Desc | Vec3Desc | Vec4Desc;

// ---------------------------------------------------------------------------
// Matrix descriptors — f32
// ---------------------------------------------------------------------------

export type mat2x2f = { readonly type: 'mat2x2f'; readonly wgslType: 'mat2x2f'; };
export const mat2x2f: mat2x2f = { type: 'mat2x2f', wgslType: 'mat2x2f' };

export type mat2x3f = { readonly type: 'mat2x3f'; readonly wgslType: 'mat2x3f'; };
export const mat2x3f: mat2x3f = { type: 'mat2x3f', wgslType: 'mat2x3f' };

export type mat2x4f = { readonly type: 'mat2x4f'; readonly wgslType: 'mat2x4f'; };
export const mat2x4f: mat2x4f = { type: 'mat2x4f', wgslType: 'mat2x4f' };

export type mat3x2f = { readonly type: 'mat3x2f'; readonly wgslType: 'mat3x2f'; };
export const mat3x2f: mat3x2f = { type: 'mat3x2f', wgslType: 'mat3x2f' };

export type mat3x3f = { readonly type: 'mat3x3f'; readonly wgslType: 'mat3x3f'; };
export const mat3x3f: mat3x3f = { type: 'mat3x3f', wgslType: 'mat3x3f' };

export type mat3x4f = { readonly type: 'mat3x4f'; readonly wgslType: 'mat3x4f'; };
export const mat3x4f: mat3x4f = { type: 'mat3x4f', wgslType: 'mat3x4f' };

export type mat4x2f = { readonly type: 'mat4x2f'; readonly wgslType: 'mat4x2f'; };
export const mat4x2f: mat4x2f = { type: 'mat4x2f', wgslType: 'mat4x2f' };

export type mat4x3f = { readonly type: 'mat4x3f'; readonly wgslType: 'mat4x3f'; };
export const mat4x3f: mat4x3f = { type: 'mat4x3f', wgslType: 'mat4x3f' };

export type mat4x4f = { readonly type: 'mat4x4f'; readonly wgslType: 'mat4x4f'; };
export const mat4x4f: mat4x4f = { type: 'mat4x4f', wgslType: 'mat4x4f' };

export type MatfDesc =
    | mat2x2f | mat2x3f | mat2x4f
    | mat3x2f | mat3x3f | mat3x4f
    | mat4x2f | mat4x3f | mat4x4f;

// ---------------------------------------------------------------------------
// Matrix descriptors — f16
// ---------------------------------------------------------------------------

export type mat2x2h = { readonly type: 'mat2x2h'; readonly wgslType: 'mat2x2h'; };
export const mat2x2h: mat2x2h = { type: 'mat2x2h', wgslType: 'mat2x2h' };

export type mat2x3h = { readonly type: 'mat2x3h'; readonly wgslType: 'mat2x3h'; };
export const mat2x3h: mat2x3h = { type: 'mat2x3h', wgslType: 'mat2x3h' };

export type mat2x4h = { readonly type: 'mat2x4h'; readonly wgslType: 'mat2x4h'; };
export const mat2x4h: mat2x4h = { type: 'mat2x4h', wgslType: 'mat2x4h' };

export type mat3x2h = { readonly type: 'mat3x2h'; readonly wgslType: 'mat3x2h'; };
export const mat3x2h: mat3x2h = { type: 'mat3x2h', wgslType: 'mat3x2h' };

export type mat3x3h = { readonly type: 'mat3x3h'; readonly wgslType: 'mat3x3h'; };
export const mat3x3h: mat3x3h = { type: 'mat3x3h', wgslType: 'mat3x3h' };

export type mat3x4h = { readonly type: 'mat3x4h'; readonly wgslType: 'mat3x4h'; };
export const mat3x4h: mat3x4h = { type: 'mat3x4h', wgslType: 'mat3x4h' };

export type mat4x2h = { readonly type: 'mat4x2h'; readonly wgslType: 'mat4x2h'; };
export const mat4x2h: mat4x2h = { type: 'mat4x2h', wgslType: 'mat4x2h' };

export type mat4x3h = { readonly type: 'mat4x3h'; readonly wgslType: 'mat4x3h'; };
export const mat4x3h: mat4x3h = { type: 'mat4x3h', wgslType: 'mat4x3h' };

export type mat4x4h = { readonly type: 'mat4x4h'; readonly wgslType: 'mat4x4h'; };
export const mat4x4h: mat4x4h = { type: 'mat4x4h', wgslType: 'mat4x4h' };

export type MathDesc =
    | mat2x2h | mat2x3h | mat2x4h
    | mat3x2h | mat3x3h | mat3x4h
    | mat4x2h | mat4x3h | mat4x4h;

export type MatDesc = MatfDesc | MathDesc;

// ---------------------------------------------------------------------------
// Primitive descriptor union
// ---------------------------------------------------------------------------

export type PrimDesc = ScalarDesc | anyVec | MatDesc;

// ---------------------------------------------------------------------------
// Atomic descriptors
// ---------------------------------------------------------------------------

export type atomicI32 = {
    readonly type: 'atomic';
    readonly wgslType: 'atomic<i32>';
    readonly inner: i32;
};

export type atomicU32 = {
    readonly type: 'atomic';
    readonly wgslType: 'atomic<u32>';
    readonly inner: u32;
};

export type anyAtomic = atomicI32 | atomicU32;

// ---------------------------------------------------------------------------
// Struct descriptor — fields uses Record<string, WgslDesc> like packcat
// ---------------------------------------------------------------------------

// Struct schema is a record of field names to descriptors
// Defined with inline type to avoid circular reference
export type StructSchema = { readonly [key: string]: Any };

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
    readonly element: Any;
    readonly length?: undefined;
};

export type SizedArrayDesc = {
    readonly type: 'sized-array';
    readonly wgslType: `array<${string}, ${number}>`;
    readonly element: Any;
    readonly length: number;
};

// ---------------------------------------------------------------------------
// Texture descriptors
// ---------------------------------------------------------------------------

/** TextureSampleType — the scalar descriptor types valid as texture sample type parameters in WGSL. */
export type TextureSampleType = f32 | i32 | u32;

// -- Sampled texture descriptors (each a distinct WGSL type) ----------------

export type texture1d<S extends TextureSampleType = TextureSampleType> = {
    readonly type: 'texture_1d';
    readonly wgslType: `texture_1d<${S['wgslType']}>`;
    readonly sampleType: S;
};
export function texture1d<S extends TextureSampleType = f32>(sampleType?: S): texture1d<S> {
    const s = (sampleType ?? f32) as S;
    return { type: 'texture_1d', wgslType: `texture_1d<${s.wgslType}>`, sampleType: s };
}

export type texture2d<S extends TextureSampleType = TextureSampleType> = {
    readonly type: 'texture_2d';
    readonly wgslType: `texture_2d<${S['wgslType']}>`;
    readonly sampleType: S;
};
export function texture2d<S extends TextureSampleType = f32>(sampleType?: S): texture2d<S> {
    const s = (sampleType ?? f32) as S;
    return { type: 'texture_2d', wgslType: `texture_2d<${s.wgslType}>`, sampleType: s };
}

export type texture2dArray<S extends TextureSampleType = TextureSampleType> = {
    readonly type: 'texture_2d_array';
    readonly wgslType: `texture_2d_array<${S['wgslType']}>`;
    readonly sampleType: S;
};
export function texture2dArray<S extends TextureSampleType = f32>(sampleType?: S): texture2dArray<S> {
    const s = (sampleType ?? f32) as S;
    return { type: 'texture_2d_array', wgslType: `texture_2d_array<${s.wgslType}>`, sampleType: s };
}

export type texture3d<S extends TextureSampleType = TextureSampleType> = {
    readonly type: 'texture_3d';
    readonly wgslType: `texture_3d<${S['wgslType']}>`;
    readonly sampleType: S;
};
export function texture3d<S extends TextureSampleType = f32>(sampleType?: S): texture3d<S> {
    const s = (sampleType ?? f32) as S;
    return { type: 'texture_3d', wgslType: `texture_3d<${s.wgslType}>`, sampleType: s };
}

export type textureCube<S extends TextureSampleType = TextureSampleType> = {
    readonly type: 'texture_cube';
    readonly wgslType: `texture_cube<${S['wgslType']}>`;
    readonly sampleType: S;
};
export function textureCube<S extends TextureSampleType = f32>(sampleType?: S): textureCube<S> {
    const s = (sampleType ?? f32) as S;
    return { type: 'texture_cube', wgslType: `texture_cube<${s.wgslType}>`, sampleType: s };
}

export type textureCubeArray<S extends TextureSampleType = TextureSampleType> = {
    readonly type: 'texture_cube_array';
    readonly wgslType: `texture_cube_array<${S['wgslType']}>`;
    readonly sampleType: S;
};
export function textureCubeArray<S extends TextureSampleType = f32>(sampleType?: S): textureCubeArray<S> {
    const s = (sampleType ?? f32) as S;
    return { type: 'texture_cube_array', wgslType: `texture_cube_array<${s.wgslType}>`, sampleType: s };
}

export type textureMultisampled2d<S extends TextureSampleType = TextureSampleType> = {
    readonly type: 'texture_multisampled_2d';
    readonly wgslType: `texture_multisampled_2d<${S['wgslType']}>`;
    readonly sampleType: S;
};
export function textureMultisampled2d<S extends TextureSampleType = f32>(sampleType?: S): textureMultisampled2d<S> {
    const s = (sampleType ?? f32) as S;
    return { type: 'texture_multisampled_2d', wgslType: `texture_multisampled_2d<${s.wgslType}>`, sampleType: s };
}

/** Union of all sampled texture descriptors. */
export type TextureDesc =
    | texture1d
    | texture2d
    | texture2dArray
    | texture3d
    | textureCube
    | textureCubeArray
    | textureMultisampled2d;

/** Non-cube sampled textures — used by TextureNode. */
export type FlatSampledTextureDesc =
    | texture1d
    | texture2d
    | texture2dArray
    | texture3d
    | textureMultisampled2d;

/** Cube sampled textures — used by CubeTextureNode. */
export type CubeSampledTextureDesc =
    | textureCube
    | textureCubeArray;

/** Maps a TextureSampleType descriptor to its vec4 result descriptor. */
export type SampleResultOf<S extends TextureSampleType> =
    S extends f32 ? vec4f
    : S extends i32 ? vec4i
    : S extends u32 ? vec4u
    : never;

/** Runtime version of SampleResultOf — maps a sample type descriptor to its vec4 result. */
export function sampleResultOf(s: TextureSampleType): vec4f | vec4i | vec4u {
    if (s.type === 'f32') return vec4f;
    if (s.type === 'i32') return vec4i;
    return vec4u;
}

/** Extracts the sampleType field from a sampled texture descriptor. */
export type SampleTypeOf<D> =
    D extends { readonly sampleType: infer S extends TextureSampleType } ? S : never;

/**
 * Maps a texture descriptor to its sampling return type:
 * - Sampled textures → vec4f / vec4i / vec4u (based on sampleType)
 * - Depth textures → f32
 */
export type TextureSampleResultOf<D extends AnyTextureDesc> =
    D extends DepthTextureDesc ? f32
    : D extends { readonly sampleType: infer S extends TextureSampleType } ? SampleResultOf<S>
    : never;

/** Runtime version of TextureSampleResultOf — maps a texture descriptor to its sampling return descriptor. */
export function textureSampleResultOf(desc: AnyTextureDesc): vec4f | vec4i | vec4u | f32 {
    if (isDepthTextureDesc(desc)) return f32;
    return sampleResultOf((desc as TextureDesc).sampleType);
}

// -- Depth texture descriptors (each a distinct WGSL type, no sample type) --

export type textureDepth2d = { readonly type: 'texture_depth_2d'; readonly wgslType: 'texture_depth_2d'; };
export const textureDepth2d: textureDepth2d = { type: 'texture_depth_2d', wgslType: 'texture_depth_2d' };

export type textureDepth2dArray = { readonly type: 'texture_depth_2d_array'; readonly wgslType: 'texture_depth_2d_array'; };
export const textureDepth2dArray: textureDepth2dArray = { type: 'texture_depth_2d_array', wgslType: 'texture_depth_2d_array' };

export type textureDepthCube = { readonly type: 'texture_depth_cube'; readonly wgslType: 'texture_depth_cube'; };
export const textureDepthCube: textureDepthCube = { type: 'texture_depth_cube', wgslType: 'texture_depth_cube' };

export type textureDepthCubeArray = { readonly type: 'texture_depth_cube_array'; readonly wgslType: 'texture_depth_cube_array'; };
export const textureDepthCubeArray: textureDepthCubeArray = { type: 'texture_depth_cube_array', wgslType: 'texture_depth_cube_array' };

export type textureDepthMultisampled2d = { readonly type: 'texture_depth_multisampled_2d'; readonly wgslType: 'texture_depth_multisampled_2d'; };
export const textureDepthMultisampled2d: textureDepthMultisampled2d = { type: 'texture_depth_multisampled_2d', wgslType: 'texture_depth_multisampled_2d' };

/** Union of all depth texture descriptors. */
export type DepthTextureDesc =
    | textureDepth2d
    | textureDepth2dArray
    | textureDepthCube
    | textureDepthCubeArray
    | textureDepthMultisampled2d;

/** Non-cube depth textures — used by DepthTextureNode. */
export type FlatDepthTextureDesc =
    | textureDepth2d
    | textureDepth2dArray
    | textureDepthMultisampled2d;

/** Cube depth textures — for future DepthCubeTextureNode. */
export type CubeDepthTextureDesc =
    | textureDepthCube
    | textureDepthCubeArray;

/** Union of all texture descriptors (sampled + depth). */
export type AnyTextureDesc = TextureDesc | DepthTextureDesc;

// ---------------------------------------------------------------------------
// Sampler descriptors
// ---------------------------------------------------------------------------

export type sampler = { readonly type: 'sampler'; readonly wgslType: 'sampler'; };
export const sampler: sampler = { type: 'sampler', wgslType: 'sampler' };
export type SamplerDesc = sampler;

export type samplerComparison = { readonly type: 'sampler_comparison'; readonly wgslType: 'sampler_comparison'; };
export const samplerComparison: samplerComparison = { type: 'sampler_comparison', wgslType: 'sampler_comparison' };
export type SamplerComparisonDesc = samplerComparison;

// ---------------------------------------------------------------------------
// Void descriptor (for control flow nodes)
// ---------------------------------------------------------------------------

export type voidDesc = { readonly type: 'void'; readonly wgslType: 'void'; };
export const voidDesc: voidDesc = { type: 'void', wgslType: 'void' };
export type VoidDesc = voidDesc;

// ---------------------------------------------------------------------------
// WgslFn descriptor (for function definition nodes)
// ---------------------------------------------------------------------------

export type wgslfn = { readonly type: 'wgslfn'; readonly wgslType: 'wgslfn'; };
export const wgslfn: wgslfn = { type: 'wgslfn', wgslType: 'wgslfn' };
export type WgslFnDesc = wgslfn;

// ---------------------------------------------------------------------------
// WgslDesc — the master union of all descriptor types
// ---------------------------------------------------------------------------

export type Any =
    // Scalars
    | f32
    | i32
    | u32
    | bool
    | f16
    // Vec2
    | vec2f
    | vec2i
    | vec2u
    | vec2bool
    | vec2h
    // Vec3
    | vec3f
    | vec3i
    | vec3u
    | vec3bool
    | vec3h
    // Vec4
    | vec4f
    | vec4i
    | vec4u
    | vec4bool
    | vec4h
    // Matrices f32
    | mat2x2f
    | mat2x3f
    | mat2x4f
    | mat3x2f
    | mat3x3f
    | mat3x4f
    | mat4x2f
    | mat4x3f
    | mat4x4f
    // Matrices f16
    | mat2x2h
    | mat2x3h
    | mat2x4h
    | mat3x2h
    | mat3x3h
    | mat3x4h
    | mat4x2h
    | mat4x3h
    | mat4x4h
    // Atomics
    | atomicI32
    | atomicU32
    // Composites
    | StructDesc
    | ArrayDesc
    | SizedArrayDesc
    // Textures (sampled)
    | texture1d
    | texture2d
    | texture2dArray
    | texture3d
    | textureCube
    | textureCubeArray
    | textureMultisampled2d
    // Textures (depth)
    | textureDepth2d
    | textureDepth2dArray
    | textureDepthCube
    | textureDepthCubeArray
    | textureDepthMultisampled2d
    // Samplers
    | SamplerDesc
    | SamplerComparisonDesc
    // Void (for control flow nodes)
    | VoidDesc
    // WgslFn (for function definition nodes)
    | WgslFnDesc;

// ---------------------------------------------------------------------------
// Type-level helpers for struct field access and arithmetic result types
// ---------------------------------------------------------------------------

/** Extract the descriptor type for a field K from struct descriptor D */
export type StructField<D extends Any, K extends string> =
    D extends StructDesc<infer S> ? (K extends keyof S ? S[K] : never) : never;

/** Extract keys from a struct descriptor */
export type StructKeys<D extends Any> = D extends StructDesc<infer S> ? keyof S & string : never;

/** Extract the schema type from a struct descriptor (or StructDef which extends StructDesc) */
export type StructSchemaOf<D extends Any> = D extends StructDesc<infer S> ? S : never;

// Helper to check if a descriptor is scalar by its type discriminant
type IsScalar<D extends Any> = D extends { type: 'f32' | 'i32' | 'u32' | 'bool' | 'f16' } ? true : false;

type IsMat<D extends Any> = D extends { type: 
    | 'mat2x2f' | 'mat2x3f' | 'mat2x4f'
    | 'mat3x2f' | 'mat3x3f' | 'mat3x4f'
    | 'mat4x2f' | 'mat4x3f' | 'mat4x4f'
    | 'mat2x2h' | 'mat2x3h' | 'mat2x4h'
    | 'mat3x2h' | 'mat3x3h' | 'mat3x4h'
    | 'mat4x2h' | 'mat4x3h' | 'mat4x4h'
} ? true : false;

type IsVec<D extends Any> = D extends { type: 
    | 'vec2f' | 'vec2i' | 'vec2u' | 'vec2<bool>' | 'vec2h'
    | 'vec3f' | 'vec3i' | 'vec3u' | 'vec3<bool>' | 'vec3h'
    | 'vec4f' | 'vec4i' | 'vec4u' | 'vec4<bool>' | 'vec4h'
} ? true : false;

/** Type-level mul result: mat*vec→vec, scalar*T→T, T*scalar→T, else A */
export type MulResultDesc<A extends Any, B extends Any> =
    IsMat<A> extends true ? (IsVec<B> extends true ? B : A) :
    IsScalar<B> extends true ? A :
    IsScalar<A> extends true ? B :
    A;

/** Type-level add/sub/div result: scalar op T→T, else A */
export type ArithResultDesc<A extends Any, B extends Any> =
    IsScalar<A> extends true ? (IsScalar<B> extends true ? A : B) : A;

/** Type-level comparison result: vec→vec<bool>, scalar→bool */
export type CompareResultDesc<D extends Any> =
    D extends vec2f | vec2i | vec2u | vec2h ? vec2bool :
    D extends vec3f | vec3i | vec3u | vec3h ? vec3bool :
    D extends vec4f | vec4i | vec4u | vec4h ? vec4bool :
    bool;

/** Extract the element descriptor from a vec descriptor, or return self for scalars */
export type VecElementDesc<D extends Any> =
    D extends vec2f | vec3f | vec4f ? f32 :
    D extends vec2i | vec3i | vec4i ? i32 :
    D extends vec2u | vec3u | vec4u ? u32 :
    D extends vec2h | vec3h | vec4h ? f16 :
    D extends vec2bool | vec3bool | vec4bool ? bool :
    D extends ScalarDesc ? D :
    Any;

/** Map a vec or scalar descriptor to its corresponding vec2 type */
export type Vec2DescOf<D extends Any> =
    D extends vec2f | vec3f | vec4f | f32 ? vec2f :
    D extends vec2i | vec3i | vec4i | i32 ? vec2i :
    D extends vec2u | vec3u | vec4u | u32 ? vec2u :
    D extends vec2h | vec3h | vec4h | f16 ? vec2h :
    D extends vec2bool | vec3bool | vec4bool | bool ? vec2bool :
    Vec2Desc;

/** Map a vec or scalar descriptor to its corresponding vec3 type */
export type Vec3DescOf<D extends Any> =
    D extends vec2f | vec3f | vec4f | f32 ? vec3f :
    D extends vec2i | vec3i | vec4i | i32 ? vec3i :
    D extends vec2u | vec3u | vec4u | u32 ? vec3u :
    D extends vec2h | vec3h | vec4h | f16 ? vec3h :
    D extends vec2bool | vec3bool | vec4bool | bool ? vec3bool :
    Vec3Desc;

/** Map a vec or scalar descriptor to its corresponding vec4 type */
export type Vec4DescOf<D extends Any> =
    D extends vec2f | vec3f | vec4f | f32 ? vec4f :
    D extends vec2i | vec3i | vec4i | i32 ? vec4i :
    D extends vec2u | vec3u | vec4u | u32 ? vec4u :
    D extends vec2h | vec3h | vec4h | f16 ? vec4h :
    D extends vec2bool | vec3bool | vec4bool | bool ? vec4bool :
    Vec4Desc;

/**
 * Maps a schema descriptor to its corresponding TypedArray type.
 * - i32/vec*i → Int32Array
 * - u32/vec*u → Uint32Array  
 * - f32/vec*f/mat → Float32Array
 * - structs/arrays → any typed array (user knows the correct type)
 */
export type TypedArrayFor<D extends Any> =
    D extends i32 | vec2i | vec3i | vec4i ? Int32Array :
    D extends u32 | vec2u | vec3u | vec4u ? Uint32Array :
    D extends f32 | vec2f | vec3f | vec4f | mat2x2f | mat2x3f | mat2x4f | mat3x2f | mat3x3f | mat3x4f | mat4x2f | mat4x3f | mat4x4f ? Float32Array :
    Float32Array | Int32Array | Uint32Array | Uint16Array | Int16Array | Uint8Array | Int8Array;

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

export function isAtomicDesc(desc: Any): desc is anyAtomic {
    return desc.type === 'atomic';
}

export function isStructDesc(desc: Any): desc is StructDesc {
    return desc.type === 'struct';
}

export function isArrayDesc(desc: Any): desc is ArrayDesc {
    return desc.type === 'array';
}

export function isSizedArrayDesc(desc: Any): desc is SizedArrayDesc {
    return desc.type === 'sized-array';
}

export function isTextureDesc(desc: Any): desc is TextureDesc {
    return desc.type.startsWith('texture_') && !desc.type.startsWith('texture_depth_');
}

export function isDepthTextureDesc(desc: Any): desc is DepthTextureDesc {
    return desc.type.startsWith('texture_depth_');
}

export function isAnyTextureDesc(desc: Any): desc is AnyTextureDesc {
    return desc.type.startsWith('texture_');
}

export function isSamplerDesc(desc: Any): desc is SamplerDesc {
    return desc.type === 'sampler';
}

export function isSamplerComparisonDesc(desc: Any): desc is SamplerComparisonDesc {
    return desc.type === 'sampler_comparison';
}

export function isMatDesc(desc: Any): desc is MatDesc {
    return desc.wgslType.startsWith('mat');
}

export function isVecDesc(desc: Any): desc is anyVec {
    return desc.wgslType.startsWith('vec');
}

// Legacy alias
export function isStructDef(desc: Any): desc is StructDesc {
    return isStructDesc(desc);
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

export function atomic(inner: i32): atomicI32;
export function atomic(inner: u32): atomicU32;
export function atomic(inner: i32 | u32): anyAtomic {
    if (inner.type === 'i32') {
        return { type: 'atomic', wgslType: 'atomic<i32>', inner };
    }
    return { type: 'atomic', wgslType: 'atomic<u32>', inner };
}

export function struct<S extends Record<string, Any>, Name extends string>(
    name: Name,
    fields: S,
): { readonly type: 'struct'; readonly wgslType: Name; readonly name: Name; readonly fields: S } {
    return { type: 'struct', wgslType: name, name, fields };
}

export function array<E extends Any>(element: E): { readonly type: 'array'; readonly wgslType: `array<${E['wgslType']}>`; readonly element: E; readonly length?: undefined } {
    return { type: 'array', wgslType: `array<${element.wgslType}>`, element };
}

export function sizedArray<E extends Any, N extends number>(element: E, length: N): { readonly type: 'sized-array'; readonly wgslType: `array<${E['wgslType']}, ${N}>`; readonly element: E; readonly length: N } {
    return { type: 'sized-array', wgslType: `array<${element.wgslType}, ${length}>`, element, length };
}

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

export type Infer<D extends Any> =
    // Struct — match structurally
    D extends { readonly type: 'struct'; readonly fields: infer S extends Record<string, Any> }
        ? { [K in keyof S]: Infer<S[K]> }
    // Atomic
    : D extends anyAtomic
        ? number
    // Scalars
    : D extends f32 | i32 | u32 | bool | f16
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
    : D extends mat2x2f | mat2x2h
        ? [number, number, number, number]
    // Mat3x3
    : D extends mat3x3f | mat3x3h
        ? [number, number, number, number, number, number, number, number, number]
    // Mat4x4
    : D extends mat4x4f | mat4x4h
        ? [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]
    // Mat2x3, Mat3x2
    : D extends mat2x3f | mat2x3h | mat3x2f | mat3x2h
        ? [number, number, number, number, number, number]
    // Mat2x4, Mat4x2
    : D extends mat2x4f | mat2x4h | mat4x2f | mat4x2h
        ? [number, number, number, number, number, number, number, number]
    // Mat3x4, Mat4x3
    : D extends mat3x4f | mat3x4h | mat4x3f | mat4x3h
        ? [number, number, number, number, number, number, number, number, number, number, number, number]
    // SizedArray — match structurally
    : D extends { readonly type: 'sized-array'; readonly element: infer E extends Any }
        ? Infer<E>[]
    // Array — match structurally
    : D extends { readonly type: 'array'; readonly element: infer E extends Any }
        ? Infer<E>[]
    : never;

// ---------------------------------------------------------------------------
// ArrayElement / StructFields — type utilities for Node<D> method signatures
// ---------------------------------------------------------------------------

export type ArrayElement<D extends Any> =
    D extends { readonly type: 'array'; readonly element: infer E extends Any } ? E :
    D extends { readonly type: 'sized-array'; readonly element: infer E extends Any } ? E :
    never;

export type StructFields<D extends Any> =
    D extends { readonly type: 'struct'; readonly fields: infer S extends Record<string, Any> } ? S : never;

// ---------------------------------------------------------------------------
// MatColumnDesc — maps a matrix descriptor to its column vector descriptor.
// matCxR has C columns of vecR, so the column type is determined by R.
// ---------------------------------------------------------------------------

export type MatColumnDesc<D extends Any> =
    D extends mat2x2f | mat3x2f | mat4x2f ? vec2f :
    D extends mat2x3f | mat3x3f | mat4x3f ? vec3f :
    D extends mat2x4f | mat3x4f | mat4x4f ? vec4f :
    D extends mat2x2h | mat3x2h | mat4x2h ? vec2h :
    D extends mat2x3h | mat3x3h | mat4x3h ? vec3h :
    D extends mat2x4h | mat3x4h | mat4x4h ? vec4h :
    never;

// ---------------------------------------------------------------------------
// ElementOf — unified element type for bracket indexing.
// array[i] → element type, matrix[i] → column vector, vector[i] → scalar
// ---------------------------------------------------------------------------

export type ElementOf<D extends Any> =
    D extends { readonly type: 'array'; readonly element: infer E extends Any } ? E :
    D extends { readonly type: 'sized-array'; readonly element: infer E extends Any } ? E :
    D extends MatDesc ? MatColumnDesc<D> :
    D extends anyVec ? VecElementDesc<D> :
    never;

// ---------------------------------------------------------------------------
// WGSL std430 layout utilities
// ---------------------------------------------------------------------------

export function roundUp(n: number, align: number): number {
    return Math.ceil(n / align) * align;
}

export function wgslAlignOf(desc: Any): number {
    if (isStructDesc(desc)) {
        let maxAlign = 4;
        for (const field of Object.values(desc.fields)) {
            maxAlign = Math.max(maxAlign, wgslAlignOf(field));
        }
        return maxAlign;
    }

    if (isArrayDesc(desc) || isSizedArrayDesc(desc)) return wgslAlignOf(desc.element);

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

export function wgslSizeOf(desc: Any): number {
    if (isStructDesc(desc)) {
        const structAlign = wgslAlignOf(desc);
        let offset = 0;
        for (const field of Object.values(desc.fields)) {
            offset = roundUp(offset, wgslAlignOf(field)) + wgslSizeOf(field);
        }
        return roundUp(offset, structAlign);
    }

    if (isSizedArrayDesc(desc)) {
        return desc.length * wgslStrideOf(desc.element);
    }

    if (isArrayDesc(desc)) {
        throw new Error(`[gpucat] wgslSizeOf: cannot compute static size of runtime-sized array '${desc.wgslType}'`);
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

export function wgslStrideOf(desc: Any): number {
    return roundUp(wgslSizeOf(desc), wgslAlignOf(desc));
}

// ---------------------------------------------------------------------------
// Buffer packing helpers
// ---------------------------------------------------------------------------

export function itemSizeOf(desc: Any): number {
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

export function typedArrayCtorOf(desc: Any): new (length: number) => Float32Array | Int32Array | Uint32Array {
    const t = desc.wgslType;
    if (t === 'i32' || t === 'vec2i' || t === 'vec3i' || t === 'vec4i') return Int32Array;
    if (t === 'u32' || t === 'vec2u' || t === 'vec3u' || t === 'vec4u') return Uint32Array;
    return Float32Array;
}

// ---------------------------------------------------------------------------
// Lookup descriptor by WGSL type string
// ---------------------------------------------------------------------------

const WGSL_TYPE_TO_DESC: Record<string, Any> = {
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

export function descFromWgslType(wgslType: string): Any {
    const desc = WGSL_TYPE_TO_DESC[wgslType];
    if (desc) return desc;
    // For custom types (structs, arrays, textures), return a generic descriptor
    return { type: 'string', wgslType } as unknown as Any;
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

export function vecElementDescOrSelf(desc: Any): Any {
    const elem = VEC_ELEMENT_DESC[desc.wgslType];
    return elem ?? desc;
}

export function vec2DescOf(desc: Any): Vec2Desc {
    const elem = VEC_ELEMENT_DESC[desc.wgslType] ?? SCALAR_DESC[desc.wgslType];
    return VEC2_DESC[elem?.wgslType ?? 'f32'] ?? vec2f;
}

export function vec3DescOf(desc: Any): Vec3Desc {
    const elem = VEC_ELEMENT_DESC[desc.wgslType] ?? SCALAR_DESC[desc.wgslType];
    return VEC3_DESC[elem?.wgslType ?? 'f32'] ?? vec3f;
}

export function vec4DescOf(desc: Any): Vec4Desc {
    const elem = VEC_ELEMENT_DESC[desc.wgslType] ?? SCALAR_DESC[desc.wgslType];
    return VEC4_DESC[elem?.wgslType ?? 'f32'] ?? vec4f;
}

const MAT_COLUMN_DESC: Record<string, anyVec> = {
    mat2x2f: vec2f, mat3x2f: vec2f, mat4x2f: vec2f,
    mat2x3f: vec3f, mat3x3f: vec3f, mat4x3f: vec3f,
    mat2x4f: vec4f, mat3x4f: vec4f, mat4x4f: vec4f,
    mat2x2h: vec2h, mat3x2h: vec2h, mat4x2h: vec2h,
    mat2x3h: vec3h, mat3x3h: vec3h, mat4x3h: vec3h,
    mat2x4h: vec4h, mat3x4h: vec4h, mat4x4h: vec4h,
};

export function matColumnDesc(desc: MatDesc): anyVec {
    return MAT_COLUMN_DESC[desc.wgslType];
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

export function mulResultDesc(a: Any, b: Any): Any {
    if (MAT_TYPES_SET.has(a.wgslType)) return VEC_TYPES_SET.has(b.wgslType) ? b : a;
    if (SCALAR_TYPES_SET.has(b.wgslType)) return a;
    if (SCALAR_TYPES_SET.has(a.wgslType)) return b;
    return a;
}

export function arithResultDesc(a: Any, b: Any): Any {
    if (SCALAR_TYPES_SET.has(a.wgslType)) return SCALAR_TYPES_SET.has(b.wgslType) ? a : b;
    return a;
}

const COMPARE_RESULT: Record<string, Any> = {
    vec2f: vec2bool, vec2i: vec2bool, vec2u: vec2bool, vec2h: vec2bool,
    vec3f: vec3bool, vec3i: vec3bool, vec3u: vec3bool, vec3h: vec3bool,
    vec4f: vec4bool, vec4i: vec4bool, vec4u: vec4bool, vec4h: vec4bool,
};

export function compareResultDesc(d: Any): Any {
    return COMPARE_RESULT[d.wgslType] ?? bool;
}
