import type { GpuBuffer } from '../core/gpu-buffer';
import type { NodeFrame } from '../renderer/node-frame';
import type { StructSchema } from '../schema/schema';
import * as d from '../schema/schema';
import {
    collectVaryings,
    createContext,
    emitAllBindings,
    emitDslFunctions,
    emitModuleScopeVars,
    emitWgslFunctions,
    generateComputeShader,
    generateFragmentShader,
    generateVertexShader,
    type TracedFn,
} from './backend/wgsl/emit';
import { type AnyNode, getChildren, walkTypeForStructs } from './graph';
import type { AttributeNode } from './lib/attribute';
import {
    type ComputeNode,
    type FnNode,
    type Node,
    NodeKind,
    type PrivateVarNode,
    type StructDef,
    type WorkgroupVarNode,
} from './lib/core';
import type { StorageNode } from './lib/storage';
import {
    type ArrayTextureNode,
    type CubeTextureNode,
    type DepthTextureNode,
    SamplerNode,
    type StorageTextureBindingNode,
    type TextureBindingNode,
    type TextureNode,
} from './lib/texture';
import type { UniformGroup, UniformNode } from './lib/uniform';
import type { InterpolationSampling, InterpolationType } from './lib/varying';
import type { WgslFunctionNode } from './lib/wgsl-fn';

/* public apis */

export function compile(slots: CompileSlots): CompileResult {
    // A fragment-less material (depth/stencil-only) may leave the slot null or undefined.
    const hasFragment = slots.fragment != null;

    // collect all roots
    const roots: Node<d.Any>[] = [slots.vertex];
    if (slots.fragment) roots.push(slots.fragment);
    if (slots.depth) roots.push(slots.depth);

    // single discovery pass across all roots, then a context per stage that references the
    // discovered facts (both stages share one binding set — see createContext).
    const discovered = discover(roots);
    const vertexCtx = createContext('vertex', true, discovered);
    const fragmentCtx = createContext('fragment', true, discovered);

    // pre-collect varyings from fragment roots (so vertex shader knows what to output)
    if (hasFragment) {
        const fragmentRoots: Node<d.Any>[] = [slots.fragment!];
        collectVaryings(fragmentRoots, vertexCtx);
    }

    // generate vertex shader
    const vertexBody = generateVertexShader(slots, vertexCtx);

    // generate fragment shader (skip for depth-only pipelines)
    let fragmentBody = '';
    if (hasFragment) {
        fragmentBody = generateFragmentShader(slots.fragment!, fragmentCtx, vertexCtx.varyings);

        // No need to merge bindings anymore - they're shared via discovered.*
    }

    // emit all bindings (each group gets its own @group index)
    const {
        wgsl: bindingsWgsl,
        uniformBlocks,
        storageEntries,
        textureEntries: textures,
        storageTextureEntries: storageTextures,
        samplerEntries: samplers,
    } = emitAllBindings(vertexCtx);

    // emit module-scope variables (var<private>)
    const moduleScopeVarsWgsl = emitModuleScopeVars(vertexCtx);

    // emit functions
    const wgslFnsCode = emitWgslFunctions(vertexCtx);
    const dslFnsCode = emitDslFunctions(vertexCtx);

    // assemble full shader
    const codeParts = [
        '// Bindings (uniforms, storage, textures, samplers)',
        bindingsWgsl,
        '// Module-scope variables',
        moduleScopeVarsWgsl,
        '// WGSL Functions',
        wgslFnsCode,
        '// DSL Functions',
        dslFnsCode,
        '// Vertex Shader',
        vertexBody,
    ];
    if (hasFragment) {
        codeParts.push('', '// Fragment Shader', fragmentBody);
    }
    const code = codeParts.filter(Boolean).join('\n');

    // collect graph info
    const graphNodes = new Map<number, Node<d.Any>>();
    const graphEdges = new Map<number, readonly number[]>();
    const graphInfo = new Map<number, NodeGraphInfo>();

    for (const [id, node] of discovered.nodeIdToNode) {
        graphNodes.set(id, node);
        graphEdges.set(
            id,
            getChildren(node).map((c) => c.id),
        );
        graphInfo.set(id, {
            stages: [],
            cseVar: vertexCtx.nodeVars.get(id) ?? fragmentCtx.nodeVars.get(id),
            usageCount: discovered.nodeIdToUsages.get(id) ?? 0,
            expression: undefined,
        });
    }

    // build varying entries
    const varyingEntries: VaryingEntry[] = [];
    let loc = 0;
    for (const [name, { node }] of vertexCtx.varyings) {
        varyingEntries.push({
            name,
            type: node.type.wgslType,
            location: loc++,
            interpolationType: node.interpolationType ?? null,
            interpolationSampling: node.interpolationSampling ?? null,
        });
    }

    // Build attributes array, unified, all entries already in ctx.attributes
    const allAttributes: AttributeEntry[] = Array.from(vertexCtx.attributes.values());

    // Group attributes by underlying buffer for efficient vertex buffer binding
    const vertexBufferGroups = groupAttributesByBuffer(allAttributes);

    return {
        code,
        vertexEntryPoint: 'vs_main',
        fragmentEntryPoint: hasFragment ? 'fs_main' : null,
        attributes: allAttributes,
        vertexBufferGroups,
        varyings: varyingEntries,
        uniformGroups: uniformBlocks,
        storage: storageEntries,
        textures,
        storageTextures,
        samplers,
        builtinsUsed: new Set([...vertexCtx.builtins, ...fragmentCtx.builtins]),
        updateBeforeNodes: discovered.updateBeforeNodes,
        updateAfterNodes: discovered.updateAfterNodes,
        updateNodes: discovered.updateNodes,
        graphNodes,
        graphEdges,
        graphInfo,
    };
}

