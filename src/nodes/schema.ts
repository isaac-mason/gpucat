/**
 * schema.ts — WgslDesc type descriptors and S.* constructor namespace.
 *
 * Import this module as:
 *   import * as S from './schema.js'
 *
 * Then use S.f32(), S.vec3f(), S.mat4x4f() etc. as WgslDesc descriptors in
 * struct() schemas and Fn() param lists.
 */

export type WgslType = string;

export type WgslDesc<T extends WgslType> = { readonly wgslType: T };

export type StructSchema = Record<string, WgslDesc<WgslType>>;

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

export function itemSizeOf(desc: WgslDesc<WgslType>): number {
    const t = desc.wgslType;
    if (t === 'f32' || t === 'i32' || t === 'u32' || t === 'bool') return 1;
    if (t === 'vec2f' || t === 'vec2i' || t === 'vec2u' || t === 'vec2<bool>') return 2;
    if (t === 'vec3f' || t === 'vec3i' || t === 'vec3u' || t === 'vec3<bool>') return 3;
    if (t === 'vec4f' || t === 'vec4i' || t === 'vec4u' || t === 'vec4<bool>') return 4;
    if (t === 'mat2x2f') return 4;
    if (t === 'mat2x3f' || t === 'mat3x2f') return 6;
    if (t === 'mat2x4f' || t === 'mat4x2f') return 8;
    if (t === 'mat3x3f') return 9;
    if (t === 'mat3x4f' || t === 'mat4x3f') return 12;
    if (t === 'mat4x4f') return 16;
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
// WgslDesc constructors — use as S.f32(), S.vec3f(), S.mat4x4f() etc.
// ---------------------------------------------------------------------------

export const f32    = (): WgslDesc<'f32'>    => ({ wgslType: 'f32' });
export const i32    = (): WgslDesc<'i32'>    => ({ wgslType: 'i32' });
export const u32    = (): WgslDesc<'u32'>    => ({ wgslType: 'u32' });
export const bool   = (): WgslDesc<'bool'>   => ({ wgslType: 'bool' });

export const vec2f  = (): WgslDesc<'vec2f'>  => ({ wgslType: 'vec2f' });
export const vec3f  = (): WgslDesc<'vec3f'>  => ({ wgslType: 'vec3f' });
export const vec4f  = (): WgslDesc<'vec4f'>  => ({ wgslType: 'vec4f' });
export const vec2i  = (): WgslDesc<'vec2i'>  => ({ wgslType: 'vec2i' });
export const vec3i  = (): WgslDesc<'vec3i'>  => ({ wgslType: 'vec3i' });
export const vec4i  = (): WgslDesc<'vec4i'>  => ({ wgslType: 'vec4i' });
export const vec2u  = (): WgslDesc<'vec2u'>  => ({ wgslType: 'vec2u' });
export const vec3u  = (): WgslDesc<'vec3u'>  => ({ wgslType: 'vec3u' });
export const vec4u  = (): WgslDesc<'vec4u'>  => ({ wgslType: 'vec4u' });

export const mat2x2f = (): WgslDesc<'mat2x2f'> => ({ wgslType: 'mat2x2f' });
export const mat2x3f = (): WgslDesc<'mat2x3f'> => ({ wgslType: 'mat2x3f' });
export const mat2x4f = (): WgslDesc<'mat2x4f'> => ({ wgslType: 'mat2x4f' });
export const mat3x2f = (): WgslDesc<'mat3x2f'> => ({ wgslType: 'mat3x2f' });
export const mat3x3f = (): WgslDesc<'mat3x3f'> => ({ wgslType: 'mat3x3f' });
export const mat3x4f = (): WgslDesc<'mat3x4f'> => ({ wgslType: 'mat3x4f' });
export const mat4x2f = (): WgslDesc<'mat4x2f'> => ({ wgslType: 'mat4x2f' });
export const mat4x3f = (): WgslDesc<'mat4x3f'> => ({ wgslType: 'mat4x3f' });
export const mat4x4f = (): WgslDesc<'mat4x4f'> => ({ wgslType: 'mat4x4f' });
