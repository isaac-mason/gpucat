import { Node, NodeKind, type StructDef, type StructInstance, ConstructNode, LiteralNode, fields, _nodeId } from './core';
import type { StructSchema, Any } from '../../schema/schema';
import type { NodeFrame } from '../../renderer/node-frame';
import {
    Uniform,
    UniformGroup,
    UniformUpdateType,
    objectGroup,
    renderGroup,
    frameGroup,
    type UniformValue,
} from '../../core/uniform';

export class UniformNode<D extends Any> extends Node<D> {
    readonly kind = NodeKind.Uniform;
    /** uniform name */
    name: string;

    /** The underlying Uniform data container */
    uniform: Uniform<D>;

    /**
     * The uniform group, determines the WGSL @group index, update cadence, and
     * struct packing. Defaults to `objectGroup`; reassign (e.g. `u.group = renderGroup`)
     * before the node is first rendered to move it to a shared group.
     */
    get group(): UniformGroup { return this.uniform.group; }
    set group(g: UniformGroup) { this.uniform.group = g; }

    /** Get the current value */
    get value(): UniformValue<D> | null { return this.uniform.value; }

    /** Set value directly */
    set value(v: UniformValue<D> | null) { this.uniform.value = v; }

    constructor(uniform: Uniform<D>, name: string) {
        super(uniform.schema);
        this.uniform = uniform;
        this.name = name;
    }

    /**
     * Register an update callback that runs per frame/render/object.
     * The callback returns a value which is assigned to the uniform's value.
     */
    onUpdate(callback: (frame: NodeFrame) => unknown, updateType: UniformUpdateType): this {
        this.updateType = updateType;
        this.update = (frame: NodeFrame) => {
            const value = callback(frame);
            if (value !== undefined) {
                this.uniform.value = value as UniformValue<D>;
            }
        };
        return this;
    }

    /** Register an update callback for FRAME update type. */
    onFrameUpdate(callback: (frame: NodeFrame) => unknown): this {
        return this.onUpdate(callback, UniformUpdateType.FRAME);
    }

    /** Register an update callback for RENDER update type. */
    onRenderUpdate(callback: (frame: NodeFrame) => unknown): this {
        return this.onUpdate(callback, UniformUpdateType.RENDER);
    }

    /** Register an update callback for OBJECT update type. */
    onObjectUpdate(callback: (frame: NodeFrame) => unknown): this {
        return this.onUpdate(callback, UniformUpdateType.OBJECT);
    }
}

// Re-export from core for convenience
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
// Value-based: pass Uniform object directly
export function uniform<D extends Any>(u: Uniform<D>): UniformNode<D>;
// Name-based: resolved from material.uniforms
export function uniform<D extends Any>(name: string, schema: D): UniformNode<D>;
// Name-based struct: resolved from material.uniforms
export function uniform<S extends StructSchema>(name: string, def: StructDef<S>): StructInstance<S>;
// Inline scalar/vector/matrix form
export function uniform<D extends Any>(init: ConstructNode<D>, name?: string): UniformNode<D>;
export function uniform<D extends Any>(init: LiteralNode<D>, name?: string): UniformNode<D>;
// Implementation
export function uniform<D extends Any, S extends StructSchema>(
    init: Uniform<D> | string | LiteralNode<D> | ConstructNode<D>,
    nameOrSchema?: string | D | StructDef<S>
): UniformNode<D> | StructInstance<S> {
    // Value-based: uniform(Uniform)
    if (typeof init === 'object' && init !== null && 'isUniform' in init) {
        const u = init as Uniform<D>;
        return new UniformNode(u, `uniform_${_nodeId}`);
    }

    // Name-based: uniform('name', schema) or uniform('name', StructDef)
    if (typeof init === 'string') {
        const name = init;
        const schema = nameOrSchema as D | StructDef<S>;

        // Check if it's a StructDef
        if (schema && 'fields' in schema && 'construct' in schema) {
            const def = schema as StructDef<S>;
            const u = new Uniform(def as unknown as D);
            const node = new UniformNode(u, name) as unknown as Node<StructDef<S>>;
            return fields(node);
        }

        // Regular schema, create Uniform for name-based resolution
        const u = new Uniform(schema as D);
        return new UniformNode(u, name);
    }

    // Inline scalar/vector/matrix form: uniform(f32(0.5), 'name')
    const initNode = init as LiteralNode<D> | ConstructNode<D>;
    const name = nameOrSchema as string | undefined;
    const uniformId = name ?? `${initNode.type.wgslType}_${_nodeId}`;

    // Extract initial value from the node
    const initialValue = extractValue(initNode);

    const u = new Uniform(initNode.type, initialValue as UniformValue<D>);
    return new UniformNode(u, uniformId);
}

/**
 * Extract a concrete value from a LiteralNode or ConstructNode.
 * For ConstructNode, recursively extracts from child LiteralNodes.
 * Returns undefined if any child is not a LiteralNode (dynamic value).
 */
function extractValue(node: LiteralNode<Any> | ConstructNode<Any>): UniformValue | undefined {
    // LiteralNode has a direct value
    if (node.kind === NodeKind.Literal) {
        return node.value as UniformValue;
    }
    
    // ConstructNode: extract values from args (must all be LiteralNodes)
    if (node.kind === NodeKind.Construct) {
        const values: number[] = [];
        for (const arg of node.args) {
            const lit = arg.kind === NodeKind.Literal ? (arg as LiteralNode<Any>) : null;
            if (lit && typeof lit.value === 'number') {
                values.push(lit.value);
            } else {
                // Dynamic child - can't extract static value
                return undefined;
            }
        }
        return values;
    }
    
    return undefined;
}
