/**
 * compile.ts — Node graph → WGSL + binding metadata.
 *
 * Exports two pure entry-point functions:
 *   compile(slots)      → CompileResult        (render: vertex + fragment)
 *   compileCompute(node) → ComputeCompileResult (compute)
 *
 * Architecture
 * ------------
 * Functional design using CompilerState:
 *   - CompilerState holds all mutable compilation state
 *   - Pure functions operate on CompilerState
 *   - No class methods - all logic in standalone functions
 *
 * Three-pass build:
 *   Setup   — walk from root nodes, collect FnNodes, StructNodes, register
 *             resource bindings (uniforms, storage, textures, samplers,
 *             attributes, varyings).
 *   Analyze — walk all nodes, call increaseUsage(node) for each reference
 *             encountered, stored in getDataFromNode(node).usageCount.
 *   Generate — call generateNode(root) per root. CSE: when usageCount > 1,
 *              emit `let _v0 = expr;` via addLineFlowCode, cache name in
 *              nodeData.propertyName.
 *
 * Builtin binding layout (render, fixed by renderer contract):
 *   Group 0, binding 0 — Camera UBO
 *   Group 0, binding 1 — Time UBO
 *   Group 1, binding 0 — Mesh UBO (always present)
 *   Group 1, binding 1+ — material resources (uniforms, textures, samplers,
 *                          storage in encounter order)
 *
 * Compute binding layout:
 *   Group 0, binding 0, 1, … — storage buffers (declared order in ComputeNode.storage)
 */

import {
    StackNode,
    SamplerNode,
    type AssignNode,
    type AttributeNode,
    type BinopNode,
    type BreakNode,
    type BuiltinNode,
    type CallNode,
    type CondNode,
    type ConstNode,
    type ConstructNode,
    type ContinueNode,
    type ConvertNode,
    type FieldNode,
    type FnNode,
    type ForNode,
    type IfNode,
    type IndexNode,
    type BufferAttributeNode,
    type Node,
    type ParamDesc,
    type ParamNode,
    type RawNode,
    type ReturnNode,
    type StorageNode,
    type StructNode,
    type TextureNode,
    type UniformNode,
    type UniformGroupNode,
    type VarNode,
    type VaryingNode,
    type WhileNode,
    type WgslType,
    type NodeKind,
    type ScalarType,
    type NodeUpdateType,
    type WgslFnNode,
    OutputStructNode,
    MRTNode,
    constLiteral,
    buildForHeader,
    lookupStructDef,
    lookupStructDefByName,
} from './nodes';
import { collectGraph, getChildren } from './collect';
import { type StructDef, type StructSchema } from './nodes';
import type { ComputeNode } from './nodes';
import type { RenderFrame } from '../renderer/render-frame';
import { PassMultipleTextureNode } from './pass-node';

/** interface for nodes that need to execute GPU work before the final composite quad each frame/render/object */
export type UpdateBeforeNode = {
    readonly id: string;
    readonly updateBeforeType: NodeUpdateType;
    updateBefore(frame: RenderFrame): boolean | void;
}

/** interface for nodes that need to execute GPU work after each draw call */
export type UpdateAfterNode = {
    readonly id: string;
    readonly updateAfterType: NodeUpdateType;
    updateAfter(frame: RenderFrame): boolean | void;
}

/** interface for nodes that push CPU data into GPU uniforms each frame/render/object */
export type UpdateNode = {
    readonly id: string;
    readonly updateType: NodeUpdateType;
    update(frame: RenderFrame): boolean | void;
}

export type AttributeEntry =
    | {
          kind: 'geometry';
          name: string;
          type: string;
          location: number;
      }
    | {
          kind: 'buffer';
          node: BufferAttributeNode<WgslType>;
          name: string;
          type: string;
          location: number;
      };

export type VaryingEntry = {
    name: string;
    type: string;
    location: number;
};

export type UniformMember = {
    uniformId: string;
    type: string;
    offset: number;
    size: number;
    node: UniformNode<WgslType>;
};

export type UniformBlockEntry = {
    group: 0 | 1;
    binding: number;
    members: UniformMember[];
    totalBytes: number;
};

export type UniformGroupBlock = {
    /** The group name (e.g. 'render', 'object'). Becomes the WGSL struct name. */
    groupName: string;
    /** The @group(N) index assigned by order. */
    groupIndex: number;
    /** The @binding(N) index within the group (always 0 for the struct UBO). */
    binding: number;
    /** Whether this group is shared (one buffer for all objects) or per-object. */
    shared: boolean;
    /** Ordered list of uniform members in the struct. */
    members: UniformMember[];
    /** Total byte size of the struct (aligned to 16 for UBO). */
    totalBytes: number;
    /** Reference to the UniformGroupNode. */
    groupNode: UniformGroupNode;
};

export type StorageEntry = {
    node: StorageNode<WgslType>;
    name: string;
    type: string;
    access: 'read' | 'read_write';
    group: 0 | 1;
    binding: number;
};

export type TextureEntry = {
    textureId: string;
    type: string;
    group: 0 | 1;
    binding: number;
    node: TextureNode;
};

export type SamplerEntry = {
    samplerId: string;
    type: 'sampler' | 'sampler_comparison';
    group: 0 | 1;
    binding: number;
    textureNode: TextureNode;
};

export type CompileResult = {
    code: string;
    attributes: AttributeEntry[];
    varyings: VaryingEntry[];
    /** User-defined uniform blocks (for backwards compat with tests). */
    uniforms: UniformBlockEntry[];
    /** Struct-based uniform groups (render, object). */
    uniformGroups: UniformGroupBlock[];
    storage: StorageEntry[];
    textures: TextureEntry[];
    samplers: SamplerEntry[];
    builtinsUsed: Set<string>;
    updateBeforeNodes: UpdateBeforeNode[];
    updateAfterNodes: UpdateAfterNode[];
    updateNodes: UpdateNode[];
    inspectableNodes: Node<WgslType>[];
};

export type CompileSlots = {
    position: Node<WgslType>;
    color: Node<WgslType>;
    /** bool node — when false, emits `discard` at the top of fs_main. */
    mask?: Node<WgslType>;
    /** f32 node — when present, emits `@builtin(frag_depth)` on the fragment output. */
    depth?: Node<WgslType>;
};

export type ComputeStorageEntry = {
    node: StorageNode<WgslType>;
    name: string;
    type: string;
    access: 'read' | 'read_write';
    group: number;
    binding: number;
};

export type ComputeCompileResult = {
    code: string;
    storage: ComputeStorageEntry[];
    workgroupSize: [number, number, number];
    /** Set of high-level builtin categories used (e.g. WGSL shader builtins). */
    builtinsUsed: Set<string>;
    /** Struct-based uniform groups (render only for compute — no object group). */
    uniformGroups: UniformGroupBlock[];
};

/** shader data for a single stage (vertex/fragment/compute) */
type ShaderData = {
    structs: string;
    uniforms: string;
    codes: string;
    vars: string;
    flow: string;
    attributes: string;
    varyings: string;
    returnType: string;
};

/** vertex-specific shader data (extends ShaderData with vertex I/O structs) */
type VertexShaderData = ShaderData & {
    inputStruct: string;
    outputStruct: string;
};

/** fragment-specific shader data (extends ShaderData with fragment I/O structs) */
type FragmentShaderData = ShaderData & {
    inputStruct: string;
    outputStruct: string;
};

/** compute-specific shader data */
type ComputeShaderData = ShaderData & {
    workgroupSize: [number, number, number];
    builtinParams: string;
};

// ---------------------------------------------------------------------------
// Bindings types — Three.js aligned
// ---------------------------------------------------------------------------

/** Types of bindings that can be in a bind group */
type BindingType = 'uniform' | 'storage' | 'texture' | 'sampler';

/**
 * A single binding entry in a bind group.
 */
type BindingEntry = {
    type: BindingType;
    name: string;
    groupNode: UniformGroupNode;
    /** The source node for this binding */
    node: UniformNode<WgslType> | StorageNode<WgslType> | TextureNode;
    /** For uniform bindings: the list of uniforms in this group */
    uniforms?: UniformNode<WgslType>[];
};

/**
 * A bind group containing multiple bindings.
 */
type BindGroup = {
    name: string;
    index: number;
    bindings: BindingEntry[];
    groupNode: UniformGroupNode;
};

type NodeStageData = {
    usageCount?: number;       // populated in analyze pass
    propertyName?: string;     // CSE: var name when usageCount > 1
    initialized?: boolean;     // setup pass dedup guard
    varName?: string;          // registered var name (parallel to three nodeData.variable)
};

