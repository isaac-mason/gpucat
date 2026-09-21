import { type Any, type Infer, type TypedArrayFor, typedArrayCtorOf } from '../schema/schema';

/** What may be assigned to a uniform: the schema's own shape, a plain array, or a matching typed array. */
export type UniformValue<T extends Any = Any> = Any extends T
    ? number | number[] | Float32Array | Int32Array | Uint32Array
    : Infer<T> | number[] | TypedArrayFor<T>;

/** What a uniform holds: no `number[]`, since a plain array is packed on write into the schema's own array. */
export type UniformStored<T extends Any = Any> = Any extends T
    ? number | Float32Array | Int32Array | Uint32Array
    : Infer<T> | TypedArrayFor<T>;

/**
 * Update frequency for uniform groups.
 */
export const UniformUpdateType = {
    NONE: 'none',
    FRAME: 'frame',
    RENDER: 'render',
    OBJECT: 'object',
} as const;
export type UniformUpdateType = (typeof UniformUpdateType)[keyof typeof UniformUpdateType];

/**
 * Uniform group, determines WGSL @group index and struct packing.
 */
export class UniformGroup {
    readonly name: string;
    readonly shared: boolean;
    readonly order: number;
    readonly updateType: UniformUpdateType;

    constructor(name: string, shared: boolean, order: number, updateType: UniformUpdateType = UniformUpdateType.NONE) {
        this.name = name;
        this.shared = shared;
        this.order = order;
        this.updateType = updateType;
    }
}

/** Create a per-object (non-shared) uniform group. */
export const uniformGroup = (name: string, order = 1, updateType: UniformUpdateType = UniformUpdateType.NONE) =>
    new UniformGroup(name, false, order, updateType);

/** Create a shared uniform group. */
export const sharedUniformGroup = (name: string, order = 0, updateType: UniformUpdateType = UniformUpdateType.NONE) =>
    new UniformGroup(name, true, order, updateType);

/**
 * frameGroup, shared uniforms updated once per frame.
 * Maps to @group(0) with FRAME update type.
 */
export const frameGroup = /*@__PURE__*/ sharedUniformGroup('frame', 0, UniformUpdateType.FRAME);

/**
 * renderGroup, shared uniforms updated per render() call.
 * Contains camera uniforms (projection, view, position, near, far).
 * Maps to @group(0) with RENDER update type.
 */
export const renderGroup = /*@__PURE__*/ sharedUniformGroup('render', 0, UniformUpdateType.RENDER);

/**
 * objectGroup, per-object uniforms updated per draw call.
 * Contains mesh matrices (modelWorldMatrix, modelNormalMatrix) and user material uniforms.
 * Maps to @group(1) with OBJECT update type.
 */
export const objectGroup = /*@__PURE__*/ uniformGroup('object', 1, UniformUpdateType.OBJECT);

/**
 * Core uniform data container.
 *
 * Owns the CPU-side value, version for dirty tracking, and group assignment.
 * Referenced by UniformNode in the DSL layer.
 *
 * @example
 * const roughness = new Uniform(d.f32, 0.5);
 * roughness.set(0.8);
 *
 * @example
 * const color = new Uniform(d.vec3f, [1, 0, 0]);
 * color.set([0, 1, 0]);
 *
 * @example With explicit group
 * const time = new Uniform(d.f32, 0, frameGroup);
 */
export class Uniform<T extends Any = Any> {
    readonly isUniform = true;
    readonly schema: T;
    /** Determines @group index, update cadence, and packing. Mutable, but only
     *  read at compile time, set it before the owning node is first rendered. */
    group: UniformGroup;
    private _value: UniformStored<T> | null = null;

    constructor(schema: T, initialValue?: UniformValue<T>, group: UniformGroup = objectGroup) {
        this.schema = schema;
        this.group = group;
        if (initialValue !== undefined) {
            this.value = initialValue;
        }
    }

    get value(): UniformStored<T> | null {
        return this._value;
    }

    /** A typed array is adopted by reference, so writing through it keeps updating this uniform. */
    set value(next: UniformValue<T> | null) {
        // Only a flat run of numbers packs. An array of vectors or matrices is already `Infer<T>`, and
        // `set` would flatten it to NaN at the wrong length.
        if (!Array.isArray(next) || typeof next[0] !== 'number') {
            this._value = next as UniformStored<T> | null;
            return;
        }
        const ArrayCtor = typedArrayCtorOf(this.schema);
        const packed = new ArrayCtor(next.length);
        packed.set(next as number[]);
        this._value = packed as UniformStored<T>;
    }
}

/** The factory form, matching `uniformGroup` and the other value constructors. */
export function createUniform<T extends Any>(schema: T, initialValue?: UniformValue<T>, group?: UniformGroup): Uniform<T> {
    return new Uniform(schema, initialValue, group);
}
