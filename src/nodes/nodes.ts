import type { NodeFrame } from '../renderer/node-frame';
import type { NodeBuilder, VaryingData } from './node-builder';
import { constLiteral } from './wgsl-utils';
import { InstancedBufferAttribute, StorageBufferAttribute, StorageInstancedBufferAttribute } from 'src/core/attribute';
import * as d from './schema';
import { type ArrayDesc, type DepthTextureDesc, isStructDef, itemSizeOf, type StructSchema, texture2d, type TextureDesc, typedArrayCtorOf, type WgslDesc } from './schema';
export { type UpdateRange } from '../core/attribute';
import type { IndirectStorageBufferAttribute } from 'src/core/attribute';
import { Texture } from '../texture/texture';
import { Color, type ColorInput } from '../utils/color';

export type StructInstance<S extends StructSchema> = {
    readonly $node: Node<WgslType>;
} & {
    readonly [K in keyof S]: Node<S[K]['wgslType'] & WgslType>;
};

export type StructDef<S extends StructSchema> = WgslDesc<string> & {
    readonly schema: S;
    readonly members: StructMember[];
    readonly node: StructNode;
    readonly nestedDefs: ReadonlyMap<string, StructDef<StructSchema>>;
    instantiate<N extends Node<WgslType>>(base: N): StructInstance<S>;
};

const _structNodeRegistry: WeakMap<StructNode, StructDef<StructSchema>> = new WeakMap();
const _structNameRegistry: Map<string, StructDef<StructSchema>> = new Map();

export function lookupStructDef(node: StructNode): StructDef<StructSchema> | undefined {
    return _structNodeRegistry.get(node);
}

export function lookupStructDefByName(wgslType: string): StructDef<StructSchema> | undefined {
    return _structNameRegistry.get(wgslType);
}

export function struct<S extends StructSchema>(wgslType: string, schema: S): StructDef<S> {
    const members: StructMember[] = Object.entries(schema).map(([name, field]) => ({
        name,
        type: field.wgslType,
    }));
    const node = new StructNode(wgslType, members);

    const nestedDefs: Map<string, StructDef<StructSchema>> = new Map();
    for (const field of Object.values(schema)) {
        if (isStructDef(field)) {
            nestedDefs.set(field.wgslType, field as unknown as StructDef<StructSchema>);
        }
    }

    function instantiate<N extends Node<WgslType>>(base: N): StructInstance<S> {
        const result: Record<string, Node<WgslType>> = { $node: base };
        for (const [name, field] of Object.entries(schema)) {
            result[name] = new FieldNode(field.wgslType as WgslType, base, name);
        }
        return result as StructInstance<S>;
    }

    const def: StructDef<S> = { wgslType, schema, members, node, nestedDefs, instantiate };
    _structNodeRegistry.set(node, def);
    _structNameRegistry.set(wgslType, def);
    return def;
}

/* wgsl type vocabulary */

export type ScalarType = 'f32' | 'i32' | 'u32' | 'bool' | 'f16';

export type Vec2Type = 'vec2f' | 'vec2i' | 'vec2u' | 'vec2<bool>' | 'vec2h';
export type Vec3Type = 'vec3f' | 'vec3i' | 'vec3u' | 'vec3<bool>' | 'vec3h';
export type Vec4Type = 'vec4f' | 'vec4i' | 'vec4u' | 'vec4<bool>' | 'vec4h';
export type VecType = Vec2Type | Vec3Type | Vec4Type;

export type MatType =
    | 'mat2x2f' | 'mat2x3f' | 'mat2x4f' | 'mat3x2f' | 'mat3x3f' | 'mat3x4f' | 'mat4x2f' | 'mat4x3f' | 'mat4x4f'
    | 'mat2x2h' | 'mat2x3h' | 'mat2x4h' | 'mat3x2h' | 'mat3x3h' | 'mat3x4h' | 'mat4x2h' | 'mat4x3h' | 'mat4x4h';

export type NumericType = ScalarType | VecType | MatType;
export type SamplerType = 'sampler' | 'sampler_comparison';
export type TextureType = string;
export type WgslType = NumericType | SamplerType | TextureType;

export type VecElement<T extends VecType> = T extends 'vec2f' | 'vec3f' | 'vec4f'
    ? 'f32'
    : T extends 'vec2i' | 'vec3i' | 'vec4i'
      ? 'i32'
      : T extends 'vec2u' | 'vec3u' | 'vec4u'
        ? 'u32'
        : T extends 'vec2h' | 'vec3h' | 'vec4h'
          ? 'f16'
          : 'bool';

export type Vec2Of<E extends ScalarType> = E extends 'f32' ? 'vec2f' : E extends 'i32' ? 'vec2i' : E extends 'u32' ? 'vec2u' : E extends 'f16' ? 'vec2h' : 'vec2<bool>';
export type Vec3Of<E extends ScalarType> = E extends 'f32' ? 'vec3f' : E extends 'i32' ? 'vec3i' : E extends 'u32' ? 'vec3u' : E extends 'f16' ? 'vec3h' : 'vec3<bool>';
export type Vec4Of<E extends ScalarType> = E extends 'f32' ? 'vec4f' : E extends 'i32' ? 'vec4i' : E extends 'u32' ? 'vec4u' : E extends 'f16' ? 'vec4h' : 'vec4<bool>';

/* swizzle type utilities */

// maps Node<T> swizzle width to the correct output type
// Rules:
//   VecType   → element scalar (for width 1), vec2/3/4 of same element (for width 2/3/4)
//   ScalarType → self (width 1 only; multi-component swizzles on scalars are invalid WGSL)
//   anything else (texture, sampler, …) → WgslType (widened, no useful info)

export type Swizzle1<T extends WgslType> =
    T extends VecType    ? VecElement<T> :
    T extends ScalarType ? T :
    WgslType;

export type Swizzle2<T extends WgslType> =
    T extends VecType ? Vec2Of<VecElement<T>> : WgslType;

export type Swizzle3<T extends WgslType> =
    T extends VecType ? Vec3Of<VecElement<T>> : WgslType;

export type Swizzle4<T extends WgslType> =
    T extends VecType ? Vec4Of<VecElement<T>> : WgslType;

export type MulResult<A extends WgslType, B extends WgslType> = A extends MatType
    ? B extends VecType
        ? B
        : A
    : B extends ScalarType
      ? A
      : A extends ScalarType
        ? B
        : A;

export type NodeKind =
    | 'const'
    | 'uniform'
    | 'attribute'
    | 'buffer_attribute'
    | 'storage'
    | 'texture'
    | 'sampler'
    | 'convert'
    | 'varying'
    | 'subBuild'
    | 'binop'
    | 'call'
    | 'wgsl'
    | 'assign'
    | 'construct'
    | 'struct'
    | 'field'
    | 'index'
    | 'builtin'
    | 'stack'
    | 'cond'
    | 'var'
    | 'if'
    | 'loop'
    | 'expression'
    | 'break'
    | 'continue'
    | 'fn'
    | 'wgsl_fn'
    | 'code'
    | 'function'
    | 'functionCall'
    | 'param'
    | 'return'
    | 'output_struct'
    | 'inspector';

export type StructMember = { readonly name: string; readonly type: WgslType };
export type BuiltinKind =
    | 'instance_index' | 'instance_data'
    | 'vertex_index' | 'global_invocation_id' | 'local_invocation_id'
    | 'local_invocation_index' | 'workgroup_id' | 'num_workgroups'
    | 'position';  // fragment position (@builtin(position) in fragment shader)
export type BinopOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '>' | '<=' | '>=';

/**
 * WGSL @interpolate interpolation type.
 *   - perspective  : values are interpolated in a perspective-correct manner (default for float types)
 *   - linear       : values are interpolated in a linear, non-perspective-correct manner
 *   - flat         : values are not interpolated; the value from the provoking vertex is used
 *                    (required for integer/unsigned-integer types)
 */
export type InterpolationType = 'perspective' | 'linear' | 'flat';

/**
 * WGSL @interpolate sampling mode (only valid when interpolation type is 'perspective' or 'linear').
 *   - center    : interpolation is performed at the center of the pixel (default)
 *   - centroid  : interpolation is performed at a point inside the primitive that is also
 *                 inside all samples covered by the fragment (avoids aliasing at primitive edges)
 *   - sample    : interpolation is performed per-sample; the fragment shader runs once per sample
 *   - either    : implementation may choose center or centroid (valid only with 'flat' in WGSL)
 */
export type InterpolationSampling = 'center' | 'centroid' | 'sample' | 'either';

/**
 * Update types for Node.update() callbacks.
 * Determines when the node's update callback is invoked.
 */
export const NodeUpdateType = {
    /** The update method is not executed. */
    NONE: 'none',
    /** The update method is executed once per frame. */
    FRAME: 'frame',
    /** The update method is executed per render() call. Multiple renders per frame for VR/shadows. */
    RENDER: 'render',
    /** The update method is executed per object/mesh that uses the node. */
    OBJECT: 'object',
} as const;

export type NodeUpdateType = typeof NodeUpdateType[keyof typeof NodeUpdateType];

/**
 * A single named + typed parameter descriptor for Fn().
 * Mirrors WGSL syntax: `name: type` e.g. `{ name: 'uv', type: S.vec2f() }` → `uv: vec2f`
 */
export type ParamDesc<T extends WgslType = WgslType> = {
    readonly name: string;
    readonly type: WgslDesc<T>;
};

/**
 * Maps a tuple of ParamDesc to a tuple of correspondingly-typed Nodes.
 * e.g. [ParamDesc<'vec2f'>, ParamDesc<'f32'>] → [Node<'vec2f'>, Node<'f32'>]
 */
export type ParamDescsToNodes<P extends readonly ParamDesc[]> = {
    [K in keyof P]: P[K] extends ParamDesc<infer U> ? Node<U> : never;
};

/** Layout descriptor for a named, fully-typed Fn. */
export type FnLayout<P extends readonly ParamDesc[]> = {
    readonly name: string;
    readonly params: [...P];
};

/**
 * Maps build stage to its parent stage.
 * Three.js aligned: used to force parent stages if skipped.
 */
const _parentBuildStage: Record<string, string | undefined> = {
    analyze: 'setup',
    generate: 'analyze',
};

export class Node<T extends WgslType> {
    readonly id: string;
    readonly kind: NodeKind;
    readonly type: T;

    /**
     * Nodes that should be built before this node.
     * Three.js aligned: used by InspectorNode via node.before().
     * Null by default for memory efficiency.
     */
    _beforeNodes: Node<WgslType>[] | null = null;

    /**
     * The update type for this node's update() method.
     * Determines when the update callback is invoked (none/frame/render/object).
     */
    updateType: NodeUpdateType = NodeUpdateType.NONE;

    /**
     * The update type for this node's updateBefore() method.
     * Three.js aligned.
     */
    updateBeforeType: NodeUpdateType = NodeUpdateType.NONE;

    /**
     * The update type for this node's updateAfter() method.
     * Three.js aligned.
     */
    updateAfterType: NodeUpdateType = NodeUpdateType.NONE;

    /**
     * Whether this node is global (should use globalCache).
     * Three.js aligned.
     */
    global: boolean = false;

    /**
     * Whether to track parent nodes during build.
     * Three.js aligned.
     */
    parents: boolean = false;

    /**
     * This flag can be used for type testing.
     * Three.js aligned: isNode = true.
     */
    readonly isNode: boolean = true;

    /**
     * The update callback. Invoked based on updateType.
     * Set via onUpdate(), onRenderUpdate(), onObjectUpdate().
     */
    update?: (frame: NodeFrame) => unknown;

    constructor(id: string, kind: NodeKind, type: T) {
        this.id = id;
        this.kind = kind;
        this.type = type;
    }

    /**
     * Set an update callback that will be invoked based on updateType.
     * The callback receives a NodeFrame and can return a value to assign.
     *
     * @param callback - The update function. Receives NodeFrame, returns value.
     * @param updateType - When to invoke: 'frame', 'render', or 'object'.
     * @returns this for method chaining.
     */
    onUpdate(callback: (frame: NodeFrame) => unknown, updateType: NodeUpdateType): this {
        this.updateType = updateType;
        this.update = callback;
        return this;
    }

    /**
     * Set an update callback invoked once per render() call.
     * Used for camera uniforms, time, etc. that are shared across all objects in a render.
     *
     * @param callback - Receives NodeFrame. Access camera, time, deltaTime from frame.
     * @returns this for method chaining.
     *
     * @example
     * const cameraView = new UniformNode('mat4x4f', 'cameraViewMatrix', renderGroup)
     *     .onRenderUpdate((frame) => frame.camera!.matrixWorldInverse);
     */
    onRenderUpdate(callback: (frame: NodeFrame) => unknown): this {
        return this.onUpdate(callback, NodeUpdateType.RENDER);
    }

    /**
     * Set an update callback invoked once per object/mesh.
     * Used for model matrices, per-object material properties, etc.
     *
     * @param callback - Receives NodeFrame. Access object from frame.
     * @returns this for method chaining.
     *
     * @example
     * const modelMatrix = new UniformNode('mat4x4f', 'modelWorldMatrix', objectGroup)
     *     .onObjectUpdate((frame) => frame.object!.matrixWorld);
     */
    onObjectUpdate(callback: (frame: NodeFrame) => unknown): this {
        return this.onUpdate(callback, NodeUpdateType.OBJECT);
    }

    /**
     * Add a node to be built before this node.
     * Three.js aligned: Node.before() method.
     *
     * Used by InspectorNode to attach itself to the node being inspected,
     * ensuring the InspectorNode gets built and its update() is called.
     *
     * @param node - The node to build before this one
     * @returns this for method chaining
     */
    before(node: Node<WgslType>): this {
        if (this._beforeNodes === null) this._beforeNodes = [];
        this._beforeNodes.push(node);
        return this;
    }

    /**
     * Mark this node as inspectable, optionally with a display name.
     * Creates an InspectorNode wrapper and attaches it via before().
     * Returns `this` for method chaining.
     *
     * Three.js aligned: mirrors the inspector() factory function.
     *
     * @example
     * const albedo = texture('texture_2d<f32>', 'albedo').inspect('Albedo');
     */
    inspect(name?: string): this {
        return this.before(new InspectorNode(this, name) as Node<WgslType>);
    }

    // ---------------------------------------------------------------------------
    // Three.js-aligned build system methods (exact naming)
    // ---------------------------------------------------------------------------

    /**
     * Nodes might refer to other objects like materials. This method allows to dynamically update the reference
     * to such objects based on a given state (e.g. the current node frame or builder).
     * Three.js aligned: Node.updateReference().
     *
     * @param _state - This method can be invoked in different contexts so state can refer to any object type.
     * @return The updated reference.
     */
    updateReference(_state: unknown): this {
        return this;
    }

    /**
     * Returns the hash of the node which is used to identify the node.
     * Three.js aligned: Node.getHash() returns a unique identifier.
     *
     * @param _builder - The NodeBuilder instance (unused in base implementation)
     * @returns The hash string (defaults to node id)
     */
    getHash(_builder: NodeBuilder): string {
        return this.id;
    }

    /**
     * Returns a shared node if one exists with the same hash.
     * Three.js aligned: Node.getShared() for node deduplication.
     *
     * @param builder - The NodeBuilder instance
     * @returns The shared node if found, otherwise this
     */
    getShared(builder: NodeBuilder): Node<WgslType> {
        const hash = this.getHash(builder);
        const nodeFromHash = builder.getNodeFromHash(hash);
        return nodeFromHash || this;
    }

    /**
     * Returns the node's type.
     * Three.js aligned: Node.getNodeType().
     *
     * @param builder - The current node builder.
     * @param output - The output of the node.
     * @return The type of the node.
     */
    getNodeType(builder: NodeBuilder, output: string | null = null): string {
        const nodeData = builder.getDataFromNode(this);

        let type: string | undefined;

        if (output !== null) {
            nodeData.typeFromOutput = nodeData.typeFromOutput || {};
            type = nodeData.typeFromOutput[output];

            if (type === undefined) {
                type = this.generateNodeType(builder, output);
                nodeData.typeFromOutput[output] = type;
            }
        } else {
            type = nodeData.type;

            if (type === undefined) {
                type = this.generateNodeType(builder);
                nodeData.type = type;
            }
        }

        return type;
    }

    /**
     * Generates the node's type.
     * Three.js aligned: Node.generateNodeType().
     *
     * @param builder - The current node builder.
     * @param output - The output of the node.
     * @return The type of the node.
     */
    generateNodeType(builder: NodeBuilder, output: string | null = null): string {
        const nodeProperties = builder.getNodeProperties(this);

        if (nodeProperties.outputNode) {
            return (nodeProperties.outputNode as Node<WgslType>).getNodeType(builder, output);
        }

        return this.type;
    }

    /**
     * Build this node for the current stage.
     * Three.js aligned: Node.build() orchestrates setup/analyze/generate based on buildStage.
     *
     * This method:
     * 1. Checks for shared nodes (deduplication via getShared)
     * 2. Builds _beforeNodes first
     * 3. Forces parent build stages if skipped (setup before analyze, analyze before generate)
     * 4. Dispatches to setup/analyze/generate based on buildStage
     *
     * @param builder - The NodeBuilder instance
     * @param output - Optional output type for type conversion
     * @returns WGSL code snippet, output node, or null depending on stage
     */
    build(builder: NodeBuilder, output?: string | Node<WgslType>): string | Node<WgslType> | null {
        // Three.js: check for shared node (deduplication)
        const refNode = this.getShared(builder);
        if (this !== refNode) {
            return refNode.build(builder, output);
        }

        // Three.js: build _beforeNodes first
        if (this._beforeNodes !== null) {
            const currentBeforeNodes = this._beforeNodes;
            this._beforeNodes = null;
            for (const beforeNode of currentBeforeNodes) {
                beforeNode.build(builder, output);
            }
            this._beforeNodes = currentBeforeNodes;
        }

        // Three.js: track build stages to avoid double-building
        const nodeData = builder.getDataFromNode(this);
        nodeData.buildStages = nodeData.buildStages || {};
        nodeData.buildStages[builder.buildStage!] = true;

        // Three.js: force parent build stage if skipped
        const parentBuildStage = _parentBuildStage[builder.buildStage!];
        if (parentBuildStage && nodeData.buildStages[parentBuildStage] !== true) {
            const previousBuildStage = builder.getBuildStage();
            builder.setBuildStage(parentBuildStage as 'setup' | 'analyze' | 'generate');
            this.build(builder);
            builder.setBuildStage(previousBuildStage);
        }

        // Three.js: add to chain for cycle detection
        builder.addChain(this);

        let result: string | Node<WgslType> | null = null;
        const buildStage = builder.getBuildStage();

        if (buildStage === 'setup') {
            // Three.js: add node to builder's node list
            builder.addNode(this);

            this.updateReference(builder);

            const properties = builder.getNodeProperties(this);

            if (properties.initialized !== true) {
                properties.initialized = true;
                properties.outputNode = this.setup(builder) || properties.outputNode || null;

                // Three.js: build child nodes from properties
                for (const childNode of Object.values(properties)) {
                    if (childNode && typeof childNode === 'object' && 'isNode' in childNode && (childNode as Node<WgslType>).isNode === true) {
                        // Track parents if requested
                        if ((childNode as Node<WgslType>).parents === true) {
                            const childProperties = builder.getNodeProperties(childNode as Node<WgslType>);
                            childProperties.parents = childProperties.parents || [];
                            (childProperties.parents as Node<WgslType>[]).push(this);
                        }
                        (childNode as Node<WgslType>).build(builder);
                    }
                }

                // Three.js: add to sequential nodes for update callbacks
                builder.addSequentialNode(this);
            }

            result = properties.outputNode ?? null;

        } else if (buildStage === 'analyze') {
            this.analyze(builder, output as Node<WgslType> | null);

        } else if (buildStage === 'generate') {
            // Three.js: check if generate takes only one argument (no output handling)
            const isGenerateOnce = this.generate.length < 2;

            if (isGenerateOnce) {
                const type = this.getNodeType(builder);
                const nodeData = builder.getDataFromNode(this);

                let snippet = nodeData.snippet;

                if (snippet === undefined) {
                    if (nodeData.generated === undefined) {
                        nodeData.generated = true;
                        snippet = this.generate(builder) || '';
                        nodeData.snippet = snippet;
                    } else {
                        // Recursion detected
                        console.warn('[gpucat] Node: Recursion detected.', this);
                        snippet = '/* Recursion detected. */';
                    }
                }

                result = builder.format(snippet, type, output as string | undefined);
            } else {
                result = this.generate(builder, output as string | undefined) || '';
            }
        }

        builder.removeChain(this);

        return result;
    }

    /**
     * Setup phase: register resources, return outputNode if transforming.
     * Three.js: Node.setup() prepares the node for compilation.
     *
     * Default implementation discovers children via reflection and stores
     * them in properties. Override for custom setup behavior.
     *
     * @param builder - The NodeBuilder instance
     * @returns A replacement output node, or null to use this node
     */
    setup(builder: NodeBuilder): Node<WgslType> | null {
        const nodeProperties = builder.getNodeProperties(this);

        let index = 0;

        for (const childNode of this.getChildren()) {
            nodeProperties['node' + index++] = childNode;
        }

        // return a outputNode if exists or null
        return nodeProperties.outputNode || null;
    }

