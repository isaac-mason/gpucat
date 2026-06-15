import type { NodeFrame } from '../renderer/node-frame';
import {
    type Node,
    type ComputeNode,
    type StructDef,
    StackNode,
    BinaryOpNode,
    CallNode,
    ConstructNode,
    FieldNode,
    IndexNode,
    ArrayNode,
    StructNode,
    AssignNode,
    InspectorNode,
    LiteralNode,
    LetNode,
    VarNode,
    PrivateVarNode,
    WorkgroupVarNode,
    IfNode,
    LoopNode,
    BreakNode,
    ContinueNode,
    DiscardNode,
    ConditionalNode,
    ReturnNode,
    FnNode,
    ParameterNode,
} from './lib/core';
import { type InterpolationType, type InterpolationSampling, VaryingNode } from './lib/varying';
import { WgslNode } from './lib/wgsl';
import { AttributeNode } from './lib/attribute';
import { GpuBuffer } from '../core/gpu-buffer';
import { TextureNode, CubeTextureNode, DepthTextureNode, ArrayTextureNode, TextureBindingNode, SamplerNode } from './lib/texture';
import { StorageNode } from './lib/storage';
import { UniformNode, UniformGroup } from './lib/uniform';
import { WgslFunctionNode } from './lib/wgsl-fn';
import { OutputStructNode, MRTNode } from './lib/mrt';
import { BuiltinNode, ComputeIndexNode, computeIndex } from './lib/builtin';
import { PassNode } from './lib/display/pass-node';
import * as d from '../schema/schema';
import type { StructSchema } from '../schema/schema';
import { constLiteral } from './wgsl-utils';

/* public apis */

export function compile(slots: CompileSlots): CompileResult {
    // create contexts for both stages
    const vertexCtx = createContext('vertex', true);
    const fragmentCtx = createContext('fragment', true);

    const hasFragment = slots.fragment !== null;

    // collect all roots
    const roots: Node<d.Any>[] = [slots.vertex];
    if (slots.fragment) roots.push(slots.fragment);
    if (slots.depth) roots.push(slots.depth);

    // single discovery pass across all roots
    const discovered = discover(roots);
    vertexCtx.usageCount = discovered.nodeIdToUsages;
    vertexCtx.mutatedNodes = discovered.mutatedNodes;
    vertexCtx.fnDefs = discovered.fnDefs;
    vertexCtx.wgslFnDefs = discovered.wgslFnDefs;
    vertexCtx.structDefs = discovered.structDefs;
    vertexCtx.storageNames = discovered.storageNames;
    vertexCtx.textures = discovered.textures;
    vertexCtx.samplers = discovered.samplers;
    vertexCtx.uniforms = discovered.uniforms;
    vertexCtx.storages = discovered.storages;
    vertexCtx.privateVars = discovered.privateVars;
    vertexCtx.workgroupVars = discovered.workgroupVars;

    fragmentCtx.usageCount = discovered.nodeIdToUsages;
    fragmentCtx.mutatedNodes = discovered.mutatedNodes;
    fragmentCtx.fnDefs = discovered.fnDefs;
    fragmentCtx.wgslFnDefs = discovered.wgslFnDefs;
    fragmentCtx.structDefs = discovered.structDefs;
    fragmentCtx.storageNames = discovered.storageNames;
    fragmentCtx.textures = discovered.textures;
    fragmentCtx.samplers = discovered.samplers;
    fragmentCtx.uniforms = discovered.uniforms;
    fragmentCtx.storages = discovered.storages;
    fragmentCtx.privateVars = discovered.privateVars;
    fragmentCtx.workgroupVars = discovered.workgroupVars;

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
    const ctx = createContext('compute', false);

    // trace the FnNode to get roots
    const fn = node.fn;
    const traced = fn.trace();

    // filter out undefined (void functions have no output)
    const roots: Node<d.Any>[] = [traced.body, traced.output].filter((n): n is Node<d.Any> => n != null);

    // single discovery pass
    const discovered = discover(roots);
    ctx.usageCount = discovered.nodeIdToUsages;
    ctx.mutatedNodes = discovered.mutatedNodes;
    ctx.fnDefs = discovered.fnDefs;
    ctx.wgslFnDefs = discovered.wgslFnDefs;
    ctx.structDefs = discovered.structDefs;
    ctx.storageNames = discovered.storageNames;
    ctx.textures = discovered.textures;
    ctx.samplers = discovered.samplers;
    ctx.uniforms = discovered.uniforms;
    ctx.storages = discovered.storages;
    ctx.privateVars = discovered.privateVars;
    ctx.workgroupVars = discovered.workgroupVars;

    // generate compute shader body (reuse the trace above, re-tracing would
    // produce fresh StorageNode/etc. ids that aren't in discovered.storageNames,
    // causing emits like `undefined[...]`).
    const computeBody = generateComputeShader(node, traced, ctx);

    // emit all bindings (each group gets its own @group index)
    const { wgsl: bindingsWgsl, uniformBlocks, storageEntries } = emitAllBindings(ctx);

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
    groupNode: UniformGroup;
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
    workgroupSize: [number, number, number];
    builtinsUsed: Set<string>;
    uniformGroups: UniformGroupBlock[];
};

type ShaderStage = 'vertex' | 'fragment' | 'compute';

/** Traced FnNode data */
type TracedFn = {
    params: ParameterNode<d.Any>[];
    body: StackNode;
    output: Node<d.Any>;
};

/** Build context - carries all state during code generation */
interface BuildContext {
    stage: ShaderStage;
    isRender: boolean;

    // Collected bindings
    uniforms: Map<string, { node: UniformNode<d.Any>; group: UniformGroup }>;
    storages: Map<string, StorageNode<d.Any>>;
    storageNames: Map<number, string>; // node.id -> generated name
    textures: Map<string, TextureBindingNode>;
    samplers: Map<string, SamplerNode>; // keyed by settingsKey for deduplication
    attributes: Map<number, AttributeEntry>; // node.id -> entry
    attrCounter: number;
    varyings: Map<string, { node: VaryingNode<d.Any>; vertexExpr: string }>;
    builtins: Set<string>;

    // Module-scope variables
    privateVars: Map<number, PrivateVarNode<d.Any>>; // node.id -> node
    workgroupVars: Map<number, WorkgroupVarNode<d.Any>>; // node.id -> node

    // Struct definitions
    structs: Map<string, StructNode>;
    structDefs: Map<string, StructDef<StructSchema>>;

    // CSE state
    usageCount: Map<number, number>;
    mutatedNodes: Set<number>;
    nodeVars: Map<number, string>;
    varCounter: number;

    // Indentation level for nested control flow (1 = function body, 2 = first nested block, etc.)
    indentLevel: number;

    // Generated code lines
    code: string[];

    // Function definitions (FnNode + WgslFnNode/FunctionNode)
    fnDefs: Map<string, { fn: FnNode<d.Any>; traced: TracedFn }>;
    wgslFnDefs: Map<string, WgslFunctionNode>;

    // Graph info for inspector
    graphNodes: Map<number, Node<d.Any>>;
    graphEdges: Map<number, number[]>;
    graphInfo: Map<number, NodeGraphInfo>;
}

function createContext(stage: ShaderStage, isRender: boolean): BuildContext {
    return {
        stage,
        isRender,
        uniforms: new Map(),
        storages: new Map(),
        storageNames: new Map(),
        textures: new Map(),
        samplers: new Map(),
        attributes: new Map(),
        attrCounter: 0,
        varyings: new Map(),
        builtins: new Set(),
        privateVars: new Map(),
        workgroupVars: new Map(),
        structs: new Map(),
        structDefs: new Map(),
        usageCount: new Map(),
        mutatedNodes: new Set(),
        nodeVars: new Map(),
        varCounter: 0,
        indentLevel: 1,
        code: [],
        fnDefs: new Map(),
        wgslFnDefs: new Map(),
        graphNodes: new Map(),
        graphEdges: new Map(),
        graphInfo: new Map(),
    };
}

