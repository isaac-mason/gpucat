/**
 * schema.ts — WgslDesc type descriptors, struct(), and S.* constructor namespace.
 *
 * Import this module as:
 *   import * as S from './schema.js'
 *
 * Then use S.f32(), S.vec3f(), S.mat4x4f() etc. as WgslDesc descriptors in
 * struct() schemas and Fn() param lists.
 *
 * For storage buffers, use S.array() to describe the element type:
 *   S.array(S.mat4x4f())   → ArrayDesc whose wgslType is 'array<mat4x4f>'
 *   S.array(S.vec4f())     → ArrayDesc whose wgslType is 'array<vec4f>'
 * ArrayDesc carries the element descriptor so the renderer can derive itemSize
 * and the appropriate TypedArray constructor automatically.
 */

import { FieldNode, GpuTypedArray, StructNode, type Node, type StructMember, type WgslType } from './nodes';


// ---------------------------------------------------------------------------
// ArrayDesc — typed array descriptor for storage buffers
// (Canonical home; schema.ts re-exports these.)
// ---------------------------------------------------------------------------

/**
 * A WgslDesc describing an `array<E>` storage buffer element type.
 *
 * - `wgslType` is the full WGSL array type string, e.g. `'array<mat4x4f>'`
 * - `elementDesc` is the inner element descriptor, used by the renderer to
 *   derive `itemSize` and the appropriate `TypedArray` constructor
 *
 * @example
 * import * as S from './schema.js'
 * const matrices = S.array(S.mat4x4f())  // ArrayDesc<'mat4x4f'>
 * // matrices.wgslType  === 'array<mat4x4f>'
 * // matrices.elementDesc === S.mat4x4f()
 */
export type ArrayDesc<E extends WgslType> = WgslDesc<`array<${E}>`> & {
    readonly isArrayDesc: true;
    readonly elementDesc: WgslDesc<E>;
};

/** Returns true if a WgslDesc is an ArrayDesc. */
export function isArrayDesc(desc: WgslDesc<WgslType>): desc is ArrayDesc<WgslType> {
    return 'isArrayDesc' in desc && (desc as ArrayDesc<WgslType>).isArrayDesc === true;
}

/**
 * Create an ArrayDesc for a storage buffer whose elements are of type `elementDesc`.
 *
 * @example
 * S.array(S.mat4x4f())  // → wgslType: 'array<mat4x4f>', itemSize: 16, Float32Array
 * S.array(S.vec4f())    // → wgslType: 'array<vec4f>',   itemSize: 4,  Float32Array
 * S.array(S.u32())      // → wgslType: 'array<u32>',     itemSize: 1,  Uint32Array
 */
export function array<E extends WgslType>(elementDesc: WgslDesc<E>): ArrayDesc<E> {
    return {
        wgslType: `array<${elementDesc.wgslType}>`,
        isArrayDesc: true,
        elementDesc,
    };
}

/** Number of scalar components in a WGSL numeric type. */
export function itemSizeOf(desc: WgslDesc<WgslType>): number {
    const t = desc.wgslType;
    if (t === 'f32' || t === 'i32' || t === 'u32' || t === 'bool') return 1;
    if (t === 'vec2f' || t === 'vec2i' || t === 'vec2u' || t === 'vec2b') return 2;
    if (t === 'vec3f' || t === 'vec3i' || t === 'vec3u' || t === 'vec3b') return 3;
    if (t === 'vec4f' || t === 'vec4i' || t === 'vec4u' || t === 'vec4b') return 4;
    if (t === 'mat2x2f') return 4;
    if (t === 'mat2x3f' || t === 'mat3x2f') return 6;
    if (t === 'mat2x4f' || t === 'mat4x2f') return 8;
    if (t === 'mat3x3f') return 9;
    if (t === 'mat3x4f' || t === 'mat4x3f') return 12;
    if (t === 'mat4x4f') return 16;
    throw new Error(`[gpucat] itemSizeOf: unsupported type '${t}'. Use S.array() with numeric types only.`);
}

/** The TypedArray constructor appropriate for a WGSL numeric type's scalar kind. */
export function typedArrayCtorOf(desc: WgslDesc<WgslType>): new (length: number) => GpuTypedArray
 {
    const t = desc.wgslType;
    if (t === 'i32' || t === 'vec2i' || t === 'vec3i' || t === 'vec4i') return Int32Array;
    if (t === 'u32' || t === 'vec2u' || t === 'vec3u' || t === 'vec4u') return Uint32Array;
    // f32, bool, all mat types → Float32Array
    return Float32Array;
}