    /**
     * Represents the analyze stage which is the second step of the build process.
     * This stage analyzes the node hierarchy and ensures descendent nodes are built.
     *
     * @param builder - The current node builder.
     * @param output - The target output node.
     */
    analyze(builder: NodeBuilder, output: Node<WgslType> | null = null): void {
        const usageCount = builder.increaseUsage(this);

        if (this.parents === true) {
            const nodeData = builder.getDataFromNode(this, 'any');
            nodeData.stages = nodeData.stages || {};
            nodeData.stages[builder.shaderStage!] = nodeData.stages[builder.shaderStage!] || [];
            nodeData.stages[builder.shaderStage!].push(output!);
        }

        if (usageCount === 1) {
            // node flow children
            const nodeProperties = builder.getNodeProperties(this);

            for (const childNode of Object.values(nodeProperties)) {
                if (childNode && (childNode as Node<WgslType>).isNode === true) {
                    (childNode as Node<WgslType>).build(builder, this);
                }
            }
        }
    }

    /**
     * Represents the generate stage which is the third step of the build process.
     * This state builds the output node and returns the resulting shader string.
     *
     * @param builder - The current node builder.
     * @param output - Can be used to define the output type.
     * @return The generated shader string.
     */
    generate(builder: NodeBuilder, output?: string): string | null {
        const { outputNode } = builder.getNodeProperties(this);

        if (outputNode && (outputNode as Node<WgslType>).isNode === true) {
            return (outputNode as Node<WgslType>).build(builder, output) as string | null;
        }

        return null;
    }

    /**
     * Generator function that can be used to iterate over the child nodes.
     * Three.js: Node.getChildren() yields child nodes.
     *
     * @yields A child node.
     */
    *getChildren(): Generator<Node<WgslType>> {
        for (const { childNode } of this._getChildren()) {
            yield childNode;
        }
    }

    /**
     * Can be used to traverse through the node's hierarchy.
     * Three.js: Node.traverse() calls callback for this and all descendants.
     *
     * @param callback - A callback that is executed per node.
     */
    traverse(callback: (node: Node<WgslType>) => void): void {
        callback(this);
        for (const childNode of this.getChildren()) {
            childNode.traverse(callback);
        }
    }

    /**
     * Returns the child nodes of this node.
     * Three.js aligned: exact copy of Node._getChildren().
     *
     * @param ignores - A set of nodes to ignore during the search to avoid circular references.
     * @returns An array of objects describing the child nodes.
     */
    _getChildren(ignores: Set<Node<WgslType>> = new Set()): Array<{ property: string; index?: number | string; childNode: Node<WgslType> }> {
        const children: Array<{ property: string; index?: number | string; childNode: Node<WgslType> }> = [];

        // avoid circular references
        ignores.add(this);

        for (const property of Object.getOwnPropertyNames(this)) {
            const object = (this as Record<string, unknown>)[property];

            // Ignore private properties and ignored nodes.
            if (property.startsWith('_') === true || ignores.has(object as Node<WgslType>)) continue;

            if (Array.isArray(object) === true) {
                for (let i = 0; i < object.length; i++) {
                    const child = object[i];

                    if (child && (child as Node<WgslType>).isNode === true) {
                        children.push({ property, index: i, childNode: child as Node<WgslType> });
                    }
                }
            } else if (object && (object as Node<WgslType>).isNode === true) {
                children.push({ property, childNode: object as Node<WgslType> });
            } else if (object && Object.getPrototypeOf(object) === Object.prototype) {
                for (const subProperty in object as object) {
                    // Ignore private sub-properties.
                    if (subProperty.startsWith('_') === true) continue;

                    const child = (object as Record<string, unknown>)[subProperty];

                    if (child && (child as Node<WgslType>).isNode === true) {
                        children.push({ property, index: subProperty, childNode: child as Node<WgslType> });
                    }
                }
            }
        }

        return children;
    }

    // arithmetic — delegate to the standalone functions (source of truth)
    add(b: Node<T>): Node<T> { return add(this, b); }
    sub(b: Node<T>): Node<T> { return sub(this, b); }
    div(b: Node<T>): Node<T> { return div(this, b); }
    mul<B extends WgslType>(b: Node<B>): Node<MulResult<T, B>> { return mul(this, b); }
    // mul(b: Node<WgslType>): Node<WgslType> { return mul(this, b); }

    // math — delegate to the standalone functions (source of truth)
    abs(): Node<T> { return abs(this); }
    floor(): Node<T> { return floor(this); }
    ceil(): Node<T> { return ceil(this); }
    fract(): Node<T> { return fract(this); }
    sqrt(): Node<T> { return sqrt(this); }
    sin(): Node<T> { return sin(this); }
    cos(): Node<T> { return cos(this); }
    negate(): Node<T> { return negate(this); }
    normalize(): Node<T> { return normalize(this); }
    length(): Node<'f32'> { return length(this); }
    dot(b: Node<T>): Node<T extends VecType ? VecElement<T> : 'f32'> { return dot(this, b) as unknown as Node<T extends VecType ? VecElement<T> : 'f32'>; }
    cross(b: Node<T>): Node<T> { return cross(this, b); }
    clamp(lo: Node<T>, hi: Node<T>): Node<T> { return clamp(this, lo, hi); }
    mix(b: Node<T>, t: Node<T>): Node<T> { return mix(this, b, t); }
    max(b: Node<T>): Node<T> { return max(this, b); }
    min(b: Node<T>): Node<T> { return min(this, b); }
    pow(b: Node<T>): Node<T> { return pow(this, b); }
    step(x: Node<T>): Node<T> { return step(this, x); }
    smoothstep(lo: Node<T>, hi: Node<T>): Node<T> { return smoothstep(lo, hi, this); }

    // struct field access — typed via explicit resultType argument
    field<R extends WgslType>(name: string, resultType: R): Node<R> { return new FieldNode(resultType, this, name); }

    // comparison operators — return Node<'bool'>
    gt(b: Node<T>): Node<'bool'> { return new BinopNode('>', 'bool', this, b); }
    lt(b: Node<T>): Node<'bool'> { return new BinopNode('<', 'bool', this, b); }
    gte(b: Node<T>): Node<'bool'> { return new BinopNode('>=', 'bool', this, b); }
    lte(b: Node<T>): Node<'bool'> { return new BinopNode('<=', 'bool', this, b); }
    eq(b: Node<T>): Node<'bool'> { return new BinopNode('==', 'bool', this, b); }
    neq(b: Node<T>): Node<'bool'> { return new BinopNode('!=', 'bool', this, b); }

    // Type conversion
    toF32(): Node<'f32'> { return new CallNode('f32', 'f32', [this]); }
    toF16(): Node<'f16'> { return new CallNode('f16', 'f16', [this]); }
    toU32(): Node<'u32'> { return new CallNode('u32', 'u32', [this]); }
    toI32(): Node<'i32'> { return new CallNode('i32', 'i32', [this]); }

    /**
     * Assign a new value to this node (used on VarNodes).
     * Produces an AssignNode and pushes it onto the current stack.
     * Throws if called outside a Fn body.
     */
    assign(value: Node<T>): void { addToStack(new AssignNode(this, value)); }

    /**
     * Declare a mutable local variable initialised to this node's value.
     * Equivalent to the standalone `toVar(this, label)`.
     *
     * When called inside a `Fn` body, the `VarNode` is pushed onto the current
     * stack so it is declared at the point of use.
     *
     * When called **outside** any `Fn` body (e.g. at module scope to build a
     * shared sub-graph), the `VarNode` is created but not added to any stack.
     * It will be emitted inline into whichever shader-stage function body first
     * references it during the generate pass — mirroring three.js TSL behaviour.
     */
    toVar(label?: string): VarNode<T> {
        const varName = label ? `var_${_nodeCounter}_${label}` : `var_${_nodeCounter}`;
        const v = new VarNode(this.type as T, varName, this);
        if (currentStack !== null) {
            currentStack.push(v as Node<WgslType>);
        }
        return v;
    }

    /**
     * Declare an immutable local constant initialized to this node's value.
     * Equivalent to the standalone `Const(this, label)`.
     *
     * When called inside a `Fn` body, the VarNode is pushed onto the current
     * stack so it is declared at the point of use.
     *
     * When called **outside** any `Fn` body (e.g. at module scope to build a
     * shared sub-graph), the VarNode is created but not added to any stack.
     * It will be emitted inline into whichever shader-stage function body first
     * references it during the generate pass.
     */
    toConst(label?: string): VarNode<T> {
        const varName = label ? `const_${_nodeCounter}_${label}` : `const_${_nodeCounter}`;
        const v = new VarNode(this.type as T, varName, this, true);
        if (currentStack !== null) {
            currentStack.push(v as Node<WgslType>);
        }
        return v;
    }