/** Get all child nodes for traversal */
function getChildren(node: Node<d.Any>): Node<d.Any>[] {
    const children: Node<d.Any>[] = [];

    // _beforeNodes are dependencies that must be processed before this node.
    // They're part of the graph but don't generate sub-expressions for this node.
    if (node._beforeNodes) {
        children.push(...node._beforeNodes);
    }

    if (node instanceof BinaryOpNode) {
        children.push(node.left, node.right);
    } else if (node instanceof CallNode) {
        children.push(...node.args);
    } else if (node instanceof ConstructNode) {
        children.push(...node.args);
    } else if (node instanceof FieldNode) {
        children.push(node.object);
    } else if (node instanceof IndexNode) {
        children.push(node.array, node.index);
    } else if (node instanceof VaryingNode) {
        // VaryingNode.node is a SubBuildNode wrapping the source
        // Push the actual source inside the SubBuildNode, not the wrapper itself
        children.push(node.node.node as Node<d.Any>);
    } else if (node instanceof AssignNode) {
        children.push(node.target, node.value);
    } else if (node instanceof LetNode || node instanceof VarNode) {
        children.push(node.init);
    } else if (node instanceof PrivateVarNode) {
        if (node.init) children.push(node.init);
    } else if (node instanceof WorkgroupVarNode) {
        // WorkgroupVarNode has no initializer (WGSL doesn't allow it)
    } else if (node instanceof ConditionalNode) {
        children.push(node.condition, node.ifTrue);
        if (node.ifFalse) children.push(node.ifFalse);
    } else if (node instanceof WgslNode) {
        children.push(...node.deps);
    } else if (node instanceof ReturnNode) {
        children.push(node.value);
    } else if (node instanceof InspectorNode) {
        children.push(node.wrappedNode);
    } else if (node instanceof PassNode) {
        // PassNode delegates to its texture node during code generation
        const textureNode = node.scope === 'fragment' ? node.getTextureNode() : node.getLinearDepthNode();
        children.push(textureNode);
    } else if (node instanceof TextureBindingNode) {
        // TextureBindingNode is a leaf, no children
    } else if (node instanceof TextureNode) {
        // TextureNode owns a bindingNode for the texture var declaration
        children.push(node.bindingNode);
        if (node.samplerNode) {
            children.push(node.samplerNode);
        }
        if (node.uvNode) {
            children.push(node.uvNode);
        }
        if (node.levelNode) {
            children.push(node.levelNode);
        }
        if (node.biasNode) {
            children.push(node.biasNode);
        }
        if (node.gradNode) {
            children.push(node.gradNode[0], node.gradNode[1]);
        }
        if (node.offsetNode) {
            children.push(node.offsetNode);
        }
        if (node.loadCoords) {
            children.push(node.loadCoords);
        }
        if (node.loadLevel) {
            children.push(node.loadLevel);
        }
    } else if (node instanceof CubeTextureNode) {
        children.push(node.bindingNode);
        if (node.samplerNode) {
            children.push(node.samplerNode);
        }
        if (node.directionNode) {
            children.push(node.directionNode);
        }
        if (node.levelNode) {
            children.push(node.levelNode);
        }
        if (node.biasNode) {
            children.push(node.biasNode);
        }
        if (node.gradNode) {
            children.push(node.gradNode[0], node.gradNode[1]);
        }
    } else if (node instanceof DepthTextureNode) {
        children.push(node.bindingNode);
        if (node.samplerNode) {
            children.push(node.samplerNode);
        }
        if (node.uvNode) {
            children.push(node.uvNode);
        }
        if (node.levelNode) {
            children.push(node.levelNode);
        }
        if (node.offsetNode) {
            children.push(node.offsetNode);
        }
        if (node.loadCoords) {
            children.push(node.loadCoords);
        }
        if (node.loadLevel) {
            children.push(node.loadLevel);
        }
    } else if (node instanceof ArrayTextureNode) {
        children.push(node.bindingNode);
        if (node.samplerNode) {
            children.push(node.samplerNode);
        }
        if (node.uvNode) {
            children.push(node.uvNode);
        }
        children.push(node.layerNode);
        if (node.levelNode) {
            children.push(node.levelNode);
        }
        if (node.biasNode) {
            children.push(node.biasNode);
        }
        if (node.gradNode) {
            children.push(node.gradNode[0], node.gradNode[1]);
        }
        if (node.offsetNode) {
            children.push(node.offsetNode);
        }
        if (node.loadCoords) {
            children.push(node.loadCoords);
        }
        if (node.loadLevel) {
            children.push(node.loadLevel);
        }
    } else if (node instanceof MRTNode) {
        // MRTNode stores outputs in outputNodes dict (members only populated post-resolve)
        children.push(...Object.values(node.outputNodes));
    } else if (node instanceof OutputStructNode) {
        children.push(...node.members);
    } else if (node instanceof LoopNode) {
        children.push(node.body);
    } else if (node instanceof IfNode) {
        children.push(node.condition);
        children.push(...node.thenBody.body);
        for (const branch of node.elseIfBranches) {
            children.push(branch.condition);
            children.push(...branch.body.body);
        }
        if (node.elseBody) {
            children.push(...node.elseBody.body);
        }
    } else if (node instanceof StackNode) {
        children.push(...node.body);
    }

    return children;
}

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
type Discovery = {
    nodeIdToUsages: Map<number, number>;
    mutatedNodes: Set<number>;
    fnDefs: Map<string, { fn: FnNode<d.Any>; traced: TracedFn }>;
    wgslFnDefs: Map<string, WgslFunctionNode>;
    structDefs: Map<string, StructDef<StructSchema>>;
    storageNames: Map<number, string>; // node.id -> globally unique name
    textures: Map<string, TextureBindingNode>;
    samplers: Map<string, SamplerNode>; // keyed by settingsKey for deduplication
    uniforms: Map<string, { node: UniformNode<d.Any>; group: UniformGroup }>;
    storages: Map<string, StorageNode<d.Any>>;
    privateVars: Map<number, PrivateVarNode<d.Any>>; // node.id -> node
    workgroupVars: Map<number, WorkgroupVarNode<d.Any>>; // node.id -> node
    nodeIdToNode: Map<number, Node<d.Any>>;
    updateBeforeNodes: UpdateBeforeNode[];
    updateAfterNodes: UpdateAfterNode[];
    updateNodes: UpdateNode[];
}

/**
 * Recursively walk a type to find and register any struct definitions.
 * Handles: struct, array, sized-array, vec, mat types.
 */
