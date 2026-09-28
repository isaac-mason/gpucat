import { frameGroup, objectGroup, renderGroup, Uniform, UniformGroup, UniformUpdateType, type UniformValue } from '../../core/uniform';
import type { NodeFrame } from '../../renderer/core/node-frame';
import type { Any, StructSchema } from '../../schema/schema';
import { type ConstructNode, type LiteralNode, Node, NodeKind, type StructDef, type StructInstance } from './core';
export declare class UniformNode<D extends Any> extends Node<D> {
    readonly kind = NodeKind.Uniform;
    /**
     * Identity: the key this uniform dedupes under. For a name-based uniform it is also the author's
     * name; a value-based one gets a generated placeholder. Either way the SPELLING in emitted source
     * comes from `uniform.label` — the resource carries the name, as GpuBuffer and GpuTexture do.
     */
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
    /**
     * `name` is this uniform's identity — the key it dedupes under. When the author supplied it (the
     * usual case) it also becomes the resource's label, which is what the emitters spell the block
     * member with. `generatedName` marks the placeholder given to a uniform that has no author name;
     * those are numbered per compile instead, because the placeholder carries a node id.
     */
    constructor(uniform: Uniform<D>, name: string, generatedName?: boolean);
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
export declare function uniform<S extends StructSchema>(name: string, def: StructDef<S>): StructInstance<S>;
export declare function uniform<D extends Any>(name: string, schema: D): UniformNode<D>;
export declare function uniform<D extends Any>(init: ConstructNode<D>, name?: string): UniformNode<D>;
export declare function uniform<D extends Any>(init: LiteralNode<D>, name?: string): UniformNode<D>;