    /* xyzw 1-component swizzles */
    get x(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'x') as unknown as Node<Swizzle1<T>>; }
    get y(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'y') as unknown as Node<Swizzle1<T>>; }
    get z(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'z') as unknown as Node<Swizzle1<T>>; }
    get w(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'w') as unknown as Node<Swizzle1<T>>; }

    /* xyzw 2-component swizzles */
    get xx(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'xx') as unknown as Node<Swizzle2<T>>; }
    get xy(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'xy') as unknown as Node<Swizzle2<T>>; }
    get xz(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'xz') as unknown as Node<Swizzle2<T>>; }
    get xw(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'xw') as unknown as Node<Swizzle2<T>>; }
    get yx(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'yx') as unknown as Node<Swizzle2<T>>; }
    get yy(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'yy') as unknown as Node<Swizzle2<T>>; }
    get yz(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'yz') as unknown as Node<Swizzle2<T>>; }
    get yw(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'yw') as unknown as Node<Swizzle2<T>>; }
    get zx(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'zx') as unknown as Node<Swizzle2<T>>; }
    get zy(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'zy') as unknown as Node<Swizzle2<T>>; }
    get zz(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'zz') as unknown as Node<Swizzle2<T>>; }
    get zw(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'zw') as unknown as Node<Swizzle2<T>>; }
    get wx(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'wx') as unknown as Node<Swizzle2<T>>; }
    get wy(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'wy') as unknown as Node<Swizzle2<T>>; }
    get wz(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'wz') as unknown as Node<Swizzle2<T>>; }
    get ww(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'ww') as unknown as Node<Swizzle2<T>>; }

    /* xyzw 3-component swizzles */
    get xxx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xxx') as unknown as Node<Swizzle3<T>>; }
    get xxy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xxy') as unknown as Node<Swizzle3<T>>; }
    get xxz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xxz') as unknown as Node<Swizzle3<T>>; }
    get xxw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xxw') as unknown as Node<Swizzle3<T>>; }
    get xyx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xyx') as unknown as Node<Swizzle3<T>>; }
    get xyy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xyy') as unknown as Node<Swizzle3<T>>; }
    get xyz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xyz') as unknown as Node<Swizzle3<T>>; }
    get xyw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xyw') as unknown as Node<Swizzle3<T>>; }
    get xzx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xzx') as unknown as Node<Swizzle3<T>>; }
    get xzy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xzy') as unknown as Node<Swizzle3<T>>; }
    get xzz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xzz') as unknown as Node<Swizzle3<T>>; }
    get xzw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xzw') as unknown as Node<Swizzle3<T>>; }
    get xwx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xwx') as unknown as Node<Swizzle3<T>>; }
    get xwy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xwy') as unknown as Node<Swizzle3<T>>; }
    get xwz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xwz') as unknown as Node<Swizzle3<T>>; }
    get xww(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xww') as unknown as Node<Swizzle3<T>>; }
    get yxx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yxx') as unknown as Node<Swizzle3<T>>; }
    get yxy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yxy') as unknown as Node<Swizzle3<T>>; }
    get yxz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yxz') as unknown as Node<Swizzle3<T>>; }
    get yxw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yxw') as unknown as Node<Swizzle3<T>>; }
    get yyx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yyx') as unknown as Node<Swizzle3<T>>; }
    get yyy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yyy') as unknown as Node<Swizzle3<T>>; }
    get yyz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yyz') as unknown as Node<Swizzle3<T>>; }
    get yyw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yyw') as unknown as Node<Swizzle3<T>>; }
    get yzx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yzx') as unknown as Node<Swizzle3<T>>; }
    get yzy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yzy') as unknown as Node<Swizzle3<T>>; }
    get yzz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yzz') as unknown as Node<Swizzle3<T>>; }
    get yzw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yzw') as unknown as Node<Swizzle3<T>>; }
    get ywx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'ywx') as unknown as Node<Swizzle3<T>>; }
    get ywy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'ywy') as unknown as Node<Swizzle3<T>>; }
    get ywz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'ywz') as unknown as Node<Swizzle3<T>>; }
    get yww(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yww') as unknown as Node<Swizzle3<T>>; }
    get zxx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zxx') as unknown as Node<Swizzle3<T>>; }
    get zxy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zxy') as unknown as Node<Swizzle3<T>>; }
    get zxz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zxz') as unknown as Node<Swizzle3<T>>; }
    get zxw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zxw') as unknown as Node<Swizzle3<T>>; }
    get zyx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zyx') as unknown as Node<Swizzle3<T>>; }
    get zyy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zyy') as unknown as Node<Swizzle3<T>>; }
    get zyz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zyz') as unknown as Node<Swizzle3<T>>; }
    get zyw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zyw') as unknown as Node<Swizzle3<T>>; }
    get zzx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zzx') as unknown as Node<Swizzle3<T>>; }
    get zzy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zzy') as unknown as Node<Swizzle3<T>>; }
    get zzz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zzz') as unknown as Node<Swizzle3<T>>; }
    get zzw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zzw') as unknown as Node<Swizzle3<T>>; }
    get zwx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zwx') as unknown as Node<Swizzle3<T>>; }
    get zwy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zwy') as unknown as Node<Swizzle3<T>>; }
    get zwz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zwz') as unknown as Node<Swizzle3<T>>; }
    get zww(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zww') as unknown as Node<Swizzle3<T>>; }
    get wxx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wxx') as unknown as Node<Swizzle3<T>>; }
    get wxy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wxy') as unknown as Node<Swizzle3<T>>; }
    get wxz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wxz') as unknown as Node<Swizzle3<T>>; }
    get wxw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wxw') as unknown as Node<Swizzle3<T>>; }
    get wyx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wyx') as unknown as Node<Swizzle3<T>>; }
    get wyy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wyy') as unknown as Node<Swizzle3<T>>; }
    get wyz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wyz') as unknown as Node<Swizzle3<T>>; }
    get wyw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wyw') as unknown as Node<Swizzle3<T>>; }
    get wzx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wzx') as unknown as Node<Swizzle3<T>>; }
    get wzy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wzy') as unknown as Node<Swizzle3<T>>; }
    get wzz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wzz') as unknown as Node<Swizzle3<T>>; }
    get wzw(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wzw') as unknown as Node<Swizzle3<T>>; }
    get wwx(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wwx') as unknown as Node<Swizzle3<T>>; }
    get wwy(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wwy') as unknown as Node<Swizzle3<T>>; }
    get wwz(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wwz') as unknown as Node<Swizzle3<T>>; }
    get www(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'www') as unknown as Node<Swizzle3<T>>; }

    /* xyzw 4-component swizzles (24 unique permutations only) */
    get xyzw(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xyzw') as unknown as Node<Swizzle4<T>>; }
    get xywz(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xywz') as unknown as Node<Swizzle4<T>>; }
    get xzyw(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xzyw') as unknown as Node<Swizzle4<T>>; }
    get xzwy(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xzwy') as unknown as Node<Swizzle4<T>>; }
    get xwyz(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xwyz') as unknown as Node<Swizzle4<T>>; }
    get xwzy(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xwzy') as unknown as Node<Swizzle4<T>>; }
    get yxzw(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'yxzw') as unknown as Node<Swizzle4<T>>; }
    get yxwz(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'yxwz') as unknown as Node<Swizzle4<T>>; }
    get yzxw(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'yzxw') as unknown as Node<Swizzle4<T>>; }
    get yzwx(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'yzwx') as unknown as Node<Swizzle4<T>>; }
    get ywxz(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'ywxz') as unknown as Node<Swizzle4<T>>; }
    get ywzx(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'ywzx') as unknown as Node<Swizzle4<T>>; }
    get zxyw(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zxyw') as unknown as Node<Swizzle4<T>>; }
    get zxwy(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zxwy') as unknown as Node<Swizzle4<T>>; }
    get zyxw(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zyxw') as unknown as Node<Swizzle4<T>>; }
    get zywx(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zywx') as unknown as Node<Swizzle4<T>>; }
    get zwxy(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zwxy') as unknown as Node<Swizzle4<T>>; }
    get zwyx(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zwyx') as unknown as Node<Swizzle4<T>>; }
    get wxyz(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wxyz') as unknown as Node<Swizzle4<T>>; }
    get wxzy(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wxzy') as unknown as Node<Swizzle4<T>>; }
    get wyxz(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wyxz') as unknown as Node<Swizzle4<T>>; }
    get wyzx(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wyzx') as unknown as Node<Swizzle4<T>>; }
    get wzxy(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wzxy') as unknown as Node<Swizzle4<T>>; }
    get wzyx(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wzyx') as unknown as Node<Swizzle4<T>>; }

    /* rgba 1-component swizzles */
    get r(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'x') as unknown as Node<Swizzle1<T>>; }
    get g(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'y') as unknown as Node<Swizzle1<T>>; }
    get b(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'z') as unknown as Node<Swizzle1<T>>; }
    get a(): Node<Swizzle1<T>> { return new FieldNode(vecElementTypeOrSelf(this.type), this, 'w') as unknown as Node<Swizzle1<T>>; }

    /* rgba 2-component swizzles */
    get rr(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'xx') as unknown as Node<Swizzle2<T>>; }
    get rg(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'xy') as unknown as Node<Swizzle2<T>>; }
    get rb(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'xz') as unknown as Node<Swizzle2<T>>; }
    get ra(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'xw') as unknown as Node<Swizzle2<T>>; }
    get gr(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'yx') as unknown as Node<Swizzle2<T>>; }
    get gg(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'yy') as unknown as Node<Swizzle2<T>>; }
    get gb(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'yz') as unknown as Node<Swizzle2<T>>; }
    get ga(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'yw') as unknown as Node<Swizzle2<T>>; }
    get br(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'zx') as unknown as Node<Swizzle2<T>>; }
    get bg(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'zy') as unknown as Node<Swizzle2<T>>; }
    get bb(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'zz') as unknown as Node<Swizzle2<T>>; }
    get ba(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'zw') as unknown as Node<Swizzle2<T>>; }
    get ar(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'wx') as unknown as Node<Swizzle2<T>>; }
    get ag(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'wy') as unknown as Node<Swizzle2<T>>; }
    get ab(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'wz') as unknown as Node<Swizzle2<T>>; }
    get aa(): Node<Swizzle2<T>> { return new FieldNode(vec2TypeOf(this.type), this, 'ww') as unknown as Node<Swizzle2<T>>; }

    /* rgba 3-component swizzles */
    get rrr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xxx') as unknown as Node<Swizzle3<T>>; }
    get rrg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xxy') as unknown as Node<Swizzle3<T>>; }
    get rrb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xxz') as unknown as Node<Swizzle3<T>>; }
    get rra(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xxw') as unknown as Node<Swizzle3<T>>; }
    get rgr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xyx') as unknown as Node<Swizzle3<T>>; }
    get rgg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xyy') as unknown as Node<Swizzle3<T>>; }
    get rgb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xyz') as unknown as Node<Swizzle3<T>>; }
    get rga(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xyw') as unknown as Node<Swizzle3<T>>; }
    get rbr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xzx') as unknown as Node<Swizzle3<T>>; }
    get rbg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xzy') as unknown as Node<Swizzle3<T>>; }
    get rbb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xzz') as unknown as Node<Swizzle3<T>>; }
    get rba(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xzw') as unknown as Node<Swizzle3<T>>; }
    get rar(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xwx') as unknown as Node<Swizzle3<T>>; }
    get rag(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xwy') as unknown as Node<Swizzle3<T>>; }
    get rab(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xwz') as unknown as Node<Swizzle3<T>>; }
    get raa(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'xww') as unknown as Node<Swizzle3<T>>; }
    get grr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yxx') as unknown as Node<Swizzle3<T>>; }
    get grg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yxy') as unknown as Node<Swizzle3<T>>; }
    get grb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yxz') as unknown as Node<Swizzle3<T>>; }
    get gra(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yxw') as unknown as Node<Swizzle3<T>>; }
    get ggr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yyx') as unknown as Node<Swizzle3<T>>; }
    get ggg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yyy') as unknown as Node<Swizzle3<T>>; }
    get ggb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yyz') as unknown as Node<Swizzle3<T>>; }
    get gga(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yyw') as unknown as Node<Swizzle3<T>>; }
    get gbr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yzx') as unknown as Node<Swizzle3<T>>; }
    get gbg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yzy') as unknown as Node<Swizzle3<T>>; }
    get gbb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yzz') as unknown as Node<Swizzle3<T>>; }
    get gba(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yzw') as unknown as Node<Swizzle3<T>>; }
    get gar(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'ywx') as unknown as Node<Swizzle3<T>>; }
    get gag(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'ywy') as unknown as Node<Swizzle3<T>>; }
    get gab(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'ywz') as unknown as Node<Swizzle3<T>>; }
    get gaa(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'yww') as unknown as Node<Swizzle3<T>>; }
    get brr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zxx') as unknown as Node<Swizzle3<T>>; }
    get brg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zxy') as unknown as Node<Swizzle3<T>>; }
    get brb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zxz') as unknown as Node<Swizzle3<T>>; }
    get bra(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zxw') as unknown as Node<Swizzle3<T>>; }
    get bgr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zyx') as unknown as Node<Swizzle3<T>>; }
    get bgg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zyy') as unknown as Node<Swizzle3<T>>; }
    get bgb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zyz') as unknown as Node<Swizzle3<T>>; }
    get bga(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zyw') as unknown as Node<Swizzle3<T>>; }
    get bbr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zzx') as unknown as Node<Swizzle3<T>>; }
    get bbg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zzy') as unknown as Node<Swizzle3<T>>; }
    get bbb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zzz') as unknown as Node<Swizzle3<T>>; }
    get bba(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zzw') as unknown as Node<Swizzle3<T>>; }
    get bar(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zwx') as unknown as Node<Swizzle3<T>>; }
    get bag(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zwy') as unknown as Node<Swizzle3<T>>; }
    get bab(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zwz') as unknown as Node<Swizzle3<T>>; }
    get baa(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'zww') as unknown as Node<Swizzle3<T>>; }
    get arr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wxx') as unknown as Node<Swizzle3<T>>; }
    get arg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wxy') as unknown as Node<Swizzle3<T>>; }
    get arb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wxz') as unknown as Node<Swizzle3<T>>; }
    get ara(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wxw') as unknown as Node<Swizzle3<T>>; }
    get agr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wyx') as unknown as Node<Swizzle3<T>>; }
    get agg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wyy') as unknown as Node<Swizzle3<T>>; }
    get agb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wyz') as unknown as Node<Swizzle3<T>>; }
    get aga(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wyw') as unknown as Node<Swizzle3<T>>; }
    get abr(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wzx') as unknown as Node<Swizzle3<T>>; }
    get abg(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wzy') as unknown as Node<Swizzle3<T>>; }
    get abb(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wzz') as unknown as Node<Swizzle3<T>>; }
    get aba(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wzw') as unknown as Node<Swizzle3<T>>; }
    get aar(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wwx') as unknown as Node<Swizzle3<T>>; }
    get aag(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wwy') as unknown as Node<Swizzle3<T>>; }
    get aab(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'wwz') as unknown as Node<Swizzle3<T>>; }
    get aaa(): Node<Swizzle3<T>> { return new FieldNode(vec3TypeOf(this.type), this, 'www') as unknown as Node<Swizzle3<T>>; }

    /* rgba 4-component swizzles (24 unique permutations only) */
    get rgba(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xyzw') as unknown as Node<Swizzle4<T>>; }
    get rgab(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xywz') as unknown as Node<Swizzle4<T>>; }
    get rbga(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xzyw') as unknown as Node<Swizzle4<T>>; }
    get rbag(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xzwy') as unknown as Node<Swizzle4<T>>; }
    get ragb(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xwyz') as unknown as Node<Swizzle4<T>>; }
    get rabg(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'xwzy') as unknown as Node<Swizzle4<T>>; }
    get grba(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'yxzw') as unknown as Node<Swizzle4<T>>; }
    get grab(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'yxwz') as unknown as Node<Swizzle4<T>>; }
    get gbra(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'yzxw') as unknown as Node<Swizzle4<T>>; }
    get gbar(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'yzwx') as unknown as Node<Swizzle4<T>>; }
    get garb(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'ywxz') as unknown as Node<Swizzle4<T>>; }
    get gabr(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'ywzx') as unknown as Node<Swizzle4<T>>; }
    get brga(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zxyw') as unknown as Node<Swizzle4<T>>; }
    get brag(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zxwy') as unknown as Node<Swizzle4<T>>; }
    get bgra(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zyxw') as unknown as Node<Swizzle4<T>>; }
    get bgar(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zywx') as unknown as Node<Swizzle4<T>>; }
    get barg(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zwxy') as unknown as Node<Swizzle4<T>>; }
    get bagr(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'zwyx') as unknown as Node<Swizzle4<T>>; }
    get argb(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wxyz') as unknown as Node<Swizzle4<T>>; }
    get arbg(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wxzy') as unknown as Node<Swizzle4<T>>; }
    get agrb(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wyxz') as unknown as Node<Swizzle4<T>>; }
    get agbr(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wyzx') as unknown as Node<Swizzle4<T>>; }
    get abrg(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wzxy') as unknown as Node<Swizzle4<T>>; }
    get abgr(): Node<Swizzle4<T>> { return new FieldNode(vec4TypeOf(this.type), this, 'wzyx') as unknown as Node<Swizzle4<T>>; }
}

// ---------------------------------------------------------------------------
// InspectorNode — wraps a node for inspector registration
// ---------------------------------------------------------------------------

let _inspectorNodeCounter = 0;

/**
 * InspectorNode wraps a node and registers it with the inspector every frame.
 *
 * Three.js aligned: mirrors src/nodes/core/InspectorNode.js
 *
 * Instead of flagging nodes with _isInspectable and manually iterating in the renderer,
 * InspectorNode leverages the existing node update system (updateType = FRAME) to
 * automatically call inspector.inspect() every frame.
 *
 * Key properties:
 * - `wrappedNode`: The original node being inspected
 * - `inspectorName`: Display name for the inspector UI
 * - `updateType = FRAME`: Ensures update() is called once per frame
 *
 * Usage:
 *   const albedo = texture('texture_2d<f32>', 'albedo').inspect('Albedo');
 *
 * The .inspect() method on Node creates an InspectorNode wrapper and attaches it
 * via node.before(), so it gets built and updated alongside the original node.
 */
export class InspectorNode<T extends WgslType> extends Node<T> {
    /** The original node being inspected. */
    readonly wrappedNode: Node<T>;

    /** Display name for the inspector UI. */
    readonly inspectorName: string;

    /** Marker for type checking. */
    readonly isInspectorNode = true;

    constructor(node: Node<T>, name?: string) {
        // Generate a unique ID for this inspector node
        const id = `inspector_${_inspectorNodeCounter++}_${node.id}`;
        super(id, 'inspector', node.type);

        this.wrappedNode = node;
        this.inspectorName = name ?? node.id;

        // Key: use the FRAME update type so update() is called every frame
        this.updateType = NodeUpdateType.FRAME;
    }

    /**
     * Called by the node update system every frame.
     * Registers this node with the renderer's inspector.
     */
    override update = (frame: NodeFrame): void => {
        frame.renderer!.inspector.inspect(this as unknown as InspectorNode<WgslType>);
    };

    /**
     * Returns the display name for the inspector.
     * Three.js aligned: getName() method.
     */
    getName(): string {
        return this.inspectorName;
    }

    override setup(builder: NodeBuilder): Node<WgslType> | null {
        // Setup the wrapped node - Three.js aligned: call build() which handles stage
        this.wrappedNode.build(builder);
        return null;
    }

    override generate(builder: NodeBuilder, output?: string): string | null {
        // InspectorNode passes through to its wrapped node for code generation
        return this.wrappedNode.build(builder, output) as string | null;
    }
}

// Use .field() for typed struct member access.

// ---------------------------------------------------------------------------
// TempNode — base class for expression nodes with automatic CSE
// ---------------------------------------------------------------------------

/**
 * TempNode is a base class for nodes that may need temporary variable extraction.
 * When a TempNode is used multiple times (usageCount > 1), it automatically creates
 * a `let` variable to avoid recomputing the expression.
 *
 * Three.js aligned: Mirrors src/nodes/core/TempNode.js
 *
 * Expression nodes that produce values (BinopNode, CallNode, ConstructNode, etc.)
 * should extend TempNode instead of Node to get automatic CSE.
 */
export class TempNode<T extends WgslType> extends Node<T> {
    /** Type marker for runtime checking */
    readonly isTempNode = true;

    constructor(id: string, kind: NodeKind, type: T) {
        super(id, kind, type);
    }

    /**
     * Check if this node has multiple usages and needs a temp variable.
     * Three.js aligned: TempNode.hasDependencies()
     */
    hasDependencies(builder: NodeBuilder): boolean {
        return builder.getUsageCount(this as unknown as Node<WgslType>) > 1;
    }

    /**
     * Build this node with automatic temporary variable extraction.
     * If usageCount > 1, creates a `let` variable and returns the variable name.
     *
     * Three.js aligned: TempNode.build()
     */
    override build(builder: NodeBuilder, output?: string): string | null {
        if (builder.getBuildStage() === 'generate') {
            const type = this.type;
            const nodeData = builder.getDataFromNode(this as unknown as Node<WgslType>);

            // Already cached? Return the variable name
            if (nodeData.propertyName !== undefined) {
                return builder.format(nodeData.propertyName, type, output);
            }

            // Need temp var? (type isn't void AND has multiple usages)
            if (type !== 'void' && output !== 'void' && this.hasDependencies(builder)) {
                // Generate the expression
                const snippet = this.generate(builder, type);
                if (snippet === null) return null;

                // Create a variable for it
                const varName = builder.getVarFromNode(this as unknown as Node<WgslType>, null, type);

                // Emit: `let varName = snippet;`
                builder.addLineFlowCode(`let ${varName} = ${snippet}`);

                // Cache for future references
                nodeData.snippet = snippet;
                nodeData.propertyName = varName;

                return builder.format(varName, type, output);
            }
        }

        // No CSE needed - just generate the code directly
        return this.generate(builder, output);
    }
}

// ---------------------------------------------------------------------------
// Subclasses — one per node kind
// ---------------------------------------------------------------------------

export class ConstNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly value: number | number[] | string,
    ) {
        super(computeId('const', { type, value }), 'const', type);
    }

    /**
     * Generate WGSL literal for this constant.
     */
    override generate(_builder: NodeBuilder, _output?: string): string {
        return constLiteral(this.type, this.value);
    }
}

/**
 * Descriptor for a uniform group — determines WGSL @group index and struct packing.
 *
 * Mirrors Three.js `nodes/core/UniformGroupNode.js` (as of PR #33047):
 * - `name`       — struct name and var name in WGSL (e.g. 'render', 'object')
 * - `shared`     — if true, one GPU buffer is shared across all materials/objects
 * - `order`      — determines @group(N) index; groups sorted by order ascending
 * - `updateType` — when this group should be re-uploaded (FRAME, RENDER, OBJECT)
 *
 * Key insight from Three.js PR #33047: instead of string-based checks like
 * `name === 'render'`, the group carries its updateType directly, enabling
 * event-driven dirty tracking via `needsUpdate` and `version`.
 */
export class UniformGroupNode {
    readonly name: string;
    readonly shared: boolean;
    readonly order: number;
    readonly updateType: NodeUpdateType | null;

    /** Dirty flag — set to true to trigger re-upload. Automatically cleared after upload. */
    needsUpdate: boolean = false;

    /** Version counter — incremented each time update() is called. */
    version: number = 0;

    /** Type-testing flag. */
    readonly isUniformGroup: boolean = true;

    constructor(name: string, shared: boolean, order: number, updateType: NodeUpdateType | null = null) {
        this.name = name;
        this.shared = shared;
        this.order = order;
        this.updateType = updateType;
    }

    /**
     * Mark this uniform group as needing an update.
     * This will trigger re-upload on the next render pass.
     */
    update(): void {
        this.needsUpdate = true;
        this.version++;
    }
}

/** Create a per-object (non-shared) uniform group with order=1. */
export const uniformGroup = (name: string, order = 1, updateType: NodeUpdateType | null = null) =>
    new UniformGroupNode(name, false, order, updateType);

/** Create a shared uniform group with configurable order (default 0). */
export const sharedUniformGroup = (name: string, order = 0, updateType: NodeUpdateType | null = null) =>
    new UniformGroupNode(name, true, order, updateType);

/**
 * frameGroup — shared uniforms updated once per frame.
 * Contains time uniforms (timeElapsed, timeDelta).
 * Maps to @group(0) with FRAME update type.
 *
 * Note: For simplicity, gpucat currently merges frame uniforms into renderGroup.
 * This is defined for Three.js API compatibility.
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
        groupNode: UniformGroupNode = objectGroup,
    ) {
        super(computeId('uniform', { type, name, groupNode: groupNode.name }), 'uniform', type);
        this.name = name;
        this.groupNode = groupNode;
    }

    /**
     * Setup: register uniform binding.
     */
    override setup(builder: NodeBuilder): Node<WgslType> | null {
        const groupName = this.groupNode.name;
        const shaderStage = builder.shaderStage ?? 'vertex';
        const bindings = builder.getBindGroupArray(groupName, shaderStage);

        let uniformEntry = builder.uniformGroups[groupName];
        if (uniformEntry === undefined) {
            uniformEntry = {
                type: 'uniform',
                name: groupName,
                groupNode: this.groupNode,
                node: this,
                uniforms: [],
            };
            builder.uniformGroups[groupName] = uniformEntry;
        }

        if (!bindings.includes(uniformEntry)) {
            bindings.push(uniformEntry);
        }

        if (!uniformEntry.uniforms!.some((n: UniformNode<WgslType>) => n.name === this.name)) {
            uniformEntry.uniforms!.push(this);
        }

        const uniformDef = lookupStructDefByName(this.type);
        if (uniformDef) builder.registerStructDef(uniformDef);
        
        return null;
    }

    /**
     * Generate: emit uniform access expression.
     */
    override generate(_builder: NodeBuilder, _output?: string): string {
        return `${this.groupNode.name}.${this.name}`;
    }
}

export class AttributeNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly name: string,
    ) {
        super(computeId('attribute', { type, name }), 'attribute', type);
    }

    /**
     * Setup: register attribute.
     */
    override setup(builder: NodeBuilder): Node<WgslType> | null {
        if (!builder.attributes.has(this.name)) {
            const totalLoc = builder.attributes.size + builder.bufferAttrs.length;
            builder.attributes.set(this.name, { kind: 'geometry', name: this.name, type: this.type, location: totalLoc });
        }
        return null;
    }

    /**
     * Generate: emit attribute access expression.
     */
    override generate(_builder: NodeBuilder, _output?: string): string {
        return `in.${this.name}`;
    }
}

/**
 * StorageNode — GPU storage buffer node.
 *
 * Holds a reference to a StorageBufferAttribute (the `value`), not a raw typed array.
 * Version and updateRanges are delegated to the attribute.
 */
export class StorageNode<T extends WgslType> extends Node<T> {
    /**
     * This flag can be used for type testing.
     */
    readonly isStorageBufferNode: true = true;

    /**
     * The buffer attribute holding the CPU-side data.
     * Mirrors Three.js StorageBufferNode.value.
     */
    readonly value: StorageBufferAttribute;

    /**
     * The buffer type (element type), e.g. 'vec4f', 'mat4x4f'.
     * Same as node.type — provided for Three.js API compatibility.
     */
    readonly bufferType: T;

    /**
     * The number of elements in the buffer.
     * Derived from value.count.
     */
    readonly bufferCount: number;

    /** The WGSL array type string, e.g. 'array<mat4x4f>'. Emitted verbatim. */
    readonly storageType: string;

    readonly access: 'read' | 'read_write';

    /**
     * Whether the node is atomic or not.
     * Mirrors Three.js StorageBufferNode.isAtomic.
     */
    isAtomic: boolean = false;

    /**
     * Uniform group — determines @group index. Defaults to objectGroup.
     */
    groupNode: UniformGroupNode;

    constructor(
        /** The buffer attribute holding the data. */
        value: StorageBufferAttribute,
        /** Element type (e.g. 'mat4x4f') — used as the node's type for downstream indexing. */
        bufferType: T,
        /** Full WGSL array type string (e.g. 'array<mat4x4f>'). */
        storageType: string,
        access: 'read' | 'read_write' = 'read',
        /** Uniform group — determines @group index. Defaults to objectGroup. */
        groupNode: UniformGroupNode = objectGroup,
    ) {
        super(nextId(), 'storage', bufferType);
        this.value = value;
        this.bufferType = bufferType;
        this.bufferCount = value.count;
        this.storageType = storageType;
        this.access = access;
        this.groupNode = groupNode;
    }

    /**
     * Check if this is an indirect storage buffer.
     */
    get isIndirectStorageBuffer(): boolean {
        return !!(this.value as IndirectStorageBufferAttribute).isIndirectStorageBufferAttribute;
    }

    /** defines whether the node is atomic or not */
    setAtomic(value: boolean): this {
        this.isAtomic = value;
        return this;
    }

    /**
     * Convenience method for making this node atomic.
     */
    toAtomic(): this {
        return this.setAtomic(true);
    }

    /** convenience method for configuring read-only access */
    toReadOnly(): StorageNode<T> {
        // Note: access is readonly after construction in gpucat.
        // This method is provided for API compatibility but requires
        // creating a new node if access needs to change.
        if (this.access === 'read') return this;
        return new StorageNode(this.value, this.bufferType, this.storageType, 'read');
    }

    /**
     * Setup: register storage binding.
     */
    override setup(builder: NodeBuilder): Node<WgslType> | null {
        const groupName = this.groupNode.name;
        const shaderStage = builder.shaderStage ?? 'compute';
        const bindings = builder.getBindGroupArray(groupName, shaderStage);

        let storEntry = builder.storageBindings[this.id];
        if (storEntry === undefined) {
            const existingStorageCount = Object.keys(builder.storageBindings).length;
            const name = `_stor${existingStorageCount}`;
            builder.storageNames.set(this.id, name);

            storEntry = {
                type: 'storage',
                name,
                groupNode: this.groupNode,
                node: this,
            };
            builder.storageBindings[this.id] = storEntry;

            const storageDef = lookupStructDefByName(this.type);
            if (storageDef) builder.registerStructDef(storageDef);
        }

        if (!bindings.includes(storEntry)) {
            bindings.push(storEntry);
        }
        
        return null;
    }

    /**
     * Generate: emit storage buffer name.
     */
    override generate(builder: NodeBuilder, _output?: string): string {
        return builder.storageNames.get(this.id) ?? this.id;
    }
}

/**
 * TextureNode - represents a texture sample operation.
 * 
 * When used as a value, it samples the texture at the given UV coordinates.
 * The node type is 'vec4f' (the sampled color), not the texture type.
 */
export class TextureNode extends Node<'vec4f'> {
    /**
     * GPU texture resource. Set this before rendering.
     * This can be set directly, OR use `value` (a Texture object) which the renderer
     * will use to create/update the GPU texture.
     */
    resource: GPUTexture | GPUTextureView | null = null;

    /**
     * GPU sampler resource. Auto-created by the renderer based on the texture's
     * sampling properties (wrap, filter, etc.).
     */
    gpuSampler: GPUSampler | null = null;

    /**
     * High-level Texture wrapper.
     * If set, the renderer will use this to create/update the GPU texture.
     * 
     * Can be:
     * - Texture (scene texture with image data)
     * - Texture with isRenderTargetTexture = true (render target color attachment)
     * - DepthTexture (render target depth attachment, extends Texture)
     */
    value: Texture | null = null;

    /**
     * The UV node for texture coordinates.
     * Defaults to uv() if not specified.
     */
    uvNode: Node<'vec2f'> | null = null;

    /**
     * The reference node
     * When sampling with different UVs, this points to the base texture node.
     */
    referenceNode: TextureNode | null = null;

    /**
     * The WGSL texture type (e.g., 'texture_2d<f32>').
     * Used for binding declarations.
     */
    readonly textureType: TextureType;

    /**
     * This flag can be used for type testing.
     */
    readonly isTextureNode = true;

    /**
     * Uniform group — determines @group index.
     * Defaults to objectGroup.
     */
    groupNode: UniformGroupNode;

    textureId: string;

    constructor(
        textureType: TextureType,
        textureId: string,
        uvNode: Node<'vec2f'> | null = null,
        /** Uniform group — determines @group index. Defaults to objectGroup. */
        groupNode: UniformGroupNode = objectGroup,
    ) {
        // Node type is vec4f (the sampled color)
        super(computeId('texture', { type: textureType, textureId, uvNode: uvNode?.id }), 'texture', 'vec4f');
        this.textureType = textureType;
        this.textureId = textureId;
        this.uvNode = uvNode;
        this.groupNode = groupNode;
    }

    /**
     * Get the base texture node (follows referenceNode chain).
     */
    getBase(): TextureNode {
        return this.referenceNode ? this.referenceNode.getBase() : this;
    }

    /**
     * Convert this texture node to another type.
     */
    convert(type: 'sampler' | 'sampler_comparison'): ConvertNode {
        return new ConvertNode(this, type);
    }

    /**
     * Clone this texture node.
     */
    clone(): TextureNode {
        const cloned = new TextureNode(this.textureType, this.textureId, this.uvNode, this.groupNode);
        cloned.value = this.value;
        cloned.resource = this.resource;
        cloned.gpuSampler = this.gpuSampler;
        cloned.referenceNode = this.referenceNode;
        return cloned;
    }

    /**
     * Sample the texture at the given UV coordinates.
     * Returns a new TextureNode with the UV set.
     */
    sample(uvNode: Node<'vec2f'>): TextureNode {
        const textureNode = this.clone();
        textureNode.uvNode = uvNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /**
     * Setup: register texture and sampler bindings.
     */
    override setup(builder: NodeBuilder): Node<WgslType> | null {
        const base = this.referenceNode ?? this;
        const key = String(base.textureId);

        const groupName = base.groupNode.name;
        const shaderStage = builder.shaderStage ?? 'fragment';
        const bindings = builder.getBindGroupArray(groupName, shaderStage);

        // Handle PassMultipleTextureNode if present
        if ('updateTexture' in base && typeof base.updateTexture === 'function') {
            (base as { updateTexture: () => void }).updateTexture();
            if ('passNode' in base) {
                const passNode = (base as { passNode: { updateBeforeType: string } }).passNode;
                if (passNode.updateBeforeType !== 'none') {
                    builder.sequentialNodes.add(passNode as import('./node-builder').UpdateBeforeNode);
                }
            }
        }

        let texEntry = builder.textureBindings[key];
        if (texEntry === undefined) {
            texEntry = {
                type: 'texture',
                name: key,
                groupNode: base.groupNode,
                node: base,
            };
            builder.textureBindings[key] = texEntry;
        }

        if (!bindings.includes(texEntry)) {
            bindings.push(texEntry);
        }

        let sampEntry = builder.samplerBindings[key];
        if (sampEntry === undefined) {
            sampEntry = {
                type: 'sampler',
                name: key,
                groupNode: base.groupNode,
                node: base,
            };
            builder.samplerBindings[key] = sampEntry;
        }

        if (!bindings.includes(sampEntry)) {
            bindings.push(sampEntry);
        }
        
        return null;
    }

    /**
     * Generate: emit texture sample expression with caching.
     */
    override generate(builder: NodeBuilder, output?: string): string {
        const base = this.referenceNode ?? this;

        // Handle sampler output type
        if (output !== undefined && /^sampler/.test(output)) {
            return `${base.textureId}_samp`;
        }

        // Cache the textureSample result in a let-var (mirrors Three.js TextureNode.generate).
        const nodeData = builder.getDataFromNode(this as unknown as Node<WgslType>);
        if (nodeData.propertyName !== undefined) {
            return nodeData.propertyName;
        }

        const texName = `${base.textureId}_tex`;
        const sampName = `${base.textureId}_samp`;
        const uvExpr = this.uvNode ? (builder.generateNode(this.uvNode) ?? 'in.uv') : 'in.uv';

        const snippet = `textureSample(${texName}, ${sampName}, ${uvExpr})`;
        const varName = builder.getUniqueVarName();
        builder.addLineFlowCode(`let ${varName} = ${snippet}`);
        nodeData.propertyName = varName;
        return varName;
    }
}

export class SamplerNode extends Node<SamplerType> {
    /** GPU sampler resource. Set this before rendering. */
    resource: GPUSampler | null = null;

    constructor(
        type: SamplerType,
        readonly samplerId: string,
    ) {
        super(computeId('sampler', { type, samplerId }), 'sampler', type);
    }
}

/**
 * SubBuildNode - wraps a node to build it in a specific sub-build context.
 * Three.js aligned: src/nodes/core/SubBuildNode.js
 * 
 * Used by VaryingNode to ensure source nodes are built in VERTEX stage.
 */
export class SubBuildNode<T extends WgslType> extends Node<T> {
    readonly isSubBuildNode = true;

    constructor(
        readonly node: Node<T>,
        readonly subBuildName: string,
        nodeType: T | null = null,
    ) {
        super(
            computeId('subBuild', { node: node.id, name: subBuildName }),
            'subBuild',
            nodeType ?? node.type,
        );
    }

    override generateNodeType(builder: NodeBuilder): WgslType {
        if (this.type !== null) return this.type;

        builder.addSubBuild(this.subBuildName);
        const nodeType = this.node.getNodeType(builder);
        builder.removeSubBuild();

        return nodeType;
    }

    override build(builder: NodeBuilder, output?: string): string | Node<WgslType> | null {
        builder.addSubBuild(this.subBuildName);
        const result = this.node.build(builder, output);
        builder.removeSubBuild();
        return result;
    }
}

/**
 * Creates a SubBuildNode wrapper.
 * Three.js aligned: subBuild() factory function.
 */
export function subBuild<T extends WgslType>(
    node: Node<T>,
    name: string,
    type: T | null = null,
): SubBuildNode<T> {
    return new SubBuildNode(node, name, type);
}

/**
 * VaryingNode - represents shader varyings that pass data from vertex to fragment stage.
 * Three.js aligned: src/nodes/core/VaryingNode.js
 */
export class VaryingNode<T extends WgslType> extends Node<T> {
    readonly isVaryingNode = true;

    /** The source node wrapped with subBuild('VERTEX') */
    readonly node: SubBuildNode<T>;

    /** The name of the varying in the shader (auto-generated if null) */
    name: string | null;

    /** Interpolation type */
    interpolationType: InterpolationType | null = null;

    /** Interpolation sampling */
    interpolationSampling: InterpolationSampling | null = null;

    constructor(
        source: Node<T>,
        name: string | null = null,
    ) {
        super(
            computeId('varying', { source: source.id, name }),
            'varying',
            source.type,
        );
        // Wrap source in SubBuildNode for VERTEX stage (Three.js pattern)
        this.node = subBuild(source, 'VERTEX');
        this.name = name;
        // Use global cache for varyings (Three.js pattern)
        this.global = true;
    }

    /**
     * Set the WGSL @interpolate qualifier for this varying.
     */
    setInterpolation(type: InterpolationType, sampling?: InterpolationSampling): this {
        this.interpolationType = type;
        this.interpolationSampling = sampling ?? null;
        return this;
    }

    override getHash(builder: NodeBuilder): string {
        return this.name || super.getHash(builder);
    }

    override generateNodeType(builder: NodeBuilder): WgslType {
        // VaryingNode is auto type - delegate to wrapped node
        return this.node.getNodeType(builder);
    }

    /**
     * Override _getChildren to return empty.
     * VaryingNode bridges vertex → fragment stages. The source node (this.node)
     * is vertex-stage data and should NOT be traversed as a child during
     * fragment-stage validation or traversal.
     */
    override _getChildren(): Array<{ property: string; index?: number | string; childNode: Node<WgslType> }> {
        return [];
    }

    /**
     * Sets up the varying with the node builder.
     */
    setupVarying(builder: NodeBuilder): VaryingData {
        const properties = builder.getNodeProperties(this as unknown as Node<WgslType>);

        let varying = properties.varying as VaryingData | undefined;

        if (varying === undefined) {
            const name = this.name;
            const type = this.getNodeType(builder);
            const interpolationType = this.interpolationType;
            const interpolationSampling = this.interpolationSampling;

            // Register varying with builder
            varying = builder.getVaryingFromNode(
                this as unknown as Node<WgslType>,
                name,
                type,
                interpolationType,
                interpolationSampling,
            );
            properties.varying = varying;
            // Three.js: properties.node = subBuild(this.node, 'VERTEX')
            // this.node is already a SubBuildNode, wrap it again for properties.node
            properties.node = subBuild(this.node, 'VERTEX');
        }

        // Track if interpolation is needed (used in fragment stage)
        varying.needsInterpolation ||= builder.shaderStage === 'fragment';

        return varying;
    }

    override setup(builder: NodeBuilder): Node<WgslType> | null {
        this.setupVarying(builder);
        builder.flowNodeFromShaderStage('vertex', this.node as unknown as Node<WgslType>);
        return null;
    }

    override analyze(builder: NodeBuilder): void {
        this.setupVarying(builder);
        builder.flowNodeFromShaderStage('vertex', this.node as unknown as Node<WgslType>);
    }

    override generate(builder: NodeBuilder, _output?: string): string {
        const properties = builder.getNodeProperties(this as unknown as Node<WgslType>);
        const varying = this.setupVarying(builder);

        // Use a property key scoped to the current stack (for sub-builds)
        const propertyKey = 'property'; // Simplified - Three.js uses getSubBuildProperty

        if (properties[propertyKey] === undefined) {
            const type = this.getNodeType(builder);
            const propertyName = `out.${varying.name}`;

            // Force node to run in vertex stage
            builder.flowNodeFromShaderStage(
                'vertex',
                properties.node as unknown as Node<WgslType>,
                type,
                propertyName,
            );

            properties[propertyKey] = propertyName;
        }

        // Return the varying access for current stage
        return `in.${varying.name}`;
    }
}

export class BinopNode<T extends WgslType> extends Node<T> {
    constructor(
        readonly op: BinopOp,
        type: T,
        readonly left: Node<WgslType>,
        readonly right: Node<WgslType>,
    ) {
        super(computeId('binop', { type, op, a: left.id, b: right.id }), 'binop', type);
    }

    override generate(builder: NodeBuilder, _output?: string): string {
        const l = builder.generateNode(this.left) ?? '/* missing */';
        const r = builder.generateNode(this.right) ?? '/* missing */';
        return `(${l} ${this.op} ${r})`;
    }
}

export class CallNode<T extends WgslType> extends Node<T> {
    readonly fnNode?: FnNode<WgslType>;
    constructor(
        type: T,
        readonly fn: string,
        readonly args: Node<WgslType>[],
        fnNode?: FnNode<WgslType>,
    ) {
        super(computeId('call', { type, fn, args: args.map((n) => n.id) }), 'call', type);
        this.fnNode = fnNode;
    }

    override generate(builder: NodeBuilder, _output?: string): string {
        // Build fnNode if present (Three.js aligned: call build() on the node)
        if (this.fnNode) {
            (this.fnNode as Node<WgslType>).build(builder);
        }
        
        const argExprs = this.args.map((a) => builder.generateNode(a) ?? '/* missing */');
        if (this.fn === 'negate' && argExprs.length === 1) return `(-${argExprs[0]})`;
        if ((this.fn === 'f32' || this.fn === 'i32' || this.fn === 'u32') && argExprs.length === 1) {
            return `${this.fn}(${argExprs[0]})`;
        }
        // Atomic functions require pointer reference (&) for first argument
        const atomicFns = [
            'atomicAdd', 'atomicSub', 'atomicMax', 'atomicMin',
            'atomicAnd', 'atomicOr', 'atomicXor',
            'atomicStore', 'atomicLoad', 'atomicExchange', 'atomicCompareExchangeWeak',
        ];
        if (atomicFns.includes(this.fn) && argExprs.length >= 1) {
            const [ptrArg, ...restArgs] = argExprs;
            const argsWithPtr = [`&${ptrArg}`, ...restArgs];
            return `${this.fn}(${argsWithPtr.join(', ')})`;
        }
        return `${this.fn}(${argExprs.join(', ')})`;
    }
}

/**
 * Inline WGSL expression node.
 * 
 * Used for embedding raw WGSL expressions with node dependencies.
 * The wgsl string uses $0, $1, etc. as placeholders for deps.
 * 
 * @example
 * const expr = new WgslNode('f32', 'dot($0, $1)', [a, b]);
 * // generates: dot(a_expr, b_expr)
 */
export class WgslNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly wgsl: string,
        readonly deps: Node<WgslType>[],
    ) {
        super(computeId('wgsl', { type, wgsl, deps: deps.map((n) => n.id) }), 'wgsl', type);
    }

    /**
     * Returns a new WgslNode with additional unreferenced deps appended.
     * Useful for pulling nodes into the graph (e.g. varyings) without
     * emitting them in the WGSL expression string.
     */
    with(...extra: Node<WgslType>[]): WgslNode<T> {
        return new WgslNode<T>(this.type as T, this.wgsl, [...this.deps, ...extra]);
    }

    override generate(builder: NodeBuilder, _output?: string): string {
        // Build all deps and substitute $0, $1, etc.
        let result = this.wgsl;
        for (let i = 0; i < this.deps.length; i++) {
            const depExpr = builder.generateNode(this.deps[i]) ?? '/* missing */';
            result = result.replace(new RegExp(`\\$${i}`, 'g'), depExpr);
        }
        return result;
    }
}

export class ConvertNode extends Node<WgslType> {
    constructor(
        readonly node: Node<WgslType>,
        readonly convertTo: string,
    ) {
        super(computeId('convert', { node: node.id, convertTo }), 'convert', convertTo as WgslType);
    }

    override generate(builder: NodeBuilder, _output?: string): string | null {
        return builder.generateNode(this.node, this.convertTo);
    }
}

export class AssignNode extends Node<'void'> {
    constructor(
        readonly target: Node<WgslType>,
        readonly value: Node<WgslType>,
    ) {
        super(computeId('assign', { target: target.id, value: value.id }), 'assign', 'void');
    }

    override generate(builder: NodeBuilder, _output?: string): null {
        const tgt = builder.generateNode(this.target) ?? '/* missing */';
        const val = builder.generateNode(this.value) ?? '/* missing */';
        builder.addLineFlowCode(`${tgt} = ${val}`);
        return null;
    }
}

export class ConstructNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly args: Node<WgslType>[],
    ) {
        super(computeId('construct', { type, args: args.map((n) => n.id) }), 'construct', type);
    }

    override generate(builder: NodeBuilder, _output?: string): string {
        const argExprs = this.args.map((a) => builder.generateNode(a) ?? '/* missing */');
        return `${this.type}(${argExprs.join(', ')})`;
    }
}

export class StructNode extends Node<string> {
    constructor(
        typeName: string,
        readonly members: StructMember[],
    ) {
        super(computeId('struct', { type: typeName, members }), 'struct', typeName);
    }

    override setup(builder: NodeBuilder): Node<WgslType> | null {
        const def = lookupStructDef(this);
        if (def) {
            builder.registerStructDef(def);
        } else if (!builder.structNodes.has(this.type)) {
            builder.structNodes.set(this.type, this);
        }
        return null;
    }

    override generate(_builder: NodeBuilder, _output?: string): string {
        return `/* struct ${this.type} */`;
    }
}

export class FieldNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly object: Node<WgslType>,
        readonly fieldName: string,
    ) {
        super(computeId('field', { type, object: object.id, field: fieldName }), 'field', type);
    }

    override generate(builder: NodeBuilder, _output?: string): string {
        const obj = builder.generateNode(this.object) ?? '/* missing */';
        return `${obj}.${this.fieldName}`;
    }
}

export class IndexNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly array: Node<WgslType>,
        readonly index: Node<WgslType>,
    ) {
        super(computeId('index', { type, array: array.id, index: index.id }), 'index', type);
    }

    override generate(builder: NodeBuilder, _output?: string): string {
        const arr = builder.generateNode(this.array) ?? '/* missing */';
        const idx = builder.generateNode(this.index) ?? '/* missing */';
        return `${arr}[${idx}]`;
    }
}

export const index = <T extends WgslType>(array: Node<T>, idx: Node<WgslType>) => new IndexNode(array.type, array, idx);

export class BuiltinNode<T extends WgslType> extends Node<T> {
    constructor(
        readonly builtinKind: BuiltinKind,
        type: T,
    ) {
        super(computeId('builtin', { builtinKind, type }), 'builtin', type);
    }

    override setup(builder: NodeBuilder): Node<WgslType> | null {
        builder.builtinsUsed.add(this.builtinKind);
        return null;
    }

    override generate(builder: NodeBuilder, _output?: string): string {
        const BUILTIN_VAR: Record<string, string> = {
            instance_index: 'instance_index',
            instance_data: 'instanceData',
            vertex_index: 'vertex_index',
        };
        const BUILTIN_VERTEX_INPUT = new Set(['instance_index', 'vertex_index']);
        const BUILTIN_FRAGMENT_INPUT = new Set(['position']);
        if (builder.shaderStage === 'compute') {
            return BUILTIN_VAR[this.builtinKind] ?? this.builtinKind;
        }
        if (BUILTIN_VERTEX_INPUT.has(this.builtinKind)) return `in.${BUILTIN_VAR[this.builtinKind] ?? this.builtinKind}`;
        if (BUILTIN_FRAGMENT_INPUT.has(this.builtinKind) && builder.shaderStage === 'fragment') return `in.${this.builtinKind}`;
        return BUILTIN_VAR[this.builtinKind] ?? this.builtinKind;
    }
}

export const builtin = <T extends WgslType>(builtinKind: BuiltinKind, type: T) => new BuiltinNode(builtinKind, type);

/* counter used by StackNode and all statement-level nodes (VarNode, IfNode) to ensure unique IDs */

let _nodeCounter = 0;
const nextId = () => `s_${_nodeCounter++}`;

/**
 * Any typed array that WebGPU can upload as a vertex buffer.
 * Use this as the `data` type for instanced buffer attributes.
 */
export type GpuTypedArray =
    | Float32Array
    | Int32Array
    | Uint32Array
    | Int16Array
    | Uint16Array
    | Int8Array
    | Uint8Array;

/**
 * BufferAttributeNode — a vertex attribute backed by a BufferAttribute or raw TypedArray.
 *
 * Mirrors Three.js BufferAttributeNode. Can be used for both regular vertex attributes
 * and per-instance attributes (stepMode: 'instance') by setting `instanced = true`.
 *
 * When passed an InstancedBufferAttribute, `instanced` is auto-set to true.
 *
 * @example
 * // Instanced attribute with InstancedBufferAttribute:
 * const attr = new InstancedBufferAttribute(new Float32Array([...]), 3);
 * const offsets = bufferAttribute(attr, S.vec3f());  // instanced = true auto
 *
 * // Instanced attribute with raw TypedArray:
 * const offsets = instancedBufferAttribute(new Float32Array([...]), S.vec3f());
 *
 * // Regular attribute:
 * const colors = bufferAttribute(new Float32Array([...]), S.vec3f());
 */
export class BufferAttributeNode<T extends WgslType> extends Node<T> {
    /** The underlying BufferAttribute (StorageBufferAttribute/InstancedBufferAttribute). */
    readonly attribute: StorageBufferAttribute | InstancedBufferAttribute;
    /** Byte stride between consecutive elements. */
    readonly stride: number;
    /** Byte offset of this attribute within each element. */
    readonly offset: number;
    /** Whether this attribute is instanced (stepMode: 'instance'). */
    instanced: boolean;

    constructor(
        type: T,
        value: StorageBufferAttribute | InstancedBufferAttribute | GpuTypedArray,
        stride: number,
        offset: number,
        itemSize: number,
    ) {
        // ID is NOT content-addressed on data (too expensive to hash large arrays).
        // Use a monotonic id so two separate bufferAttribute() calls are always distinct.
        super(nextId(), 'buffer_attribute', type);

        // If passed a raw TypedArray, wrap it in a StorageBufferAttribute
        if (ArrayBuffer.isView(value)) {
            this.attribute = new StorageBufferAttribute(value as GpuTypedArray, itemSize);
            this.instanced = false;
        } else {
            this.attribute = value;
            // Auto-detect instanced from attribute type
            this.instanced = 'isInstancedBufferAttribute' in value && value.isInstancedBufferAttribute === true;
        }

        this.stride = stride;
        this.offset = offset;
    }

    /** Set instanced flag (chainable). */
    setInstanced(value: boolean): this {
        this.instanced = value;
        return this;
    }

    override setup(builder: NodeBuilder): Node<WgslType> | null {
        if (!builder.bufferAttrNames.has(this.id)) {
            const totalLoc = builder.attributes.size + builder.bufferAttrs.length;
            const name = `_buf${builder.bufferAttrs.length}`;
            builder.bufferAttrNames.set(this.id, name);
            builder.bufferAttrs.push({
                kind: 'buffer',
                node: this as unknown as BufferAttributeNode<WgslType>,
                name,
                type: this.type,
                location: totalLoc,
            });
        }
        return null;
    }

    override generate(builder: NodeBuilder, _output?: string): string {
        const name = builder.bufferAttrNames.get(this.id);
        return name ? `in.${name}` : `/* missing buffer attr ${this.id} */`;
    }
}

export class StackNode extends Node<'void'> {
    readonly body: Node<WgslType>[];
    constructor(initial?: Node<WgslType>[]) {
        // StackNode used during tracing starts empty; the `stack(...)` DSL helper
        // passes an initial array. ID is computed lazily after tracing is complete,
        // but for now we use a monotonic ID so two stacks are never deduplicated.
        super(nextId(), 'stack', 'void');
        this.body = initial ? [...initial] : [];
    }
    push(node: Node<WgslType>): void {
        this.body.push(node);
    }

    override generate(builder: NodeBuilder, _output?: string): null {
        for (const stmt of this.body) {
            stmt.build(builder);
        }
        return null;
    }
}

export class CondNode<T extends WgslType> extends Node<T> {
    readonly ifFalse?: Node<WgslType>;
    constructor(
        readonly condition: Node<WgslType>,
        readonly ifTrue: Node<T>,
        ifFalse?: Node<T>,
    ) {
        super(computeId('cond', { condition: condition.id, ifTrue: ifTrue.id, ifFalse: ifFalse?.id }), 'cond', ifTrue.type);
        this.ifFalse = ifFalse;
    }

    override generate(builder: NodeBuilder, _output?: string): string {
        const condExpr = builder.generateNode(this.condition) ?? '/* missing */';
        const trueExpr = builder.generateNode(this.ifTrue) ?? '/* missing */';
        const falseExpr = this.ifFalse ? (builder.generateNode(this.ifFalse) ?? '/* missing */') : `${this.type}()`;
        return `select(${falseExpr}, ${trueExpr}, ${condExpr})`;
    }
}

/**
 * VarNode — a mutable local variable declared inside a Fn body.
 * Created by `toVar()`. The JS handle is returned so the caller can call
 * `.assign()` later. The node is also pushed onto the current StackNode.
 *
 * kind: 'var'
 */
export class VarNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly varName: string,
        readonly init: Node<T>,
        readonly isConst: boolean = false,
    ) {
        super(nextId(), 'var', type);
    }

    override generate(builder: NodeBuilder, _output?: string): string {
        const data = builder.getDataFromNode(this as unknown as Node<WgslType>);
        if (data.propertyName === undefined) {
            data.propertyName = this.varName;
            const initExpr = builder.generateNode(this.init) ?? '/* missing */';
            if (this.isConst) {
                builder.addLineFlowCode(`let ${this.varName} = ${initExpr}`);
            } else {
                const name = builder.getVarFromNode(this as unknown as Node<WgslType>, this.varName, this.type);
                builder.addLineFlowCode(`${name} = ${initExpr}`);
            }
        }
        return this.varName;
    }
}

/**
 * IfNode — statement-form conditional (compiles to `if (cond) { ... } else { ... }`).
 * Distinct from CondNode which is the expression form (`select(a,b,cond)`).
 * Created by `If()`. The `.Else()` chain sets elseBody on the same IfNode.
 *
 * kind: 'if'
 */
export class IfNode extends Node<'void'> {
    elseBody: StackNode | null = null;
    constructor(
        readonly condition: Node<WgslType>,
        readonly thenBody: StackNode,
    ) {
        super(nextId(), 'if', 'void');
    }

    override generate(builder: NodeBuilder, _output?: string): null {
        const condExpr = builder.generateNode(this.condition) ?? '/* missing */';
        builder.addFlowCode(`${builder.tab}if (${condExpr}) {\n`);
        builder.emitStackIntoFlow(this.thenBody, builder.tab + '    ');
        if (this.elseBody) {
            builder.addFlowCode(`${builder.tab}} else {\n`);
            builder.emitStackIntoFlow(this.elseBody, builder.tab + '    ');
        }
        builder.addFlowCode(`${builder.tab}}\n`);
        return null;
    }
}

/**
 * LoopParam describes a single loop level in a Loop/For construct.
 * Matches Three.js TSL LoopNode param format exactly.
 *
 * Can be:
 * - A plain number (count from 0 to n-1)
 * - A Node (count from 0 to node-1, or while-loop if boolean type)
 * - A config object with start/end/type/condition/update/name
 */
export type LoopParam = Node<WgslType> | number | {
    /** Inclusive start value. Node<WgslType> or plain number. Default: 0. */
    start?: Node<WgslType> | number;
    /** End bound. Node<WgslType> or plain number. */
    end?: Node<WgslType> | number;
    /** WGSL scalar type for the index variable. Default: 'i32' to match Three.js. */
    type?: ScalarType;
    /** Comparison operator. Auto-inferred when omitted. */
    condition?: '<' | '<=' | '>' | '>=';
    /** Per-iteration step as a Node, number, string, or function. */
    update?: Node<WgslType> | number | string | ((...args: unknown[]) => void);
    /** Variable name override. Default: auto-generated (i, j, k, ...). */
    name?: string;
};

/** Legacy ForRange type - alias for LoopParam config object for backwards compat during transition. */
export type ForRange = Exclude<LoopParam, Node<WgslType> | number>;

/** Helper for generating loop update snippets. */
function buildLoopUpdateSnippet(
    update: unknown,
    iName: string,
    type: ScalarType,
    defaultOp: '++' | '--',
    builder: NodeBuilder,
): string {
    if (update === null || update === undefined) return `${iName}${defaultOp}`;
    if (typeof update === 'number') {
        const delta = constLiteral(type, Math.abs(update));
        const op = defaultOp.includes('+') ? '+=' : '-=';
        return `${iName} ${op} ${delta}`;
    }
    if (typeof update === 'string') {
        // String update like '+= 2' or '++'
        return `${iName} ${update}`;
    }
    if (update instanceof Node) {
        // Node update - generate the node expression
        const nodeExpr = builder.generateNode(update as Node<WgslType>) ?? '1';
        const op = defaultOp.includes('+') ? '+=' : '-=';
        return `${iName} ${op} ${nodeExpr}`;
    }
    // Function update - not supported at generate time (should have been handled in setup)
    return `${iName}${defaultOp}`;
}

/**
 * LoopNode — statement-form loop supporting all Three.js TSL Loop forms.
 * 
 * **Matches Three.js TSL exactly:**
 * - Stores raw params array (loop descriptors + callback)
 * - Callback execution is deferred to compile time
 * - Supports all Three.js Loop forms:
 *   - Simple count: `Loop(count, ({i}) => ...)`
 *   - Config object: `Loop({start, end, type, condition, update, name}, ({i}) => ...)`
 *   - Nested loops: `Loop(10, 5, ({i, j}) => ...)`
 *   - Boolean while: `Loop(boolNode, () => ...)` (when node type is 'bool')
 *   - Backwards: `Loop({start: 10}, () => {})` (only start given, counts down)
 *
 * kind: 'loop'
 */
export class LoopNode extends Node<'void'> {
    /**
     * Raw params array. All elements except the last are loop level descriptors.
     * The last element is the callback function.
     */
    readonly params: unknown[];
    
    constructor(params: unknown[] = []) {
        super(nextId(), 'loop', 'void');
        this.params = params;
    }
    
    /**
     * Returns a loop variable name based on an index. The pattern is
     * `0` = `i`, `1`= `j`, `2`= `k` and so on.
     * Matches Three.js TSL LoopNode.getVarName()
     */
    getVarName(index: number): string {
        return String.fromCharCode('i'.charCodeAt(0) + index);
    }
    
    /**
     * Add this node to the current stack.
     * Matches Three.js TSL .toStack() method.
     */
    toStack(): this {
        addToStack(this);
        return this;
    }

    override generate(builder: NodeBuilder, _output?: string): null {
        // Get the stack that was created during setup (deferred callback execution)
        // Matches Three.js: const stackNode = properties.stackNode;
        const data = builder.getDataFromNode(this as unknown as Node<WgslType>);
        const stackNode = data.stackNode as StackNode | undefined;
        if (!stackNode) {
            builder.addFlowCode(`${builder.tab}/* loop: missing stack */\n`);
            return null;
        }

        const params = this.params;
        const numLoops = params.length - 1;

        // Generate nested loop headers for each level (matches Three.js LoopNode.generate)
        for (let i = 0; i < numLoops; i++) {
            const param = params[i];

            let loopSnippet: string;

            if (param instanceof Node) {
                // Node parameter
                const paramType = param.type;

                if (paramType === 'bool') {
                    // While-style loop with boolean condition
                    const condExpr = builder.generateNode(param) ?? 'true';
                    loopSnippet = `while (${condExpr})`;
                } else {
                    // For-style loop: 0 to node-1
                    const name = this.getVarName(i);
                    const type: ScalarType = 'i32';
                    const endExpr = builder.generateNode(param) ?? '0';
                    loopSnippet = `for (var ${name} : ${type} = 0i; ${name} < ${endExpr}; ${name}++)`;
                }
            } else if (typeof param === 'number') {
                // Simple count: 0 to param-1
                const name = this.getVarName(i);
                const type: ScalarType = 'i32';
                const endExpr = constLiteral(type, param);
                loopSnippet = `for (var ${name} : ${type} = 0i; ${name} < ${endExpr}; ${name}++)`;
            } else if (typeof param === 'object' && param !== null) {
                // Config object with start/end/type/condition/update/name
                const cfg = param as {
                    start?: Node<WgslType> | number;
                    end?: Node<WgslType> | number;
                    type?: ScalarType;
                    condition?: '<' | '<=' | '>' | '>=';
                    update?: unknown;
                    name?: string;
                };

                const type: ScalarType = cfg.type ?? 'i32';
                const name = cfg.name ?? this.getVarName(i);
                const start = cfg.start;
                const end = cfg.end;
                let condition = cfg.condition;

                // Handle start/end inference (matches Three.js logic)
                const getExpr = (v: Node<WgslType> | number | undefined): string | undefined => {
                    if (v === undefined) return undefined;
                    if (typeof v === 'number') return constLiteral(type, v);
                    return builder.generateNode(v) ?? '0';
                };

                let startExpr = getExpr(start);
                let endExpr = getExpr(end);

                // Backwards loop: only start given
                if (startExpr !== undefined && endExpr === undefined) {
                    startExpr = `${startExpr} - 1i`;
                    endExpr = '0i';
                    condition = '>=';
                } else if (endExpr !== undefined && startExpr === undefined) {
                    startExpr = '0i';
                    condition = '<';
                }

                // Default condition based on start/end values
                if (condition === undefined) {
                    const startNum = typeof start === 'number' ? start : 0;
                    const endNum = typeof end === 'number' ? end : 1;
                    condition = startNum > endNum ? '>=' : '<';
                }

                const defaultOp = condition.includes('<') ? '++' : '--';
                const updateSnippet = buildLoopUpdateSnippet(cfg.update, name, type, defaultOp, builder);

                loopSnippet = `for (var ${name} : ${type} = ${startExpr ?? '0i'}; ${name} ${condition} ${endExpr ?? '0i'}; ${updateSnippet})`;
            } else {
                // Fallback
                loopSnippet = `/* unknown loop param type */`;
            }

            builder.addFlowCode(`${builder.tab}${loopSnippet} {\n`);
            builder.addFlowTab();
        }

        // Emit body at the innermost nesting level
        builder.emitStackIntoFlow(stackNode, builder.tab);

        // Close all loop braces (innermost to outermost)
        for (let i = numLoops - 1; i >= 0; i--) {
            builder.removeFlowTab();
            builder.addFlowCode(`${builder.tab}}\n`);
        }

        return null;
    }
}

/**
 * BreakNode — a `break` statement inside a loop body.
 * Created by `Break()`.
 *
 * kind: 'break'
 */
export class BreakNode extends Node<'void'> {
    constructor() {
        super(nextId(), 'break', 'void');
    }

    override generate(builder: NodeBuilder, _output?: string): null {
        builder.addLineFlowCode('break');
        return null;
    }
}

/**
 * ContinueNode — a `continue` statement inside a loop body.
 * Created by `Continue()`.
 *
 * kind: 'continue'
 */
export class ContinueNode extends Node<'void'> {
    constructor() {
        super(nextId(), 'continue', 'void');
    }

    override generate(builder: NodeBuilder, _output?: string): null {
        builder.addLineFlowCode('continue');
        return null;
    }
}

/**
 * ExpressionNode — inline WGSL snippet node.
 * Matches Three.js TSL ExpressionNode exactly.
 *
 * Used for:
 * - Loop index variables: `expression('i', 'i32')` → generates `i`
 * - Control flow: `expression('continue')` → generates `continue;`
 * - Any raw WGSL snippet that needs to be embedded
 *
 * kind: 'expression'
 */
export class ExpressionNode<T extends WgslType> extends Node<T> {
    constructor(
        /** The native WGSL code snippet */
        readonly snippet: string,
        /** The node type (default 'void') */
        type: T = 'void' as T,
    ) {
        super(nextId(), 'expression', type);
    }

    override generate(builder: NodeBuilder, _output?: string): string | null {
        // Matches Three.js ExpressionNode.generate() exactly:
        // - If type is 'void', add as flow code line (statement)
        // - Otherwise return the snippet as an expression
        if (this.type === 'void') {
            builder.addLineFlowCode(this.snippet);
            return null;
        }
        return this.snippet;
    }
}

/**
 * ParamNode — a typed function parameter placeholder.
 * Created by `Fn()` when it builds the FnNode. Also used as the loop index in ForNode.
 *
 * kind: 'param'
 */
export class ParamNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly paramIndex: number,
        /** The declared name from FnLayout.params[i].name, if a layout was provided. */
        readonly paramName?: string,
    ) {
        super(nextId(), 'param', type);
    }

    override generate(_builder: NodeBuilder, _output?: string): string {
        return this.paramName ?? `p${this.paramIndex}`;
    }
}

export class ReturnNode<T extends WgslType> extends Node<T> {
    constructor(readonly value: Node<T>) {
        super(nextId(), 'return', value.type);
    }

    override generate(builder: NodeBuilder, _output?: string): null {
        const valExpr = builder.generateNode(this.value) ?? '/* missing */';
        builder.addLineFlowCode(`return ${valExpr}`);
        return null;
    }
}

/**
 * FnNode — a named WGSL function defined via `Fn(jsFunc)` or `Fn(jsFunc, layout)`.
 * Holds the parameter descriptors and a JS function that, when called with
 * ParamNodes, performs eager tracing to produce the body StackNode + outputNode.
 *
 * The compiler calls `trace()` once to materialise the body.
 *
 * kind: 'fn'
 */
export class FnNode<T extends WgslType> extends Node<T> {
    /** WGSL function name. From layout.name if provided, otherwise auto-generated `fn_<id>`. */
    readonly fnName: string;
    /**
     * Parameter descriptors. ParamDesc[] when a layout was provided (carries name + type),
     * WgslDesc[] when no layout was given (type only, name will be auto `p0`, `p1`, …).
     */
    readonly paramDescs: (ParamDesc | WgslDesc<WgslType>)[];
    /** The JS function passed to Fn(). The compiler calls this with ParamNodes. */
    readonly jsFunc: (...args: Node<WgslType>[]) => Node<T>;

    constructor(
        returnType: T,
        paramDescs: (ParamDesc | WgslDesc<WgslType>)[],
        jsFunc: (...args: Node<WgslType>[]) => Node<T>,
        fnName?: string,
    ) {
        super(nextId(), 'fn', returnType);
        this.fnName = fnName ?? `fn_${this.id}`;
        this.paramDescs = paramDescs;
        this.jsFunc = jsFunc;
    }

    /**
     * Create a ComputeNode from this FnNode.
     *
     * @example
     * const kernel = Fn(() => {
     *     const idx = globalId.x;
     *     // ...
     * }).compute({ dispatch: [Math.ceil(N / 64)] });
     */
    compute(opts: ComputeOptions): ComputeNode { 
        return new ComputeNode({ fn: this, ...opts });
     }
    

    /**
     * StackNode body and the output expression node.
     * Returns { params, body, output } for use by the compiler.
     */
    trace(): { params: ParamNode<WgslType>[]; body: StackNode; output: Node<T> } {
        const params = this.paramDescs.map((d, i) => {
            const paramName = 'name' in d ? (d as ParamDesc).name : undefined;
            const wgslType = 'name' in d ? (d as ParamDesc).type.wgslType : (d as WgslDesc<WgslType>).wgslType;
            return new ParamNode(wgslType, i, paramName);
        });
        const stack = new StackNode();
        const prev = pushStack(stack);
        let output: Node<T>;
        try {
            output = this.jsFunc(...params);
        } finally {
            popStack(prev);
        }
        return { params, body: stack, output };
    }

    override generate(_builder: NodeBuilder, _output?: string): string {
        // FnNode itself just returns a placeholder - actual function call 
        // generation is handled by CallNode.generate()
        return `/* fn ${this.type} */`;
    }
}

// ---------------------------------------------------------------------------
// CodeNode / FunctionNode / FunctionCallNode — Three.js TSL aligned
// ---------------------------------------------------------------------------

/**
 * Parsed WGSL function info returned by parseWgslFunction().
 * Three.js aligned: mirrors WGSLNodeFunction structure.
 */
export type NodeFunctionInput = {
    name: string;
    type: string;
    pointer?: boolean;
};

export type NodeFunction = {
    type: string;
    inputs: NodeFunctionInput[];
    name: string;
    inputsCode: string;
    blockCode: string;
    outputType: string;
    getCode(name?: string): string;
};

/**
 * Parse WGSL function source into a NodeFunction.
 * Three.js aligned: mirrors WGSLNodeFunction parsing.
 */
function parseWgslFunction(source: string): NodeFunction {
    source = source.trim();

    const declarationRegexp = /^[fn]*\s*([a-z_0-9]+)?\s*\(([\s\S]*?)\)\s*[-]*[>]*\s*([a-z_0-9]+(?:<[\s\S]+?>)?)?/i;
    const propertiesRegexp = /([a-z_0-9]+)\s*:\s*([a-z_0-9]+(?:<[\s\S]+?>)?)/ig;

    const declaration = source.match(declarationRegexp);

    if (declaration === null || declaration.length < 2) {
        throw new Error(`[gpucat] FunctionNode: Could not parse WGSL function.\n${source.slice(0, 100)}...`);
    }

    const inputsCode = declaration[2] || '';
    const propsMatches: { name: string; type: string }[] = [];
    let match: RegExpExecArray | null = null;

    while ((match = propertiesRegexp.exec(inputsCode)) !== null) {
        propsMatches.push({ name: match[1], type: match[2] });
    }

    const inputs: NodeFunctionInput[] = [];
    for (const { name, type } of propsMatches) {
        let resolvedType = type;
        let pointer = false;

        if (resolvedType.startsWith('ptr')) {
            resolvedType = 'pointer';
            pointer = true;
        }

        inputs.push({ name, type: resolvedType, pointer });
    }

    // Find where function body starts (after the signature)
    const bodyStart = source.indexOf('{');
    const blockCode = bodyStart >= 0 ? source.substring(bodyStart) : '{}';
    const outputType = declaration[3] || 'void';

    const name = declaration[1] !== undefined ? declaration[1] : '';
    const type = outputType; // Keep WGSL type as-is

    return {
        type,
        inputs,
        name,
        inputsCode,
        blockCode,
        outputType,
        getCode(fnName = name): string {
            const outputPart = outputType !== 'void' ? `-> ${outputType}` : '';
            return `fn ${fnName}(${inputsCode.trim()}) ${outputPart}${blockCode}`;
        },
    };
}

/**
 * CodeNode — base class for native shader code sections.
 * 
 * Three.js aligned: three/src/nodes/code/CodeNode.js
 * 
 * kind: 'code'
 */
export class CodeNode extends Node<'code'> {
    /** Type marker for runtime checking */
    readonly isCodeNode = true;

    /** Global nodes use globalCache for deduplication */
    override global = true;

    /** The native shader code */
    code: string;

    /** Array of included CodeNodes/FunctionNodes */
    includes: CodeNode[];

    /** The language ('wgsl') */
    language: string;

    constructor(code = '', includes: CodeNode[] = [], language = 'wgsl') {
        super(computeId('code', { code, language }), 'code', 'code');
        this.code = code;
        this.includes = includes;
        this.language = language;
    }

    setIncludes(includes: CodeNode[]): this {
        this.includes = includes;
        return this;
    }

    getIncludes(_builder: NodeBuilder): CodeNode[] {
        return this.includes;
    }

    override generate(builder: NodeBuilder): string {
        const includes = this.getIncludes(builder);

        // Build all includes first (registers them into codes[shaderStage])
        for (const include of includes) {
            include.build(builder);
        }

        // Register this code into the builder's codes list
        const nodeCode = builder.getCodeFromNode(this, this.getNodeType(builder));
        nodeCode.code = this.code;

        return nodeCode.code;
    }
}

/**
 * FunctionNode — represents a native WGSL function.
 * 
 * Three.js aligned: three/src/nodes/code/FunctionNode.js
 * 
 * kind: 'function'
 */
export class FunctionNode extends CodeNode {
    /** Type marker for runtime checking */
    readonly isFunctionNode = true;

    constructor(code = '', includes: CodeNode[] = [], language = 'wgsl') {
        super(code, includes, language);
        // Override kind for FunctionNode
        (this as { kind: NodeKind }).kind = 'function';
    }

    /**
     * Get the node function (parsed WGSL) for this function node.
     * Cached in nodeData.
     */
    getNodeFunction(builder: NodeBuilder): NodeFunction {
        const nodeData = builder.getDataFromNode(this as unknown as Node<WgslType>);

        let nodeFunction = nodeData.nodeFunction as NodeFunction | undefined;

        if (nodeFunction === undefined) {
            nodeFunction = parseWgslFunction(this.code);
            nodeData.nodeFunction = nodeFunction;
        }

        return nodeFunction;
    }

    /**
     * Returns the inputs (parameters) of this function.
     */
    getInputs(builder: NodeBuilder): NodeFunctionInput[] {
        return this.getNodeFunction(builder).inputs;
    }

    /**
     * Returns the return type of this function.
     */
    override getNodeType(builder: NodeBuilder): string {
        return this.getNodeFunction(builder).type;
    }

    override generate(builder: NodeBuilder, output?: string): string {
        // Build includes first
        super.generate(builder);

        const nodeFunction = this.getNodeFunction(builder);
        const name = nodeFunction.name;
        const type = nodeFunction.type;

        // Register into codes
        const nodeCode = builder.getCodeFromNode(this as unknown as Node<WgslType>, type);

        if (name !== '') {
            nodeCode.name = name;
        }

        const propertyName = nodeCode.name;
        const code = nodeFunction.getCode(propertyName);

        nodeCode.code = code + '\n';

        if (output === 'property') {
            // Return just the function name
            return propertyName;
        } else {
            // Return a call to the function with no args
            return `${propertyName}()`;
        }
    }

    /**
     * Create a FunctionCallNode that calls this function.
     * Three.js aligned: FunctionNode can be called via fn.call(...params)
     */
    call(...params: (Node<WgslType> | Record<string, Node<WgslType>>)[]): FunctionCallNode {
        // If single object param, treat as named parameters
        if (params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !('isNode' in params[0])) {
            return new FunctionCallNode(this, params[0] as Record<string, Node<WgslType>>);
        }
        // Otherwise treat as positional array
        return new FunctionCallNode(this, params as Node<WgslType>[]);
    }
}

/**
 * FunctionCallNode — represents a call to a FunctionNode.
 * 
 * Three.js aligned: three/src/nodes/code/FunctionCallNode.js
 * 
 * kind: 'functionCall'
 */
export class FunctionCallNode extends TempNode<WgslType> {
    /** Type marker for runtime checking */
    readonly isFunctionCallNode = true;

    /** The function node being called */
    functionNode: FunctionNode;

    /** Parameters for the function call (array or named object) */
    parameters: Node<WgslType>[] | Record<string, Node<WgslType>>;

    constructor(
        functionNode: FunctionNode,
        parameters: Node<WgslType>[] | Record<string, Node<WgslType>> = [],
    ) {
        const id = computeId('functionCall', { fn: functionNode.code, params: Array.isArray(parameters) ? parameters.length : Object.keys(parameters).length });
        super(id, 'functionCall', 'void'); // Type will be determined dynamically
        this.functionNode = functionNode;
        this.parameters = parameters;
    }

    setParameters(parameters: Node<WgslType>[] | Record<string, Node<WgslType>>): this {
        this.parameters = parameters;
        return this;
    }

    getParameters(): Node<WgslType>[] | Record<string, Node<WgslType>> {
        return this.parameters;
    }

    /**
     * Get the return type from the function node.
     */
    override getNodeType(builder: NodeBuilder): string {
        return this.functionNode.getNodeType(builder);
    }

    override generate(builder: NodeBuilder): string {
        const params: string[] = [];
        const functionNode = this.functionNode;
        const inputs = functionNode.getInputs(builder);
        const parameters = this.parameters;

        const generateInput = (node: Node<WgslType>, inputNode: NodeFunctionInput): string => {
            const pointer = inputNode.pointer;
            const built = node.build(builder, inputNode.type);
            const expr = (typeof built === 'string' ? built : null) ?? '/* missing */';

            if (pointer) {
                return '&' + expr;
            }
            return expr;
        };

        if (Array.isArray(parameters)) {
            // Positional parameters
            for (let i = 0; i < inputs.length; i++) {
                const node = parameters[i];
                if (node !== undefined) {
                    params.push(generateInput(node, inputs[i]));
                } else {
                    console.warn(`[gpucat] FunctionCallNode: Missing parameter at index ${i}`);
                    params.push('0.0'); // fallback
                }
            }
        } else {
            // Named parameters
            for (const inputNode of inputs) {
                const node = parameters[inputNode.name];
                if (node !== undefined) {
                    params.push(generateInput(node, inputNode));
                } else {
                    console.warn(`[gpucat] FunctionCallNode: Missing parameter '${inputNode.name}'`);
                    params.push('0.0'); // fallback
                }
            }
        }

        // Build the function (registers it into codes) and get the function name
        const functionName = functionNode.build(builder, 'property');

        return `${functionName}(${params.join(', ')})`;
    }
}

/**
 * Create a WGSL function from raw WGSL source code.
 *
 * The source must be a complete WGSL function definition:
 * ```wgsl
 * fn myFunc(a: f32, b: vec3f) -> vec4f {
 *     return vec4f(b * a, 1.0);
 * }
 * ```
 *
 * Returns a callable that creates FunctionCallNodes when invoked with arguments.
 * Arguments can be passed as:
 * - Positional: `myFunc(aNode, bNode)`
 * - Named object: `myFunc({ a: aNode, b: bNode })`
 *
 * Three.js aligned: mirrors three/src/nodes/code/FunctionNode.js nativeFn/wgslFn
 *
 * @param source - Complete WGSL function source code
 * @param includes - Other wgslFn functions this function depends on
 *
 * @example
 * const aces = wgslFn(`
 *     fn acesToneMapping(color: vec3f) -> vec3f {
 *         let c = color;
 *         return clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
 *     }
 * `);
 *
 * // Use in node graph:
 * const tonemapped = aces(linearColor);
 * // Or with named params:
 * const tonemapped = aces({ color: linearColor });
 */
export function wgslFn(
    source: string,
    includes: (WgslFnCallable | FunctionNode)[] = [],
): WgslFnCallable {
    // Extract FunctionNode from callable includes (Three.js pattern)
    const includeNodes: CodeNode[] = [];
    for (let i = 0; i < includes.length; i++) {
        const include = includes[i];
        // If it's a callable from wgslFn, extract the functionNode
        if (typeof include === 'function') {
            const fn = (include as WgslFnCallable).functionNode;
            if (fn) {
                includeNodes.push(fn);
            }
        } else if (include instanceof FunctionNode) {
            includeNodes.push(include);
        }
    }

    const functionNode = new FunctionNode(source.trim(), includeNodes, 'wgsl');

    // Return a callable that creates FunctionCallNodes
    const fn = (...params: (Node<WgslType> | Record<string, Node<WgslType>>)[]): FunctionCallNode => {
        return functionNode.call(...params);
    };

    // Attach functionNode for include resolution (Three.js pattern)
    fn.functionNode = functionNode;

    return fn as WgslFnCallable;
}

/** Type for the callable returned by wgslFn (Three.js aligned) */
export type WgslFnCallable = {
    (...params: (Node<WgslType> | Record<string, Node<WgslType>>)[]): FunctionCallNode;
    functionNode: FunctionNode;
};

// ---------------------------------------------------------------------------
// currentStack — module-level tracing context
// ---------------------------------------------------------------------------

let currentStack: StackNode | null = null;

/**
 * Push a new stack onto the stack context.
 * Returns the previous stack so it can be restored with popStack().
 * Exported for use by the compiler during deferred loop callback execution.
 */
export function pushStack(stack: StackNode): StackNode | null {
    const prev = currentStack;
    currentStack = stack;
    return prev;
}

/**
 * Restore the previous stack context.
 * Exported for use by the compiler during deferred loop callback execution.
 */
export function popStack(prev: StackNode | null): void {
    currentStack = prev;
}

function addToStack(node: Node<WgslType>): void {
    if (currentStack === null) {
        throw new Error(
            `[gpucat] Control flow (toVar, If, For, Return) must be called inside a Fn body. ` +
                `You are calling it outside of any Fn — wrap your code in Fn([...], () => { ... }).`,
        );
    }
    currentStack.push(node);
}

// ---------------------------------------------------------------------------
// Content-addressed ID
// ---------------------------------------------------------------------------

function computeId(kind: string, fields: Record<string, unknown>): string {
    return 'n_' + djb2(stableStringify({ kind, ...fields })).toString(36);
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const keys = Object.keys(value as object).sort();
    return (
        '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',') + '}'
    );
}

function djb2(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
        hash = hash >>> 0;
    }
    return hash;
}

// ---------------------------------------------------------------------------
// DSL constructor functions
// ---------------------------------------------------------------------------

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
    name?: string,
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
export const attribute = <T extends WgslType>(type: WgslDesc<T>, name: string) => new AttributeNode<T>(type.wgslType as T, name);

/**
 * UV attribute node for texture coordinate access.
 * 
 * Returns an AttributeNode that reads the 'uv' vertex attribute (or 'uv1', 'uv2', etc.
 * for additional UV channels).
 * 
 * This mirrors Three.js `uv()` from `UV.js`:
 *   `export const uv = (index = 0) => attribute('uv' + (index > 0 ? index : ''), 'vec2');`
 * 
 * @param index - The UV channel index. Defaults to 0 (reads 'uv'). 
 *                Index 1 reads 'uv1', index 2 reads 'uv2', etc.
 * @returns An AttributeNode<'vec2f'> representing the UV coordinates.
 * 
 * @example
 * // Default UV channel
 * const texCoord = uv();
 * 
 * // Second UV channel (e.g., for lightmaps)
 * const lightmapUV = uv(1);
 * 
 * // Sample a texture with UVs
 * const color = myTexture.sample(uv());
 */
export const uv = (index = 0): AttributeNode<'vec2f'> => 
    new AttributeNode<'vec2f'>('vec2f', 'uv' + (index > 0 ? index : ''));

/**
 * Create a `StorageNode` backed by a `StorageBufferAttribute` (or subclass).
 *
 * The preferred form — mirrors Three's `storage(bufferAttr, schema, access)`.
 * Accepts either an `ArrayDesc` (e.g. `S.array(S.vec4f())`) or a `StructDef`
 * (from `struct(...)`) as the schema argument.
 *
 * When a `StructDef` is passed the node's element type and storage type are
 * both set to the struct name (e.g. `'DrawBuffer'`), matching how Three.js
 * emits `var<storage> x : DrawBuffer`.
 *
 * If `attr` is an `IndirectStorageBufferAttribute`, `_indirectOwner` is wired
 * automatically so the renderer reuses the same `STORAGE | INDIRECT | COPY_DST`
 * GPUBuffer for both the compute binding and the `drawIndirect` call.
 *
 * @example — array schema
 * const posAttr = new StorageBufferAttribute(posData, 4);
 * const positions = storage(posAttr, S.array(S.vec4f()));
 *
 * @example — struct schema (mirrors Three.js)
 * const DrawBuffer = struct('DrawBuffer', { vertexCount: S.u32(), instanceCount: S.u32(), ... });
 * const drawAttr = new IndirectStorageBufferAttribute(false, 1);
 * const drawStorage = storage(drawAttr, DrawBuffer, 'read_write');
 */
export function storage<E extends WgslType>(
    attr: StorageBufferAttribute,
    schema: ArrayDesc<E>,
    access?: 'read' | 'read_write',
): StorageNode<E>;
export function storage<S extends StructSchema>(
    attr: StorageBufferAttribute,
    schema: StructDef<S>,
    access?: 'read' | 'read_write',
): StructInstance<S>;
export function storage(
    attr: StorageBufferAttribute,
    schema: ArrayDesc<WgslType> | StructDef<StructSchema>,
    access: 'read' | 'read_write' = 'read',
): StorageNode<WgslType> | StructInstance<StructSchema> {
    let elementType: WgslType;
    let storageType: string;
    if (isStructDef(schema)) {
        elementType = schema.wgslType;
        storageType = schema.wgslType;
    } else {
        const arrayDesc = schema as ArrayDesc<WgslType>;
        elementType = arrayDesc.elementDesc.wgslType;
        storageType = arrayDesc.wgslType;
    }

    const node = new StorageNode(attr, elementType, storageType, access);

    // When given a StructDef, instantiate a StructInstance so callers can do
    // drawStorage.instanceCount.assign(...) — mirrors Three.js TSL pattern.
    if (isStructDef(schema)) {
        return schema.instantiate(node);
    }

    return node;
}

/**
 * Create a `StorageNode` with a zero-initialised typed array allocated internally.
 *
 * The element type and TypedArray kind are derived from `arrayDesc`:
 * - `S.array(S.vec4f())`   → `Float32Array` of length `count * 4`
 * - `S.array(S.u32())`     → `Uint32Array`  of length `count * 1`
 * - `S.array(S.mat4x4f())` → `Float32Array` of length `count * 16`
 *
 * @example
 * import * as S from './schema'
 * const colors = storageArray(N, S.array(S.vec4f()), 'read_write')
 * // Modify colors.value.array, then: colors.value.needsUpdate = true
 */
export const storageArray = <E extends WgslType>(
    count: number,
    arrayDesc: ArrayDesc<E>,
    access: 'read' | 'read_write' = 'read',
): StorageNode<E> => {
    const itemSize = itemSizeOf(arrayDesc.elementDesc);
    const Ctor = typedArrayCtorOf(arrayDesc.elementDesc);
    const data = new Ctor(count * itemSize);
    const attr = new StorageBufferAttribute(data, itemSize);
    return new StorageNode(attr, arrayDesc.elementDesc.wgslType as E, arrayDesc.wgslType, access);
};

/**
 * Create a storage buffer node backed by a StorageInstancedBufferAttribute.
 * Useful for per-instance data in compute and render shaders, similar to Three.js's `instancedArray`.
 *
 * Accepts either:
 * - A count (number) and an array descriptor — creates a zeroed buffer of that size
 * - A pre-filled TypedArray and an array descriptor — uses the provided data
 *
 * @param countOrData - Number of instances, or a pre-filled TypedArray
 * @param arrayDesc - Array type descriptor (e.g. `d.array(d.vec4f)`, or a StructDef)
 * @param access - Storage access mode: 'read' (default) or 'read_write'
 *
 * @example
 * // Create storage for 1024 particles with vec4f (position + w)
 * const particles = instancedArray(1024, d.array(d.vec4f), 'read_write');
 *
 * // With a struct type:
 * const ParticleStruct = struct('Particle', {
 *     position: d.vec3f,
 *     velocity: d.vec3f,
 *     C: d.mat3x3f,
 * });
 * const particleBuffer = instancedArray(maxParticles, d.array(ParticleStruct), 'read_write');
 *
 * // With pre-filled data:
 * const initialData = new Float32Array(1024 * 4);
 * // ... fill data ...
 * const particles = instancedArray(initialData, d.array(d.vec4f), 'read_write');
 */
export const instancedArray = <E extends WgslType>(
    countOrData: number | Float32Array | Int32Array | Uint32Array,
    arrayDesc: ArrayDesc<E>,
    access: 'read' | 'read_write' = 'read',
): StorageNode<E> => {
    const itemSize = itemSizeOf(arrayDesc.elementDesc);
    const Ctor = typedArrayCtorOf(arrayDesc.elementDesc);

    let attr: StorageInstancedBufferAttribute;
    if (typeof countOrData === 'number') {
        // Create new zeroed buffer
        attr = new StorageInstancedBufferAttribute(countOrData, itemSize, Ctor);
    } else {
        // Use provided data
        attr = new StorageInstancedBufferAttribute(countOrData, itemSize);
    }

    return new StorageNode(attr, arrayDesc.elementDesc.wgslType as E, arrayDesc.wgslType, access);
};

/**
 * Create a texture node from a Texture object.
 *
 * @param tex - The Texture object containing image data
 * @param textureDesc - Optional texture type descriptor (default: texture2d())
 *
 * @example
 * const albedo = texture(myTexture);
 * const cubeMap = texture(myCubeTexture, S.textureCube());
 */
export const texture = (
    tex: Texture,
    textureDesc: TextureDesc | DepthTextureDesc = texture2d(),
): TextureNode => {
    // Prefix with 't' to ensure valid WGSL identifier (can't start with a number)
    const node = new TextureNode(textureDesc.wgslType as TextureType, `t${tex.id}`);
    node.value = tex;
    return node;
};

/**
 * Wraps a value into a node if needed.
 * Converts raw values (textures, numbers, etc.) to nodes.
 */
export function nodeObject<T extends WgslType>(val: T | Node<T> | unknown): Node<WgslType> {
    if (val && typeof val === 'object' && 'isNode' in (val as Record<string, unknown>)) {
        return val as Node<WgslType>;
    }
    // For now, only handle Texture objects - others can be added later
    if (val && typeof val === 'object' && 'isTexture' in (val as Record<string, unknown>)) {
        return texture(val as Texture);
    }
    throw new Error(`[gpucat] nodeObject: cannot convert ${typeof val} to Node`);
}

/**
 * Converts a node to a different type (e.g., texture to sampler).
 */
export const convert = (node: Node<WgslType> | unknown, types: string): ConvertNode => {
    return new ConvertNode(nodeObject(node), types);
};

/**
 * Converts a texture node to a sampler reference.
 * Returns a RawNode that emits `${textureId}_samp`.
 */
export const sampler = (value: TextureNode): ConvertNode => value.convert('sampler');

/**
 * Converts a texture to a sampler comparison reference for depth comparison.
 */
export const samplerComparison = (value: TextureNode): ConvertNode => value.convert('sampler_comparison');

export const varying = <T extends WgslType>(source: Node<T>, name?: string) => new VaryingNode<T>(source, name ?? null);

/**
 * Create an inline WGSL expression node using a tagged template literal.
 * 
 * @param type - Either a WgslType string ('f32', 'vec3f', etc.) or a WgslDesc
 * 
 * @example
 * // With type string:
 * const expr = wgsl('f32')`dot(${a}, ${b})`;
 * 
 * // With WgslDesc:
 * const expr = wgsl(d.vec4f)`vec4f(${rgb}, 1.0)`;
 * 
 * // Preserving input type:
 * const sinNode = <T extends WgslType>(a: Node<T>) => wgsl(a.type)`sin(${a})`;
 */
export const wgsl = <T extends WgslType>(type: T | WgslDesc<T>) =>
    (strings: TemplateStringsArray, ...deps: Node<WgslType>[]): WgslNode<T> => {
        const wgslStr = String.raw({ raw: strings }, ...deps.map((_, i) => `$${i}`));
        const resolvedType = typeof type === 'string' ? type : type.wgslType;
        return new WgslNode(resolvedType as T, wgslStr, deps);
    };
export const stack = (...body: Node<WgslType>[]) => new StackNode(body);
export const cond = <T extends WgslType>(condition: Node<WgslType>, ifTrue: Node<T>, ifFalse?: Node<T>) =>
    new CondNode(condition, ifTrue, ifFalse);


// ---------------------------------------------------------------------------
// Vec constructor helpers
//
// makeVec2 / makeVec3 / makeVec4 are internal factories that produce typed
// constructor functions for any vec2/vec3/vec4 WGSL type.
//
// For each component:
//   - If a raw number is passed, it is wrapped in a ConstNode of the element
//     scalar type (f32 for *f, i32 for *i, u32 for *u, bool for *b).
//   - Node values pass through unchanged.
//   - If ALL arguments are raw numbers the result is still a ConstructNode
//     (WGSL handles the constant folding at compile time; the graph stays
//     uniform). This matches Three.js ConvertType behaviour closely enough
//     for our purposes — we don't need the ConstNode short-circuit path
//     because our ConstNode factories (vec3f, vec3i, …) already cover that.
// ---------------------------------------------------------------------------

/** Type predicate: returns true if v is a Node<WgslType>. Use instead of instanceof Node. */
export function isNode(v: unknown): v is Node<WgslType> {
    return v instanceof Node;
}

type Scalar = Node<WgslType> | number | boolean;

/** Wrap a scalar JS value as the appropriate ConstNode for the given vec element type. */
function wrapScalar(v: Scalar, elemType: 'f32' | 'f16' | 'i32' | 'u32' | 'bool'): Node<WgslType> {
    if (isNode(v)) return v;
    if (elemType === 'bool') return new ConstNode('bool', (v as boolean | number) ? 1 : 0);
    if (elemType === 'i32')  return new ConstNode('i32',  Math.trunc(v as number));
    if (elemType === 'u32')  return new ConstNode('u32',  Math.trunc(v as number));
    if (elemType === 'f16')  return new ConstNode('f16',  v as number);
    return new ConstNode('f32', v as number);
}

function elemOf(type: Vec2Type | Vec3Type | Vec4Type): 'f32' | 'f16' | 'i32' | 'u32' | 'bool' {
    if (type.endsWith('h')) return 'f16';
    if (type.endsWith('f')) return 'f32';
    if (type.endsWith('i')) return 'i32';
    if (type.endsWith('u')) return 'u32';
    return 'bool';
}

function makeVec2<T extends Vec2Type>(type: T) {
    return (x: Scalar, y: Scalar): ConstructNode<T> => {
        const e = elemOf(type);
        return new ConstructNode(type, [wrapScalar(x, e), wrapScalar(y, e)]);
    };
}

function makeVec3<T extends Vec3Type>(type: T) {
    function ctor(xy: Node<WgslType>, z: Scalar): ConstructNode<T>;
    function ctor(x: Scalar, y: Scalar, z: Scalar): ConstructNode<T>;
    function ctor(a: Scalar, b: Scalar, c?: Scalar): ConstructNode<T> {
        const e = elemOf(type);
        if (c === undefined) return new ConstructNode(type, [wrapScalar(a, e), wrapScalar(b, e)]);
        return new ConstructNode(type, [wrapScalar(a, e), wrapScalar(b, e), wrapScalar(c, e)]);
    }
    return ctor;
}

function makeVec4<T extends Vec4Type>(type: T) {
    function ctor(xy: Node<WgslType>, zw: Node<WgslType>): ConstructNode<T>;
    function ctor(xy: Node<WgslType>, z: Scalar, w: Scalar): ConstructNode<T>;
    function ctor(xyz: Node<WgslType>, w: Scalar): ConstructNode<T>;
    function ctor(x: Scalar, y: Scalar, z: Scalar, w: Scalar): ConstructNode<T>;
    function ctor(a: Scalar, b: Scalar, c?: Scalar, d?: Scalar): ConstructNode<T> {
        const e = elemOf(type);
        if (c === undefined) return new ConstructNode(type, [wrapScalar(a, e), wrapScalar(b, e)]);
        if (d === undefined) return new ConstructNode(type, [wrapScalar(a, e), wrapScalar(b, e), wrapScalar(c, e)]);
        return new ConstructNode(type, [wrapScalar(a, e), wrapScalar(b, e), wrapScalar(c, e), wrapScalar(d, e)]);
    }
    return ctor;
}


// ---------------------------------------------------------------------------
// Type constructors — WGSL-style naming with flexible component packing.
//
// These accept nodes, numbers, or component packing (e.g., vec3f(vec2, f32))
// ---------------------------------------------------------------------------

// aliases
export const vec2 = makeVec2('vec2f');
export const vec3 = makeVec3('vec3f');
export const vec4 = makeVec4('vec4f');

export const mat4 = (c0: Node<'vec4f'>, c1: Node<'vec4f'>, c2: Node<'vec4f'>, c3: Node<'vec4f'>) =>
    new ConstructNode('mat4x4f', [c0, c1, c2, c3]);

// Standalone math — source of truth; chaining methods on Node<T> delegate to these.
export const add = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<T> => new BinopNode('+', a.type, a, b) as Node<T>;
export const sub = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<T> => new BinopNode('-', a.type, a, b) as Node<T>;
export const div = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<T> => new BinopNode('/', a.type, a, b) as Node<T>;
export const mul = <A extends WgslType, B extends WgslType>(a: Node<A>, b: Node<B>) => new BinopNode('*', mulResultType(a.type, b.type), a, b) as unknown as Node<MulResult<A, B>>;
export const dot = (a: Node<WgslType>, b: Node<WgslType>) => new CallNode('f32', 'dot', [a, b]);
export const cross = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<T> => new CallNode(a.type, 'cross', [a, b]) as Node<T>;
export const normalize = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'normalize', [a]) as Node<T>;
export const length = (a: Node<WgslType>): Node<'f32'> => new CallNode('f32', 'length', [a]);
export const abs = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'abs', [a]) as Node<T>;
export const floor = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'floor', [a]) as Node<T>;
export const ceil = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'ceil', [a]) as Node<T>;
export const fract = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'fract', [a]) as Node<T>;
export const sqrt = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'sqrt', [a]) as Node<T>;
export const sin = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'sin', [a]) as Node<T>;
export const cos = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'cos', [a]) as Node<T>;
export const negate = <T extends WgslType>(a: Node<T>): Node<T> => new CallNode(a.type, 'negate', [a]) as Node<T>;
export const pow = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<T> => new CallNode(a.type, 'pow', [a, b]) as Node<T>;
export const max = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<T> => new CallNode(a.type, 'max', [a, b]) as Node<T>;
export const min = <T extends WgslType>(a: Node<T>, b: Node<T>): Node<T> => new CallNode(a.type, 'min', [a, b]) as Node<T>;
export const clamp = <T extends WgslType>(a: Node<T>, lo: Node<T>, hi: Node<T>): Node<T> => new CallNode(a.type, 'clamp', [a, lo, hi]) as Node<T>;
export const mix = <T extends WgslType>(a: Node<T>, b: Node<T>, t: Node<T>): Node<T> => new CallNode(a.type, 'mix', [a, b, t]) as Node<T>;
export const step = <T extends WgslType>(edge: Node<T>, x: Node<T>): Node<T> => new CallNode(x.type, 'step', [edge, x]) as Node<T>;
export const smoothstep = <T extends WgslType>(lo: Node<T>, hi: Node<T>, x: Node<T>): Node<T> => new CallNode(x.type, 'smoothstep', [lo, hi, x]) as Node<T>;

