import { type WgslType, Node, type StructDef, type StructInstance, computeId, ConstructNode, NodeUpdateType, ConstNode } from './core';
import type { StructSchema } from '../schema';
import type { NodeFrame } from 'src/renderer/node-frame';

/**
 * Descriptor for a uniform group — determines WGSL @group index and struct packing.
 */
export class UniformGroupNode {
    readonly name: string;
    readonly shared: boolean;
    readonly order: number;
    readonly updateType: NodeUpdateType | null;

    /**
     * Version counter — bumped by the renderer once per frame (for frameGroup)
     * or once per render pass (for renderGroup). Used for deduplication gating:
     * updateUniformBinding() skips re-processing if binding.lastProcessedVersion
     * equals groupNode.version.
     */
    version: number = 0;

    /** Type-testing flag. */
    readonly isUniformGroup: boolean = true;

    constructor(name: string, shared: boolean, order: number, updateType: NodeUpdateType | null = null) {
        this.name = name;
        this.shared = shared;
        this.order = order;
        this.updateType = updateType;
    }
}

export class UniformNode<T extends WgslType> extends Node<T> {
    /**
     * Uniform group — determines @group index and struct packing.
     */
    readonly groupNode: UniformGroupNode;

    /**
     * Field name within the struct (e.g. 'cameraViewMatrix', 'roughness').
     */
    readonly name: string;

    /** CPU-side value. Set this to update the uniform on the GPU. */
    value: number | number[] | Float32Array | null = null;

    /** Monotonically incremented when value is set. Renderer re-uploads when stale. */
    version: number = 0;

    constructor(
        type: T,
        name: string,
        groupNode: UniformGroupNode = objectGroup
    ) {
        super(computeId('uniform', { type, name, groupNode: groupNode.name }), 'uniform', type);
        this.name = name;
        this.groupNode = groupNode;
    }

    /**
     * Override onUpdate to wrap the callback like Three.js does.
     * The user callback returns a value, which is assigned to this.value internally.
     * The wrapped callback returns void, compatible with NodeFrame.updateNode().
     */
    onUpdate(callback: (frame: NodeFrame) => unknown, updateType: NodeUpdateType): this {
        this.updateType = updateType;
        // Wrap the callback: call user's callback, assign returned value to this.value
        this.update = (frame: NodeFrame) => {
            const value = callback(frame);
            if (value !== undefined) {
                this.value = value as typeof this.value;
                this.version++;
            }
        };
        return this;
    }
}

/** Create a per-object (non-shared) uniform group with order=1. */
export const uniformGroup = (name: string, order = 1, updateType: NodeUpdateType | null = null) => new UniformGroupNode(name, false, order, updateType);

/** Create a shared uniform group with configurable order (default 0). */
export const sharedUniformGroup = (name: string, order = 0, updateType: NodeUpdateType | null = null) => new UniformGroupNode(name, true, order, updateType);

/**
 * frameGroup — shared uniforms updated once per frame.
 * Contains time uniforms (timeElapsed, timeDelta).
 * Maps to @group(0) with FRAME update type.
 *
 * Note: For simplicity, gpucat currently merges frame uniforms into renderGroup.
 */
export const frameGroup = /*@__PURE__*/ sharedUniformGroup('frame', 0, NodeUpdateType.FRAME);

/**
 * renderGroup — shared uniforms updated per render() call.
 * Contains camera uniforms (projection, view, position, near, far).
 * Maps to @group(0) with RENDER update type.
 *
 * Camera is in renderGroup (not frameGroup) because it can change between
 * render calls within the same frame (VR stereo, shadow maps, portals).
 */
export const renderGroup = /*@__PURE__*/ sharedUniformGroup('render', 0, NodeUpdateType.RENDER);

/**
 * objectGroup — per-object uniforms updated per draw call.
 * Contains mesh matrices (modelWorldMatrix, modelNormalMatrix) and user material uniforms.
 * Maps to @group(1) with OBJECT update type.
 */
export const objectGroup = /*@__PURE__*/ uniformGroup('object', 1, NodeUpdateType.OBJECT);

/**
 * Declare a material uniform.
 *
 * **Scalar / vector / matrix form** — pass a typed ConstNode as the initialiser:
 *   uniform(f32(0.5))               // anonymous — uniformId derived from type
 *   uniform(f32(0.5), 'roughness')  // explicit name used as the WGSL field name
 *   uniform(vec4f(1, 0, 0, 1), 'baseColor')
 *
 * **Struct form** — pass a StructDef directly; returns a typed StructInstance
 * whose keys are FieldNodes and whose `.$node` is the underlying UniformNode:
 *   const MyStruct = struct('MyStruct', { x: S.f32(), y: S.f32() })
 *   const myVal = uniform(MyStruct, 'myVal')
 *   myVal.x      // → FieldNode<'f32'>
 *   myVal.$node  // → UniformNode<'MyStruct'>
 *
 * The underlying UniformNode is content-addressed on (type, uniformId) so two
 * calls with the same arguments return the same node object.
 */
export function uniform<S extends StructSchema>(def: StructDef<S>, name: string): StructInstance<S>;
export function uniform<T extends WgslType>(init: ConstructNode<T>, name?: string): UniformNode<T>;
export function uniform<T extends WgslType>(init: ConstNode<T>, name?: string): UniformNode<T>;
export function uniform<T extends WgslType, S extends StructSchema>(
    init: ConstNode<T> | ConstructNode<T> | StructDef<S>,
    name?: string
): UniformNode<T> | StructInstance<S> {
    if ('schema' in init) {
        // Struct form: init is a StructDef
        const def = init as StructDef<S>;
        const uniformId = name ?? def.wgslType;
        const node = new UniformNode<string>(def.wgslType, uniformId);
        return def.instantiate(node);
    }
    // Scalar / vector / matrix form: init is a ConstNode or ConstructNode.
    // ConstNode carries a .value; ConstructNode carries .args — we only seed
    // the initial CPU-side value for ConstNodes (scalars / literal vectors).
    const initNode = init as ConstNode<T> | ConstructNode<T>;
    const uniformId = name ?? initNode.type;
    const node = new UniformNode(initNode.type, uniformId);
    if (node.value === null && 'value' in initNode && initNode.value !== null) {
        node.value = initNode.value as number | number[];
    }
    return node;
}

