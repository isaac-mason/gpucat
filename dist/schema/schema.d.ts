/**
 * schema.ts, WGSL type descriptors following packcat's discriminated union pattern.
 *
 * Every descriptor has:
 *   - `type`, discriminant string for type-level narrowing and runtime switching
 *   - `wgslType`, the WGSL type name string
 *
 * For primitives, type === wgslType (e.g. { type: 'f32'; wgslType: 'f32' }).
 * For composites, type is the discriminant ('array', 'struct') and wgslType is computed.
 */
export declare const f32: f32;
export type f32 = {
    type: 'f32';
    wgslType: 'f32';
};
export declare const i32: i32;
export type i32 = {
    type: 'i32';
    wgslType: 'i32';
};
export declare const u32: u32;
export type u32 = {
    type: 'u32';
    wgslType: 'u32';
};
export declare const bool: bool;
export type bool = {
    type: 'bool';
    wgslType: 'bool';
};
export declare const f16: f16;
export type f16 = {
    type: 'f16';
    wgslType: 'f16';
};
export type Scalar = f32 | i32 | u32 | bool | f16;
export type vec2f = {
    type: 'vec2f';
    wgslType: 'vec2f';
};
export declare const vec2f: vec2f;
export type vec2i = {
    type: 'vec2i';
    wgslType: 'vec2i';
};
export declare const vec2i: vec2i;
export type vec2u = {
    type: 'vec2u';
    wgslType: 'vec2u';
};
export declare const vec2u: vec2u;
export type vec2bool = {
    type: 'vec2<bool>';
    wgslType: 'vec2<bool>';
};
export declare const vec2bool: vec2bool;
export type vec2h = {
    type: 'vec2h';
    wgslType: 'vec2h';
};
export declare const vec2h: vec2h;
export type Vec2 = vec2f | vec2i | vec2u | vec2bool | vec2h;
export type vec3f = {
    type: 'vec3f';
    wgslType: 'vec3f';
};
export declare const vec3f: vec3f;
export type vec3i = {
    type: 'vec3i';
    wgslType: 'vec3i';
};
export declare const vec3i: vec3i;
export type vec3u = {
    type: 'vec3u';
    wgslType: 'vec3u';
};
export declare const vec3u: vec3u;
export type vec3bool = {
    type: 'vec3<bool>';
    wgslType: 'vec3<bool>';
};
export declare const vec3bool: vec3bool;
export type vec3h = {
    type: 'vec3h';
    wgslType: 'vec3h';
};
export declare const vec3h: vec3h;
export type Vec3 = vec3f | vec3i | vec3u | vec3bool | vec3h;
export type vec4f = {
    type: 'vec4f';
    wgslType: 'vec4f';
};
export declare const vec4f: vec4f;
export type vec4i = {
    type: 'vec4i';
    wgslType: 'vec4i';
};
export declare const vec4i: vec4i;
export type vec4u = {
    type: 'vec4u';
    wgslType: 'vec4u';
};
export declare const vec4u: vec4u;
export type vec4bool = {
    type: 'vec4<bool>';
    wgslType: 'vec4<bool>';
};
export declare const vec4bool: vec4bool;
export type vec4h = {
    type: 'vec4h';
    wgslType: 'vec4h';
};
export declare const vec4h: vec4h;
export type Vec4 = vec4f | vec4i | vec4u | vec4bool | vec4h;
export type Vec = Vec2 | Vec3 | Vec4;
export type mat2x2f = {
    type: 'mat2x2f';
    wgslType: 'mat2x2f';
};
export declare const mat2x2f: mat2x2f;
export type mat2x3f = {
    type: 'mat2x3f';
    wgslType: 'mat2x3f';
};
export declare const mat2x3f: mat2x3f;
export type mat2x4f = {
    type: 'mat2x4f';
    wgslType: 'mat2x4f';
};
export declare const mat2x4f: mat2x4f;
export type mat3x2f = {
    type: 'mat3x2f';
    wgslType: 'mat3x2f';
};
export declare const mat3x2f: mat3x2f;
export type mat3x3f = {
    type: 'mat3x3f';
    wgslType: 'mat3x3f';
};
export declare const mat3x3f: mat3x3f;
export type mat3x4f = {
    type: 'mat3x4f';
    wgslType: 'mat3x4f';
};
export declare const mat3x4f: mat3x4f;
export type mat4x2f = {
    type: 'mat4x2f';
    wgslType: 'mat4x2f';
};
export declare const mat4x2f: mat4x2f;
export type mat4x3f = {
    type: 'mat4x3f';
    wgslType: 'mat4x3f';
};
export declare const mat4x3f: mat4x3f;
export type mat4x4f = {
    type: 'mat4x4f';
    wgslType: 'mat4x4f';
};
export declare const mat4x4f: mat4x4f;
export type MatF = mat2x2f | mat2x3f | mat2x4f | mat3x2f | mat3x3f | mat3x4f | mat4x2f | mat4x3f | mat4x4f;
export type mat2x2h = {
    type: 'mat2x2h';
    wgslType: 'mat2x2h';
};
export declare const mat2x2h: mat2x2h;
export type mat2x3h = {
    type: 'mat2x3h';
    wgslType: 'mat2x3h';
};
export declare const mat2x3h: mat2x3h;
export type mat2x4h = {
    type: 'mat2x4h';
    wgslType: 'mat2x4h';
};
export declare const mat2x4h: mat2x4h;
export type mat3x2h = {
    type: 'mat3x2h';
    wgslType: 'mat3x2h';
};
export declare const mat3x2h: mat3x2h;
export type mat3x3h = {
    type: 'mat3x3h';
    wgslType: 'mat3x3h';
};
export declare const mat3x3h: mat3x3h;
export type mat3x4h = {
    type: 'mat3x4h';
    wgslType: 'mat3x4h';
};
export declare const mat3x4h: mat3x4h;
export type mat4x2h = {
    type: 'mat4x2h';
    wgslType: 'mat4x2h';
};
export declare const mat4x2h: mat4x2h;
export type mat4x3h = {
    type: 'mat4x3h';
    wgslType: 'mat4x3h';
};
export declare const mat4x3h: mat4x3h;
export type mat4x4h = {
    type: 'mat4x4h';
    wgslType: 'mat4x4h';
};
export declare const mat4x4h: mat4x4h;
export type MatH = mat2x2h | mat2x3h | mat2x4h | mat3x2h | mat3x3h | mat3x4h | mat4x2h | mat4x3h | mat4x4h;
export type Mat = MatF | MatH;
export type Prim = Scalar | Vec | Mat;
export type atomicI32 = {
    type: 'atomic';
    wgslType: 'atomic<i32>';
    inner: i32;
};
export type atomicU32 = {
    type: 'atomic';
    wgslType: 'atomic<u32>';
    inner: u32;
};
export type Atomic = atomicI32 | atomicU32;
export type StructSchema = {
    [key: string]: Any;
};
export type StructDesc<S extends StructSchema = StructSchema> = {
    type: 'struct';
    wgslType: string;
    name: string;
    fields: S;
};
/** TextureSampleType, the scalar descriptor types valid as texture sample type parameters in WGSL. */
export type TextureSampleType = f32 | i32 | u32;
export type texture1d<S extends TextureSampleType = TextureSampleType> = {
    type: 'texture_1d';
    wgslType: `texture_1d<${S['wgslType']}>`;
    sampleType: S;
};
export declare function texture1d<S extends TextureSampleType = f32>(sampleType?: S): texture1d<S>;
export type texture2d<S extends TextureSampleType = TextureSampleType> = {
    type: 'texture_2d';
    wgslType: `texture_2d<${S['wgslType']}>`;
    sampleType: S;
};
export declare function texture2d<S extends TextureSampleType = f32>(sampleType?: S): texture2d<S>;
export type texture2dArray<S extends TextureSampleType = TextureSampleType> = {
    type: 'texture_2d_array';
    wgslType: `texture_2d_array<${S['wgslType']}>`;
    sampleType: S;
};
export declare function texture2dArray<S extends TextureSampleType = f32>(sampleType?: S): texture2dArray<S>;
export type texture3d<S extends TextureSampleType = TextureSampleType> = {
    type: 'texture_3d';
    wgslType: `texture_3d<${S['wgslType']}>`;
    sampleType: S;
};
export declare function texture3d<S extends TextureSampleType = f32>(sampleType?: S): texture3d<S>;
export type textureCube<S extends TextureSampleType = TextureSampleType> = {
    type: 'texture_cube';
    wgslType: `texture_cube<${S['wgslType']}>`;
    sampleType: S;
};
export declare function textureCube<S extends TextureSampleType = f32>(sampleType?: S): textureCube<S>;
export type textureCubeArray<S extends TextureSampleType = TextureSampleType> = {
    type: 'texture_cube_array';
    wgslType: `texture_cube_array<${S['wgslType']}>`;
    sampleType: S;
};
export declare function textureCubeArray<S extends TextureSampleType = f32>(sampleType?: S): textureCubeArray<S>;
export type textureMultisampled2d<S extends TextureSampleType = TextureSampleType> = {
    type: 'texture_multisampled_2d';
    wgslType: `texture_multisampled_2d<${S['wgslType']}>`;
    sampleType: S;
};
export declare function textureMultisampled2d<S extends TextureSampleType = f32>(sampleType?: S): textureMultisampled2d<S>;
/** Union of all sampled texture descriptors. */
export type SampledTexture = texture1d | texture2d | texture2dArray | texture3d | textureCube | textureCubeArray | textureMultisampled2d;
/** Non-cube sampled textures, used by TextureNode. */
export type FlatSampledTexture = texture1d | texture2d | texture2dArray | texture3d | textureMultisampled2d;
/** Cube sampled textures, used by CubeTextureNode. */
export type CubeSampledTexture = textureCube | textureCubeArray;
/** Maps a TextureSampleType descriptor to its vec4 result descriptor. */
export type SampleResultOf<S extends TextureSampleType> = S extends f32 ? vec4f : S extends i32 ? vec4i : S extends u32 ? vec4u : never;
/** Runtime version of SampleResultOf, maps a sample type descriptor to its vec4 result. */
export declare function sampleResultOf(s: TextureSampleType): vec4f | vec4i | vec4u;
/** Extracts the sampleType field from a sampled texture descriptor. */
export type SampleTypeOf<D> = D extends {
    sampleType: infer S extends TextureSampleType;
} ? S : never;
/**
 * Maps a texture descriptor to its sampling return type:
 * - Sampled textures → vec4f / vec4i / vec4u (based on sampleType)
 * - Depth textures → f32
 */