type NodeData = {
    vertex?: NodeStageData;
    fragment?: NodeStageData;
    compute?: NodeStageData;
    any?: NodeStageData;       // stage-agnostic (fn traces, etc.)
    fn?: NodeStageData;        // inside _emitFnDecl traces (shaderStage === null → 'fn')
};

type TracedFn = ReturnType<FnNode<WgslType>['trace']>;

/* node kind -> type */
type NodeOf<K extends NodeKind> =
    K extends 'const'                    ? ConstNode<WgslType>                    :
    K extends 'uniform'                  ? UniformNode<WgslType>                  :
    K extends 'attribute'                ? AttributeNode<WgslType>                :
    K extends 'buffer_attribute'         ? BufferAttributeNode<WgslType>          :
    K extends 'storage'                  ? StorageNode<WgslType>                  :
    K extends 'texture'                  ? TextureNode                            :
    K extends 'sampler'                  ? SamplerNode                            :
    K extends 'varying'                  ? VaryingNode<WgslType>                  :
    K extends 'binop'                    ? BinopNode<WgslType>                    :
    K extends 'call'                     ? CallNode<WgslType>                     :
    K extends 'raw'                      ? RawNode<WgslType>                      :
    K extends 'assign'                   ? Node<WgslType>                         :
    K extends 'construct'                ? Node<WgslType>                         :
    K extends 'struct'                   ? StructNode                             :
    K extends 'field'                    ? FieldNode<WgslType>                    :
    K extends 'index'                    ? IndexNode<WgslType>                    :
    K extends 'builtin'                  ? Node<WgslType>                         :
    K extends 'stack'                    ? StackNode                              :
    K extends 'cond'                     ? CondNode<WgslType>                     :
    K extends 'var'                      ? VarNode<WgslType>                      :
    K extends 'if'                       ? IfNode                                 :
    K extends 'for'                      ? ForNode                                :
    K extends 'while'                    ? WhileNode                              :
    K extends 'break'                    ? BreakNode                              :
    K extends 'continue'                 ? ContinueNode                           :
    K extends 'fn'                       ? FnNode<WgslType>                       :
    K extends 'param'                    ? ParamNode<WgslType>                    :
    K extends 'return'                   ? ReturnNode<WgslType>                   :
    Node<WgslType>;

type NodeCompilerDef<K extends NodeKind = NodeKind> = {
    isStatement: boolean;
    isLeaf: boolean;
    setup: ((node: NodeOf<K>, state: CompilerState) => void) | null;
    generate: (node: NodeOf<K>, state: CompilerState, output?: string) => string | null;
};

type RenderInput = { kind: 'render'; slots: CompileSlots };
type ComputeInput = { kind: 'compute'; node: ComputeNode };

export type CompilerState = {
    // Build stage cursor (parallel to three NodeBuilder.buildStage)
    buildStage: 'setup' | 'analyze' | 'generate' | null;
    // Shader stage cursor (parallel to three NodeBuilder.shaderStage)
    shaderStage: 'vertex' | 'fragment' | 'compute' | null;

    // Per-node WeakMap state (parallel to three NodeBuilder.nodeData)
    nodeData: WeakMap<Node<WgslType>, NodeData>;

    // Current writable code buffer (parallel to three NodeBuilder.flow)
    flow: { code: string };
    // Per-stage accumulated code (from flowChildNode calls)
    flowCode: Record<string, string>;

    // CSE var counter
    varCounter: number;
    // For-loop index counter
    forCounter: number;

    // Per-stage var declaration registry (parallel to three this.vars[shaderStage])
    stageVars: Record<string, { name: string; type: string }[]>;

    // Root nodes per stage
    flowNodes: {
        vertex: Node<WgslType>[];
        fragment: Node<WgslType>[];
        compute: Node<WgslType>[];
    };

    // Accumulated flow results per root node (for buildCode)
    flowResults: Map<Node<WgslType>, { code: string; result: string | null }>;

    // Input
    input: RenderInput | ComputeInput;

    // Collected resources (render)
    attributes: Map<string, AttributeEntry & { kind: 'geometry' }>;
    bufferAttrs: Array<AttributeEntry & { kind: 'buffer' }>;
    bufferAttrNames: Map<string, string>;
    varyings: Map<string, VaryingEntry>;
    builtinsUsed: Set<string>;
    structNodes: Map<string, StructNode>;

    /**
     * Per-stage bindings keyed by groupName.
     */
    bindings: {
        vertex: Record<string, BindingEntry[]>;
        fragment: Record<string, BindingEntry[]>;
        compute: Record<string, BindingEntry[]>;
    };

    /**
     * Tracks binding/group indices per groupName.
     */
    bindingsIndexes: Record<string, { binding: number; group: number }>;

    /**
     * Cached bind groups after getBindings() is called.
     */
    bindGroups: BindGroup[] | null;

    /**
     * Shared uniform binding entries keyed by groupName.
     */
    uniformGroups: Record<string, BindingEntry>;

    /**
     * Shared texture binding entries keyed by textureId.
     */
    textureBindings: Record<string, BindingEntry>;

    /**
     * Shared sampler binding entries keyed by textureId.
     */
    samplerBindings: Record<string, BindingEntry>;

    /**
     * Shared storage binding entries keyed by storage id.
     */
    storageBindings: Record<string, BindingEntry>;

    // Legacy maps for name lookups during generate
    storageNames: Map<string, string>;

    fnNodes: Map<string, { fn: FnNode<WgslType>; traced: TracedFn }>;

    /** Raw WGSL function nodes — emit their source directly. */
    wgslFnNodes: Map<string, WgslFnNode<WgslType>>;

    // All nodes seen (for expression lookup during generate)
    allNodes: Map<string, Node<WgslType>>;

    // Storage nodes inferred from compute trace (encounter order)
    computeStorage: StorageNode<WgslType>[];

    // Ordered lists of nodes needing lifecycle callbacks (post-order DFS).
    sequentialNodes: Set<UpdateBeforeNode | UpdateAfterNode>;
    updateBeforeNodes: UpdateBeforeNode[];
    updateAfterNodes: UpdateAfterNode[];
    updateNodes: UpdateNode[];

    // Build results — populated by buildCode()
    renderResult: CompileResult | null;
    computeResult: ComputeCompileResult | null;
};

function createCompilerState(input: RenderInput | ComputeInput): CompilerState {
    return {
        buildStage: null,
        shaderStage: null,
        nodeData: new WeakMap(),
        flow: { code: '' },
        flowCode: { vertex: '', fragment: '', compute: '' },
        varCounter: 0,
        forCounter: 0,
        stageVars: {},
        flowNodes: { vertex: [], fragment: [], compute: [] },
        flowResults: new Map(),
        input,
        attributes: new Map(),
        bufferAttrs: [],
        bufferAttrNames: new Map(),
        varyings: new Map(),
        builtinsUsed: new Set(),
        structNodes: new Map(),
        bindings: { vertex: {}, fragment: {}, compute: {} },
        bindingsIndexes: {},
        bindGroups: null,
        uniformGroups: {},
        textureBindings: {},
        samplerBindings: {},
        storageBindings: {},
        storageNames: new Map(),
        fnNodes: new Map(),
        wgslFnNodes: new Map(),
        allNodes: new Map(),
        computeStorage: [],
        sequentialNodes: new Set(),
        updateBeforeNodes: [],
        updateAfterNodes: [],
        updateNodes: [],
        renderResult: null,
        computeResult: null,
    };
}

export function compile(slots: CompileSlots): CompileResult {
    const state = createCompilerState({ kind: 'render', slots });
    build(state);
    return state.renderResult!;
}

export function compileCompute(node: ComputeNode): ComputeCompileResult {
    const state = createCompilerState({ kind: 'compute', node });
    build(state);
    return state.computeResult!;
}

// Builtin WGSL variable names for render stage
const COMPUTE_BUILTIN_PARAM: Record<string, { attr: string; type: string }> = {
    global_invocation_id:   { attr: 'global_invocation_id',   type: 'vec3u' },
    local_invocation_id:    { attr: 'local_invocation_id',    type: 'vec3u' },
    local_invocation_index: { attr: 'local_invocation_index', type: 'u32'   },
    workgroup_id:           { attr: 'workgroup_id',           type: 'vec3u' },
    num_workgroups:         { attr: 'num_workgroups',         type: 'vec3u' },
};

/**
 * Top-level orchestrator: setup → analyze → generate → buildCode
 */