/** Transpose a matrix. Returns the transposed matrix with swapped row/column type. */
export const transpose = <T extends MatType>(m: Node<T>): Node<T> => new CallNode(m.type, 'transpose', [m]) as Node<T>;

export const textureSample = (t: Node<WgslType>, s: Node<WgslType>, uv: Node<WgslType>) =>
    new CallNode('vec4f', 'textureSample', [t, s, uv]);
export const textureLoad = (t: Node<WgslType>, coord: Node<WgslType>, level: Node<WgslType>) =>
    new CallNode('vec4f', 'textureLoad', [t, coord, level]);
export const textureSampleLevel = (t: Node<WgslType>, s: Node<WgslType>, uv: Node<WgslType>, level: Node<WgslType>) =>
    new CallNode('vec4f', 'textureSampleLevel', [t, s, uv, level]);

/**
 * Internal helper for creating buffer attribute nodes.
 * @param value     A BufferAttribute, InstancedBufferAttribute, or raw TypedArray.
 * @param desc      WgslDesc for the attribute element type.
 * @param stride    Byte stride between consecutive elements
 * @param offset    Byte offset within each element
 * @param instanced Whether this is an instanced attribute.
 */
function createBufferAttribute<T extends WgslType>(
    value: StorageBufferAttribute | InstancedBufferAttribute | GpuTypedArray,
    desc: WgslDesc<T>,
    stride: number,
    offset: number,
    instanced: boolean,
): BufferAttributeNode<T> {
    const node = new BufferAttributeNode(desc.wgslType as T, value, stride, offset, itemSizeOf(desc));
    if (instanced) node.setInstanced(true);
    return node;
}