function walkTypeForStructs(type: d.Any, register: (def: StructDef<StructSchema>) => void): void {
    if (d.isStructDef(type)) {
        register(type as unknown as StructDef<StructSchema>);
        return;
    }

    // For arrays, walk the element type
    if (d.isArrayDesc(type) || d.isSizedArrayDesc(type)) {
        walkTypeForStructs(type.element, register);
        return;
    }

    // For vectors and matrices, no structs to find
}

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

    function markTargetChain(node: Node<d.Any>) {
        mutatedNodes.add(node.id);
        if (node instanceof FieldNode) {
            markTargetChain(node.object);
        } else if (node instanceof IndexNode) {
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
                samplerNode = new SamplerNode(d.sampler, name, binding.groupNode);
                textureNode.samplerNode = samplerNode;
            }
            registerSampler(samplerNode);
        }
    }

    function visit(node: Node<d.Any>) {
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
        if (node instanceof AssignNode) {
            markTargetChain(node.target);
        }

        // function discovery
        if (node instanceof CallNode && node.fnNode) {
            const fn = node.fnNode;
            if (!fnDefs.has(fn.fnName)) {
                const traced = fn.trace();
                fnDefs.set(fn.fnName, { fn, traced });
                visit(traced.body);
                visit(traced.output);
            }
        }
        if (node instanceof CallNode && node.wgslFnNode) {
            const fn = node.wgslFnNode as WgslFunctionNode;
            if (!wgslFnDefs.has(fn.code)) {
                wgslFnDefs.set(fn.code, fn);
                for (const inc of fn.includes) {
                    if (inc instanceof WgslFunctionNode && !wgslFnDefs.has(inc.code)) {
                        wgslFnDefs.set(inc.code, inc);
                    }
                }
            }
        }

        // storage + struct definition discovery
        if (node instanceof StorageNode) {
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
        if (node instanceof TextureBindingNode) {
            const name = node.textureId;
            if (!textures.has(name)) {
                textures.set(name, node);
            }
        }
        if (node instanceof TextureNode) {
            registerTextureWithSampler(node);
        }
        if (node instanceof CubeTextureNode) {
            registerTextureWithSampler(node);
        }
        if (node instanceof DepthTextureNode) {
            registerTextureWithSampler(node);
        }
        if (node instanceof ArrayTextureNode) {
            registerTextureWithSampler(node);
        }
        if (node instanceof SamplerNode) {
            registerSampler(node);
        }
        if (node instanceof UniformNode) {
            const name = node.name;
            const group = node.group;
            if (!uniforms.has(name)) {
                uniforms.set(name, { node, group });
            }
        }

        // module scope variable discovery
        if (node instanceof PrivateVarNode) {
            if (!privateVars.has(node.id)) {
                privateVars.set(node.id, node);
            }
        }
        if (node instanceof WorkgroupVarNode) {
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
        samplers,
        uniforms,
        storages,
        privateVars,
        workgroupVars,
    };
}

/** Pre-collect VaryingNodes from roots and generate their vertex expressions. */
function collectVaryings(roots: Node<d.Any>[], ctx: BuildContext): void {
    const visited = new Set<number>();

    function visit(node: Node<d.Any>) {
        if (visited.has(node.id)) return;
        visited.add(node.id);

        if (node instanceof VaryingNode) {
            const name = node.name ?? `v_${node.id}`;
            if (!ctx.varyings.has(name)) {
                // generate vertex expression for this varying
                const sourceNode = node.node.node;
                const sourceExpr = generateExpr(ctx, sourceNode);
                ctx.varyings.set(name, { node, vertexExpr: sourceExpr });
            }
        }

        for (const child of getChildren(node)) {
            visit(child);
        }
    }

    for (const root of roots) {
        visit(root);
    }
}

function wgslAlign(type: string): number {
    if (type === 'f32' || type === 'i32' || type === 'u32') return 4;
    if (type === 'f16') return 2;
    if (type.startsWith('vec2')) return 8;
    if (type.startsWith('vec3') || type.startsWith('vec4')) return 16;
    if (type.startsWith('mat')) return 16;
    return 4;
}

function wgslSize(type: string): number {
    if (type === 'f32' || type === 'i32' || type === 'u32') return 4;
    if (type === 'f16') return 2;
    if (type.startsWith('vec2')) return 8;
    if (type.startsWith('vec3')) return 12;
    if (type.startsWith('vec4')) return 16;
    if (type === 'mat2x2f' || type === 'mat2x2h') return 16;
    if (type === 'mat3x3f' || type === 'mat3x3h') return 48;
    if (type === 'mat4x4f' || type === 'mat4x4h') return 64;
    return 4;
}

/* expression generation */

function generateExpr(ctx: BuildContext, node: Node<d.Any>): string {
    // Record node for graph
    ctx.graphNodes.set(node.id, node);

    // CSE: if already computed and multi-use, return variable name
    if (ctx.nodeVars.has(node.id)) {
        return ctx.nodeVars.get(node.id)!;
    }

    let expr: string;

    if (node instanceof LiteralNode) {
        expr = constLiteral(node.type.wgslType, node.value);
    } else if (node instanceof UniformNode) {
        expr = generateUniform(ctx, node);
    } else if (node instanceof AttributeNode) {
        expr = generateAttribute(ctx, node);
    } else if (node instanceof StorageNode) {
        expr = generateStorage(ctx, node);
    } else if (node instanceof PassNode) {
        // PassNode used as expression delegates to its texture node
        const textureNode = node.scope === 'fragment' ? node.getTextureNode() : node.getLinearDepthNode();
        expr = generateExpr(ctx, textureNode);
    } else if (node instanceof TextureBindingNode) {
        expr = generateTextureBinding(ctx, node);
    } else if (node instanceof TextureNode) {
        expr = generateTexture(ctx, node);
    } else if (node instanceof CubeTextureNode) {
        expr = generateCubeTexture(ctx, node);
    } else if (node instanceof DepthTextureNode) {
        expr = generateDepthTexture(ctx, node);
    } else if (node instanceof ArrayTextureNode) {
        expr = generateArrayTexture(ctx, node);
    } else if (node instanceof SamplerNode) {
        expr = generateSampler(ctx, node);
    } else if (node instanceof VaryingNode) {
        expr = generateVarying(ctx, node);
    } else if (node instanceof BinaryOpNode) {
        const left = generateExpr(ctx, node.left);
        const right = generateExpr(ctx, node.right);
        expr = `(${left} ${node.op} ${right})`;
    } else if (node instanceof CallNode) {
        expr = generateCall(ctx, node);
    } else if (node instanceof ArrayNode) {
        const args = node.elements.map((e) => generateExpr(ctx, e));
        expr = `array<${node.type.element.wgslType}, ${node.elements.length}>(${args.join(', ')})`;
    } else if (node instanceof ConstructNode) {
        const args = node.args.map((a) => generateExpr(ctx, a));
        expr = `${node.type.wgslType}(${args.join(', ')})`;
    } else if (node instanceof FieldNode) {
        const obj = generateExpr(ctx, node.object);
        expr = `${obj}.${node.fieldName}`;
    } else if (node instanceof IndexNode) {
        const arr = generateExpr(ctx, node.array);
        const idx = generateExpr(ctx, node.index);
        expr = `${arr}[${idx}]`;
    } else if (node instanceof BuiltinNode) {
        expr = generateBuiltin(ctx, node);
    } else if (node instanceof ComputeIndexNode) {
        expr = 'computeIndex';
    } else if (node instanceof ConditionalNode) {
        const cond = generateExpr(ctx, node.condition);
        const t = generateExpr(ctx, node.ifTrue);
        const f = node.ifFalse ? generateExpr(ctx, node.ifFalse) : `${node.type.wgslType}()`;
        expr = `select(${f}, ${t}, ${cond})`;
    } else if (node instanceof WgslNode) {
        // inline WGSL with $0, $1, ... placeholders
        let wgsl = node.wgsl;
        for (let i = 0; i < node.deps.length; i++) {
            const depExpr = generateExpr(ctx, node.deps[i]);
            wgsl = wgsl.replace(new RegExp(`\\$${i}`, 'g'), depExpr);
        }
        expr = wgsl;
    } else if (node instanceof LetNode) {
        // LetNode as expression returns the variable name
        // If not yet declared, emit the declaration now
        if (!ctx.nodeVars.has(node.id)) {
            const init = generateExpr(ctx, node.init);
            ctx.code.push(`    let ${node.varName} = ${init};`);
            ctx.nodeVars.set(node.id, node.varName);
        }
        expr = node.varName;
    } else if (node instanceof VarNode) {
        // VarNode as expression returns the variable name
        // If not yet declared, emit the declaration now
        if (!ctx.nodeVars.has(node.id)) {
            const init = generateExpr(ctx, node.init);
            ctx.code.push(`    var ${node.varName} = ${init};`);
            ctx.nodeVars.set(node.id, node.varName);
        }
        expr = node.varName;
    } else if (node instanceof PrivateVarNode) {
        // PrivateVarNode is module-scope, emitted separately
        // Just return the variable name - declaration is in emitModuleScopeVars
        ctx.nodeVars.set(node.id, node.varName);
        expr = node.varName;
    } else if (node instanceof WorkgroupVarNode) {
        // WorkgroupVarNode is module-scope, emitted separately
        // Validate it's only used in compute shaders
        if (ctx.stage !== 'compute') {
            throw new Error(
                `[builder] WorkgroupVarNode '${node.varName}' can only be used in compute shaders, but was used in ${ctx.stage} stage.`,
            );
        }
        ctx.nodeVars.set(node.id, node.varName);
        expr = node.varName;
    } else if (node instanceof ParameterNode) {
        expr = node.paramName ?? `p${node.paramIndex}`;
    } else if (node instanceof InspectorNode) {
        // inspector is transparent - just generate the wrapped node
        expr = generateExpr(ctx, node.wrappedNode);
    } else if (node instanceof OutputStructNode || node instanceof MRTNode) {
        // these are handled specially at the fragment output level
        expr = `/* OutputStruct */`;
    } else {
        console.warn(`[builder] Unknown node kind for expr: ${node.constructor.name}`, node);
        expr = `/* unknown: ${node.constructor.name} */`;
    }

    // CSE: if multi-use, extract to variable
    const usage = ctx.usageCount.get(node.id) ?? 1;
    if (usage > 1 && !ctx.nodeVars.has(node.id) && !isTrivialExpr(node) && !isNonCopyable(node)) {
        const varName = `_v${ctx.varCounter++}`;
        const keyword = ctx.mutatedNodes.has(node.id) ? 'var' : 'let';
        ctx.code.push(`    ${keyword} ${varName} = ${expr};`);
        ctx.nodeVars.set(node.id, varName);

        // record CSE info for graph
        const info = ctx.graphInfo.get(node.id);
        if (info) {
            (info as { cseVar: string }).cseVar = varName;
        }

        return varName;
    }

    return expr;
}

/** Check if a type descriptor contains atomic types (recursively) */
function containsAtomics(desc: d.Any): boolean {
    if (d.isAtomicDesc(desc)) return true;
    if (d.isStructDesc(desc)) {
        for (const fieldDesc of Object.values(desc.fields)) {
            if (containsAtomics(fieldDesc as d.Any)) return true;
        }
    }
    if (d.isArrayDesc(desc) || d.isSizedArrayDesc(desc)) {
        return containsAtomics(desc.element);
    }
    return false;
}

/** Check if expression is trivial enough that repeating it is cheap (no need to extract) */
function isTrivialExpr(node: Node<d.Any>): boolean {
    return (
        node instanceof LiteralNode ||
        node instanceof LetNode ||
        node instanceof VarNode ||
        node instanceof PrivateVarNode ||
        node instanceof WorkgroupVarNode ||
        node instanceof ParameterNode ||
        node instanceof BuiltinNode ||
        node instanceof FieldNode ||
        // binding references are global names
        node instanceof StorageNode ||
        node instanceof UniformNode ||
        node instanceof TextureBindingNode ||
        node instanceof SamplerNode ||
        node instanceof AttributeNode
    );
}

/** Check if a node's type cannot be copied into a let binding */
function isNonCopyable(node: Node<d.Any>): boolean {
    if (containsAtomics(node.type)) return true;
    if (isStorageElementAccess(node)) return true;
    return false;
}

/** Check if node is an access into storage (IndexNode into StorageNode, or FieldNode/IndexNode chain from one) */
function isStorageElementAccess(node: Node<d.Any>): boolean {
    if (node instanceof IndexNode) {
        if (node.array instanceof StorageNode) return true;
        // Also check if indexing into something that's itself a storage access
        return isStorageElementAccess(node.array);
    }
    if (node instanceof FieldNode) return isStorageElementAccess(node.object);
    return false;
}

/* binding generation */

function generateUniform(ctx: BuildContext, node: UniformNode<d.Any>): string {
    const name = node.name;
    const group = node.group;
    ctx.uniforms.set(name, { node, group });

    return `uniforms_${group.name}.${name}`;
}

function generateAttribute(ctx: BuildContext, node: AttributeNode<d.Any>): string {
    if (ctx.stage !== 'vertex') {
        const attrName = node.name ?? `(unnamed attribute id=${node.id})`;
        throw new Error(
            `[builder] AttributeNode '${attrName}' can only be used in vertex stage, but was used in ${ctx.stage} stage. ` +
                `Use varying() to pass vertex data to fragment stage. ` +
                `Common cause: TextureNode with default uvNode (which uses uv() attribute) being sampled in fragment shader without explicit UV coordinates. ` +
                `Fix: use textureNode.sample(yourUV) with a varying or fragment-stage UV.`,
        );
    }

    // Deduplicate by node.id, same node always returns the same WGSL name
    const existing = ctx.attributes.get(node.id);
    if (existing) {
        return `input.${existing.shaderName}`;
    }

    const location = ctx.attributes.size;
    const index = ctx.attrCounter++;

    if (node.isNamedReference) {
        const geomName = node.name!;
        const shaderName = `_${geomName}_${index}`;
        ctx.attributes.set(node.id, {
            kind: 'geometry',
            name: geomName,
            shaderName,
            type: node.type.wgslType,
            location,
            node,
            stride: node.stride,
            offset: node.offset,
            instanced: node.instanced,
        });
        return `input.${shaderName}`;
    } else {
        const shaderName = `_buf_${index}`;
        ctx.attributes.set(node.id, {
            kind: 'buffer',
            name: null,
            shaderName,
            type: node.type.wgslType,
            location,
            node,
            stride: node.stride,
            offset: node.offset,
            instanced: node.instanced,
        });
        return `input.${shaderName}`;
    }
}

function generateStorage(ctx: BuildContext, node: StorageNode<d.Any>): string {
    // name was assigned globally during discover()
    const name = ctx.storageNames.get(node.id)!;

    // register in storages map for binding emission (idempotent)
    if (!ctx.storages.has(name)) {
        ctx.storages.set(name, node);
    }

    return name;
}

function generateTextureBinding(ctx: BuildContext, node: TextureBindingNode): string {
    const name = node.textureId;
    if (!ctx.textures.has(name)) {
        ctx.textures.set(name, node);
    }
    return name;
}

function generateTexture(ctx: BuildContext, node: TextureNode): string {
    const binding = node.bindingNode;
    const name = generateTextureBinding(ctx, binding);

    // textureLoad mode - no sampler needed
    if (node.samplingMode === 'load') {
        if (!node.loadCoords) {
            throw new Error(`[builder] TextureNode '${name}' in load mode has no loadCoords`);
        }
        const coordsExpr = generateExpr(ctx, node.loadCoords);
        const levelExpr = node.loadLevel ? generateExpr(ctx, node.loadLevel) : '0';
        return `textureLoad(${name}, ${coordsExpr}, ${levelExpr})`;
    }

    // Sampling modes require a sampler
    // If no samplerNode exists (e.g., PassTextureNode), create a default one
    let samplerNode = node.samplerNode;
    if (!samplerNode) {
        samplerNode = new SamplerNode(d.sampler, name, binding.groupNode);
        // Store it on the node so it's consistent across calls
        node.samplerNode = samplerNode;
    }

    // Register the sampler (this handles deduplication by settingsKey)
    const samplerName = generateSampler(ctx, samplerNode);

    // Sampling modes - require UV coordinates
    if (!node.uvNode) {
        throw new Error(`[builder] TextureNode '${name}' has no uvNode. Set uvNode or use texture.sample(uvNode).`);
    }
    const uvExpr = generateExpr(ctx, node.uvNode);

    // Build offset suffix if present (2D/2D-array only)
    const offsetSuffix = node.offsetNode ? `, ${generateExpr(ctx, node.offsetNode)}` : '';

    // textureSampleGrad
    if (node.samplingMode === 'grad') {
        if (!node.gradNode) {
            throw new Error(`[builder] TextureNode '${name}' in grad mode has no gradNode`);
        }
        const ddx = generateExpr(ctx, node.gradNode[0]);
        const ddy = generateExpr(ctx, node.gradNode[1]);
        return `textureSampleGrad(${name}, ${samplerName}, ${uvExpr}, ${ddx}, ${ddy}${offsetSuffix})`;
    }

    // textureSampleBias
    if (node.samplingMode === 'bias') {
        if (!node.biasNode) {
            throw new Error(`[builder] TextureNode '${name}' in bias mode has no biasNode`);
        }
        const bias = generateExpr(ctx, node.biasNode);
        return `textureSampleBias(${name}, ${samplerName}, ${uvExpr}, ${bias}${offsetSuffix})`;
    }

    // textureSampleLevel
    if (node.samplingMode === 'level') {
        if (!node.levelNode) {
            throw new Error(`[builder] TextureNode '${name}' in level mode has no levelNode`);
        }
        const level = generateExpr(ctx, node.levelNode);
        return `textureSampleLevel(${name}, ${samplerName}, ${uvExpr}, ${level}${offsetSuffix})`;
    }

    // textureSample (default)
    return `textureSample(${name}, ${samplerName}, ${uvExpr}${offsetSuffix})`;
}

function generateCubeTexture(ctx: BuildContext, node: CubeTextureNode): string {
    const binding = node.bindingNode;
    const name = generateTextureBinding(ctx, binding);

    // Cube textures don't support textureLoad - only sampling modes

    // Sampling modes require a sampler
    let samplerNode = node.samplerNode;
    if (!samplerNode) {
        samplerNode = new SamplerNode(d.sampler, name, binding.groupNode);
        node.samplerNode = samplerNode;
    }

    // Register the sampler (this handles deduplication by settingsKey)
    const samplerName = generateSampler(ctx, samplerNode);

    // Cube textures require a direction vector (vec3f)
    if (!node.directionNode) {
        throw new Error(`[builder] CubeTextureNode '${name}' has no directionNode. Use cubeTexture.sample(direction).`);
    }
    const dirExpr = generateExpr(ctx, node.directionNode);

    // Cube textures do NOT support offset

    // textureSampleGrad (vec3f gradients for cube textures)
    if (node.samplingMode === 'grad') {
        if (!node.gradNode) {
            throw new Error(`[builder] CubeTextureNode '${name}' in grad mode has no gradNode`);
        }
        const ddx = generateExpr(ctx, node.gradNode[0]);
        const ddy = generateExpr(ctx, node.gradNode[1]);
        return `textureSampleGrad(${name}, ${samplerName}, ${dirExpr}, ${ddx}, ${ddy})`;
    }

    // textureSampleBias
    if (node.samplingMode === 'bias') {
        if (!node.biasNode) {
            throw new Error(`[builder] CubeTextureNode '${name}' in bias mode has no biasNode`);
        }
        const bias = generateExpr(ctx, node.biasNode);
        return `textureSampleBias(${name}, ${samplerName}, ${dirExpr}, ${bias})`;
    }

    // textureSampleLevel
    if (node.samplingMode === 'level') {
        if (!node.levelNode) {
            throw new Error(`[builder] CubeTextureNode '${name}' in level mode has no levelNode`);
        }
        const level = generateExpr(ctx, node.levelNode);
        return `textureSampleLevel(${name}, ${samplerName}, ${dirExpr}, ${level})`;
    }

    // textureSample (default)
    return `textureSample(${name}, ${samplerName}, ${dirExpr})`;
}

function generateDepthTexture(ctx: BuildContext, node: DepthTextureNode): string {
    const binding = node.bindingNode;
    const name = generateTextureBinding(ctx, binding);

    // textureLoad mode, no sampler needed
    if (node.samplingMode === 'load') {
        if (!node.loadCoords) {
            throw new Error(`[builder] DepthTextureNode '${name}' in load mode has no loadCoords`);
        }
        const coordsExpr = generateExpr(ctx, node.loadCoords);
        const levelExpr = node.loadLevel ? generateExpr(ctx, node.loadLevel) : '0';
        return `textureLoad(${name}, ${coordsExpr}, ${levelExpr})`;
    }

    // Sampling modes require a sampler
    let samplerNode = node.samplerNode;
    if (!samplerNode) {
        samplerNode = new SamplerNode(d.sampler, name, binding.groupNode);
        node.samplerNode = samplerNode;
    }

    const samplerName = generateSampler(ctx, samplerNode);

    if (!node.uvNode) {
        throw new Error(`[builder] DepthTextureNode '${name}' has no uvNode. Set uvNode or use depthTexture.sample(uvNode).`);
    }
    const uvExpr = generateExpr(ctx, node.uvNode);

    const offsetSuffix = node.offsetNode ? `, ${generateExpr(ctx, node.offsetNode)}` : '';

    // textureSampleLevel (i32 level for depth textures)
    if (node.samplingMode === 'level') {
        if (!node.levelNode) {
            throw new Error(`[builder] DepthTextureNode '${name}' in level mode has no levelNode`);
        }
        const level = generateExpr(ctx, node.levelNode);
        return `textureSampleLevel(${name}, ${samplerName}, ${uvExpr}, ${level}${offsetSuffix})`;
    }

    // textureSample (default), returns f32
    return `textureSample(${name}, ${samplerName}, ${uvExpr}${offsetSuffix})`;
}

function generateArrayTexture(ctx: BuildContext, node: ArrayTextureNode): string {
    const binding = node.bindingNode;
    const name = generateTextureBinding(ctx, binding);

    const layerExpr = generateExpr(ctx, node.layerNode);

    // textureLoad mode, no sampler needed
    // WGSL: textureLoad(t, coords, array_index, level)
    if (node.samplingMode === 'load') {
        if (!node.loadCoords) {
            throw new Error(`[builder] ArrayTextureNode '${name}' in load mode has no loadCoords`);
        }
        const coordsExpr = generateExpr(ctx, node.loadCoords);
        const levelExpr = node.loadLevel ? generateExpr(ctx, node.loadLevel) : '0';
        return `textureLoad(${name}, ${coordsExpr}, ${layerExpr}, ${levelExpr})`;
    }

    // Sampling modes require a sampler
    let samplerNode = node.samplerNode;
    if (!samplerNode) {
        samplerNode = new SamplerNode(d.sampler, name, binding.groupNode);
        node.samplerNode = samplerNode;
    }

    const samplerName = generateSampler(ctx, samplerNode);

    if (!node.uvNode) {
        throw new Error(`[builder] ArrayTextureNode '${name}' has no uvNode. Set uvNode or use arrayTexture.sample(uvNode).`);
    }
    const uvExpr = generateExpr(ctx, node.uvNode);

    const offsetSuffix = node.offsetNode ? `, ${generateExpr(ctx, node.offsetNode)}` : '';

    // textureSampleGrad(t, s, coords, array_index, ddx, ddy [, offset])
    if (node.samplingMode === 'grad') {
        if (!node.gradNode) {
            throw new Error(`[builder] ArrayTextureNode '${name}' in grad mode has no gradNode`);
        }
        const ddx = generateExpr(ctx, node.gradNode[0]);
        const ddy = generateExpr(ctx, node.gradNode[1]);
        return `textureSampleGrad(${name}, ${samplerName}, ${uvExpr}, ${layerExpr}, ${ddx}, ${ddy}${offsetSuffix})`;
    }

    // textureSampleBias(t, s, coords, array_index, bias [, offset])
    if (node.samplingMode === 'bias') {
        if (!node.biasNode) {
            throw new Error(`[builder] ArrayTextureNode '${name}' in bias mode has no biasNode`);
        }
        const bias = generateExpr(ctx, node.biasNode);
        return `textureSampleBias(${name}, ${samplerName}, ${uvExpr}, ${layerExpr}, ${bias}${offsetSuffix})`;
    }

    // textureSampleLevel(t, s, coords, array_index, level [, offset])
    if (node.samplingMode === 'level') {
        if (!node.levelNode) {
            throw new Error(`[builder] ArrayTextureNode '${name}' in level mode has no levelNode`);
        }
        const level = generateExpr(ctx, node.levelNode);
        return `textureSampleLevel(${name}, ${samplerName}, ${uvExpr}, ${layerExpr}, ${level}${offsetSuffix})`;
    }

    // textureSample(t, s, coords, array_index [, offset])
    return `textureSample(${name}, ${samplerName}, ${uvExpr}, ${layerExpr}${offsetSuffix})`;
}

function generateSampler(ctx: BuildContext, node: SamplerNode): string {
    const key = node.settingsKey;

    // Register sampler for binding emission (deduplicated by settings)
    if (!ctx.samplers.has(key)) {
        ctx.samplers.set(key, node);
    }

    // Return the sampler variable name (uses the registered sampler's ID for deduplication)
    const registeredSampler = ctx.samplers.get(key)!;
    return `${registeredSampler.samplerId}_sampler`;
}

function generateVarying(ctx: BuildContext, node: VaryingNode<d.Any>): string {
    if (ctx.stage === 'compute') {
        throw new Error(`[builder] VaryingNode not allowed in compute shaders`);
    }

    const name = node.name ?? `v_${node.id}`;

    if (ctx.stage === 'vertex') {
        // in vertex: generate the source expression (unwrap SubBuildNode)
        const sourceNode = node.node.node; // SubBuildNode.node is the actual source
        const sourceExpr = generateExpr(ctx, sourceNode);
        ctx.varyings.set(name, { node, vertexExpr: sourceExpr });
        return sourceExpr;
    } else {
        // in fragment: read from input
        // make sure varying is registered
        if (!ctx.varyings.has(name)) {
            ctx.varyings.set(name, { node, vertexExpr: '' });
        }
        return `input.${name}`;
    }
}

function generateBuiltin(ctx: BuildContext, node: BuiltinNode<d.Any>): string {
    ctx.builtins.add(node.builtinKind);

    const builtinMap: Record<string, string> = {
        vertex_index: 'input.vertex_index',
        instance_index: 'input.instance_index',
        global_invocation_id: 'global_id',
        local_invocation_id: 'local_id',
        local_invocation_index: 'local_index',
        workgroup_id: 'workgroup_id',
        num_workgroups: 'num_workgroups',
        position: ctx.stage === 'fragment' ? 'input.position' : 'output.position',
    };

    return builtinMap[node.builtinKind] ?? `/* unknown builtin: ${node.builtinKind} */`;
}

/* function call generation */

function generateCall(ctx: BuildContext, node: CallNode<d.Any>): string {
    // if this calls an FnNode, make sure it's registered
    if (node.fnNode) {
        const fn = node.fnNode;
        if (!ctx.fnDefs.has(fn.fnName)) {
            const traced = fn.trace();
            ctx.fnDefs.set(fn.fnName, { fn, traced });
        }
    }

    // if this calls a WgslFunctionNode, make sure it's registered
    if (node.wgslFnNode) {
        const fn = node.wgslFnNode as WgslFunctionNode;
        if (!ctx.wgslFnDefs.has(fn.code)) {
            ctx.wgslFnDefs.set(fn.code, fn);
            // also register includes
            for (const inc of fn.includes) {
                if (inc instanceof WgslFunctionNode && !ctx.wgslFnDefs.has(inc.code)) {
                    ctx.wgslFnDefs.set(inc.code, inc);
                }
            }
        }
    }

    const args = node.args.map((a) => generateExpr(ctx, a));

    // handle special cases
    if (node.fn === 'negate' && args.length === 1) {
        return `(-${args[0]})`;
    }
    if (node.fn === 'not' && args.length === 1) {
        return `(!${args[0]})`;
    }

    // atomic functions need pointer reference
    const atomicFns = [
        'atomicAdd',
        'atomicSub',
        'atomicMax',
        'atomicMin',
        'atomicAnd',
        'atomicOr',
        'atomicXor',
        'atomicStore',
        'atomicLoad',
        'atomicExchange',
        'atomicCompareExchangeWeak',
    ];

    if (atomicFns.includes(node.fn) && args.length >= 1) {
        const [ptr, ...rest] = args;
        return `${node.fn}(&${ptr}, ${rest.join(', ')})`;
    }

    return `${node.fn}(${args.join(', ')})`;
}

/* statement generation */

function generateStmt(ctx: BuildContext, node: Node<d.Any>): void {
    const ind = '    '.repeat(ctx.indentLevel);

    if (node instanceof LetNode) {
        const init = generateExpr(ctx, node.init);
        ctx.code.push(`${ind}let ${node.varName} = ${init};`);
        ctx.nodeVars.set(node.id, node.varName);
    } else if (node instanceof VarNode) {
        const init = generateExpr(ctx, node.init);
        ctx.code.push(`${ind}var ${node.varName} = ${init};`);
        ctx.nodeVars.set(node.id, node.varName);
    } else if (node instanceof AssignNode) {
        const target = generateExpr(ctx, node.target);
        const value = generateExpr(ctx, node.value);
        ctx.code.push(`${ind}${target} = ${value};`);
    } else if (node instanceof IfNode) {
        generateIfStmt(ctx, node);
    } else if (node instanceof LoopNode) {
        generateLoopStmt(ctx, node);
    } else if (node instanceof BreakNode) {
        ctx.code.push(`${ind}break;`);
    } else if (node instanceof ContinueNode) {
        ctx.code.push(`${ind}continue;`);
    } else if (node instanceof DiscardNode) {
        ctx.code.push(`${ind}discard;`);
    } else if (node instanceof ReturnNode) {
        if (node.value.type.wgslType === 'void') {
            ctx.code.push(`${ind}return;`);
        } else {
            const val = generateExpr(ctx, node.value);
            ctx.code.push(`${ind}return ${val};`);
        }
    } else if (node instanceof StackNode) {
        for (const child of node.body) {
            generateStmt(ctx, child);
        }
    } else {
        // treat as expression statement
        const expr = generateExpr(ctx, node);
        // If the node was hoisted to a CSE variable, its expression (and any side
        // effect, e.g. atomicAdd) was already emitted in the `let`/`var` binding.
        // Re-emitting it here would be a bare `_vN;` reference, which is dead code
        // and invalid WGSL, so skip it.
        const hoisted = ctx.nodeVars.get(node.id);
        if (expr && !expr.startsWith('/*') && expr !== hoisted) {
            ctx.code.push(`${ind}${expr};`);
        }
    }
}

function generateIfStmt(ctx: BuildContext, node: IfNode): void {
    const ind = '    '.repeat(ctx.indentLevel);
    const cond = generateExpr(ctx, node.condition);
    ctx.code.push(`${ind}if (${cond}) {`);

    ctx.indentLevel++;
    for (const child of node.thenBody.body) {
        generateStmt(ctx, child);
    }
    ctx.indentLevel--;

    // Handle else-if branches
    for (const branch of node.elseIfBranches) {
        const branchCond = generateExpr(ctx, branch.condition);
        ctx.code.push(`${ind}} else if (${branchCond}) {`);
        ctx.indentLevel++;
        for (const child of branch.body.body) {
            generateStmt(ctx, child);
        }
        ctx.indentLevel--;
    }

    // Handle else branch
    if (node.elseBody && node.elseBody.body.length > 0) {
        ctx.code.push(`${ind}} else {`);
        ctx.indentLevel++;
        for (const child of node.elseBody.body) {
            generateStmt(ctx, child);
        }
        ctx.indentLevel--;
    }

    ctx.code.push(`${ind}}`);
}

function generateLoopStmt(ctx: BuildContext, node: LoopNode): void {
    const { config, loopVar, body } = node;

    // Generate a unique WGSL variable name for this loop
    const depth = ctx.indentLevel - 1;
    const wgslVarName = `i_${depth}_${ctx.varCounter++}`;

    // Register the loop variable so references resolve to the WGSL name
    ctx.nodeVars.set(loopVar.id, wgslVarName);

    // Build loop header based on config type
    let loopHeader: string;

    if (typeof config === 'number') {
        loopHeader = `for (var ${wgslVarName}: i32 = 0i; ${wgslVarName} < ${config}i; ${wgslVarName}++)`;
    } else if (config instanceof LiteralNode || config instanceof UniformNode) {
        const endExpr = generateExpr(ctx, config as Node<d.Any>);
        loopHeader = `for (var ${wgslVarName}: i32 = 0i; ${wgslVarName} < ${endExpr}; ${wgslVarName}++)`;
    } else if (
        typeof config === 'object' &&
        config !== null &&
        !(config instanceof LiteralNode) &&
        !(config instanceof UniformNode)
    ) {
        const cfg = config as {
            start?: Node<d.Any> | number;
            end?: Node<d.Any> | number;
            type?: d.Scalar;
            condition?: '<' | '<=' | '>' | '>=';
            name?: string;
        };

        const typeDesc = cfg.type ?? d.i32;
        const typeStr = typeDesc.wgslType;

        const getExpr = (v: Node<d.Any> | number | undefined): string | undefined => {
            if (v === undefined) return undefined;
            if (typeof v === 'number') return constLiteral(typeStr, v);
            return generateExpr(ctx, v as Node<d.Any>);
        };

        const startExpr = getExpr(cfg.start) ?? '0i';
        const endExpr = getExpr(cfg.end) ?? '0i';
        const condition = cfg.condition ?? '<';

        loopHeader = `for (var ${wgslVarName}: ${typeStr} = ${startExpr}; ${wgslVarName} ${condition} ${endExpr}; ${wgslVarName}++)`;
    } else {
        loopHeader = `/* unknown loop range type */`;
    }

    // Emit loop with pre-captured body
    const ind = '    '.repeat(ctx.indentLevel);
    ctx.code.push(`${ind}${loopHeader} {`);
    ctx.indentLevel++;

    for (const stmt of body.body) {
        generateStmt(ctx, stmt);
    }

    ctx.indentLevel--;
    ctx.code.push(`${ind}}`);
}

/* wgsl code assembly */

/**
 * Emit module-scope variable declarations (var<private> and var<workgroup>).
 * These are emitted before bindings in the shader.
 */
function emitModuleScopeVars(ctx: BuildContext): string {
    const lines: string[] = [];

    // Emit private variables
    for (const [, node] of ctx.privateVars) {
        if (node.init) {
            // With initializer - need to generate init expression in a temporary context
            // Since these are module-scope, we can't use function-scope expressions directly
            // The init must be a const-expression (compile-time constant)
            const initExpr = generateModuleScopeInitExpr(node.init);
            lines.push(`var<private> ${node.varName}: ${node.type.wgslType} = ${initExpr};`);
        } else {
            // Without initializer
            lines.push(`var<private> ${node.varName}: ${node.type.wgslType};`);
        }
    }

    // Emit workgroup variables (only in compute shaders - already validated in generateExpr)
    for (const [, node] of ctx.workgroupVars) {
        // Workgroup variables cannot have initializers in WGSL
        lines.push(`var<workgroup> ${node.varName}: ${node.type.wgslType};`);
    }

    return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

/**
 * Generate a const-expression for module-scope variable initializers.
 * Module-scope initializers must be const-expressions (compile-time constants).
 */
function generateModuleScopeInitExpr(node: Node<d.Any>): string {
    if (node instanceof LiteralNode) {
        return constLiteral(node.type.wgslType, node.value);
    } else if (node instanceof ConstructNode) {
        const args = node.args.map((a) => generateModuleScopeInitExpr(a));
        return `${node.type.wgslType}(${args.join(', ')})`;
    } else if (node instanceof BinaryOpNode) {
        const left = generateModuleScopeInitExpr(node.left);
        const right = generateModuleScopeInitExpr(node.right);
        return `(${left} ${node.op} ${right})`;
    } else if (node instanceof CallNode) {
        // Only const-evaluable built-in functions are allowed
        const args = node.args.map((a) => generateModuleScopeInitExpr(a));
        return `${node.fn}(${args.join(', ')})`;
    } else {
        throw new Error(
            `[builder] Module-scope variable initializer must be a const-expression. ` +
                `Got ${node.constructor.name}. Only literals, constructors, and const-evaluable ` +
                `built-in functions are allowed.`,
        );
    }
}

/**
 * Binding group data structure for collecting all bindings per @group(N).
 * each named group gets its own @group index.
 */
type BindingGroupData = {
    groupNode: UniformGroup;
    groupIndex: number;
    uniforms: UniformNode<d.Any>[];
    storages: { name: string; node: StorageNode<d.Any> }[];
    textures: { name: string; node: TextureBindingNode }[];
    samplers: { name: string; node: SamplerNode }[];
};

/**
 * Emit all bindings (uniforms, storage, textures, samplers).
 *
 * - Each named group (render, object, etc.) gets its own @group(N) index
 * - Groups are sorted by UniformGroup.order
 * - The @group(N) index is the SORTED ARRAY POSITION, not the order value directly
 * - Within each group, bindings get sequential @binding(M) indices starting from 0
 */
function emitAllBindings(ctx: BuildContext): {
    wgsl: string;
    uniformBlocks: UniformGroupBlock[];
    storageEntries: StorageEntry[];
    textureEntries: TextureEntry[];
    samplerEntries: SamplerEntry[];
} {
    // step 1: collect all resources by their group
    const groupsByName = new Map<string, BindingGroupData>();

    // helper to get or create a group
    const getGroup = (groupNode: UniformGroup): BindingGroupData => {
        const name = groupNode.name;
        if (!groupsByName.has(name)) {
            groupsByName.set(name, {
                groupNode,
                groupIndex: groupNode.order, // temporary, will be reassigned after sorting
                uniforms: [],
                storages: [],
                textures: [],
                samplers: [],
            });
        }
        return groupsByName.get(name)!;
    };

    // collect uniforms
    for (const [_name, { node, group }] of ctx.uniforms) {
        getGroup(group).uniforms.push(node);
    }

    // collect storage buffers
    for (const [name, node] of ctx.storages) {
        getGroup(node.groupNode).storages.push({ name, node });
    }

    // collect textures
    for (const [name, node] of ctx.textures) {
        getGroup(node.groupNode).textures.push({ name, node });
    }

    // collect samplers (deduplicated by settingsKey)
    for (const [_settingsKey, node] of ctx.samplers) {
        const name = node.samplerId;
        getGroup(node.groupNode).samplers.push({ name, node });
    }

    // step 2: sort groups by their order, then assign sequential group indices
    // @group(N) is the sorted array position
    const sortedGroups = [...groupsByName.values()].sort((a, b) => a.groupNode.order - b.groupNode.order);

    // Reassign groupIndex to be the sorted array position
    for (let i = 0; i < sortedGroups.length; i++) {
        sortedGroups[i].groupIndex = i;
    }

    // step 3: emit WGSL and build result arrays
    const lines: string[] = [];
    const uniformBlocks: UniformGroupBlock[] = [];
    const storageEntries: StorageEntry[] = [];
    const textureEntries: TextureEntry[] = [];
    const samplerEntries: SamplerEntry[] = [];

    // emit struct definitions required by storage bindings (topological order)
    for (const [_typeName, def] of ctx.structDefs) {
        lines.push(`struct ${def.wgslType} {`);
        for (const member of def.members) {
            lines.push(`    ${member.name}: ${member.type.wgslType},`);
        }
        lines.push(`}`);
        lines.push('');
    }

    for (const group of sortedGroups) {
        const groupIndex = group.groupIndex;
        const groupName = group.groupNode.name;
        let bindingIndex = 0;

        // emit uniform struct and binding (if any uniforms)
        if (group.uniforms.length > 0) {
            lines.push(`struct Uniforms_${groupName} {`);

            const members: UniformMember[] = [];
            let offset = 0;

            for (const u of group.uniforms) {
                const align = wgslAlign(u.type.wgslType);
                const size = wgslSize(u.type.wgslType);

                // align offset
                offset = Math.ceil(offset / align) * align;

                lines.push(`    ${u.name}: ${u.type.wgslType},`);
                members.push({
                    uniformId: u.name,
                    schema: u.type,
                    offset,
                    size,
                    node: u,
                });

                offset += size;
            }

            lines.push(`}`);
            lines.push(
                `@group(${groupIndex}) @binding(${bindingIndex}) var<uniform> uniforms_${groupName}: Uniforms_${groupName};`,
            );
            lines.push('');

            // Compute struct alignment (max alignment of all members)
            let structAlign = 4;
            for (const u of group.uniforms) {
                structAlign = Math.max(structAlign, wgslAlign(u.type.wgslType));
            }
            // Round up totalBytes to struct alignment
            const totalBytes = Math.ceil(offset / structAlign) * structAlign;

            uniformBlocks.push({
                groupName,
                groupIndex,
                binding: bindingIndex,
                shared: group.groupNode.shared,
                members,
                totalBytes,
                groupNode: group.groupNode,
            });

            bindingIndex++;
        }

        // emit storage bindings
        for (const { name, node } of group.storages) {
            const access = ctx.stage === 'compute' ? node.access : 'read';
            const accessStr = access === 'read_write' ? 'read_write' : 'read';

            lines.push(
                `@group(${groupIndex}) @binding(${bindingIndex}) var<storage, ${accessStr}> ${name}: ${node.storageType};`,
            );

            storageEntries.push({
                node,
                name,
                type: node.storageType,
                access,
                group: groupIndex,
                binding: bindingIndex,
            });

            bindingIndex++;
        }

        // emit texture and sampler bindings
        for (const { name, node } of group.textures) {
            lines.push(`@group(${groupIndex}) @binding(${bindingIndex}) var ${name}: ${node.type.wgslType};`);
            textureEntries.push({
                textureId: name,
                type: node.type.wgslType,
                group: groupIndex,
                binding: bindingIndex,
                node,
            });
            bindingIndex++;
        }

        for (const { name, node } of group.samplers) {
            // node is now a SamplerNode - get sampler type from its compare property
            const samplerType = node.compare ? 'sampler_comparison' : 'sampler';
            lines.push(`@group(${groupIndex}) @binding(${bindingIndex}) var ${name}_sampler: ${samplerType};`);
            samplerEntries.push({
                samplerId: `${name}_sampler`,
                type: samplerType,
                group: groupIndex,
                binding: bindingIndex,
                samplerNode: node,
            });
            bindingIndex++;
        }
    }

    return {
        wgsl: lines.join('\n'),
        uniformBlocks,
        storageEntries,
        textureEntries,
        samplerEntries,
    };
}

function emitWgslFunctions(ctx: BuildContext): string {
    const lines: string[] = [];
    const emitted = new Set<string>();

    // emit wgslFn functions in dependency order
    for (const [_code, fn] of ctx.wgslFnDefs) {
        // emit includes first
        for (const inc of fn.includes) {
            if (inc instanceof WgslFunctionNode && !emitted.has(inc.code)) {
                lines.push(inc.code.trim());
                lines.push('');
                emitted.add(inc.code);
            }
        }

        if (!emitted.has(fn.code)) {
            lines.push(fn.code.trim());
            lines.push('');
            emitted.add(fn.code);
        }
    }

    return lines.join('\n');
}

function emitDslFunctions(ctx: BuildContext): string {
    const lines: string[] = [];

    for (const [name, { fn, traced }] of ctx.fnDefs) {
        // build parameter list
        const params = traced.params
            .map((p, i) => {
                const pName = p.paramName ?? `p${i}`;
                return `${pName}: ${p.type.wgslType}`;
            })
            .join(', ');

        // generate function body
        const fnCtx = createContext(ctx.stage, ctx.isRender);
        fnCtx.usageCount = ctx.usageCount;
        fnCtx.fnDefs = ctx.fnDefs;
        fnCtx.wgslFnDefs = ctx.wgslFnDefs;
        fnCtx.textures = ctx.textures;
        fnCtx.samplers = ctx.samplers;
        fnCtx.uniforms = ctx.uniforms;
        fnCtx.storages = ctx.storages;
        fnCtx.storageNames = ctx.storageNames;

        // register param names in context
        for (const p of traced.params) {
            fnCtx.nodeVars.set(p.id, p.paramName ?? `p${p.paramIndex}`);
        }

        // generate statements from body
        for (const stmt of traced.body.body) {
            generateStmt(fnCtx, stmt);
        }

        // generate return expression
        const returnExpr = generateExpr(fnCtx, traced.output);

        lines.push(`fn ${name}(${params}) -> ${fn.type.wgslType} {`);
        lines.push(...fnCtx.code);
        if (fn.type.wgslType !== 'void') {
            lines.push(`    return ${returnExpr};`);
        }
        lines.push(`}`);
        lines.push('');
    }

    return lines.join('\n');
}

/* vertex shader generation */

function generateVertexShader(slots: CompileSlots, ctx: BuildContext): string {
    const lines: string[] = [];

    // generate vertex expression
    const vertexExpr = generateExpr(ctx, slots.vertex);

    // check if we have any vertex inputs (attributes or builtins)
    const hasVertexIndex = ctx.builtins.has('vertex_index');
    const hasInstanceIndex = ctx.builtins.has('instance_index');
    const hasInputs = ctx.attributes.size > 0 || hasVertexIndex || hasInstanceIndex;

    // emit input struct only if we have inputs (WGSL structs must have at least one member)
    if (hasInputs) {
        lines.push('struct VertexInput {');
        for (const [, attr] of ctx.attributes) {
            lines.push(`    @location(${attr.location}) ${attr.shaderName}: ${attr.type},`);
        }
        if (hasVertexIndex) {
            lines.push(`    @builtin(vertex_index) vertex_index: u32,`);
        }
        if (hasInstanceIndex) {
            lines.push(`    @builtin(instance_index) instance_index: u32,`);
        }
        lines.push('}');
        lines.push('');
    }

    // emit output struct
    lines.push('struct VertexOutput {');
    lines.push('    @builtin(position) position: vec4f,');
    let varyingLoc = 0;
    for (const [name, { node }] of ctx.varyings) {
        let interp = '';
        if (node.interpolationType) {
            interp = ` @interpolate(${node.interpolationType}`;
            if (node.interpolationSampling) {
                interp += `, ${node.interpolationSampling}`;
            }
            interp += ')';
        }
        lines.push(`    @location(${varyingLoc})${interp} ${name}: ${node.type.wgslType},`);
        varyingLoc++;
    }
    lines.push('}');
    lines.push('');

    // emit main function - omit input parameter if no inputs
    lines.push('@vertex');
    if (hasInputs) {
        lines.push('fn vs_main(input: VertexInput) -> VertexOutput {');
    } else {
        lines.push('fn vs_main() -> VertexOutput {');
    }
    lines.push('    var output: VertexOutput;');
    lines.push(...ctx.code);
    lines.push(`    output.position = ${vertexExpr};`);

    // assign varyings
    for (const [name, { vertexExpr }] of ctx.varyings) {
        lines.push(`    output.${name} = ${vertexExpr};`);
    }

    lines.push('    return output;');
    lines.push('}');

    return lines.join('\n');
}

/* fragment shader generation */

function generateFragmentShader(
    fragmentNode: Node<d.Any>,
    ctx: BuildContext,
    varyings: Map<string, { node: VaryingNode<d.Any>; vertexExpr: string }>,
): string {
    const lines: string[] = [];

    // copy varyings from vertex stage
    for (const [name, data] of varyings) {
        if (!ctx.varyings.has(name)) {
            ctx.varyings.set(name, data);
        }
    }

    // generate color expression
    const fragmentExpr = generateExpr(ctx, fragmentNode);

    // check if we have any fragment inputs (varyings or builtins)
    const hasFragCoord = ctx.builtins.has('position');
    const hasInputs = ctx.varyings.size > 0 || hasFragCoord;

    // emit input struct only if we have inputs (WGSL structs must have at least one member)
    if (hasInputs) {
        lines.push('struct FragmentInput {');
        if (hasFragCoord) {
            lines.push('    @builtin(position) position: vec4f,');
        }
        let varyingLoc = 0;
        for (const [name, { node }] of ctx.varyings) {
            let interp = '';
            if (node.interpolationType) {
                interp = ` @interpolate(${node.interpolationType}`;
                if (node.interpolationSampling) {
                    interp += `, ${node.interpolationSampling}`;
                }
                interp += ')';
            }
            lines.push(`    @location(${varyingLoc})${interp} ${name}: ${node.type.wgslType},`);
            varyingLoc++;
        }
        lines.push('}');
        lines.push('');
    }

    // check for MRT
    const isMRT = fragmentNode instanceof MRTNode;
    const mrtNode = isMRT ? (fragmentNode as MRTNode) : null;

    // Pre-generate all MRT output expressions NOW so that CSE let-declarations
    // are pushed into ctx.code before we emit the function body.
    // (For non-MRT, colorExpr above already did this.)
    let mrtExprs: { name: string; expr: string }[] | null = null;
    if (isMRT && mrtNode) {
        mrtExprs = [];
        if (mrtNode.members.length > 0) {
            for (let i = 0; i < mrtNode.members.length; i++) {
                const member = mrtNode.members[i];
                if (!member) continue;
                const name = mrtNode._resolvedNames[i] || `output_${i}`;
                const expr = generateExpr(ctx, member);
                mrtExprs.push({ name, expr });
            }
        } else {
            for (const name in mrtNode.outputNodes) {
                const expr = generateExpr(ctx, mrtNode.outputNodes[name]);
                mrtExprs.push({ name, expr });
            }
        }
    }

    if (isMRT && mrtNode) {
        // generate MRT output struct with all outputs
        lines.push('struct FragmentOutput {');

        // use members array (populated by resolveOutputs) for @location order
        // fall back to outputNodes keys if members not resolved yet
        if (mrtNode.members.length > 0) {
            // members are resolved - use them in order
            for (let i = 0; i < mrtNode.members.length; i++) {
                const member = mrtNode.members[i];
                if (!member) continue; // sparse array possible
                const name = mrtNode._resolvedNames[i] || `output_${i}`;
                const wgslType = member.type.wgslType === 'vec4f' ? 'vec4f' : 'vec4f'; // MRT always outputs vec4f
                lines.push(`    @location(${i}) ${name}: ${wgslType},`);
            }
        } else {
            // fallback: use outputNodes directly (unresolved order)
            let loc = 0;
            for (const name in mrtNode.outputNodes) {
                lines.push(`    @location(${loc}) ${name}: vec4f,`);
                loc++;
            }
        }

        lines.push('}');
    }

    lines.push('');

    // emit main function - omit input parameter if no inputs
    lines.push('@fragment');
    if (isMRT && mrtNode) {
        if (hasInputs) {
            lines.push('fn fs_main(input: FragmentInput) -> FragmentOutput {');
        } else {
            lines.push('fn fs_main() -> FragmentOutput {');
        }
        lines.push('    var output: FragmentOutput;');
    } else {
        if (hasInputs) {
            lines.push('fn fs_main(input: FragmentInput) -> @location(0) vec4f {');
        } else {
            lines.push('fn fs_main() -> @location(0) vec4f {');
        }
    }

    lines.push(...ctx.code);

    if (isMRT && mrtExprs) {
        // Use pre-generated expressions (generated before ctx.code was emitted)
        for (const { name, expr } of mrtExprs) {
            lines.push(`    output.${name} = ${expr};`);
        }
        lines.push('    return output;');
    } else {
        lines.push(`    return ${fragmentExpr};`);
    }

    lines.push('}');

    return lines.join('\n');
}

/* compute shader generation */

function generateComputeShader(
    node: ComputeNode,
    traced: ReturnType<FnNode<d.Any>['trace']>,
    ctx: BuildContext,
): string {
    const lines: string[] = [];
    const fn = node.fn;

    // generate statements from body
    for (const stmt of traced.body.body) {
        generateStmt(ctx, stmt);
    }

    // generate output if non-void
    if (fn.type.wgslType !== 'void') {
        const outputExpr = generateExpr(ctx, traced.output);
        ctx.code.push(`    // Output: ${outputExpr}`);
    }

    // build workgroup size
    const wgSize = node.workgroupSize ?? [64, 1, 1];
    const [WX, WY, WZ] = wgSize;

    // check if computeIndex is used
    const usesComputeIndex = (ctx.usageCount.get(computeIndex.id) ?? 0) > 0;

    if (usesComputeIndex) {
        // computeIndex depends on global_id and num_workgroups
        ctx.builtins.add('global_invocation_id');
        ctx.builtins.add('num_workgroups');

        // emit private variable for computeIndex
        lines.push('var<private> computeIndex: u32;');
        lines.push('');
    }

    // emit main function
    lines.push(`@compute @workgroup_size(${WX}, ${WY}, ${WZ})`);
    lines.push('fn cs_main(');

    const builtinParams: string[] = [];
    if (ctx.builtins.has('global_invocation_id')) {
        builtinParams.push('    @builtin(global_invocation_id) global_id: vec3u');
    }
    if (ctx.builtins.has('local_invocation_id')) {
        builtinParams.push('    @builtin(local_invocation_id) local_id: vec3u');
    }
    if (ctx.builtins.has('local_invocation_index')) {
        builtinParams.push('    @builtin(local_invocation_index) local_index: u32');
    }
    if (ctx.builtins.has('workgroup_id')) {
        builtinParams.push('    @builtin(workgroup_id) workgroup_id: vec3u');
    }
    if (ctx.builtins.has('num_workgroups')) {
        builtinParams.push('    @builtin(num_workgroups) num_workgroups: vec3u');
    }

    lines.push(builtinParams.join(',\n'));
    lines.push(') {');

    // compute linearized index at start of function (only if used)
    if (usesComputeIndex) {
        lines.push(
            `    computeIndex = global_id.x + global_id.y * (${WX}u * num_workgroups.x) + global_id.z * (${WX}u * num_workgroups.x) * (${WY}u * num_workgroups.y);`,
        );
    }

    lines.push(...ctx.code);
    lines.push('}');

    return lines.join('\n');
}