function build(state: CompilerState): void {
    registerRoots(state);

    // setup() -> stage 1: create possible new nodes and/or return an output reference node
    // analyze() -> stage 2: analyze nodes to possible optimization and validation
    // generate() -> stage 3: generate shader
    for (const stage of ['setup', 'analyze', 'generate'] as const) {
        state.buildStage = stage;
        const stages = state.input.kind === 'render'
            ? (['vertex', 'fragment'] as const)
            : (['compute'] as const);
        for (const shaderStage of stages) {
            state.shaderStage = shaderStage;
            for (const node of state.flowNodes[shaderStage]) {
                if (stage === 'generate') {
                    const flowData = flowChildNode(state, node);
                    state.flowResults.set(node, flowData);
                } else {
                    buildNode(state, node);
                }
            }
        }
    }

    state.buildStage = null;
    state.shaderStage = null;

    // stage 4: build code for a specific output
    buildCode(state);

    // Split sequentialNodes into typed arrays
    buildUpdateNodes(state);
}

/**
 * Register root nodes per stage
 */
function registerRoots(state: CompilerState): void {
    if (state.input.kind === 'render') {
        const { position, color, mask, depth } = state.input.slots;
        // Stage validation: fragment graph must not contain vertex-only nodes
        validateFragmentRoot(state, color);
        if (mask) validateFragmentRoot(state, mask);
        if (depth) validateFragmentRoot(state, depth);
        state.flowNodes.vertex.push(position);
        state.flowNodes.fragment.push(color);
        if (mask)  state.flowNodes.fragment.push(mask);
        if (depth) state.flowNodes.fragment.push(depth);
    } else {
        // Compute: trace Fn body, infer storage nodes from graph
        const { body, storage } = state.input.node.trace();
        state.computeStorage = storage;
        // Register storage nodes into allNodes so setup pass finds them
        for (const s of storage) {
            state.allNodes.set(s.id, s);
        }
        state.flowNodes.compute.push(body);
    }
}

function validateFragmentRoot(_state: CompilerState, root: Node<WgslType>): void {
    const graph = collectGraph(root);
    for (const node of graph.nodes.values()) {
        if (node.kind === 'attribute') {
            const n = node as AttributeNode<WgslType>;
            throw new Error(
                `[gpucat] attribute('${n.type}', '${n.name}') is a vertex-only node and cannot be used ` +
                `in the fragment graph. Bridge it to the fragment stage with varying('${n.type}', '<name>', ${n.name}).`,
            );
        }
        if (node.kind === 'buffer_attribute') {
            throw new Error(
                `[gpucat] bufferAttribute() / instancedBufferAttribute() is a vertex-only node and cannot be used ` +
                `in the fragment graph. Bridge it to the fragment stage with varying('<type>', '<name>', <node>).`,
            );
        }
    }
}

/** get per-node-per-stage state */
function getDataFromNode(state: CompilerState, node: Node<WgslType>, stage?: string): NodeStageData {
    const s = stage ?? state.shaderStage ?? 'any';
    let data = state.nodeData.get(node);
    if (!data) {
        data = {};
        state.nodeData.set(node, data);
    }
    const key = s as keyof NodeData;
    if (!data[key]) data[key] = {};
    return data[key]!;
}

/** increase usage count for a node (called in analyze pass) */
function increaseUsage(state: CompilerState, node: Node<WgslType>): number {
    const data = getDataFromNode(state, node);
    data.usageCount = (data.usageCount ?? 0) + 1;
    return data.usageCount;
}

function addLineFlowCode(state: CompilerState, code: string): void {
    state.flow.code += `    ${code};\n`;
}

function addFlowCode(state: CompilerState, code: string): void {
    state.flow.code += code;
}

/** register a VarNode's declaration into the per-stage vars preamble */
function getVarFromNode(state: CompilerState, node: Node<WgslType>, varName: string, type: string): string {
    const stage = state.shaderStage ?? 'fn';
    const data = getDataFromNode(state, node, stage);

    if (data.varName === undefined) {
        const vars = state.stageVars[stage] ?? (state.stageVars[stage] = []);
        vars.push({ name: varName, type });
        data.varName = varName;
    }

    return data.varName;
}

/** serialize the per-stage vars dict to a WGSL declaration block */
function getVars(state: CompilerState, stage: string): string {
    const vars = state.stageVars[stage];
    if (!vars || vars.length === 0) return '';
    return vars.map((v) => `    var ${v.name} : ${v.type};`).join('\n') + '\n';
}

/** returns the bindings array for a group name and shader stage */
function getBindGroupArray(state: CompilerState, groupName: string, shaderStage: 'vertex' | 'fragment' | 'compute'): BindingEntry[] {
    const stageBindings = state.bindings[shaderStage];
    
    let bindGroup = stageBindings[groupName];
    
    if (bindGroup === undefined) {
        if (state.bindingsIndexes[groupName] === undefined) {
            state.bindingsIndexes[groupName] = {
                binding: 0,
                group: Object.keys(state.bindingsIndexes).length
            };
        }
        stageBindings[groupName] = bindGroup = [];
    }
    
    return bindGroup;
}

/** returns all bind groups merged from all shader stages */
function getBindings(state: CompilerState): BindGroup[] {
    if (state.bindGroups !== null) {
        return state.bindGroups;
    }

    const groups: Record<string, BindingEntry[]> = {};
    const shaderStages = state.input.kind === 'render'
        ? ['vertex', 'fragment'] as const
        : ['compute'] as const;

    // merge bindings from all stages
    for (const shaderStage of shaderStages) {
        const stageBindings = state.bindings[shaderStage];
        for (const groupName in stageBindings) {
            const bindings = stageBindings[groupName];
            const groupBindings = groups[groupName] || (groups[groupName] = []);
            
            for (const binding of bindings) {
                if (!groupBindings.includes(binding)) {
                    groupBindings.push(binding);
                }
            }
        }
    }

    // create BindGroup objects
    const bindGroups: BindGroup[] = [];
    for (const groupName in groups) {
        const bindings = groups[groupName];
        if (bindings.length === 0) continue;
        
        bindGroups.push({
            name: groupName,
            index: state.bindingsIndexes[groupName]?.group ?? 0,
            bindings,
            groupNode: bindings[0].groupNode,
        });
    }

    state.bindGroups = bindGroups;
    return bindGroups;
}

/** sorts bind groups by groupNode.order and assigns final group indices */
function sortBindingGroups(state: CompilerState): void {
    const bindGroups = getBindings(state);
    
    // sort by groupNode.order
    bindGroups.sort((a, b) => a.groupNode.order - b.groupNode.order);
    
    // assign final group indices
    for (let i = 0; i < bindGroups.length; i++) {
        const bindGroup = bindGroups[i];
        state.bindingsIndexes[bindGroup.name].group = i;
        bindGroup.index = i;
    }
}

/** saves/installs/restores the flow buffer */
function flowChildNode(state: CompilerState, node: Node<WgslType>): { code: string; result: string | null } {
    const previousFlow = state.flow;
    state.flow = { code: '' };
    const result = buildNode(state, node);
    const flowData = { code: state.flow.code, result };
    state.flow = previousFlow;
    return flowData;
}

/** run a node in a different shader stage */
function flowNodeFromShaderStage(
    state: CompilerState,
    stage: 'vertex' | 'fragment' | 'compute',
    node: Node<WgslType>,
    propertyName?: string,
): string | null {
    const previousStage = state.shaderStage;
    state.shaderStage = stage;
    const flowData = flowChildNode(state, node);
    if (propertyName && flowData.result !== null) {
        state.flowCode[stage] += `    ${propertyName} = ${flowData.result};\n`;
    }
    state.flowCode[stage] += flowData.code;
    state.shaderStage = previousStage;
    return flowData.result;
}

/** single dispatch entry point for building nodes */
function buildNode(state: CompilerState, node: Node<WgslType>): string | null {
    if (state.buildStage === 'setup') {
        setupNode(state, node);
        return null;
    }
    if (state.buildStage === 'analyze') {
        analyzeNode(state, node);
        return null;
    }
    // Generate stage
    return generateNode(state, node);
}

/** split sequentialNodes into typed arrays */
function buildUpdateNodes(state: CompilerState): void {
    for (const node of state.sequentialNodes) {
        if ('updateBeforeType' in node && (node as UpdateBeforeNode).updateBeforeType !== 'none') {
            state.updateBeforeNodes.push(node as UpdateBeforeNode);
        }
        if ('updateAfterType' in node && (node as UpdateAfterNode).updateAfterType !== 'none') {
            state.updateAfterNodes.push(node as UpdateAfterNode);
        }
    }
}