/**
 * Create a BufferAttributeNode — a vertex attribute backed by a BufferAttribute or TypedArray.
 *
 * @param value   A BufferAttribute, InstancedBufferAttribute, or raw TypedArray.
 * @param desc    WgslDesc for the attribute element type (e.g. `S.vec3f()`, `S.f32()`).
 * @param stride  Byte stride between consecutive elements (default: 0 = tightly packed).
 * @param offset  Byte offset within each element (default: 0).
 *
 * @example
 * const colors = bufferAttribute(new Float32Array([1,0,0, 0,1,0]), S.vec3f());
 */
export const bufferAttribute = <T extends WgslType>(
    value: StorageBufferAttribute | InstancedBufferAttribute | GpuTypedArray,
    desc: WgslDesc<T>,
    stride = 0,
    offset = 0,
) => createBufferAttribute(value, desc, stride, offset, false);

/**
 * Create an instanced BufferAttributeNode — a per-instance vertex attribute
 * uploaded by the renderer as a vertex buffer with stepMode: 'instance'.
 *
 * Mirrors Three.js TSL's instancedBufferAttribute() pattern.
 *
 * @param value   An InstancedBufferAttribute, or a raw TypedArray.
 * @param desc    WgslDesc for the attribute element type (e.g. `S.vec3f()`, `S.f32()`).
 * @param stride  Byte stride between consecutive instance records (default: 0 = tightly packed).
 * @param offset  Byte offset within each instance record (default: 0).
 *
 * @example
 * // With InstancedBufferAttribute:
 * const attr = new InstancedBufferAttribute(new Float32Array([1,0,0, 0,1,0]), 3);
 * const colors = instancedBufferAttribute(attr, S.vec3f());
 *
 * // With raw TypedArray:
 * const colors = instancedBufferAttribute(new Float32Array([1,0,0, 0,1,0]), S.vec3f());
 */