export function compileCompute(node: ComputeNode): ComputeCompileResult {
    // trace the FnNode to get roots
    const fn = node.fn;
    const traced = fn.trace();

    // filter out undefined (void functions have no output)
    const roots: Node<d.Any>[] = [traced.body, traced.output].filter((n): n is Node<d.Any> => n != null);

    // single discovery pass, then a context referencing the discovered facts (see createContext).
    const discovered = discover(roots);
    const ctx = createContext('compute', false, discovered);

    // generate compute shader body (reuse the trace above, re-tracing would
    // produce fresh StorageNode/etc. ids that aren't in discovered.storageNames,
    // causing emits like `undefined[...]`).
    const computeBody = generateComputeShader(node, traced, ctx);

    // emit all bindings (each group gets its own @group index)
    const { wgsl: bindingsWgsl, uniformBlocks, storageEntries, storageTextureEntries: storageTextures } = emitAllBindings(ctx);

    // emit module-scope variables (var<private>, var<workgroup>)
    const moduleScopeVarsWgsl = emitModuleScopeVars(ctx);

    // emit functions
    const wgslFnsCode = emitWgslFunctions(ctx);
    const dslFnsCode = emitDslFunctions(ctx);

    // assemble full shader
    const code = [
        '// Bindings (uniforms, storage, textures, samplers)',
        bindingsWgsl,
        '// Module-scope variables',
        moduleScopeVarsWgsl,
        '// WGSL Functions',
        wgslFnsCode,
        '// DSL Functions',
        dslFnsCode,
        '// Compute Shader',
        computeBody,
    ]
        .filter(Boolean)
        .join('\n');

    // convert storage entries to compute format
    const computeStorage: ComputeStorageEntry[] = storageEntries.map((e) => ({
        node: e.node,
        name: e.name,
        type: e.type,
        access: e.access,
        group: e.group,
        binding: e.binding,
    }));

    return {
        code,
        storage: computeStorage,
        storageTextures,
        workgroupSize: node.workgroupSize ?? [64, 1, 1],
        builtinsUsed: ctx.builtins,
        uniformGroups: uniformBlocks,
    };
}