function setupNode(state: CompilerState, node: Node<WgslType>): void {
    const data = getDataFromNode(state, node, 'any');
    if (data.initialized) return;
    data.initialized = true;

    // register node into allNodes for expression lookup
    if (!state.allNodes.has(node.id)) {
        state.allNodes.set(node.id, node);
    }

    // visit children first (depth-first)
    for (const child of getChildren(node)) {
        setupNode(state, child);
    }

    // delegate resource registration to compilerDefs
    compilerDefs[node.kind].setup?.(node as never, state);

    // post-order: collect nodes needing lifecycle callbacks
    if ('updateBeforeType' in node) {
        const n = node as unknown as UpdateBeforeNode;
        if (n.updateBeforeType !== 'none') {
            state.sequentialNodes.add(n);
        }
    }
    if ('updateAfterType' in node) {
        const n = node as unknown as UpdateAfterNode;
        if (n.updateAfterType !== 'none') {
            state.sequentialNodes.add(n);
        }
    }
    if ('updateType' in node) {
        const n = node as unknown as UpdateNode;
        if (n.updateType !== 'none' && !state.updateNodes.includes(n)) {
            state.updateNodes.push(n);
        }
    }
}

function setupFnNode(state: CompilerState, fn: FnNode<WgslType>): void {
    const data = getDataFromNode(state, fn as unknown as Node<WgslType>, 'any');
    if (data.initialized) return;
    data.initialized = true;

    const traced = fn.trace();
    state.fnNodes.set(fn.id, { fn, traced });

    // register param nodes into allNodes
    for (const p of traced.params) {
        if (!state.allNodes.has(p.id)) state.allNodes.set(p.id, p);
    }

    // walk the output expression graph
    const bodyGraph = collectGraph(traced.output);
    for (const [id, node] of bodyGraph.nodes) {
        if (!state.allNodes.has(id)) state.allNodes.set(id, node);
    }

    // walk statement nodes
    const stackGraph = collectGraph(traced.body);
    for (const [id, node] of stackGraph.nodes) {
        if (!state.allNodes.has(id)) state.allNodes.set(id, node);
    }

    // recurse into body to collect nested Fns and resources
    setupStackNode(state, traced.body);

    // also recurse into the output expression
    for (const node of bodyGraph.nodes.values()) {
        if (node.kind === 'call') {
            const cn = node as CallNode<WgslType>;
            if (cn.fnNode) {
                setupCallNodeFn(state, cn.fnNode);
            }
        }
    }
}

/**
 * Setup a WgslFnNode — raw WGSL function that gets emitted directly.
 * Handles includes recursively.
 */
function setupWgslFnNode(state: CompilerState, fn: WgslFnNode<WgslType>): void {
    if (state.wgslFnNodes.has(fn.id)) return;
    state.wgslFnNodes.set(fn.id, fn);

    // Recursively setup includes
    for (const include of fn.includes) {
        setupWgslFnNode(state, include);
    }
}

/**
 * Setup the function node for a CallNode, handling both FnNode and WgslFnNode.
 */
function setupCallNodeFn(state: CompilerState, fnNode: FnNode<WgslType> | WgslFnNode<WgslType>): void {
    if (fnNode.kind === 'wgsl_fn') {
        setupWgslFnNode(state, fnNode as WgslFnNode<WgslType>);
    } else if (fnNode.kind === 'fn' && !state.fnNodes.has(fnNode.id)) {
        setupFnNode(state, fnNode as FnNode<WgslType>);
    }
}

function setupStackNode(state: CompilerState, stack: Node<WgslType>): void {
    if (stack.kind !== 'stack') return;
    const s = stack as StackNode;
    for (const stmt of s.body) {
        setupNodeRecursive(state, stmt);
    }
}

function setupNodeRecursive(state: CompilerState, node: Node<WgslType>): void {
    switch (node.kind) {
        case 'call': {
            const cn = node as CallNode<WgslType>;
            if (cn.fnNode) {
                setupCallNodeFn(state, cn.fnNode);
            }
            break;
        }
        case 'if': {
            const n = node as IfNode;
            setupStackNode(state, n.thenBody);
            if (n.elseBody) setupStackNode(state, n.elseBody);
            break;
        }
        case 'for': {
            const n = node as ForNode;
            setupStackNode(state, n.body);
            break;
        }
        case 'while': {
            const n = node as WhileNode;
            setupStackNode(state, n.body);
            break;
        }
        default:
            break;
    }
}

function registerStructDef(state: CompilerState, def: StructDef<StructSchema>): void {
    for (const nested of def.nestedDefs.values()) {
        registerStructDef(state, nested);
    }
    if (!state.structNodes.has(def.wgslType)) {
        state.structNodes.set(def.wgslType, def.node);
    }
}

function analyzeNode(state: CompilerState, node: Node<WgslType>): void {
    const count = increaseUsage(state, node);

    // Only recurse into children the first time we see this node
    if (count !== 1) return;

    for (const child of getChildren(node)) {
        analyzeNode(state, child);
    }

    // VaryingNode: also analyze its source in vertex stage
    if (node.kind === 'varying') {
        const vn = node as VaryingNode<WgslType>;
        const prevStage = state.shaderStage;
        state.shaderStage = 'vertex';
        analyzeNode(state, vn.source);
        state.shaderStage = prevStage;
    }

    // StackNode: analyze all body statements
    if (node.kind === 'stack') {
        const s = node as StackNode;
        for (const stmt of s.body) {
            analyzeNode(state, stmt);
        }
    }
}

/** generate WGSL code for a node */
function generateNode(state: CompilerState, node: Node<WgslType>, output?: string): string | null {
    const data = getDataFromNode(state, node);
    const def  = compilerDefs[node.kind];

    // CSE hit: already emitted as a var
    if (data.propertyName !== undefined && output === undefined) return data.propertyName;

    if (def.isStatement || def.isLeaf) return def.generate(node as never, state, output);

    if ((data.usageCount ?? 0) > 1 && output === undefined) {
        // CSE: emit a var and cache its name
        const snippet = def.generate(node as never, state, output)!;
        const varName = `_v${state.varCounter++}`;
        addLineFlowCode(state, `let ${varName} = ${snippet}`);
        data.propertyName = varName;
        return varName;
    }

    return def.generate(node as never, state, output);
}

/** emit a StackNode's statements with a given indent */
function emitStackIntoFlow(state: CompilerState, stack: StackNode, indent: string): void {
    const outerFlow = state.flow;
    state.flow = { code: '' };

    for (const stmt of stack.body) {
        buildNode(state, stmt);
    }

    const indented = state.flow.code.replace(/^    /gm, indent);
    outerFlow.code += indented;
    state.flow = outerFlow;
}

function emitFnDecl(state: CompilerState, fn: FnNode<WgslType>, traced: TracedFn): string {
    const { params, body, output } = traced;

    // Register param names so generateNode resolves them
    for (const p of params) {
        const data = getDataFromNode(state, p);
        data.propertyName = p.paramName ?? `p${p.paramIndex}`;
    }

    const paramList = params.map((p, i) => {
        const name = p.paramName ?? `p${i}`;
        const desc = fn.paramDescs[i];
        const wgslType = 'name' in desc
            ? (desc as ParamDesc).type.wgslType
            : (desc as { wgslType: string }).wgslType;
        return `${name} : ${wgslType}`;
    }).join(', ');

    // Generate the body statements
    const prevBuildStage = state.buildStage;
    const prevShaderStage = state.shaderStage;
    const prevStageVars = state.stageVars;
    state.buildStage = 'generate';
    state.shaderStage = null;
    state.stageVars = {};

    const bodyFlow = flowChildNode(state, body);
    const retExpr = generateNode(state, output) ?? '/* missing */';

    const fnVarsPreamble = getVars(state, 'fn');
    state.buildStage = prevBuildStage;
    state.shaderStage = prevShaderStage;
    state.stageVars = prevStageVars;

    return [
        `fn ${fn.fnName}(${paramList}) -> ${fn.type} {`,
        ...(fnVarsPreamble ? [fnVarsPreamble.replace(/\n$/, '')] : []),
        bodyFlow.code.replace(/\n$/, ''),
        `    return ${retExpr};`,
        `}`,
    ].join('\n');
}

/** returns user-defined struct declarations */
function getStructs(state: CompilerState): string {
    const lines: string[] = [];
    for (const sn of state.structNodes.values()) {
        const members = sn.members.map((m) => `    ${m.name} : ${m.type},`).join('\n');
        lines.push(`struct ${sn.type} {\n${members}\n}`);
    }
    return lines.join('\n');
}