export const instancedBufferAttribute = <T extends WgslType>(
    value: InstancedBufferAttribute | GpuTypedArray,
    desc: WgslDesc<T>,
    stride = 0,
    offset = 0,
) => createBufferAttribute(value, desc, stride, offset, true);

/**
 * Declare a mutable variable initialised to `init`.
 *
 * @param init    Initial value node — element type T is inferred from this.
 * @param label   Optional debug label — appended to the generated var name (e.g. 'color' → 'var_42_color').
 * @returns       A VarNode you can later call `.assign()` on.
 *
 * **Inside a `Fn` body** — the declaration is emitted at the call site (function-scope `var`).
 *
 * **Outside any `Fn` body** — the VarNode is created but not pushed onto a stack.
 * It is emitted inline into whatever shader-stage function body first references it
 * during the generate pass, mirroring three.js TSL behaviour.
 *
 * @example
 * const acc = toVar(f32(0.0), 'acc')
 * acc.assign(acc.add(f32(1.0)))
 */
export function Var<T extends WgslType>(init: Node<T>, label?: string): VarNode<T> {
    return init.toVar(label);
}

/**
 * Declare an immutable constant initialized to `init`.
 *
 * @param init    Initial value node — element type T is inferred from this.
 * @param label   Optional debug label — appended to the generated const name.
 * @returns       A VarNode with isConst=true that can NOT be assigned to.
 *
 * **Inside a `Fn` body** — the declaration is emitted as WGSL `let` at the call site.
 *
 * **Outside any `Fn` body** — the VarNode is created but not pushed onto a stack.
 * It will be emitted inline into whatever shader-stage function body first references it
 * during the generate pass.
 *
 * @example
 * const result = Const(f32(0.0), 'result')
 */