/* types */

export type NodeUpdateType = 'none' | 'frame' | 'render' | 'object';

export type UpdateBeforeNode = {
    readonly id: number;
    readonly updateBeforeType: NodeUpdateType;
    updateBefore(frame: NodeFrame): boolean | void;
};

export type UpdateAfterNode = {
    readonly id: number;
    readonly updateAfterType: NodeUpdateType;
    updateAfter(frame: NodeFrame): boolean | void;
};

export type UpdateNode = {
    readonly id: number;
    readonly updateType: NodeUpdateType;
    update(frame: NodeFrame): boolean | void;
};

export type AttributeEntry = {
    kind: 'geometry' | 'buffer';
    /** For geometry: the geometry buffer name. For buffer: null (direct reference). */
    name: string | null;
    /** WGSL struct member name (e.g. '_position_0', '_buf_1'). */
    shaderName: string;
    type: string;
    location: number;
    node: AttributeNode<d.Any>;
    stride: number;
    offset: number;
    instanced: boolean;
};

/**
 * VertexBufferGroup, groups attributes that share the same underlying buffer.
 *
 * For interleaved vertex data, multiple attributes may reference the same buffer
 * with different offsets. Grouping them enables:
 * - One GPUVertexBufferLayout with multiple attributes
 * - One setVertexBuffer() call per unique buffer
 *
 * This follows WebGPU's design where VertexBufferLayout.attributes is an array.
 */
export type VertexBufferGroup = {
    /** For geometry-based: the buffer name. For direct buffer: null. */
    name: string | null;
    /** For direct buffer: the GpuBuffer. For geometry-based: null (resolved at render time). */
    buffer: GpuBuffer<d.Any> | null;
    /** Shared stride (must match across grouped attributes). */
    stride: number;
    /** Whether these are per-instance attributes. */
    instanced: boolean;
    /** The attributes in this group (for building GPUVertexBufferLayout.attributes). */
    attributes: {
        type: string;
        offset: number;
        shaderLocation: number;
    }[];
};

export type VaryingEntry = {
    name: string;
    type: string;
    location: number;
    interpolationType: InterpolationType | null;
    interpolationSampling: InterpolationSampling | null;
};

export type UniformMember = {
    uniformId: string;
    schema: d.Any;
    offset: number;
    size: number;
    node: UniformNode<d.Any>;
};

export type UniformGroupBlock = {
    groupName: string;
    groupIndex: number;
    binding: number;
    shared: boolean;
    members: UniformMember[];
    totalBytes: number;
    group: UniformGroup;
};

export type StorageEntry = {
    node: StorageNode<d.Any>;
    name: string;
    type: string;
    access: 'read' | 'read_write';
    group: number;
    binding: number;
};

export type TextureEntry = {
    textureId: string;
    type: string;
    group: number;
    binding: number;
    node: TextureBindingNode;
};

export type StorageTextureEntry = {
    textureId: string;
    /** Composed WGSL binding type, e.g. `texture_storage_2d<rgba8unorm, write>`. */
    type: string;
    format: d.StorageTextureFormat;
    access: d.StorageTextureAccess;
    dim: '1d' | '2d' | '2d_array' | '3d';
    group: number;
    binding: number;
    node: StorageTextureBindingNode;
};

export type SamplerEntry = {
    samplerId: string;
    type: 'sampler' | 'sampler_comparison';
    group: number;
    binding: number;
    samplerNode: SamplerNode<d.sampler | d.samplerComparison>;
};

export type ComputeStorageEntry = {
    node: StorageNode<d.Any>;
    name: string;
    type: string;
    access: 'read' | 'read_write';
    group: number;
    binding: number;
};

export type NodeGraphInfo = {
    stages: ReadonlyArray<'vertex' | 'fragment' | 'compute'>;
    cseVar: string | undefined;
    usageCount: number;
    expression: string | undefined;
};

