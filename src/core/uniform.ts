import type { Any } from '../nodes/schema';

export type UniformValue = number | number[] | Float32Array | Int32Array | Uint32Array;

/**
 * Update frequency for uniform groups.
 */
export const UniformUpdateType = {
    NONE:   'none',
    FRAME:  'frame',
    RENDER: 'render',
    OBJECT: 'object',
} as const;
export type UniformUpdateType = (typeof UniformUpdateType)[keyof typeof UniformUpdateType];

/**
 * Uniform group — determines WGSL @group index and struct packing.
 */
export class UniformGroup {
    readonly name: string;
    readonly shared: boolean;
    readonly order: number;
    readonly updateType: UniformUpdateType;

    /**
     * Version counter — bumped by the renderer once per frame (for frameGroup)
     * or once per render pass (for renderGroup). Used for deduplication gating.
     */
    version: number = 0;

    constructor(
        name: string,
        shared: boolean,
        order: number,
        updateType: UniformUpdateType = UniformUpdateType.NONE
    ) {
        this.name = name;
        this.shared = shared;
        this.order = order;
        this.updateType = updateType;
    }
}

/** Create a per-object (non-shared) uniform group. */
export const uniformGroup = (
    name: string,
    order = 1,
    updateType: UniformUpdateType = UniformUpdateType.NONE
) => new UniformGroup(name, false, order, updateType);

/** Create a shared uniform group. */
export const sharedUniformGroup = (
    name: string,
    order = 0,
    updateType: UniformUpdateType = UniformUpdateType.NONE
) => new UniformGroup(name, true, order, updateType);

/**
 * frameGroup — shared uniforms updated once per frame.
 * Contains time uniforms (timeElapsed, timeDelta).
 * Maps to @group(0) with FRAME update type.
 */
export const frameGroup = /*@__PURE__*/ sharedUniformGroup('frame', 0, UniformUpdateType.FRAME);

/**
 * renderGroup — shared uniforms updated per render() call.
 * Contains camera uniforms (projection, view, position, near, far).
 * Maps to @group(0) with RENDER update type.
 */
export const renderGroup = /*@__PURE__*/ sharedUniformGroup('render', 0, UniformUpdateType.RENDER);

/**
 * objectGroup — per-object uniforms updated per draw call.
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
    readonly schema: T;
    readonly group: UniformGroup;
    value: UniformValue | null = null;

    constructor(schema: T, initialValue?: UniformValue, group: UniformGroup = objectGroup) {
        this.schema = schema;
        this.group = group;
        if (initialValue !== undefined) {
            this.value = initialValue;
        }
    }
}