export function Const<T extends WgslType>(init: Node<T>, label?: string): VarNode<T> {
    return init.toConst(label);
}

/** Chainable object returned by `If()` so `.Else()` can be chained. */
export type IfChain = { Else(body: () => void): IfChain };

/**
 * Statement-form conditional inside a Fn body.
 *
 * The `thenBody` callback is called immediately during tracing (side-effects only,
 * no return value). Use `Return(node)` inside for early exits.
 *
 * @returns An object with `.Else(body)` for chaining else branches.
 *
 * @example
 * If(x.gt(konst('f32', 0.5)), () => {
 *     result.assign(konst('vec3f', [1, 0, 0]))
 * }).Else(() => {
 *     result.assign(konst('vec3f', [0, 0, 1]))
 * })
 */
export function If(condition: Node<WgslType>, thenBody: () => void): IfChain {
    const thenStack = new StackNode();
    const prev = pushStack(thenStack);
    try {
        thenBody();
    } finally {
        popStack(prev);
    }
    const ifNode = new IfNode(condition, thenStack);
    addToStack(ifNode);

    const chain: IfChain = {
        Else(elseBody: () => void): IfChain {
            const elseStack = new StackNode();
            const elseFrame = pushStack(elseStack);
            try {
                elseBody();
            } finally {
                popStack(elseFrame);
            }
            ifNode.elseBody = elseStack;
            return chain; // return same chain to allow further Else() calls if needed
        },
    };
    return chain;
}

/**
 * Loop — statement-form loop matching Three.js TSL exactly.
 * 
 * Creates a LoopNode with raw params and adds it to the current stack.
 * The callback is NOT executed immediately - execution is deferred to compile time.
 * This matches Three.js TSL's lazy evaluation approach.
 *
 * **Simple count** (0 to n-1):
 * ```ts
 * Loop(count, ({ i }) => { ... })
 * ```
 *
 * **Config object**:
 * ```ts
 * Loop({ start: 0, end: 10, type: 'i32' }, ({ i }) => { ... })
 * ```
 *
 * **Nested loops**:
 * ```ts
 * Loop(10, 5, ({ i, j }) => { ... })
 * ```
 *
 * **Boolean while-style**:
 * ```ts
 * Loop(value.lessThan(10), () => { value.addAssign(1); })
 * ```
 *
 * **Backwards** (start only):
 * ```ts
 * Loop({ start: 10 }, ({ i }) => { ... })
 * ```
 *
 * Use `Break()` and `Continue()` inside the body for loop control.
 */
export function Loop(...params: unknown[]): LoopNode {
    // Convert params to nodes where appropriate (matching nodeArray behavior)
    // Numbers are kept as-is, nodes are kept as-is, objects are kept as-is
    // This matches Three.js: nodeArray(params, 'int')
    return new LoopNode(params).toStack();
}

/**
 * For — alias for Loop, matching Three.js TSL.
 * @see Loop
 */
export const For = Loop;

/**
 * While — convenience wrapper for boolean while-style loops.
 * Equivalent to `Loop(condition, () => { ... })`.
 */
export function While(condition: Node<WgslType>, body: () => void): void {
    Loop(condition, body);
}

export function Return<T extends WgslType>(value: Node<T>): void {
    addToStack(new ReturnNode(value) as Node<WgslType>);
}

export function Break(): void {
    addToStack(new BreakNode());
}

export function Continue(): void {
    addToStack(new ContinueNode());
}

/**
 * Create an inline WGSL expression node.
 * Matches Three.js TSL `expression()` exactly.
 *
 * Used for:
 * - Loop index variables: `expression('i', 'i32')` → generates `i`
 * - Control flow: `expression('continue')` → generates `continue;`
 * - Any raw WGSL snippet
 *
 * @param snippet - The native WGSL code snippet
 * @param nodeType - The node type (default 'void')
 */
export function expression<T extends WgslType = 'void'>(snippet: string, nodeType?: T): ExpressionNode<T> {
    return new ExpressionNode<T>(snippet, nodeType);
}

/**
 * Define a reusable WGSL function.
 *
 * ### No-layout form (anonymous, params must be manually annotated)
 * ```ts
 * const double = Fn((x: Node<'f32'>) => x.mul(f32(2)))
 * ```
 * Emits: `fn fn_<id>(p0: f32) -> f32`
 *
 * ### Layout form (named, param types fully inferred from layout)
 * ```ts
 * const heatmap = Fn((uv, roughness) => {
 *     return vec3f(uv.x, uv.y, 0)
 * }, {
 *     name: 'heatmap',
 *     params: [
 *         { name: 'uv',        type: S.vec2f() },
 *         { name: 'roughness', type: S.f32()   },
 *     ],
 * })
 * ```
 * Emits: `fn heatmap(uv: vec2f, roughness: f32) -> vec3f`
 *
 * Call both forms the same way:
 * ```ts
 * const result = heatmap(uvNode, roughnessNode)  // → CallNode<'vec3f'>
 * ```
 */
// Overload 1 — with layout: param types inferred from layout.params
export function Fn<T extends WgslType, P extends readonly ParamDesc[]>(
    jsFunc: (...args: ParamDescsToNodes<P>) => Node<T>,
    layout: FnLayout<P>,
): (...args: ParamDescsToNodes<P>) => CallNode<T>;
// Overload 2 — no-params void body: returns the FnNode for use with .compute()
export function Fn(
    jsFunc: () => void,
): FnNode<'void'>;
// Overload 3 — no layout: params are Node<WgslType>, user annotates manually
export function Fn<T extends WgslType>(
    jsFunc: (...args: Node<WgslType>[]) => Node<T>,
): (...args: Node<WgslType>[]) => CallNode<T>;
// Implementation
export function Fn<T extends WgslType>(
    jsFunc: ((...args: Node<WgslType>[]) => Node<T>) | (() => void),
    layout?: FnLayout<readonly ParamDesc[]>,
): ((...args: Node<WgslType>[]) => CallNode<T>) | FnNode<'void'> {
    // Build dummy ParamNodes for the dry-run trace that infers the return type.
    const paramDescs: (ParamDesc | WgslDesc<WgslType>)[] = layout?.params ?? [];
    const dummyParams = paramDescs.map((d, i) => {
        const paramName = 'name' in d ? (d as ParamDesc).name : undefined;
        const wgslType = 'name' in d ? (d as ParamDesc).type.wgslType : (d as WgslDesc<WgslType>).wgslType;
        return new ParamNode(wgslType, i, paramName);
    });

    const traceStack = new StackNode();
    const prev = pushStack(traceStack);
    let returnType: T | 'void';
    try {
        const output = (jsFunc as (...args: Node<WgslType>[]) => Node<T> | undefined)(...dummyParams);
        returnType = output != null ? (output.type as T) : 'void';
    } finally {
        popStack(prev);
    }

    // No-params void-body case — return the FnNode directly for .compute() chaining.
    if (returnType === 'void' && paramDescs.length === 0 && !layout) {
        return new FnNode<'void'>(
            'void',
            [],
            jsFunc as (...args: Node<WgslType>[]) => Node<'void'>,
            undefined,
        );
    }

    const fnNode = new FnNode<T>(returnType as T, paramDescs, jsFunc as (...args: Node<WgslType>[]) => Node<T>, layout?.name);

    return (...args: Node<WgslType>[]): CallNode<T> => {
        return new CallNode<T>(returnType as T, fnNode.fnName, args, fnNode);
    };
}

const VEC_ELEMENT: Record<string, ScalarType> = {
    vec2f: 'f32',
    vec3f: 'f32',
    vec4f: 'f32',
    vec2i: 'i32',
    vec3i: 'i32',
    vec4i: 'i32',
    vec2u: 'u32',
    vec3u: 'u32',
    vec4u: 'u32',
    vec2h: 'f16',
    vec3h: 'f16',
    vec4h: 'f16',
};
const VEC2_OF: Record<string, string> = { f32: 'vec2f', i32: 'vec2i', u32: 'vec2u', f16: 'vec2h' };
const VEC3_OF: Record<string, string> = { f32: 'vec3f', i32: 'vec3i', u32: 'vec3u', f16: 'vec3h' };
const VEC4_OF: Record<string, string> = { f32: 'vec4f', i32: 'vec4i', u32: 'vec4u', f16: 'vec4h' };
const MAT_TYPES = new Set([
    'mat2x2f', 'mat2x3f', 'mat2x4f', 'mat3x2f', 'mat3x3f', 'mat3x4f', 'mat4x2f', 'mat4x3f', 'mat4x4f',
    'mat2x2h', 'mat2x3h', 'mat2x4h', 'mat3x2h', 'mat3x3h', 'mat3x4h', 'mat4x2h', 'mat4x3h', 'mat4x4h',
]);
const VEC_TYPES = new Set(Object.keys(VEC_ELEMENT));
const SCALAR_TYPES = new Set(['f32', 'i32', 'u32', 'bool', 'f16']);

export const isVecType = (t: string) => VEC_TYPES.has(t);
export const isMatType = (t: string) => MAT_TYPES.has(t);
export const isScalarType = (t: string) => SCALAR_TYPES.has(t);

export function vecElementType(t: string): WgslType {
    return (VEC_ELEMENT[t] ?? 'f32') as WgslType;
}
export function vecElementTypeOrSelf(t: string): WgslType {
    return (VEC_ELEMENT[t] ?? t) as WgslType;
}

export function vec2TypeOf(t: string): WgslType {
    const e = VEC_ELEMENT[t] ?? (SCALAR_TYPES.has(t) ? t : 'f32');
    return (VEC2_OF[e] ?? 'vec2f') as WgslType;
}

export function vec3TypeOf(t: string): WgslType {
    const e = VEC_ELEMENT[t] ?? (SCALAR_TYPES.has(t) ? t : 'f32');
    return (VEC3_OF[e] ?? 'vec3f') as WgslType;
}

export function vec4TypeOf(t: string): WgslType {
    const e = VEC_ELEMENT[t] ?? (SCALAR_TYPES.has(t) ? t : 'f32');
    return (VEC4_OF[e] ?? 'vec4f') as WgslType;
}

export function mulResultType(a: string, b: string): WgslType {
    if (MAT_TYPES.has(a)) return (VEC_TYPES.has(b) ? b : a) as WgslType;
    if (SCALAR_TYPES.has(b)) return a as WgslType;
    if (SCALAR_TYPES.has(a)) return b as WgslType;
    return a as WgslType;
}

export const f32  = (v = 0):                       ConstNode<'f32'>    => new ConstNode('f32',    v);
export const f16  = (v = 0):                       ConstNode<'f16'>    => new ConstNode('f16',    v);
export const i32  = (v = 0):                       ConstNode<'i32'>    => new ConstNode('i32',    v);
export const u32  = (v = 0):                       ConstNode<'u32'>    => new ConstNode('u32',    v);
export const bool = (v: boolean):                  ConstNode<'bool'>   => new ConstNode('bool',   v ? 1 : 0);

export const vec2f = makeVec2('vec2f');
export const vec3f = makeVec3('vec3f');
export const vec4f = makeVec4('vec4f');

export const vec2i = makeVec2('vec2i');
export const vec3i = makeVec3('vec3i');
export const vec4i = makeVec4('vec4i');

export const vec2u = makeVec2('vec2u');
export const vec3u = makeVec3('vec3u');
export const vec4u = makeVec4('vec4u');

export const vec2h = makeVec2('vec2h');
export const vec3h = makeVec3('vec3h');
export const vec4h = makeVec4('vec4h');

export const vec2b  = makeVec2('vec2<bool>');
export const vec3b  = makeVec3('vec3<bool>');
export const vec4b  = makeVec4('vec4<bool>');

export const mat2x2f = (...v: number[]): ConstNode<'mat2x2f'> => new ConstNode('mat2x2f', v.length ? v : []);
export const mat2x3f = (...v: number[]): ConstNode<'mat2x3f'> => new ConstNode('mat2x3f', v.length ? v : []);
export const mat2x4f = (...v: number[]): ConstNode<'mat2x4f'> => new ConstNode('mat2x4f', v.length ? v : []);
export const mat3x2f = (...v: number[]): ConstNode<'mat3x2f'> => new ConstNode('mat3x2f', v.length ? v : []);
export const mat3x3f = (...v: number[]): ConstNode<'mat3x3f'> => new ConstNode('mat3x3f', v.length ? v : []);
export const mat3x4f = (...v: number[]): ConstNode<'mat3x4f'> => new ConstNode('mat3x4f', v.length ? v : []);
export const mat4x2f = (...v: number[]): ConstNode<'mat4x2f'> => new ConstNode('mat4x2f', v.length ? v : []);
export const mat4x3f = (...v: number[]): ConstNode<'mat4x3f'> => new ConstNode('mat4x3f', v.length ? v : []);
export const mat4x4f = (...v: number[]): ConstNode<'mat4x4f'> => new ConstNode('mat4x4f', v.length ? v : []);
export const mat2x2h = (...v: number[]): ConstNode<'mat2x2h'> => new ConstNode('mat2x2h', v.length ? v : []);
export const mat2x3h = (...v: number[]): ConstNode<'mat2x3h'> => new ConstNode('mat2x3h', v.length ? v : []);
export const mat2x4h = (...v: number[]): ConstNode<'mat2x4h'> => new ConstNode('mat2x4h', v.length ? v : []);
export const mat3x2h = (...v: number[]): ConstNode<'mat3x2h'> => new ConstNode('mat3x2h', v.length ? v : []);
export const mat3x3h = (...v: number[]): ConstNode<'mat3x3h'> => new ConstNode('mat3x3h', v.length ? v : []);
export const mat3x4h = (...v: number[]): ConstNode<'mat3x4h'> => new ConstNode('mat3x4h', v.length ? v : []);
export const mat4x2h = (...v: number[]): ConstNode<'mat4x2h'> => new ConstNode('mat4x2h', v.length ? v : []);
export const mat4x3h = (...v: number[]): ConstNode<'mat4x3h'> => new ConstNode('mat4x3h', v.length ? v : []);
export const mat4x4h = (...v: number[]): ConstNode<'mat4x4h'> => new ConstNode('mat4x4h', v.length ? v : []);

/**
 * Convert any color input to a `ConstNode<'vec3f'>` (linear RGB).
 *
 * This is the primary way to introduce a color into the node graph.
 * The resulting node has type `vec3f` so it can be used anywhere a `vec3f`
 * is expected — including as the first argument to `vec4(xyz, w)`.
 *
 * @example
 * import { color, vec4, f32 } from 'gpucat';
 *
 * // Build an opaque red vec4f for use as a fragment color
 * const fragColor = vec4(color('#f00'), f32(1));
 *
 * // Other accepted forms:
 * color('hsl(200, 80%, 50%)');
 * color('deepskyblue');
 * color(0xff8800);
 * color([1, 0.5, 0]);
 * color(new Color('red'));
 */