/** emits WGSL declarations for all bindings */
function emitBindingsWGSL(state: CompilerState): string {
    const lines: string[] = [];
    const bindGroups = getBindings(state);

    for (const group of bindGroups) {
        const groupIndex = group.index;
        let bindingIndex = 0;

        for (const entry of group.bindings) {
            if (entry.type === 'uniform' && entry.uniforms) {
                const structTypeName = entry.groupNode.name + 'Struct';
                const memberLines = entry.uniforms.map(u => `    ${u.name} : ${u.type},`).join('\n');
                lines.push(`struct ${structTypeName} {\n${memberLines}\n}`);
                lines.push(`@group(${groupIndex}) @binding(${bindingIndex}) var<uniform> ${entry.groupNode.name} : ${structTypeName};`);
                bindingIndex++;
            } else if (entry.type === 'storage') {
                const storageNode = entry.node as StorageNode<WgslType>;
                const access = state.input.kind === 'render' ? 'read' : storageNode.access;
                lines.push(`@group(${groupIndex}) @binding(${bindingIndex}) var<storage, ${access}> ${entry.name} : ${storageNode.storageType};`);
                bindingIndex++;
            } else if (entry.type === 'texture') {
                const textureNode = entry.node as TextureNode;
                lines.push(`@group(${groupIndex}) @binding(${bindingIndex}) var ${entry.name}_tex : ${textureNode.textureType};`);
                bindingIndex++;
            } else if (entry.type === 'sampler') {
                lines.push(`@group(${groupIndex}) @binding(${bindingIndex}) var ${entry.name}_samp : sampler;`);
                bindingIndex++;
            }
        }
    }

    return lines.join('\n');
}

/** returns user-defined function declarations */
function getCodes(state: CompilerState): string {
    const lines: string[] = [];

    // Emit raw WGSL functions (wgslFn) first, as regular FnNodes may depend on them
    for (const wgslFn of state.wgslFnNodes.values()) {
        lines.push(wgslFn.wgslSource);
    }

    // Emit traced JS functions (Fn)
    for (const { fn, traced } of state.fnNodes.values()) {
        lines.push(emitFnDecl(state, fn, traced));
    }

    return lines.join('\n\n');
}

function buildVertexShaderData(state: CompilerState): VertexShaderData {
    const varyingList = [...state.varyings.values()];
    const attrList = [...state.attributes.values()];

    // Build VertexInput struct
    const inputLines: string[] = [`struct VertexInput {`];
    for (const a of attrList) {
        inputLines.push(`    @location(${a.location}) ${a.name} : ${a.type},`);
    }
    for (const a of state.bufferAttrs) {
        inputLines.push(`    @location(${a.location}) ${a.name} : ${a.type},`);
    }
    if (state.builtinsUsed.has('instance_index')) {
        inputLines.push(`    @builtin(instance_index) instance_index : u32,`);
    }
    if (state.builtinsUsed.has('vertex_index')) {
        inputLines.push(`    @builtin(vertex_index) vertex_index : u32,`);
    }
    inputLines.push(`}`);
    const inputStruct = inputLines.join('\n');

    // Build VertexOutput struct
    const outputLines: string[] = [`struct VertexOutput {`];
    outputLines.push(`    @builtin(position) position : vec4f,`);
    for (const v of varyingList) {
        outputLines.push(`    @location(${v.location}) ${v.name} : ${v.type},`);
    }
    outputLines.push(`}`);
    const outputStruct = outputLines.join('\n');

    // Build vars
    const vars = getVars(state, 'vertex') ?? '';

    // Build flow
    const flowLines: string[] = [];

    if (state.flowCode.vertex) {
        flowLines.push(state.flowCode.vertex.replace(/\n$/, ''));
    }

    const posRoot = state.input.kind === 'render' ? state.input.slots.position : null;
    if (posRoot) {
        const flowData = state.flowResults.get(posRoot);
        if (flowData) {
            if (flowData.code) flowLines.push(flowData.code.replace(/\n$/, ''));
            flowLines.push(`    out.position = ${flowData.result};`);
        }
    }

    // Assign varyings
    for (const v of varyingList) {
        const vn = findVaryingNodeByName(state, v.name);
        if (vn) {
            const prevBuildStage = state.buildStage;
            const prevShaderStage = state.shaderStage;
            state.buildStage = 'generate';
            state.shaderStage = 'vertex';
            const srcExpr = generateNode(state, vn.source) ?? '/* missing */';
            state.buildStage = prevBuildStage;
            state.shaderStage = prevShaderStage;
            flowLines.push(`    out.${v.name} = ${srcExpr};`);
        }
    }

    const flow = flowLines.join('\n');

    return {
        structs: '',
        uniforms: '',
        codes: '',
        vars,
        flow,
        attributes: 'in : VertexInput',
        varyings: '',
        returnType: 'VertexOutput',
        inputStruct,
        outputStruct,
    };
}

function buildFragmentShaderData(state: CompilerState): FragmentShaderData {
    const varyingList = [...state.varyings.values()];
    const hasVaryings = varyingList.length > 0;

    const slots = state.input.kind === 'render' ? state.input.slots : null;
    const maskRoot = slots?.mask;
    const depthRoot = slots?.depth;
    const hasDepth = depthRoot !== undefined;
    const colorRoot = slots?.color ?? null;

    const isMRT = colorRoot instanceof OutputStructNode;
    const mrtNode = isMRT ? colorRoot as OutputStructNode : null;

    // Build FragmentInput struct
    let inputStruct = '';
    if (hasVaryings) {
        const inputLines: string[] = [`struct FragmentInput {`];
        for (const v of varyingList) {
            inputLines.push(`    @location(${v.location}) ${v.name} : ${v.type},`);
        }
        inputLines.push(`}`);
        inputStruct = inputLines.join('\n');
    }

    const needsOutputStruct = isMRT || hasDepth;

    // Build FragmentOutput struct
    let outputStruct = '';
    if (needsOutputStruct) {
        const outputLines: string[] = [`struct FragmentOutput {`];
        if (isMRT && mrtNode) {
            for (let i = 0; i < mrtNode.members.length; i++) {
                const member = mrtNode.members[i];
                if (!member) continue;
                const name = (mrtNode instanceof MRTNode && mrtNode._resolvedNames[i])
                    ? mrtNode._resolvedNames[i]
                    : `output${i}`;
                outputLines.push(`    @location(${i}) ${name} : vec4f,`);
            }
        } else {
            outputLines.push(`    @location(0) color : vec4f,`);
        }
        if (hasDepth) {
            outputLines.push(`    @builtin(frag_depth) frag_depth : f32,`);
        }
        outputLines.push(`}`);
        outputStruct = outputLines.join('\n');
    }

    // Build vars
    const vars = getVars(state, 'fragment') ?? '';

    // Build flow
    const flowLines: string[] = [];

    if (maskRoot) {
        const maskFlowData = state.flowResults.get(maskRoot);
        if (maskFlowData) {
            if (maskFlowData.code) flowLines.push(maskFlowData.code.replace(/\n$/, ''));
            flowLines.push(`    if (!(${maskFlowData.result})) { discard; }`);
        }
    }

    if (colorRoot) {
        if (isMRT && mrtNode) {
            flowLines.push(`    var _out : FragmentOutput;`);

            for (let i = 0; i < mrtNode.members.length; i++) {
                const member = mrtNode.members[i];
                if (!member) continue;

                const memberFlow = flowChildNode(state, member);
                if (memberFlow.code) flowLines.push(memberFlow.code.replace(/\n$/, ''));

                const name = (mrtNode instanceof MRTNode && mrtNode._resolvedNames[i])
                    ? mrtNode._resolvedNames[i]
                    : `output${i}`;
                flowLines.push(`    _out.${name} = ${memberFlow.result};`);
            }

            if (hasDepth && depthRoot) {
                const depthFlowData = state.flowResults.get(depthRoot);
                if (depthFlowData) {
                    if (depthFlowData.code) flowLines.push(depthFlowData.code.replace(/\n$/, ''));
                    flowLines.push(`    _out.frag_depth = ${depthFlowData.result};`);
                }
            }

            flowLines.push(`    return _out;`);
        } else {
            const flowData = state.flowResults.get(colorRoot);
            if (flowData) {
                if (flowData.code) flowLines.push(flowData.code.replace(/\n$/, ''));

                if (hasDepth) {
                    const depthFlowData = state.flowResults.get(depthRoot!);
                    flowLines.push(`    var _out : FragmentOutput;`);
                    flowLines.push(`    _out.color = ${flowData.result};`);
                    if (depthFlowData) {
                        if (depthFlowData.code) flowLines.push(depthFlowData.code.replace(/\n$/, ''));
                        flowLines.push(`    _out.frag_depth = ${depthFlowData.result};`);
                    }
                    flowLines.push(`    return _out;`);
                } else {
                    flowLines.push(`    return ${flowData.result};`);
                }
            }
        }
    }

    const flow = flowLines.join('\n');

    const returnType = needsOutputStruct ? 'FragmentOutput' : '@location(0) vec4f';
    const varyingsParam = hasVaryings ? 'in : FragmentInput' : '';

    return {
        structs: '',
        uniforms: '',
        codes: '',
        vars,
        flow,
        attributes: '',
        varyings: varyingsParam,
        returnType,
        inputStruct,
        outputStruct,
    };
}