/**
 * A WGSL type descriptor: a plain object carrying the WGSL type string as a
 * phantom type parameter. Used as field descriptors in struct() and as
 * Fn() param type declarations.
 *
 * Example: S.f32() returns WgslDesc<'f32'>, S.mat4x4f() returns WgslDesc<'mat4x4f'>.
 * See src/nodes/schema.ts for the WgslDesc constructor namespace.
 */
export type WgslDesc<T extends WgslType> = { readonly wgslType: T };

/** Record of field name → WgslDesc, describing a WGSL struct's members. */
export type StructSchema = Record<string, WgslDesc<WgslType>>;

/**
 * A WgslDesc whose type is the name of a nested struct.
 * Carries the full StructDef so the compiler can resolve declaration order.
 */
export type StructDesc<S extends StructSchema> = WgslDesc<string> & {
    readonly structDef: StructDef<S>;
};

/**
 * Given a StructSchema, produces an object type where each key maps to the
 * appropriately-typed Node. $node is the base node the instance was created from.
 */
export type StructInstance<S extends StructSchema> = {
    readonly $node: Node<WgslType>;
} & {
    readonly [K in keyof S]: Node<S[K]['wgslType']>;
};

/** The object returned by struct(). */
export type StructDef<S extends StructSchema> = {
    readonly schema: S;
    readonly typeName: string;
    readonly members: StructMember[];
    readonly node: StructNode;
    /** Any nested struct defs referenced by this struct's fields, keyed by typeName. */
    readonly nestedDefs: ReadonlyMap<string, StructDef<StructSchema>>;
    instantiate<N extends Node<WgslType>>(base: N): StructInstance<S>;
};

// ---------------------------------------------------------------------------
// Module-level StructNode → StructDef registry (populated by struct())
// ---------------------------------------------------------------------------

const _structNodeRegistry: WeakMap<StructNode, StructDef<StructSchema>> = new WeakMap();
const _structNameRegistry: Map<string, StructDef<StructSchema>> = new Map();

/** Look up the StructDef that owns a given StructNode, if any. */
export function lookupStructDef(node: StructNode): StructDef<StructSchema> | undefined {
    return _structNodeRegistry.get(node);
}

/** Look up a StructDef by its WGSL type name, if registered via struct(). */
export function lookupStructDefByName(typeName: string): StructDef<StructSchema> | undefined {
    return _structNameRegistry.get(typeName);
}

// ---------------------------------------------------------------------------
// struct
// ---------------------------------------------------------------------------

/**
 * Define a typed WGSL struct schema.
 *
 * @example
 * import * as S from './schema.js'
 *
 * const CameraStruct = struct('Camera', {
 *     projectionMatrix: S.mat4x4f(),
 *     viewMatrix:       S.mat4x4f(),
 *     position:         S.vec3f(),
 *     near:             S.f32(),
 *     far:              S.f32(),
 * });
 */
export function struct<S extends StructSchema>(typeName: string, schema: S): StructDef<S> {
    const members: StructMember[] = Object.entries(schema).map(([name, desc]) => ({ name, type: desc.wgslType }));
    const node = new StructNode(typeName, members);

    // Collect any StructDesc fields as nested deps
    const nestedDefs: Map<string, StructDef<StructSchema>> = new Map();
    for (const desc of Object.values(schema)) {
        if (isStructDesc(desc)) {
            nestedDefs.set(desc.structDef.typeName, desc.structDef);
        }
    }

    function instantiate<N extends Node<WgslType>>(base: N): StructInstance<S> {
        const result: Record<string, Node<WgslType>> = { $node: base };
        for (const [name, desc] of Object.entries(schema)) {
            result[name] = new FieldNode(desc.wgslType, base, name);
        }
        return result as StructInstance<S>;
    }

    const def: StructDef<S> = { schema, typeName, members, node, nestedDefs, instantiate };
    _structNodeRegistry.set(node, def);
    _structNameRegistry.set(typeName, def);
    return def;
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

// ---------------------------------------------------------------------------
// S.nested — nested struct descriptor
// ---------------------------------------------------------------------------

/** Returns true if a WgslDesc is a StructDesc (carries a nested StructDef). */
export function isStructDesc<S extends StructSchema>(desc: WgslDesc<WgslType>): desc is StructDesc<S> {
    return 'structDef' in desc;
}

/**
 * Wrap an existing StructDef as a WgslDesc for use as a field inside another struct() schema.
 *
 * @example
 * const Inner = struct('Inner', { x: S.f32() });
 * const Outer = struct('Outer', { inner: S.nested(Inner), y: S.f32() });
 */
export function nested<S extends StructSchema>(def: StructDef<S>): StructDesc<S> {
    return { wgslType: def.typeName, structDef: def };
}