export type CompileSlots = {
    vertex: Node<d.Any>;
    fragment?: Node<d.Any>;
    depth?: Node<d.Any>;
};

export type CompileResult = {
    code: string;
    vertexEntryPoint: string;
    fragmentEntryPoint: string | null;
    attributes: AttributeEntry[];
    vertexBufferGroups: VertexBufferGroup[];
    varyings: VaryingEntry[];
    uniformGroups: UniformGroupBlock[];
    storage: StorageEntry[];
    textures: TextureEntry[];
    storageTextures: StorageTextureEntry[];
    samplers: SamplerEntry[];
    builtinsUsed: Set<string>;
    updateBeforeNodes: UpdateBeforeNode[];
    updateAfterNodes: UpdateAfterNode[];
    updateNodes: UpdateNode[];
    graphNodes: ReadonlyMap<number, Node<d.Any>>;
    graphEdges: ReadonlyMap<number, readonly number[]>;
    graphInfo: ReadonlyMap<number, NodeGraphInfo>;
};

export type ComputeCompileResult = {
    code: string;
    storage: ComputeStorageEntry[];
    storageTextures: StorageTextureEntry[];
    workgroupSize: [number, number, number];
    builtinsUsed: Set<string>;
    uniformGroups: UniformGroupBlock[];
};

/**
 * Group attributes by their underlying buffer for efficient vertex buffer binding.
 *
 * Attributes sharing the same buffer (either by name for geometry-based, or by
 * buffer reference for direct) are grouped together. This enables:
 * - One GPUVertexBufferLayout with multiple attributes
 * - One setVertexBuffer() call per unique buffer
 *
 * @param entries - Flat array of AttributeEntry from compilation
 * @returns Array of VertexBufferGroup, one per unique buffer
 */
function groupAttributesByBuffer(entries: AttributeEntry[]): VertexBufferGroup[] {
    // Use separate maps for name-based and buffer-based grouping
    const nameGroups = new Map<string, VertexBufferGroup>();
    const bufferGroups = new Map<GpuBuffer<d.Any>, VertexBufferGroup>();

    for (const entry of entries) {
        let group: VertexBufferGroup | undefined;

        if (entry.kind === 'geometry') {
            // Name-based grouping
            const geomName = entry.name!;
            group = nameGroups.get(geomName);
            if (!group) {
                group = {
                    name: geomName,
                    buffer: null,
                    stride: entry.stride,
                    instanced: entry.instanced,
                    attributes: [],
                };
                nameGroups.set(geomName, group);
            }
        } else {
            // Buffer-based grouping
            const buffer = entry.node.buffer!;
            group = bufferGroups.get(buffer);
            if (!group) {
                group = {
                    name: null,
                    buffer,
                    stride: entry.stride,
                    instanced: entry.instanced,
                    attributes: [],
                };
                bufferGroups.set(buffer, group);
            }
        }

        // Validate stride/instanced match within group
        if (group.stride !== entry.stride) {
            throw new Error(
                `[gpucat] Interleaved attributes sharing buffer must have matching stride. ` +
                    `Got ${entry.stride} but group has ${group.stride}.`,
            );
        }
        if (group.instanced !== entry.instanced) {
            throw new Error(`[gpucat] Interleaved attributes sharing buffer must have matching instanced flag.`);
        }

        group.attributes.push({
            type: entry.type,
            offset: entry.offset,
            shaderLocation: entry.location,
        });
    }

    // Combine both maps into a single array, preserving order (name-based first, then buffer-based)
    return [...nameGroups.values(), ...bufferGroups.values()];
}

