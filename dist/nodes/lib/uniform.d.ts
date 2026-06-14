import { Node, type StructDef, type StructInstance, ConstructNode, LiteralNode } from './core';
import type { StructSchema, Any } from '../../schema/schema';
import type { NodeFrame } from '../../renderer/node-frame';
import { Uniform, UniformGroup, UniformUpdateType, objectGroup, renderGroup, frameGroup, type UniformValue } from '../../core/uniform';
export declare class UniformNode<D extends Any> extends Node<D> {
    /** uniform name */
    name: string;
    /** The underlying Uniform data container */
    uniform: Uniform<D>;
    /**
     * The uniform group, determines the WGSL @group index, update cadence, and
     * struct packing. Defaults to `objectGroup`; reassign (e.g. `u.group = renderGroup`)
     * before the node is first rendered to move it to a shared group.
     */
    get group(): UniformGroup;
    set group(g: UniformGroup);
    /** Get the current value */
    get value(): UniformValue<D> | null;
    /** Set value directly */
    set value(v: UniformValue<D> | null);
    constructor(uniform: Uniform<D>, name: string);
    /**
     * Register an update callback that runs per frame/render/object.
     * The callback returns a value which is assigned to the uniform's value.
     */
    onUpdate(callback: (frame: NodeFrame) => unknown, updateType: UniformUpdateType): this;
    /** Register an update callback for FRAME update type. */
    onFrameUpdate(callback: (frame: NodeFrame) => unknown): this;
    /** Register an update callback for RENDER update type. */
    onRenderUpdate(callback: (frame: NodeFrame) => unknown): this;
    /** Register an update callback for OBJECT update type. */
    onObjectUpdate(callback: (frame: NodeFrame) => unknown): this;
}
export { Uniform, UniformGroup, UniformUpdateType, objectGroup, renderGroup, frameGroup };
/**
 * Declare a material uniform.
 *
 * **Value-based form**, pass a Uniform object; the node references it:
 *   const roughnessU = new Uniform(d.f32, 0.5);
 *   const roughness = uniform(roughnessU);
 *   roughnessU.set(0.8);  // update via Uniform
 *
 * **Name-based form**, resolved from material.uniforms at render time:
 *   const roughness = uniform('roughness', d.f32);
 *   const myVal = uniform('myVal', MyStruct);  // struct variant
 *
 * **Inline form**, pass a typed LiteralNode as the initialiser:
 *   uniform(f32(0.5))               // anonymous, uniformId derived from type
 *   uniform(f32(0.5), 'roughness')  // explicit name used as the WGSL field name
 *   uniform(vec4f(1, 0, 0, 1), 'baseColor')
 */
export declare function uniform<D extends Any>(u: Uniform<D>): UniformNode<D>;
export declare function uniform<D extends Any>(name: string, schema: D): UniformNode<D>;
export declare function uniform<S extends StructSchema>(name: string, def: StructDef<S>): StructInstance<S>;
export declare function uniform<D extends Any>(init: ConstructNode<D>, name?: string): UniformNode<D>;
export declare function uniform<D extends Any>(init: LiteralNode<D>, name?: string): UniformNode<D>;