function buildUniformGroupBlock(
    groupNode: UniformGroupNode,
    nodes: UniformNode<WgslType>[],
    groupIndex: number,
    binding: number,
): UniformGroupBlock {
    const members: UniformMember[] = [];
    let offset = 0;
    for (const n of nodes) {
        const align = std140Align(n.type);
        const size = std140Size(n.type);
        offset = alignUp(offset, align);
        members.push({ uniformId: n.name, type: n.type, offset, size, node: n });
        offset += size;
    }
    const totalBytes = alignUp(offset, 16);
    return {
        groupName: groupNode.name,
        groupIndex,
        binding,
        shared: groupNode.shared,
        members,
        totalBytes,
        groupNode,
    };
}

function getWGSLVertexCode(shaderData: VertexShaderData): string {
    const varsSection = shaderData.vars ? `\n${shaderData.vars}` : '';
    const flowSection = shaderData.flow ? `\n${shaderData.flow}` : '';

    return `${shaderData.inputStruct}

${shaderData.outputStruct}

@vertex
fn vs_main(${shaderData.attributes}) -> ${shaderData.returnType} {
    var out : ${shaderData.returnType};${varsSection}${flowSection}
    return out;
}`;
}

function getWGSLFragmentCode(shaderData: FragmentShaderData): string {
    const inputStructSection = shaderData.inputStruct ? `${shaderData.inputStruct}\n\n` : '';
    const outputStructSection = shaderData.outputStruct ? `${shaderData.outputStruct}\n\n` : '';
    const varsSection = shaderData.vars ? `\n${shaderData.vars}` : '';
    const flowSection = shaderData.flow ? `\n${shaderData.flow}` : '';

    return `${inputStructSection}${outputStructSection}@fragment
fn fs_main(${shaderData.varyings}) -> ${shaderData.returnType} {${varsSection}${flowSection}
}`;
}

function buildComputeShaderData(state: CompilerState): ComputeShaderData {
    if (state.input.kind !== 'compute') throw new Error('buildComputeShaderData called on render state');

    // Build builtin params
    const paramParts: string[] = [];
    for (const [kind, info] of Object.entries(COMPUTE_BUILTIN_PARAM)) {
        if (state.builtinsUsed.has(kind)) {
            paramParts.push(`    @builtin(${info.attr}) ${kind} : ${info.type}`);
        }
    }
    const builtinParams = paramParts.length > 0 ? '\n' + paramParts.join(',\n') + '\n' : '';

    // Build vars
    const vars = getVars(state, 'compute') ?? '';

    // Build flow
    const flowLines: string[] = [];
    const bodyRoot = state.flowNodes.compute[0];
    if (bodyRoot) {
        const flowData = state.flowResults.get(bodyRoot);
        if (flowData?.code) {
            flowLines.push(flowData.code.replace(/\n$/, ''));
        }
    }
    const flow = flowLines.join('\n');

    return {
        structs: '',
        uniforms: '',
        codes: '',
        vars,
        flow,
        attributes: '',
        varyings: '',
        returnType: '',
        workgroupSize: state.input.node.workgroupSize,
        builtinParams,
    };
}

function getWGSLComputeCode(shaderData: ComputeShaderData): string {
    const [wx, wy, wz] = shaderData.workgroupSize;
    const varsSection = shaderData.vars ? `\n${shaderData.vars}` : '';
    const flowSection = shaderData.flow ? `\n${shaderData.flow}` : '';

    return `@compute @workgroup_size(${wx}, ${wy}, ${wz})
fn cs_main(${shaderData.builtinParams}) {${varsSection}${flowSection}
}`;
}

function buildCode(state: CompilerState): void {
    // Sort bind groups by groupNode.order
    sortBindingGroups(state);
    const bindGroups = getBindings(state);

    // Build entries from bind groups
    const uniformGroupBlocks: UniformGroupBlock[] = [];
    const storageEntries: StorageEntry[] = [];
    const computeStorageEntries: ComputeStorageEntry[] = [];
    const textureEntries: TextureEntry[] = [];
    const samplerEntries: SamplerEntry[] = [];

    for (const group of bindGroups) {
        const groupIndex = group.index;
        let bindingIndex = 0;

        const uniformsInGroup: UniformNode<WgslType>[] = [];

        for (const entry of group.bindings) {
            if (entry.type === 'uniform' && entry.uniforms) {
                uniformsInGroup.push(...entry.uniforms);
                bindingIndex++;
            } else if (entry.type === 'storage') {
                const storageNode = entry.node as StorageNode<WgslType>;
                if (state.input.kind === 'render') {
                    storageEntries.push({
                        node: storageNode,
                        name: entry.name,
                        type: storageNode.storageType,
                        access: storageNode.access,
                        group: groupIndex as 0 | 1,
                        binding: bindingIndex,
                    });
                } else {
                    computeStorageEntries.push({
                        node: storageNode,
                        name: entry.name,
                        type: storageNode.storageType,
                        access: storageNode.access,
                        group: groupIndex,
                        binding: bindingIndex,
                    });
                }
                bindingIndex++;
            } else if (entry.type === 'texture') {
                const textureNode = entry.node as TextureNode;
                textureEntries.push({
                    textureId: entry.name,
                    type: textureNode.textureType,
                    group: groupIndex as 0 | 1,
                    binding: bindingIndex,
                    node: textureNode,
                });
                bindingIndex++;
            } else if (entry.type === 'sampler') {
                const textureNode = entry.node as TextureNode;
                samplerEntries.push({
                    samplerId: entry.name,
                    type: 'sampler',
                    group: groupIndex as 0 | 1,
                    binding: bindingIndex,
                    textureNode,
                });
                bindingIndex++;
            }
        }

        if (uniformsInGroup.length > 0) {
            const block = buildUniformGroupBlock(group.groupNode, uniformsInGroup, groupIndex, 0);
            uniformGroupBlocks.push(block);
        }
    }

    // Build shader preamble
    const structs = getStructs(state);
    const bindings = emitBindingsWGSL(state);
    const codes = getCodes(state);
    const preamble = [structs, bindings, codes].filter(s => s).join('\n\n');

    // Generate stage-specific code
    if (state.input.kind === 'render') {
        const vertexShaderData = buildVertexShaderData(state);
        const fragmentShaderData = buildFragmentShaderData(state);

        const vertexCode = getWGSLVertexCode(vertexShaderData);
        const fragmentCode = getWGSLFragmentCode(fragmentShaderData);

        const code = [preamble, vertexCode, fragmentCode].filter(s => s).join('\n\n');

        const attributes: AttributeEntry[] = [
            ...[...state.attributes.values()],
            ...state.bufferAttrs,
        ];
        const varyings = [...state.varyings.values()];

        // Legacy uniforms array
        const objectGroup = uniformGroupBlocks.find(g => g.groupNode.name === 'object');
        const legacyMaterialUniforms = objectGroup
            ? objectGroup.members.filter(m =>
                m.uniformId !== 'modelWorldMatrix' && m.uniformId !== 'modelNormalMatrix')
            : [];
        const legacyUniformBlockEntry: UniformBlockEntry | null = legacyMaterialUniforms.length > 0
            ? { group: 1, binding: 0, members: legacyMaterialUniforms, totalBytes: objectGroup!.totalBytes }
            : null;

        state.renderResult = {
            code,
            attributes,
            varyings,
            uniforms: legacyUniformBlockEntry ? [legacyUniformBlockEntry] : [],
            uniformGroups: uniformGroupBlocks,
            storage: storageEntries,
            textures: textureEntries,
            samplers: samplerEntries,
            builtinsUsed: new Set(state.builtinsUsed),
            updateBeforeNodes: state.updateBeforeNodes,
            updateAfterNodes: state.updateAfterNodes,
            updateNodes: state.updateNodes,
            inspectableNodes: [...state.allNodes.values()].filter(n => n._isInspectable),
        };
    } else {
        const computeShaderData = buildComputeShaderData(state);
        const computeCode = getWGSLComputeCode(computeShaderData);
        const code = [preamble, computeCode].filter(s => s).join('\n\n');

        state.computeResult = {
            code,
            storage: computeStorageEntries,
            workgroupSize: state.input.node.workgroupSize,
            builtinsUsed: new Set(state.builtinsUsed),
            uniformGroups: uniformGroupBlocks,
        };
    }
}