export type TextureSampleResultOf<D extends Texture> = D extends DepthTexture ? f32 : D extends {
    sampleType: infer S extends TextureSampleType;
} ? SampleResultOf<S> : never;
/** Runtime version of TextureSampleResultOf, maps a texture descriptor to its sampling return descriptor. */
export declare function textureSampleResultOf(desc: Texture): vec4f | vec4i | vec4u | f32;
export type textureDepth2d = {
    type: 'texture_depth_2d';
    wgslType: 'texture_depth_2d';
};
export declare const textureDepth2d: textureDepth2d;
export type textureDepth2dArray = {
    type: 'texture_depth_2d_array';
    wgslType: 'texture_depth_2d_array';
};
export declare const textureDepth2dArray: textureDepth2dArray;
export type textureDepthCube = {
    type: 'texture_depth_cube';
    wgslType: 'texture_depth_cube';
};
export declare const textureDepthCube: textureDepthCube;
export type textureDepthCubeArray = {
    type: 'texture_depth_cube_array';
    wgslType: 'texture_depth_cube_array';
};
export declare const textureDepthCubeArray: textureDepthCubeArray;
export type textureDepthMultisampled2d = {
    type: 'texture_depth_multisampled_2d';
    wgslType: 'texture_depth_multisampled_2d';
};
export declare const textureDepthMultisampled2d: textureDepthMultisampled2d;
/** Union of all depth texture descriptors. */
export type DepthTexture = textureDepth2d | textureDepth2dArray | textureDepthCube | textureDepthCubeArray | textureDepthMultisampled2d;
/** Non-cube depth textures, used by DepthTextureNode. */
export type FlatDepthTexture = textureDepth2d | textureDepth2dArray | textureDepthMultisampled2d;
/** Cube depth textures, for future DepthCubeTextureNode. */
export type CubeDepthTexture = textureDepthCube | textureDepthCubeArray;
/** WGSL access mode for a storage texture binding. */
export type StorageTextureAccess = 'read' | 'write' | 'read_write';
/**
 * Per-format info for storage textures. `channel` is the WGSL channel type of the texel value
 * (drives the textureStore/textureLoad value type `vec4<channel>`); `readWrite` is whether the
 * format permits `access: 'read_write'`.
 *
 * Per the core WebGPU "Texture Format Capabilities" table, ONLY the 32-bit single-channel
 * formats — `r32uint`, `r32sint`, `r32float` — support `read_write` storage access. Every other
 * storage-capable format is read-only / write-only. (`bgra8unorm` storage also needs the
 * `bgra8unorm-storage` feature.) This is enforced in `storageTexture()` as a friendly early error;
 * the device is the ultimate authority.
 */