export function color(input: ColorInput): ConstNode<'vec3f'> {
    const c = input instanceof Color ? input : new Color(input);
    return new ConstNode('vec3f', [c.r, c.g, c.b]);
}

/** Projection matrix of the scene camera. In renderGroup. */
export const cameraProjectionMatrix = /*@__PURE__*/ new UniformNode('mat4x4f', 'cameraProjectionMatrix', renderGroup)
    .onRenderUpdate((frame) => frame.camera!.projectionMatrix);

/** View (world-to-camera) matrix. In renderGroup. */
export const cameraViewMatrix = /*@__PURE__*/ new UniformNode('mat4x4f', 'cameraViewMatrix', renderGroup)
    .onRenderUpdate((frame) => frame.camera!.matrixWorldInverse);

/** Camera world-space position. In renderGroup. */
export const cameraPosition = /*@__PURE__*/ new UniformNode('vec3f', 'cameraPosition', renderGroup)
    .onRenderUpdate((frame) => frame.camera!.position);

/** Camera near plane distance. In renderGroup. */
export const cameraNear = /*@__PURE__*/ new UniformNode('f32', 'cameraNear', renderGroup)
    .onRenderUpdate((frame) => frame.camera!.near);

/** Camera far plane distance. In renderGroup. */
export const cameraFar = /*@__PURE__*/ new UniformNode('f32', 'cameraFar', renderGroup)
    .onRenderUpdate((frame) => frame.camera!.far);

/** Elapsed time in seconds. In renderGroup. */
export const timeElapsed = /*@__PURE__*/ new UniformNode('f32', 'timeElapsed', renderGroup)
    .onRenderUpdate((frame) => frame.time);

/** Frame delta time in seconds. In renderGroup. */
export const timeDelta = /*@__PURE__*/ new UniformNode('f32', 'timeDelta', renderGroup)
    .onRenderUpdate((frame) => frame.deltaTime);

/** Model-to-world transform matrix. In objectGroup. Three.js name: modelWorldMatrix. */
export const modelWorldMatrix = /*@__PURE__*/ new UniformNode('mat4x4f', 'modelWorldMatrix', objectGroup)
    .onObjectUpdate((frame) => frame.object!.matrixWorld);

/** Normal matrix (inverse-transpose of upper-left 3x3 of model matrix). In objectGroup. */
export const modelNormalMatrix = /*@__PURE__*/ new UniformNode('mat3x3f', 'modelNormalMatrix', objectGroup)
    .onObjectUpdate((frame) => frame.object!.normalMatrix);

/** @builtin(instance_index) — the instance index for instanced draw calls. */
export const instanceIndex: BuiltinNode<'u32'> = /*@__PURE__*/ builtin('instance_index', 'u32');

/** @builtin(vertex_index) — the vertex index in the current draw call. */
export const vertexIndex: BuiltinNode<'u32'> = /*@__PURE__*/ builtin('vertex_index', 'u32');

/** @builtin(global_invocation_id) — unique thread ID across the entire dispatch. */
export const globalId: BuiltinNode<'vec3u'> = /*@__PURE__*/ builtin('global_invocation_id', 'vec3u');

/** @builtin(local_invocation_id) — thread ID within its workgroup. */
export const localId: BuiltinNode<'vec3u'> = /*@__PURE__*/ builtin('local_invocation_id', 'vec3u');

/** @builtin(local_invocation_index) — flat 1-D index within the workgroup. */
export const localIndex: BuiltinNode<'u32'> = /*@__PURE__*/ builtin('local_invocation_index', 'u32');

/** @builtin(workgroup_id) — workgroup coordinate in the dispatch grid. */
export const workgroupId: BuiltinNode<'vec3u'> = /*@__PURE__*/ builtin('workgroup_id', 'vec3u');

/** @builtin(num_workgroups) — total number of workgroups dispatched. */
export const numWorkgroups: BuiltinNode<'vec3u'> = /*@__PURE__*/ builtin('num_workgroups', 'vec3u');

/**
 * Fragment position in window/pixel coordinates.
 * @builtin(position) in the fragment shader — vec4f where xy are pixel coordinates.
 *
 * This is the raw fragment coordinate from the rasterizer.
 * Use screenCoordinate.xy for 2D pixel position.
 */
export const fragCoord: BuiltinNode<'vec4f'> = /*@__PURE__*/ builtin('position', 'vec4f');

/**
 * Screen coordinate — the current fragment's xy position in pixels.
 * Equivalent to @builtin(position).xy in WGSL.
 *
 * @example
 * // Get pixel position
 * const pixelPos = screenCoordinate;
 */
export const screenCoordinate = fragCoord.xy;

/**
 * Screen/viewport size in pixels. Updated per render by the renderer.
 * In renderGroup so it's shared across all objects in a frame.
 *
 * @example
 * // Get screen dimensions
 * const size = screenSize; // vec2f(width, height)
 */
export const screenSize: UniformNode<'vec2f'> = /*@__PURE__*/ new UniformNode('vec2f', 'screenSize', renderGroup)
    .onRenderUpdate(({ width, height }) => [width, height]);

/**
 * Normalized screen UV coordinates in [0, 1] range.
 * Computed as screenCoordinate / screenSize.
 *
 * (0, 0) is top-left, (1, 1) is bottom-right (following WebGPU conventions).
 *
 * @example
 * // Sample a texture using screen UV
 * const color = texture.sample(screenUV);
 *
 * // Use x component for horizontal effects
 * const x = screenUV.x;
 */
export const screenUV: Node<'vec2f'> = /*@__PURE__*/ (() => {
    return div(screenCoordinate, screenSize) as Node<'vec2f'>;
})();

/** helper for vertex shader: compute clip-space position from vertex position attribute and camera matrices. */
export const positionClip: Node<'vec4f'> = (() => {
    const pos = attribute(d.vec3f, 'position');
    const localPos = vec4f(pos, f32(1.0));

    const worldPos = mul(modelWorldMatrix, localPos);

    const viewPos = mul(cameraViewMatrix, worldPos);
    const clipPos = mul(cameraProjectionMatrix, viewPos);

    return clipPos as unknown as Node<'vec4f'>;
})();

let _outputStructCounter = 0;

/**
 * Represents a fragment shader output struct with multiple @location outputs.
 * Used for MRT (Multiple Render Targets).
 *
 * Each member in the `members` array corresponds to a @location(N) output.
 * The index in the array determines the @location index.
 *
 * @example
 * // Direct usage (rare):
 * const outputs = new OutputStructNode([colorNode, normalNode, velocityNode]);
 *
 * // Typically created via mrt() helper instead.
 */
export class OutputStructNode extends Node<'vec4f'> {
    /**
     * Array of output nodes. Each node maps to @location(index).
     * All nodes should produce vec4f values.
     */
    members: Node<WgslType>[];

    /** Type flag for runtime checking. */
    readonly isOutputStructNode = true;

    constructor(members: Node<WgslType>[] = [], id?: string) {
        super(id ?? `_output_struct_${_outputStructCounter++}`, 'output_struct', 'vec4f');
        this.members = members;
    }

    override _getChildren(): Array<{ property: string; index?: number | string; childNode: Node<WgslType> }> {
        return this.members.map((m, i) => ({ property: 'members', index: i, childNode: m }));
    }

    override setup(builder: NodeBuilder): Node<WgslType> | null {
        // Setup all members - Three.js aligned: call build() on each
        for (const member of this.members) {
            if (member) member.build(builder);
        }
        return null;
    }

    override generate(_builder: NodeBuilder, _output?: string): string {
        return `/* output_struct ${this.id} */`;
    }
}

let _mrtCounter = 0;

/**
 * MRT (Multiple Render Targets) node.
 *
 * Takes a dictionary of named outputs. At setup time, the names are resolved
 * to @location(N) indices based on the current render target's texture names.
 *
 * @example
 * // Set up render target with named textures:
 * const rt = new RenderTarget(device, w, h, { count: 3 });
 * rt.textures[0].name = 'color';
 * rt.textures[1].name = 'normal';
 * rt.textures[2].name = 'velocity';
 *
 * // Create MRT node:
 * const mrtNode = mrt({
 *     color: outputColor,      // -> @location(0)
 *     normal: viewNormal,      // -> @location(1)
 *     velocity: motionVector,  // -> @location(2)
 * });
 *
 * // Use in material:
 * const mat = new Material({
 *     vertex: clipPos,
 *     fragment: mrtNode,
 * });
 */
export class MRTNode extends OutputStructNode {
    /**
     * Dictionary of named outputs. Keys are texture names,
     * values are nodes producing vec4f values.
     */
    outputNodes: Record<string, Node<WgslType>>;

    /** Type flag for runtime checking. */
    readonly isMRTNode = true;

    /**
     * Resolved output names in order. Populated during setup() when
     * render target is known. Used by the compiler to emit correct
     * @location indices.
     */
    _resolvedNames: string[] = [];

    constructor(outputNodes: Record<string, Node<WgslType>>) {
        super([], `_mrt_${_mrtCounter++}`);
        this.outputNodes = outputNodes;
    }

    /**
     * Returns true if this MRT node has an output with the given name.
     */
    has(name: string): boolean {
        return this.outputNodes[name] !== undefined;
    }

    /**
     * Returns the output node for the given name.
     */
    get(name: string): Node<WgslType> | undefined {
        return this.outputNodes[name];
    }

    /**
     * Merge another MRTNode's outputs into this one.
     * Returns a new MRTNode with combined outputs (other's outputs override this's).
     */
    merge(other: MRTNode): MRTNode {
        return new MRTNode({ ...this.outputNodes, ...other.outputNodes });
    }

    /**
     * Resolve output names to @location indices based on render target textures.
     * Called by the compiler when the render target is known.
     *
     * @param getTextureIndex - Function that maps texture name to index (from RenderTarget)
     */
    resolveOutputs(getTextureIndex: (name: string) => number): void {
        const members: Node<WgslType>[] = [];
        const names: string[] = [];

        for (const name in this.outputNodes) {
            const index = getTextureIndex(name);
            if (index === -1) {
                console.warn(`[MRTNode] Output '${name}' not found in render target textures. Skipping.`);
                continue;
            }
            // Ensure the node outputs vec4f (wrap if needed)
            let node = this.outputNodes[name];
            if (node.type !== 'vec4f') {
                node = vec4f(node as Node<'vec3f'>, new ConstNode('f32', 1));
            }
            members[index] = node;
            names[index] = name;
        }

        this.members = members;
        this._resolvedNames = names;
    }

    override _getChildren(): Array<{ property: string; index?: number | string; childNode: Node<WgslType> }> {
        // Before setup, return outputNodes values; after setup, use members
        if (this.members.length > 0) {
            return this.members
                .filter(Boolean)
                .map((m, i) => ({ property: 'members', index: i, childNode: m }));
        }
        return Object.entries(this.outputNodes).map(([key, node]) => ({
            property: 'outputNodes',
            index: key,
            childNode: node,
        }));
    }
}

/**
 * Create an MRT (Multiple Render Targets) node from a dictionary of outputs.
 *
 * Output names must match the `.name` property of textures in the render target.
 * The compiler maps each output to the corresponding @location(N) based on
 * texture array indices.
 *
 * @example
 * const mrtOutput = mrt({
 *     color: finalColor,
 *     normal: viewSpaceNormal,
 *     velocity: motionVector,
 * });
 *
 * const material = new Material({
 *     vertex: clipPosition,
 *     fragment: mrtOutput,
 * });
 */
export function mrt(outputNodes: Record<string, Node<WgslType>>): MRTNode {
    return new MRTNode(outputNodes);
}

let _computeCounter = 0;

export type ComputeOptions = {
    /**
     * Dispatch dimensions [x, y, z] — number of workgroups to dispatch.
     * Trailing 1s may be omitted: [N] = [N, 1, 1], [N, M] = [N, M, 1].
     */
    dispatch: [x: number, y: number, z: number] | [x: number, y: number] | [x: number];
    /**
     * Workgroup size tuple [x, y, z].
     * Defaults to [64, 1, 1].
     */
    workgroupSize?: [x: number, y: number, z: number];
};

export type ComputeNodeOptions = ComputeOptions & {
    /** The FnNode whose body becomes the @compute entry point. */
    fn: FnNode<WgslType>;
};

/**
 * A plain object representing a single WebGPU compute dispatch.
 *
 * Storage buffers are inferred automatically by walking the traced Fn body
 * for StorageNode children. Binding order = encounter order (depth-first).
 *
 * Use `renderer.compile(node)` to pre-warm, then `renderer.compute(node)` each frame.
 */
export class ComputeNode {
    readonly id: string;
    readonly fn: FnNode<WgslType>;
    readonly workgroupSize: [number, number, number];
    readonly dispatch: [number, number, number];

    constructor(opts: ComputeNodeOptions) {
        this.id = `_compute_${_computeCounter++}`;
        this.fn = opts.fn;
        this.workgroupSize = opts.workgroupSize ?? [64, 1, 1];
        const d = opts.dispatch;
        this.dispatch = [d[0], d[1] ?? 1, d[2] ?? 1];
    }

    /**
     * Trace the Fn body and infer storage buffers from the graph.
     * Returns { body, storage } — called once by compileCompute().
     */
    trace(): { body: StackNode; storage: StorageNode<WgslType>[] } {
        const { body } = this.fn.trace();

        const storage: StorageNode<WgslType>[] = [];
        const seen = new Set<string>();
        const queue: Node<WgslType>[] = [body];
        const visited = new Set<string>();

        while (queue.length > 0) {
            const node = queue.pop()!;
            if (visited.has(node.id)) continue;
            visited.add(node.id);
            if (node.kind === 'storage') {
                if (!seen.has(node.id)) {
                    seen.add(node.id);
                    storage.push(node as StorageNode<WgslType>);
                }
            }
            for (const child of node.getChildren()) {
                queue.push(child);
            }
        }

        return { body, storage };
    }
}

/**
 * Create a ComputeNode from a FnNode.
 *
 * @example
 * const kernel = compute(
 *     Fn(() => { ... }),
 *     { dispatch: [Math.ceil(N / 64)] },
 * );
 */
export function compute(fn: FnNode<WgslType>, opts: ComputeOptions): ComputeNode {
    return new ComputeNode({ fn, ...opts });
}

// ---------------------------------------------------------------------------
// Atomic operations
//
// WebGPU only supports atomic operations on i32 and u32 types.
// These functions create CallNodes for the WGSL atomic built-in functions.
// They operate on storage buffer elements marked as atomic.
// ---------------------------------------------------------------------------

/**
 * Atomically adds `value` to the atomic value at `ptr` and returns the old value.
 *
 * In WGSL: `atomicAdd(&ptr, value) -> i32/u32`
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @param value - The value to add
 * @returns The old value before the addition
 *
 * @example
 * const grid = storageArray(GRID_SIZE, S.array(S.i32()), 'read_write');
 * const cellIdx = computeCellIndex();
 * const oldVal = atomicAdd(grid.element(cellIdx), i32(100));
 */
export function atomicAdd<T extends 'i32' | 'u32'>(ptr: Node<T>, value: Node<T>): Node<T> {
    return new CallNode(ptr.type as T, 'atomicAdd', [ptr, value]);
}

/**
 * Atomically stores `value` to the atomic location at `ptr`.
 *
 * In WGSL: `atomicStore(&ptr, value)`
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @param value - The value to store
 *
 * @example
 * const grid = storageArray(GRID_SIZE, S.array(S.i32()), 'read_write');
 * const cellIdx = computeCellIndex();
 * atomicStore(grid.element(cellIdx), i32(0));
 */
export function atomicStore<T extends 'i32' | 'u32'>(ptr: Node<T>, value: Node<T>): void {
    addToStack(new CallNode('void', 'atomicStore', [ptr, value]) as Node<WgslType>);
}

/**
 * Atomically loads the value from the atomic location at `ptr`.
 *
 * In WGSL: `atomicLoad(&ptr) -> i32/u32`
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @returns The current value at the atomic location
 *
 * @example
 * const grid = storageArray(GRID_SIZE, S.array(S.i32()), 'read_write');
 * const cellIdx = computeCellIndex();
 * const val = atomicLoad(grid.element(cellIdx));
 */
export function atomicLoad<T extends 'i32' | 'u32'>(ptr: Node<T>): Node<T> {
    return new CallNode(ptr.type as T, 'atomicLoad', [ptr]);
}

/**
 * Atomically subtracts `value` from the atomic value at `ptr` and returns the old value.
 *
 * In WGSL: `atomicSub(&ptr, value) -> i32/u32`
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @param value - The value to subtract
 * @returns The old value before the subtraction
 */
export function atomicSub<T extends 'i32' | 'u32'>(ptr: Node<T>, value: Node<T>): Node<T> {
    return new CallNode(ptr.type as T, 'atomicSub', [ptr, value]);
}

/**
 * Atomically computes the maximum of the atomic value and `value`, stores it, and returns the old value.
 *
 * In WGSL: `atomicMax(&ptr, value) -> i32/u32`
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @param value - The value to compare with
 * @returns The old value before the operation
 */
export function atomicMax<T extends 'i32' | 'u32'>(ptr: Node<T>, value: Node<T>): Node<T> {
    return new CallNode(ptr.type as T, 'atomicMax', [ptr, value]);
}

/**
 * Atomically computes the minimum of the atomic value and `value`, stores it, and returns the old value.
 *
 * In WGSL: `atomicMin(&ptr, value) -> i32/u32`
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @param value - The value to compare with
 * @returns The old value before the operation
 */
export function atomicMin<T extends 'i32' | 'u32'>(ptr: Node<T>, value: Node<T>): Node<T> {
    return new CallNode(ptr.type as T, 'atomicMin', [ptr, value]);
}

/**
 * Atomically computes the bitwise AND of the atomic value and `value`, stores it, and returns the old value.
 *
 * In WGSL: `atomicAnd(&ptr, value) -> i32/u32`
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @param value - The value to AND with
 * @returns The old value before the operation
 */
export function atomicAnd<T extends 'i32' | 'u32'>(ptr: Node<T>, value: Node<T>): Node<T> {
    return new CallNode(ptr.type as T, 'atomicAnd', [ptr, value]);
}

/**
 * Atomically computes the bitwise OR of the atomic value and `value`, stores it, and returns the old value.
 *
 * In WGSL: `atomicOr(&ptr, value) -> i32/u32`
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @param value - The value to OR with
 * @returns The old value before the operation
 */
export function atomicOr<T extends 'i32' | 'u32'>(ptr: Node<T>, value: Node<T>): Node<T> {
    return new CallNode(ptr.type as T, 'atomicOr', [ptr, value]);
}

/**
 * Atomically computes the bitwise XOR of the atomic value and `value`, stores it, and returns the old value.
 *
 * In WGSL: `atomicXor(&ptr, value) -> i32/u32`
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @param value - The value to XOR with
 * @returns The old value before the operation
 */
export function atomicXor<T extends 'i32' | 'u32'>(ptr: Node<T>, value: Node<T>): Node<T> {
    return new CallNode(ptr.type as T, 'atomicXor', [ptr, value]);
}

/**
 * Atomically exchanges the value at `ptr` with `value` and returns the old value.
 *
 * In WGSL: `atomicExchange(&ptr, value) -> i32/u32`
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @param value - The new value to store
 * @returns The old value before the exchange
 */
export function atomicExchange<T extends 'i32' | 'u32'>(ptr: Node<T>, value: Node<T>): Node<T> {
    return new CallNode(ptr.type as T, 'atomicExchange', [ptr, value]);
}

/**
 * Atomically compares the value at `ptr` with `comparator` and if equal, stores `value`.
 * Returns the old value (regardless of whether the exchange happened).
 *
 * In WGSL: `atomicCompareExchangeWeak(&ptr, comparator, value) -> __atomic_compare_exchange_result<T>`
 *
 * Note: WGSL returns a struct { old_value: T, exchanged: bool }. This function returns the struct type
 * which you need to access via .old_value and .exchanged fields.
 *
 * @param ptr - A node representing an atomic storage location (must be i32 or u32)
 * @param comparator - The expected current value
 * @param value - The new value to store if comparison succeeds
 * @returns A struct node with old_value and exchanged fields
 */
export function atomicCompareExchangeWeak<T extends 'i32' | 'u32'>(
    ptr: Node<T>,
    comparator: Node<T>,
    value: Node<T>,
): Node<WgslType> {
    // WGSL returns __atomic_compare_exchange_result<T> which is a struct
    // For now we type it as WgslType; users access .old_value and .exchanged via .field()
    return new CallNode('void' as WgslType, 'atomicCompareExchangeWeak', [ptr, comparator, value]);
}

/**
 * Struct descriptor for a non-indexed indirect draw call (`drawIndirect`).
 * Memory layout (4 × u32, 16 bytes):
 *   vertexCount, instanceCount, firstVertex, firstInstance
 */
export const DrawIndirect = struct('DrawIndirect', {
    vertexCount:   d.u32,
    instanceCount: d.u32,
    firstVertex:   d.u32,
    firstInstance: d.u32,
});

/**
 * Struct descriptor for an indexed indirect draw call (`drawIndexedIndirect`).
 * Memory layout (5 × u32, 20 bytes):
 *   indexCount, instanceCount, firstIndex, baseVertex, firstInstance
 */
export const DrawIndexedIndirect = struct('DrawIndexedIndirect', {
    indexCount:    d.u32,
    instanceCount: d.u32,
    firstIndex:    d.u32,
    baseVertex:    d.u32,
    firstInstance: d.u32,
});