function findVaryingNodeByName(state: CompilerState, name: string): VaryingNode<WgslType> | null {
    for (const node of state.allNodes.values()) {
        if (node.kind === 'varying') {
            const vn = node as VaryingNode<WgslType>;
            if (vn.name === name) return vn;
        }
    }
    return null;
}

const compilerDefs: Record<NodeKind, NodeCompilerDef> = {
    const: {
        isStatement: false, isLeaf: true,
        setup: null,
        generate: (node: ConstNode<WgslType>, _state: CompilerState) => constLiteral(node.type, node.value),
    },
    uniform: {
        isStatement: false, isLeaf: true,
        setup: (node: UniformNode<WgslType>, state: CompilerState) => {
            const groupName = node.groupNode.name;
            const shaderStage = state.shaderStage ?? 'vertex';
            const bindings = getBindGroupArray(state, groupName, shaderStage);

            let uniformEntry = state.uniformGroups[groupName];
            if (uniformEntry === undefined) {
                uniformEntry = {
                    type: 'uniform',
                    name: groupName,
                    groupNode: node.groupNode,
                    node: node,
                    uniforms: [],
                };
                state.uniformGroups[groupName] = uniformEntry;
            }

            if (!bindings.includes(uniformEntry)) {
                bindings.push(uniformEntry);
            }

            if (!uniformEntry.uniforms!.some((n: UniformNode<WgslType>) => n.name === node.name)) {
                uniformEntry.uniforms!.push(node);
            }

            const uniformDef = lookupStructDefByName(node.type);
            if (uniformDef) registerStructDef(state, uniformDef);
        },
        generate: (node: UniformNode<WgslType>, _state: CompilerState) =>
            `${node.groupNode.name}.${node.name}`,
    },
    attribute: {
        isStatement: false, isLeaf: true,
        setup: (node: AttributeNode<WgslType>, state: CompilerState) => {
            if (!state.attributes.has(node.name)) {
                const totalLoc = state.attributes.size + state.bufferAttrs.length;
                state.attributes.set(node.name, { kind: 'geometry', name: node.name, type: node.type, location: totalLoc });
            }
        },
        generate: (node: AttributeNode<WgslType>, _state: CompilerState) => `in.${node.name}`,
    },
    buffer_attribute: {
        isStatement: false, isLeaf: true,
        setup: (node: BufferAttributeNode<WgslType>, state: CompilerState) => {
            if (!state.bufferAttrNames.has(node.id)) {
                const totalLoc = state.attributes.size + state.bufferAttrs.length;
                const name = `_buf${state.bufferAttrs.length}`;
                state.bufferAttrNames.set(node.id, name);
                state.bufferAttrs.push({ kind: 'buffer', node: node as unknown as BufferAttributeNode<WgslType>, name, type: node.type, location: totalLoc });
            }
        },
        generate: (node: BufferAttributeNode<WgslType>, state: CompilerState) => {
            const name = state.bufferAttrNames.get(node.id);
            return name ? `in.${name}` : `/* missing buffer attr ${node.id} */`;
        },
    },
    storage: {
        isStatement: false, isLeaf: true,
        setup: (node: StorageNode<WgslType>, state: CompilerState) => {
            const groupName = node.groupNode.name;
            const shaderStage = state.shaderStage ?? 'compute';
            const bindings = getBindGroupArray(state, groupName, shaderStage);

            let storEntry = state.storageBindings[node.id];
            if (storEntry === undefined) {
                const existingStorageCount = Object.keys(state.storageBindings).length;
                const name = `_stor${existingStorageCount}`;
                state.storageNames.set(node.id, name);

                storEntry = {
                    type: 'storage',
                    name,
                    groupNode: node.groupNode,
                    node: node,
                };
                state.storageBindings[node.id] = storEntry;

                const storageDef = lookupStructDefByName(node.type);
                if (storageDef) registerStructDef(state, storageDef);
            }

            if (!bindings.includes(storEntry)) {
                bindings.push(storEntry);
            }
        },
        generate: (node: StorageNode<WgslType>, state: CompilerState) => state.storageNames.get(node.id) ?? node.id,
    },
    texture: {
        isStatement: false, isLeaf: false,
        setup: (node: TextureNode, state: CompilerState) => {
            const base = node.referenceNode ?? node;
            const key = String(base.textureId);

            const groupName = base.groupNode.name;
            const shaderStage = state.shaderStage ?? 'fragment';
            const bindings = getBindGroupArray(state, groupName, shaderStage);

            if (base instanceof PassMultipleTextureNode) {
                base.updateTexture();
                const passNode = base.passNode;
                if (passNode.updateBeforeType !== 'none') {
                    state.sequentialNodes.add(passNode);
                }
            }

            let texEntry = state.textureBindings[key];
            if (texEntry === undefined) {
                texEntry = {
                    type: 'texture',
                    name: key,
                    groupNode: base.groupNode,
                    node: base,
                };
                state.textureBindings[key] = texEntry;
            }

            if (!bindings.includes(texEntry)) {
                bindings.push(texEntry);
            }

            let sampEntry = state.samplerBindings[key];
            if (sampEntry === undefined) {
                sampEntry = {
                    type: 'sampler',
                    name: key,
                    groupNode: base.groupNode,
                    node: base,
                };
                state.samplerBindings[key] = sampEntry;
            }

            if (!bindings.includes(sampEntry)) {
                bindings.push(sampEntry);
            }
        },
        generate: (node: TextureNode, state: CompilerState, output?: string) => {
            const base = node.referenceNode ?? node;
            
            if (output !== undefined && /^sampler/.test(output)) {
                return `${base.textureId}_samp`;
            }
            
            const texName = `${base.textureId}_tex`;
            const sampName = `${base.textureId}_samp`;
            
            const uvExpr = node.uvNode ? generateNode(state, node.uvNode) : 'in.uv';
            
            return `textureSample(${texName}, ${sampName}, ${uvExpr})`;
        },
    },
    convert: {
        isStatement: false, isLeaf: false,
        setup: (node: ConvertNode, state: CompilerState) => {
            setupNode(state, node.node);
        },
        generate: (node: ConvertNode, state: CompilerState) => {
            const type = node.convertTo;
            const snippet = generateNode(state, node.node, type);
            return snippet;
        },
    },
    varying: {
        isStatement: false, isLeaf: true,
        setup: (node: VaryingNode<WgslType>, state: CompilerState) => {
            if (!state.varyings.has(node.name)) {
                state.varyings.set(node.name, { name: node.name, type: node.type, location: state.varyings.size });
            }
            setupNode(state, node.source);
        },
        generate: (node: VaryingNode<WgslType>, state: CompilerState) => {
            if (state.shaderStage === 'fragment') {
                const varyingData = getDataFromNode(state, node as unknown as Node<WgslType>, 'fragment');
                if (varyingData.propertyName === undefined) {
                    flowNodeFromShaderStage(state, 'vertex', node.source);
                    varyingData.propertyName = `in.${node.name}`;
                }
                return `in.${node.name}`;
            }
            return `in.${node.name}`;
        },
    },
    binop: {
        isStatement: false, isLeaf: false,
        setup: null,
        generate: (node: BinopNode<WgslType>, state: CompilerState) => {
            const l = generateNode(state, node.left) ?? '/* missing */';
            const r = generateNode(state, node.right) ?? '/* missing */';
            return `(${l} ${node.op} ${r})`;
        },
    },
    call: {
        isStatement: false, isLeaf: false,
        setup: (node: CallNode<WgslType>, state: CompilerState) => {
            if (node.fnNode) {
                setupCallNodeFn(state, node.fnNode);
            }
        },
        generate: (node: CallNode<WgslType>, state: CompilerState) => {
            const argExprs = node.args.map((a) => generateNode(state, a) ?? '/* missing */');
            if (node.fn === 'negate' && argExprs.length === 1) return `(-${argExprs[0]})`;
            if ((node.fn === 'f32' || node.fn === 'i32' || node.fn === 'u32') && argExprs.length === 1) {
                return `${node.fn}(${argExprs[0]})`;
            }
            return `${node.fn}(${argExprs.join(', ')})`;
        },
    },
    raw: {
        isStatement: false, isLeaf: false,
        setup: null,
        generate: (node: RawNode<WgslType>, state: CompilerState) => {
            const depExprs = node.deps.map((d) => generateNode(state, d) ?? '/* missing */');
            return node.wgsl.replace(/\$(\d+)(?:_(\w+))?/g, (_, idx, suffix) => {
                const dep = depExprs[parseInt(idx, 10)];
                if (!dep) return `/* dep${idx}${suffix ? '_' + suffix : ''} */`;
                return suffix ? `${dep}_${suffix}` : dep;
            });
        },
    },
    assign: {
        isStatement: true, isLeaf: false,
        setup: null,
        generate: (node: AssignNode, state: CompilerState) => {
            const tgt = generateNode(state, node.target) ?? '/* missing */';
            const val = generateNode(state, node.value) ?? '/* missing */';
            addLineFlowCode(state, `${tgt} = ${val}`);
            return null;
        },
    },
    construct: {
        isStatement: false, isLeaf: false,
        setup: null,
        generate: (node: ConstructNode<WgslType>, state: CompilerState) => {
            const argExprs = node.args.map((a) => generateNode(state, a) ?? '/* missing */');
            return `${node.type}(${argExprs.join(', ')})`;
        },
    },
    struct: {
        isStatement: false, isLeaf: true,
        setup: (node: StructNode, state: CompilerState) => {
            const def = lookupStructDef(node);
            if (def) {
                registerStructDef(state, def);
            } else if (!state.structNodes.has(node.type)) {
                state.structNodes.set(node.type, node);
            }
        },
        generate: (node: StructNode, _state: CompilerState) => `/* struct ${node.type} */`,
    },
    field: {
        isStatement: false, isLeaf: false,
        setup: null,
        generate: (node: FieldNode<WgslType>, state: CompilerState) => {
            const obj = generateNode(state, node.object) ?? '/* missing */';
            return `${obj}.${node.fieldName}`;
        },
    },
    index: {
        isStatement: false, isLeaf: false,
        setup: null,
        generate: (node: IndexNode<WgslType>, state: CompilerState) => {
            const arr = generateNode(state, node.array) ?? '/* missing */';
            const idx = generateNode(state, node.index) ?? '/* missing */';
            return `${arr}[${idx}]`;
        },
    },
    builtin: {
        isStatement: false, isLeaf: true,
        setup: (node: BuiltinNode<WgslType>, state: CompilerState) => {
            state.builtinsUsed.add(node.builtinKind);
        },
        generate: (node: BuiltinNode<WgslType>, state: CompilerState) => {
            const BUILTIN_VAR: Record<string, string> = {
                instance_index: 'instance_index',
                instance_data:  'instanceData',
                vertex_index:   'vertex_index',
            };
            const BUILTIN_VERTEX_INPUT = new Set(['instance_index', 'vertex_index']);
            if (state.shaderStage === 'compute') {
                return BUILTIN_VAR[node.builtinKind] ?? node.builtinKind;
            }
            if (BUILTIN_VERTEX_INPUT.has(node.builtinKind)) return `in.${BUILTIN_VAR[node.builtinKind] ?? node.builtinKind}`;
            return BUILTIN_VAR[node.builtinKind] ?? node.builtinKind;
        },
    },
    stack: {
        isStatement: true, isLeaf: false,
        setup: null,
        generate: (node: StackNode, state: CompilerState) => {
            for (const stmt of node.body) {
                buildNode(state, stmt);
            }
            return null;
        },
    },
    cond: {
        isStatement: false, isLeaf: false,
        setup: null,
        generate: (node: CondNode<WgslType>, state: CompilerState) => {
            const condExpr = generateNode(state, node.condition) ?? '/* missing */';
            const trueExpr = generateNode(state, node.ifTrue) ?? '/* missing */';
            const falseExpr = node.ifFalse
                ? generateNode(state, node.ifFalse) ?? '/* missing */'
                : `${node.type}()`;
            return `select(${falseExpr}, ${trueExpr}, ${condExpr})`;
        },
    },
    var: {
        isStatement: true, isLeaf: false,
        setup: null,
        generate: (node: VarNode<WgslType>, state: CompilerState) => {
            const name = getVarFromNode(state, node as unknown as Node<WgslType>, node.varName, node.type);
            const initExpr = generateNode(state, node.init) ?? '/* missing */';
            addLineFlowCode(state, `${name} = ${initExpr}`);
            return name;
        },
    },
    if: {
        isStatement: true, isLeaf: false,
        setup: null,
        generate: (node: IfNode, state: CompilerState) => {
            const condExpr = generateNode(state, node.condition) ?? '/* missing */';
            addFlowCode(state, `    if (${condExpr}) {\n`);
            emitStackIntoFlow(state, node.thenBody, '        ');
            if (node.elseBody) {
                addFlowCode(state, `    } else {\n`);
                emitStackIntoFlow(state, node.elseBody, '        ');
            }
            addFlowCode(state, `    }\n`);
            return null;
        },
    },
    for: {
        isStatement: true, isLeaf: false,
        setup: null,
        generate: (node: ForNode, state: CompilerState) => {
            const iName = `i_${state.forCounter++}`;
            const idxData = getDataFromNode(state, node.indexVar as unknown as Node<WgslType>);
            idxData.propertyName = iName;
            const getScalarExpr = (v: Node<WgslType> | number, _type: ScalarType) =>
                typeof v === 'number'
                    ? constLiteral(_type, v)
                    : generateNode(state, v as Node<WgslType>) ?? '/* missing */';
            const header = buildForHeader(node.range, iName, getScalarExpr);
            addFlowCode(state, `    ${header} {\n`);
            emitStackIntoFlow(state, node.body, '        ');
            addFlowCode(state, `    }\n`);
            return null;
        },
    },
    while: {
        isStatement: true, isLeaf: false,
        setup: null,
        generate: (node: WhileNode, state: CompilerState) => {
            const condExpr = generateNode(state, node.condition) ?? '/* missing */';
            addFlowCode(state, `    while (${condExpr}) {\n`);
            emitStackIntoFlow(state, node.body, '        ');
            addFlowCode(state, `    }\n`);
            return null;
        },
    },
    break: {
        isStatement: true, isLeaf: false,
        setup: null,
        generate: (_node: BreakNode, state: CompilerState) => {
            addLineFlowCode(state, 'break');
            return null;
        },
    },
    continue: {
        isStatement: true, isLeaf: false,
        setup: null,
        generate: (_node: ContinueNode, state: CompilerState) => {
            addLineFlowCode(state, 'continue');
            return null;
        },
    },
    fn: {
        isStatement: false, isLeaf: true,
        setup: null,
        generate: (node: FnNode<WgslType>, _state: CompilerState) => `/* fn ${node.type} */`,
    },
    param: {
        isStatement: false, isLeaf: true,
        setup: null,
        generate: (node: ParamNode<WgslType>, _state: CompilerState) => node.paramName ?? `p${node.paramIndex}`,
    },
    return: {
        isStatement: true, isLeaf: false,
        setup: null,
        generate: (node: ReturnNode<WgslType>, state: CompilerState) => {
            const valExpr = generateNode(state, node.value) ?? '/* missing */';
            addLineFlowCode(state, `return ${valExpr}`);
            return null;
        },
    },
    output_struct: {
        isStatement: false, isLeaf: false,
        setup: (node: OutputStructNode, state: CompilerState) => {
            for (const member of node.members) {
                if (member) setupNode(state, member);
            }
        },
        generate: (node: OutputStructNode, _state: CompilerState) => {
            return `/* output_struct ${node.id} */`;
        },
    },
} as unknown as Record<NodeKind, NodeCompilerDef>;