export declare const STORAGE_FORMATS: {
    readonly rgba8unorm: {
        readonly channel: "f32";
        readonly readWrite: false;
    };
    readonly rgba8snorm: {
        readonly channel: "f32";
        readonly readWrite: false;
    };
    readonly rgba8uint: {
        readonly channel: "u32";
        readonly readWrite: false;
    };
    readonly rgba8sint: {
        readonly channel: "i32";
        readonly readWrite: false;
    };
    readonly bgra8unorm: {
        readonly channel: "f32";
        readonly readWrite: false;
    };
    readonly rgba16uint: {
        readonly channel: "u32";
        readonly readWrite: false;
    };
    readonly rgba16sint: {
        readonly channel: "i32";
        readonly readWrite: false;
    };
    readonly rgba16float: {
        readonly channel: "f32";
        readonly readWrite: false;
    };
    readonly r32uint: {
        readonly channel: "u32";
        readonly readWrite: true;
    };
    readonly r32sint: {
        readonly channel: "i32";
        readonly readWrite: true;
    };
    readonly r32float: {
        readonly channel: "f32";
        readonly readWrite: true;
    };
    readonly rg32uint: {
        readonly channel: "u32";
        readonly readWrite: false;
    };
    readonly rg32sint: {
        readonly channel: "i32";
        readonly readWrite: false;
    };
    readonly rg32float: {
        readonly channel: "f32";
        readonly readWrite: false;
    };
    readonly rgba32uint: {
        readonly channel: "u32";
        readonly readWrite: false;
    };
    readonly rgba32sint: {
        readonly channel: "i32";
        readonly readWrite: false;
    };
    readonly rgba32float: {
        readonly channel: "f32";
        readonly readWrite: false;
    };
};
/** A WebGPU storage-capable texel format. */
export type StorageTextureFormat = keyof typeof STORAGE_FORMATS;
/** The vec4 value descriptor for a storage format's channel (textureStore/Load value type). */
export type StorageValueOf<F extends StorageTextureFormat> = (typeof STORAGE_FORMATS)[F]['channel'] extends 'u32' ? vec4u : (typeof STORAGE_FORMATS)[F]['channel'] extends 'i32' ? vec4i : vec4f;
/** Runtime version of StorageValueOf — maps a format to its vec4 value descriptor. */
export declare function storageValueOf(format: StorageTextureFormat): vec4f | vec4i | vec4u;
export type textureStorage1d<F extends StorageTextureFormat = StorageTextureFormat, A extends StorageTextureAccess = StorageTextureAccess> = {
    type: 'texture_storage_1d';
    wgslType: `texture_storage_1d<${F}, ${A}>`;
    dim: '1d';
    format: F;
    access: A;
};
export declare function textureStorage1d<F extends StorageTextureFormat = 'rgba8unorm', A extends StorageTextureAccess = 'write'>(format?: F, access?: A): textureStorage1d<F, A>;
export type textureStorage2d<F extends StorageTextureFormat = StorageTextureFormat, A extends StorageTextureAccess = StorageTextureAccess> = {
    type: 'texture_storage_2d';
    wgslType: `texture_storage_2d<${F}, ${A}>`;
    dim: '2d';
    format: F;
    access: A;
};
export declare function textureStorage2d<F extends StorageTextureFormat = 'rgba8unorm', A extends StorageTextureAccess = 'write'>(format?: F, access?: A): textureStorage2d<F, A>;
export type textureStorage2dArray<F extends StorageTextureFormat = StorageTextureFormat, A extends StorageTextureAccess = StorageTextureAccess> = {
    type: 'texture_storage_2d_array';
    wgslType: `texture_storage_2d_array<${F}, ${A}>`;
    dim: '2d_array';
    format: F;
    access: A;
};
export declare function textureStorage2dArray<F extends StorageTextureFormat = 'rgba8unorm', A extends StorageTextureAccess = 'write'>(format?: F, access?: A): textureStorage2dArray<F, A>;
export type textureStorage3d<F extends StorageTextureFormat = StorageTextureFormat, A extends StorageTextureAccess = StorageTextureAccess> = {
    type: 'texture_storage_3d';
    wgslType: `texture_storage_3d<${F}, ${A}>`;
    dim: '3d';
    format: F;
    access: A;
};
export declare function textureStorage3d<F extends StorageTextureFormat = 'rgba8unorm', A extends StorageTextureAccess = 'write'>(format?: F, access?: A): textureStorage3d<F, A>;
/** Union of all storage texture descriptors. */
export type StorageTexture = textureStorage1d | textureStorage2d | textureStorage2dArray | textureStorage3d;
/** Union of all texture descriptors (sampled + depth + storage). */
export type Texture = SampledTexture | DepthTexture | StorageTexture;
export type sampler = {
    type: 'sampler';
    wgslType: 'sampler';
};
export declare const sampler: sampler;
export type samplerComparison = {
    type: 'sampler_comparison';
    wgslType: 'sampler_comparison';
};
export declare const samplerComparison: samplerComparison;
export type Void = {
    type: 'void';
    wgslType: 'void';
};
export declare const Void: Void;
export type WgslFn = {
    type: 'wgslfn';
    wgslType: 'wgslfn';
};
export declare const WgslFn: WgslFn;
export type Any = f32 | i32 | u32 | bool | f16 | vec2f | vec2i | vec2u | vec2bool | vec2h | vec3f | vec3i | vec3u | vec3bool | vec3h | vec4f | vec4i | vec4u | vec4bool | vec4h | mat2x2f | mat2x3f | mat2x4f | mat3x2f | mat3x3f | mat3x4f | mat4x2f | mat4x3f | mat4x4f | mat2x2h | mat2x3h | mat2x4h | mat3x2h | mat3x3h | mat3x4h | mat4x2h | mat4x3h | mat4x4h | atomicI32 | atomicU32 | StructDesc | array<any> | sizedArray<any> | texture1d | texture2d | texture2dArray | texture3d | textureCube | textureCubeArray | textureMultisampled2d | textureDepth2d | textureDepth2dArray | textureDepthCube | textureDepthCubeArray | textureDepthMultisampled2d | textureStorage1d | textureStorage2d | textureStorage2dArray | textureStorage3d | sampler | samplerComparison | Void | WgslFn;
/** Extract the descriptor type for a field K from struct descriptor D */
export type StructField<D extends Any, K extends string> = D extends StructDesc<infer S> ? (K extends keyof S ? S[K] : never) : never;
/** Extract keys from a struct descriptor */
export type StructKeys<D extends Any> = D extends StructDesc<infer S> ? keyof S & string : never;
/** Extract the schema type from a struct descriptor (or StructDef which extends StructDesc) */
export type StructSchemaOf<D extends Any> = D extends StructDesc<infer S> ? S : never;
type IsScalar<D extends Any> = D extends {
    type: 'f32' | 'i32' | 'u32' | 'bool' | 'f16';
} ? true : false;
type IsMat<D extends Any> = D extends {
    type: 'mat2x2f' | 'mat2x3f' | 'mat2x4f' | 'mat3x2f' | 'mat3x3f' | 'mat3x4f' | 'mat4x2f' | 'mat4x3f' | 'mat4x4f' | 'mat2x2h' | 'mat2x3h' | 'mat2x4h' | 'mat3x2h' | 'mat3x3h' | 'mat3x4h' | 'mat4x2h' | 'mat4x3h' | 'mat4x4h';
} ? true : false;
type IsVec<D extends Any> = D extends {
    type: 'vec2f' | 'vec2i' | 'vec2u' | 'vec2<bool>' | 'vec2h' | 'vec3f' | 'vec3i' | 'vec3u' | 'vec3<bool>' | 'vec3h' | 'vec4f' | 'vec4i' | 'vec4u' | 'vec4<bool>' | 'vec4h';
} ? true : false;
/** Type-level mul result: mat*vec→vec, scalar*T→T, T*scalar→T, else A */
export type MulResultDesc<A extends Any, B extends Any> = IsMat<A> extends true ? (IsVec<B> extends true ? B : A) : IsScalar<B> extends true ? A : IsScalar<A> extends true ? B : A;
/** Type-level add/sub/div result: scalar op T→T, else A */
export type ArithResultDesc<A extends Any, B extends Any> = IsScalar<A> extends true ? (IsScalar<B> extends true ? A : B) : A;
/** Type-level comparison result: vec→vec<bool>, scalar→bool */
export type CompareResultDesc<D extends Any> = D extends vec2f | vec2i | vec2u | vec2h ? vec2bool : D extends vec3f | vec3i | vec3u | vec3h ? vec3bool : D extends vec4f | vec4i | vec4u | vec4h ? vec4bool : bool;
/** Extract the element descriptor from a vec descriptor, or return self for scalars */
export type VecElementDesc<D extends Any> = D extends vec2f | vec3f | vec4f ? f32 : D extends vec2i | vec3i | vec4i ? i32 : D extends vec2u | vec3u | vec4u ? u32 : D extends vec2h | vec3h | vec4h ? f16 : D extends vec2bool | vec3bool | vec4bool ? bool : D extends Scalar ? D : Any;
/** Map a vec or scalar descriptor to its corresponding vec2 type */
export type Vec2DescOf<D extends Any> = D extends vec2f | vec3f | vec4f | f32 ? vec2f : D extends vec2i | vec3i | vec4i | i32 ? vec2i : D extends vec2u | vec3u | vec4u | u32 ? vec2u : D extends vec2h | vec3h | vec4h | f16 ? vec2h : D extends vec2bool | vec3bool | vec4bool | bool ? vec2bool : Vec2;
/** Map a vec or scalar descriptor to its corresponding vec3 type */
export type Vec3DescOf<D extends Any> = D extends vec2f | vec3f | vec4f | f32 ? vec3f : D extends vec2i | vec3i | vec4i | i32 ? vec3i : D extends vec2u | vec3u | vec4u | u32 ? vec3u : D extends vec2h | vec3h | vec4h | f16 ? vec3h : D extends vec2bool | vec3bool | vec4bool | bool ? vec3bool : Vec3;
/** Map a vec or scalar descriptor to its corresponding vec4 type */
export type Vec4DescOf<D extends Any> = D extends vec2f | vec3f | vec4f | f32 ? vec4f : D extends vec2i | vec3i | vec4i | i32 ? vec4i : D extends vec2u | vec3u | vec4u | u32 ? vec4u : D extends vec2h | vec3h | vec4h | f16 ? vec4h : D extends vec2bool | vec3bool | vec4bool | bool ? vec4bool : Vec4;
/**
 * Maps a schema descriptor to its corresponding TypedArray type.
 * - i32/vec*i → Int32Array
 * - u32/vec*u → Uint32Array
 * - f32/vec*f/mat → Float32Array
 * - structs/arrays → any typed array (user knows the correct type)
 */