/** result of a single DFS pass that discovers all metadata needed before code generation */
export type Discovery = {
    nodeIdToUsages: Map<number, number>;
    mutatedNodes: Set<number>;
    fnDefs: Map<string, { fn: FnNode<d.Any>; traced: TracedFn }>;
    wgslFnDefs: Map<string, WgslFunctionNode>;
    structDefs: Map<string, StructDef<StructSchema>>;
    storageNames: Map<number, string>; // node.id -> globally unique name
    textures: Map<string, TextureBindingNode>;
    storageTextures: Map<string, StorageTextureBindingNode>;
    samplers: Map<string, SamplerNode>; // keyed by settingsKey for deduplication
    uniforms: Map<string, { node: UniformNode<d.Any>; group: UniformGroup }>;
    storages: Map<string, StorageNode<d.Any>>;
    privateVars: Map<number, PrivateVarNode<d.Any>>; // node.id -> node
    workgroupVars: Map<number, WorkgroupVarNode<d.Any>>; // node.id -> node
    nodeIdToNode: Map<number, Node<d.Any>>;
    updateBeforeNodes: UpdateBeforeNode[];
    updateAfterNodes: UpdateAfterNode[];
    updateNodes: UpdateNode[];
};

function discover(roots: Node<d.Any>[]): Discovery {
    const nodeIdToNode = new Map<number, Node<d.Any>>();
    const nodeIdToUsages = new Map<number, number>();

    const visited = new Set<number>();
    const mutatedNodes = new Set<number>();

    const fnDefs = new Map<string, { fn: FnNode<d.Any>; traced: TracedFn }>();
    const wgslFnDefs = new Map<string, WgslFunctionNode>();
    const structDefs = new Map<string, StructDef<StructSchema>>();
    const storageNames = new Map<number, string>();
    const textures = new Map<string, TextureBindingNode>();
    const storageTextures = new Map<string, StorageTextureBindingNode>();
    const samplers = new Map<string, SamplerNode>(); // keyed by settingsKey
    const uniforms = new Map<string, { node: UniformNode<d.Any>; group: UniformGroup }>();
    const storages = new Map<string, StorageNode<d.Any>>();
    const privateVars = new Map<number, PrivateVarNode<d.Any>>();
    const workgroupVars = new Map<number, WorkgroupVarNode<d.Any>>();
    const updateBeforeNodes: UpdateBeforeNode[] = [];
    const updateAfterNodes: UpdateAfterNode[] = [];
    const updateNodes: UpdateNode[] = [];

    function registerStructDef(def: StructDef<StructSchema>): void {
        if (structDefs.has(def.wgslType)) return;
        for (const nested of def.nestedDefs.values()) {
            registerStructDef(nested);
        }
        structDefs.set(def.wgslType, def);
    }

    function markTargetChain(rawNode: Node<d.Any>) {
        const node = rawNode as AnyNode;
        mutatedNodes.add(node.id);
        if (node.kind === NodeKind.Field) {
            markTargetChain(node.object);
        } else if (node.kind === NodeKind.Index) {
            markTargetChain(node.array);
        }
    }

    function registerSampler(samplerNode: SamplerNode): void {
        const key = samplerNode.settingsKey;
        if (!samplers.has(key)) {
            samplers.set(key, samplerNode);
        }
    }

    function registerTextureWithSampler(textureNode: TextureNode | CubeTextureNode | DepthTextureNode | ArrayTextureNode): void {
        // Register the texture binding
        const binding = textureNode.bindingNode;
        const name = binding.textureId;
        if (!textures.has(name)) {
            textures.set(name, binding);
        }

        // For sampling modes (not 'load'), ensure a sampler exists and register it
        if (textureNode.samplingMode !== 'load') {
            let samplerNode = textureNode.samplerNode;
            if (!samplerNode) {
                // Create default sampler (same logic as generateTexture had)
                samplerNode = new SamplerNode(d.sampler, name, binding.group);
                textureNode.samplerNode = samplerNode;
            }
            registerSampler(samplerNode);
        }
    }

    function visit(rawNode: Node<d.Any>) {
        const node = rawNode as AnyNode;
        // usage counting
        nodeIdToUsages.set(node.id, (nodeIdToUsages.get(node.id) ?? 0) + 1);

        // exit if visited
        if (visited.has(node.id)) return;
        visited.add(node.id);

        // collect all nodes
        nodeIdToNode.set(node.id, node);

        // collect update lifecycle nodes
        if (node.updateBeforeType !== 'none' && node.updateBefore) {
            updateBeforeNodes.push(node as unknown as UpdateBeforeNode);
        }
        if (node.updateAfterType !== 'none' && node.updateAfter) {
            updateAfterNodes.push(node as unknown as UpdateAfterNode);
        }
        if (node.updateType !== 'none' && node.update) {
            updateNodes.push(node as unknown as UpdateNode);
        }

        // mutated nodes: walk assignment target chains
        if (node.kind === NodeKind.Assign) {
            markTargetChain(node.target);
        }

        // function discovery
        if (node.kind === NodeKind.Call && node.fnNode) {
            const fn = node.fnNode;
            if (!fnDefs.has(fn.fnName)) {
                const traced = fn.trace();
                fnDefs.set(fn.fnName, { fn, traced });
                visit(traced.body);
                visit(traced.output);
            }
        }
        if (node.kind === NodeKind.Call && node.wgslFnNode) {
            const fn = node.wgslFnNode as WgslFunctionNode;
            if (!wgslFnDefs.has(fn.code)) {
                wgslFnDefs.set(fn.code, fn);
                for (const inc of fn.includes) {
                    if (inc.kind === NodeKind.WgslFunction && !wgslFnDefs.has(inc.code)) {
                        wgslFnDefs.set(inc.code, inc);
                    }
                }
            }
        }

        // storage + struct definition discovery
        if (node.kind === NodeKind.Storage) {
            if (!storageNames.has(node.id)) {
                storageNames.set(node.id, `_storage${storageNames.size}`);
            }
            // Also register storage for binding emission
            const storageName = storageNames.get(node.id)!;
            if (!storages.has(storageName)) {
                storages.set(storageName, node);
            }

            // Walk the type to find and register any struct definitions
            walkTypeForStructs(node.type, registerStructDef);
        }

        // binding discovery: textures, samplers, uniforms
        if (node.kind === NodeKind.TextureBinding) {
            const name = node.textureId;
            if (!textures.has(name)) {
                textures.set(name, node);
            }
        }
        if (node.kind === NodeKind.StorageTextureBinding) {
            const name = node.textureId;
            if (!storageTextures.has(name)) {
                storageTextures.set(name, node);
            }
        }
        if (node.kind === NodeKind.Texture) {
            registerTextureWithSampler(node);
        }
        if (node.kind === NodeKind.CubeTexture) {
            registerTextureWithSampler(node);
        }
        if (node.kind === NodeKind.DepthTexture) {
            registerTextureWithSampler(node);
        }
        if (node.kind === NodeKind.ArrayTexture) {
            registerTextureWithSampler(node);
        }
        if (node.kind === NodeKind.Sampler) {
            registerSampler(node);
        }
        if (node.kind === NodeKind.Uniform) {
            const name = node.name;
            const group = node.group;
            if (!uniforms.has(name)) {
                uniforms.set(name, { node, group });
            }
        }

        // module scope variable discovery
        if (node.kind === NodeKind.PrivateVar) {
            if (!privateVars.has(node.id)) {
                privateVars.set(node.id, node);
            }
        }
        if (node.kind === NodeKind.WorkgroupVar) {
            if (!workgroupVars.has(node.id)) {
                workgroupVars.set(node.id, node);
            }
        }

        // visit children
        for (const child of getChildren(node)) {
            visit(child);
        }
    }

    for (const root of roots) {
        visit(root);
    }

    return {
        nodeIdToNode,
        nodeIdToUsages,
        mutatedNodes,
        fnDefs,
        wgslFnDefs,
        structDefs,
        storageNames,
        updateBeforeNodes,
        updateAfterNodes,
        updateNodes,
        textures,
        storageTextures,
        samplers,
        uniforms,
        storages,
        privateVars,
        workgroupVars,
    };
}