/* std140 layout helpers */

function std140Size(type: string): number {
    switch (type) {
        case 'f32': case 'i32': case 'u32': case 'bool': return 4;
        case 'vec2f': case 'vec2i': case 'vec2u': case 'vec2<bool>': return 8;
        case 'vec3f': case 'vec3i': case 'vec3u': case 'vec3<bool>': return 12;
        case 'vec4f': case 'vec4i': case 'vec4u': case 'vec4<bool>': return 16;
        case 'mat2x2f': return 32;
        case 'mat2x3f': case 'mat2x4f': return 32;
        case 'mat3x2f': return 48;
        case 'mat3x3f': case 'mat3x4f': return 48;
        case 'mat4x2f': return 64;
        case 'mat4x3f': case 'mat4x4f': return 64;
        default: return 16;
    }
}

function std140Align(type: string): number {
    switch (type) {
        case 'f32': case 'i32': case 'u32': case 'bool': return 4;
        case 'vec2f': case 'vec2i': case 'vec2u': case 'vec2<bool>': return 8;
        case 'vec3f': case 'vec3i': case 'vec3u': case 'vec3<bool>': return 16;
        case 'vec4f': case 'vec4i': case 'vec4u': case 'vec4<bool>': return 16;
        default: return 16;
    }
}

function alignUp(offset: number, align: number): number {
    return Math.ceil(offset / align) * align;
}