export type TypedArrayFor<D extends Any> = D extends i32 | vec2i | vec3i | vec4i ? Int32Array : D extends u32 | vec2u | vec3u | vec4u ? Uint32Array : D extends f32 | vec2f | vec3f | vec4f | mat2x2f | mat2x3f | mat2x4f | mat3x2f | mat3x3f | mat3x4f | mat4x2f | mat4x3f | mat4x4f ? Float32Array : Float32Array | Int32Array | Uint32Array | Uint16Array | Int16Array | Uint8Array | Int8Array;
export type ScalarType = 'f32' | 'i32' | 'u32' | 'bool' | 'f16';
export type Vec2Type = 'vec2f' | 'vec2i' | 'vec2u' | 'vec2<bool>' | 'vec2h';
export type Vec3Type = 'vec3f' | 'vec3i' | 'vec3u' | 'vec3<bool>' | 'vec3h';
export type Vec4Type = 'vec4f' | 'vec4i' | 'vec4u' | 'vec4<bool>' | 'vec4h';
export type VecType = Vec2Type | Vec3Type | Vec4Type;
export type MatType = 'mat2x2f' | 'mat2x3f' | 'mat2x4f' | 'mat3x2f' | 'mat3x3f' | 'mat3x4f' | 'mat4x2f' | 'mat4x3f' | 'mat4x4f' | 'mat2x2h' | 'mat2x3h' | 'mat2x4h' | 'mat3x2h' | 'mat3x3h' | 'mat3x4h' | 'mat4x2h' | 'mat4x3h' | 'mat4x4h';
export type PrimType = ScalarType | VecType | MatType;
export type AtomicType = 'atomic<i32>' | 'atomic<u32>';
export type WgslType = PrimType | AtomicType | `array<${string}>` | `array<${string}, ${number}>` | string;
export declare function isAtomicDesc(desc: Any): desc is Atomic;
export declare function isStructDesc(desc: Any): desc is StructDesc;
export declare function isArrayDesc(desc: Any): desc is array;
export declare function isSizedArrayDesc(desc: Any): desc is sizedArray;
export declare function isTextureDesc(desc: Any): desc is SampledTexture;
export declare function isDepthTextureDesc(desc: Any): desc is DepthTexture;
export declare function isStorageTextureDesc(desc: Any): desc is StorageTexture;
export declare function isAnyTextureDesc(desc: Any): desc is Texture;
export declare function isCubeTextureDesc(desc: Texture): boolean;
export declare function isCubeArrayTextureDesc(desc: Texture): boolean;
export declare function isArrayTextureDesc(desc: Texture): boolean;
/** Returns the GPUTextureDimension for a texture schema type */
export declare function textureDimension(desc: Texture): GPUTextureDimension;
/** Returns the GPUTextureViewDimension for a texture schema type */
export declare function textureViewDimension(desc: Texture): GPUTextureViewDimension;
export declare function isSamplerDesc(desc: Any): desc is sampler;
export declare function isSamplerComparisonDesc(desc: Any): desc is samplerComparison;
export declare function isMatDesc(desc: Any): desc is Mat;
export declare function isVecDesc(desc: Any): desc is Vec;
export declare function isStructDef(desc: Any): desc is StructDesc;
export declare function atomic(inner: i32): atomicI32;
export declare function atomic(inner: u32): atomicU32;
export type array<E extends Any = Any> = {
    type: 'array';
    wgslType: `array<${E['wgslType']}>`;
    element: E;
    length?: undefined;
};
export declare function array<E extends Any>(element: E): {
    type: 'array';
    wgslType: `array<${E['wgslType']}>`;
    element: E;
    length?: undefined;
};
export type sizedArray<E extends Any = Any, N extends number = number> = {
    type: 'sized-array';
    wgslType: `array<${E['wgslType']}, ${N}>`;
    element: E;
    length: N;
};
export declare function sizedArray<E extends Any, N extends number>(element: E, length: N): {
    type: 'sized-array';
    wgslType: `array<${E['wgslType']}, ${N}>`;
    element: E;
    length: N;
};
export type ArrayElement<D extends Any> = D extends {
    type: 'array';
    element: infer E extends Any;
} ? E : D extends {
    type: 'sized-array';
    element: infer E extends Any;
} ? E : never;
export declare const samplerDesc: () => sampler;
export declare const samplerComparisonDesc: () => samplerComparison;
export type Infer<D extends Any> = D extends {
    type: 'struct';
    fields: infer S extends Record<string, Any>;
} ? {
    [K in keyof S]: Infer<S[K]>;
} : D extends Atomic ? number : D extends f32 | i32 | u32 | bool | f16 ? number : D extends Vec2 ? [number, number] : D extends Vec3 ? [number, number, number] : D extends Vec4 ? [number, number, number, number] : D extends mat2x2f | mat2x2h ? [number, number, number, number] : D extends mat3x3f | mat3x3h ? [number, number, number, number, number, number, number, number, number] : D extends mat4x4f | mat4x4h ? [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number] : D extends mat2x3f | mat2x3h | mat3x2f | mat3x2h ? [number, number, number, number, number, number] : D extends mat2x4f | mat2x4h | mat4x2f | mat4x2h ? [number, number, number, number, number, number, number, number] : D extends mat3x4f | mat3x4h | mat4x3f | mat4x3h ? [number, number, number, number, number, number, number, number, number, number, number, number] : D extends {
    type: 'sized-array';
    element: infer E extends Any;
} ? Infer<E>[] : D extends {
    type: 'array';
    element: infer E extends Any;
} ? Infer<E>[] : never;
export type StructFields<D extends Any> = D extends {
    type: 'struct';
    fields: infer S extends Record<string, Any>;
} ? S : never;
export type MatColumnDesc<D extends Any> = D extends mat2x2f | mat3x2f | mat4x2f ? vec2f : D extends mat2x3f | mat3x3f | mat4x3f ? vec3f : D extends mat2x4f | mat3x4f | mat4x4f ? vec4f : D extends mat2x2h | mat3x2h | mat4x2h ? vec2h : D extends mat2x3h | mat3x3h | mat4x3h ? vec3h : D extends mat2x4h | mat3x4h | mat4x4h ? vec4h : never;
export type ElementOf<D extends Any> = D extends {
    type: 'array';
    element: infer E extends Any;
} ? E : D extends {
    type: 'sized-array';
    element: infer E extends Any;
} ? E : D extends Mat ? MatColumnDesc<D> : D extends Vec ? VecElementDesc<D> : never;
export declare function roundUp(n: number, align: number): number;
export declare function wgslAlignOf(desc: Any): number;
export declare function wgslSizeOf(desc: Any): number;
export declare function wgslStrideOf(desc: Any): number;
export declare function itemSizeOf(desc: Any): number;
export declare function typedArrayCtorOf(desc: Any): new (length: number) => Float32Array | Int32Array | Uint32Array;
export declare function descFromWgslType(wgslType: string): Any;
export declare function vecElementDescOrSelf(desc: Any): Any;
export declare function vec2DescOf(desc: Any): Vec2;
export declare function vec3DescOf(desc: Any): Vec3;
export declare function vec4DescOf(desc: Any): Vec4;
export declare function matColumnDesc(desc: Mat): Vec;
export declare function mulResultDesc(a: Any, b: Any): Any;
export declare function arithResultDesc(a: Any, b: Any): Any;
export declare function compareResultDesc(d: Any): Any;
export {};
