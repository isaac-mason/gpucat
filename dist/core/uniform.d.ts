import type { Any } from 'gpucat/dist/schema/schema';
export type UniformValue = number | number[] | Float32Array | Int32Array | Uint32Array;
/**
 * Update frequency for uniform groups.
 */
export declare const UniformUpdateType: {
    readonly NONE: "none";
    readonly FRAME: "frame";
    readonly RENDER: "render";
    readonly OBJECT: "object";
};
export type UniformUpdateType = (typeof UniformUpdateType)[keyof typeof UniformUpdateType];
/**
 * Uniform group — determines WGSL @group index and struct packing.
 */
export declare class UniformGroup {
    readonly name: string;
    readonly shared: boolean;
    readonly order: number;
    readonly updateType: UniformUpdateType;
    constructor(name: string, shared: boolean, order: number, updateType?: UniformUpdateType);
}
/** Create a per-object (non-shared) uniform group. */
export declare const uniformGroup: (name: string, order?: number, updateType?: UniformUpdateType) => UniformGroup;
/** Create a shared uniform group. */
export declare const sharedUniformGroup: (name: string, order?: number, updateType?: UniformUpdateType) => UniformGroup;
/**
 * frameGroup — shared uniforms updated once per frame.
 * Contains time uniforms (timeElapsed, timeDelta).
 * Maps to @group(0) with FRAME update type.
 */
export declare const frameGroup: UniformGroup;
/**
 * renderGroup — shared uniforms updated per render() call.
 * Contains camera uniforms (projection, view, position, near, far).
 * Maps to @group(0) with RENDER update type.
 */
export declare const renderGroup: UniformGroup;
/**
 * objectGroup — per-object uniforms updated per draw call.
 * Contains mesh matrices (modelWorldMatrix, modelNormalMatrix) and user material uniforms.
 * Maps to @group(1) with OBJECT update type.
 */
export declare const objectGroup: UniformGroup;
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
export declare class Uniform<T extends Any = Any> {
    readonly schema: T;
    readonly group: UniformGroup;
    value: UniformValue | null;
    constructor(schema: T, initialValue?: UniformValue, group?: UniformGroup);
}
