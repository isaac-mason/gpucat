/**
 * compile.ts — Node graph → WGSL + binding metadata.
 *
 * Exports two pure entry-point functions:
 *   compile(slots)      → CompileResult        (render: vertex + fragment)
 *   compileCompute(node) → ComputeCompileResult (compute)
 *
 * Both functions create a single WgslBuilder internally. The builder follows
 * three NodeBuilder's three-pass architecture (setup → analyze → generate)
 * and its WeakMap-based per-node state model (getDataFromNode).
 *
 * Architecture
 * ------------
 * Three-pass build:
 *   Setup   — walk from root nodes, collect FnNodes, StructNodes, register
 *             resource bindings (uniforms, storage, textures, samplers,
 *             attributes, varyings). Replaces collectGraph()+collectResources().
 *   Analyze — walk all nodes, call increaseUsage(node) for each reference
 *             encountered, stored in getDataFromNode(node).usageCount. Replaces
 *             the separate refCount() pass.
 *   Generate — call _generateNodeExpr(root) per root. CSE: when usageCount > 1,
 *              emit `let _v0 = expr;` via addLineFlowCode, cache name in
 *              nodeData.propertyName. Replaces emitGraphStmts()+letBindings map.
 *
 * Key aligned patterns from three NodeBuilder:
 *   getDataFromNode(node, stage?)  — WeakMap<Node, NodeData> per-node-per-stage
 *   increaseUsage(node)            — called in analyze pass, replaces refCount()
 *   flow / addLineFlowCode         — code accumulation buffer
 *   flowChildNode / flowNodeFromShaderStage — for VaryingNode vertex-stage emit
 *   _buildNode(node)               — single dispatch entry (parallel to node.build(builder))
 *
 * What is NOT adopted from three:
 *   - No node.setup()/analyze()/generate() methods on node classes
 *   - No topo-sort (recursive generate visits children before parents naturally)
 *   - No open class hierarchy — the switch(node.kind) visitor stays exhaustive
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
    type NodeUpdateTypeValue,
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

/**
 * Controls how often a node's update method is called.
 *
 * Re-exported as a type alias for compatibility with UpdateBeforeNode/UpdateAfterNode interfaces.
 * The canonical NodeUpdateType constant lives in nodes.ts.
 */
export type NodeUpdateType = NodeUpdateTypeValue;

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
    /** Mirrors three Node.update(frame) — single argument. Returns false to cancel/revert. */
    update(frame: RenderFrame): boolean | void;
}

// ---------------------------------------------------------------------------
// Public types — render
// ---------------------------------------------------------------------------

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

/**
 * A struct-based uniform buffer block for a UniformGroupNode.
 * Three.js equivalent: NodeUniformsGroup + struct emission in WGSLNodeBuilder.
 */
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
    /**
     * The TextureNode this sampler is derived from (Three.js pattern).
     * The renderer gets the GPUSampler from textureNode.gpuSampler.
     * This replaces the old SamplerNode reference.
     */
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
    /**
     * Ordered list of nodes whose updateBefore() must run before the composite quad.
     * Post-order (dependencies first). Dedup granularity controlled by updateBeforeType.
     * Three equivalent: NodeBuilderState.updateBeforeNodes.
     */
    updateBeforeNodes: UpdateBeforeNode[];
    /**
     * Ordered list of nodes whose updateAfter() must run after each draw pass.
     * Post-order (dependencies first). Dedup granularity controlled by updateAfterType.
     * Three equivalent: NodeBuilderState.updateAfterNodes.
     */
    updateAfterNodes: UpdateAfterNode[];
    /**
     * Ordered list of nodes whose update() must run to push CPU→GPU uniform data.
     * Dedup granularity controlled by updateType.
     * Three equivalent: NodeBuilderState.updateNodes (sourced from builder.nodes).
     */
    updateNodes: UpdateNode[];
    /**
     * Nodes marked with .inspect() found in this compile unit.
     * The renderer passes these to inspector.inspect() each frame.
     */
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

// ---------------------------------------------------------------------------
// Public types — compute
// ---------------------------------------------------------------------------

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
 * Three.js pattern: NodeUniformsGroup, NodeSampler, NodeSampledTexture, NodeStorageBuffer
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
 * Three.js pattern: BindGroup class
 */
type BindGroup = {
    name: string;
    index: number;
    bindings: BindingEntry[];
    groupNode: UniformGroupNode;
};

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export function compile(slots: CompileSlots): CompileResult {
    const builder = new WgslBuilder({ kind: 'render', slots });
    builder.build();
    return builder.renderResult!;
}

export function compileCompute(node: ComputeNode): ComputeCompileResult {
    const builder = new WgslBuilder({ kind: 'compute', node });
    builder.build();
    return builder.computeResult!;
}

// Builtin WGSL variable names for render stage — used in _getWGSLVertexCode
const COMPUTE_BUILTIN_PARAM: Record<string, { attr: string; type: string }> = {
    global_invocation_id:   { attr: 'global_invocation_id',   type: 'vec3u' },
    local_invocation_id:    { attr: 'local_invocation_id',    type: 'vec3u' },
    local_invocation_index: { attr: 'local_invocation_index', type: 'u32'   },
    workgroup_id:           { attr: 'workgroup_id',           type: 'vec3u' },
    num_workgroups:         { attr: 'num_workgroups',         type: 'vec3u' },
};

// ---------------------------------------------------------------------------
// Per-node state types (aligned with three getDataFromNode)
// ---------------------------------------------------------------------------

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
    setup: ((node: NodeOf<K>, builder: WgslBuilder) => void) | null;
    generate: (node: NodeOf<K>, builder: WgslBuilder, output?: string) => string | null;
};

let compilerDefs: Record<NodeKind, NodeCompilerDef>;

type RenderInput = { kind: 'render'; slots: CompileSlots };
type ComputeInput = { kind: 'compute'; node: ComputeNode };

export class WgslBuilder {
    // Build stage cursor (parallel to three NodeBuilder.buildStage)
    buildStage: 'setup' | 'analyze' | 'generate' | null = null;
    // Shader stage cursor (parallel to three NodeBuilder.shaderStage)
    shaderStage: 'vertex' | 'fragment' | 'compute' | null = null;

    // Per-node WeakMap state (parallel to three NodeBuilder.nodeData)
    nodeData: WeakMap<Node<WgslType>, NodeData> = new WeakMap();

    // Current writable code buffer (parallel to three NodeBuilder.flow)
    flow: { code: string } = { code: '' };
    // Per-stage accumulated code (from flowChildNode calls)
    flowCode: Record<string, string> = { vertex: '', fragment: '', compute: '' };

    // CSE var counter
    varCounter = 0;
    // For-loop index counter
    forCounter = 0;

    // Per-stage var declaration registry (parallel to three this.vars[shaderStage])
    // Each entry: { name, type } — one per registered VarNode per stage.
    // Keyed by shaderStage string ('vertex'|'fragment'|'compute'|null→'fn').
    stageVars: Record<string, { name: string; type: string }[]> = {};

    // Root nodes per stage
    flowNodes: {
        vertex: Node<WgslType>[];
        fragment: Node<WgslType>[];
        compute: Node<WgslType>[];
    } = { vertex: [], fragment: [], compute: [] };

    // Accumulated flow results per root node (for buildCode)
    flowResults: Map<Node<WgslType>, { code: string; result: string | null }> = new Map();

    // Input
    input: RenderInput | ComputeInput;

    // Collected resources (render)
    attributes: Map<string, AttributeEntry & { kind: 'geometry' }> = new Map();
    bufferAttrs: Array<AttributeEntry & { kind: 'buffer' }> = [];
    bufferAttrNames: Map<string, string> = new Map();
    varyings: Map<string, VaryingEntry> = new Map();
    builtinsUsed: Set<string> = new Set();
    structNodes: Map<string, StructNode> = new Map();

    // -----------------------------------------------------------------------
    // Bindings system — Three.js aligned
    // All resources (uniforms, storage, textures, samplers) are tracked here.
    // -----------------------------------------------------------------------

    /**
     * Per-stage bindings keyed by groupName.
     * Three.js pattern: this.bindings[shaderStage][groupName] = array of bindings
     */
    bindings: {
        vertex: Record<string, BindingEntry[]>;
        fragment: Record<string, BindingEntry[]>;
        compute: Record<string, BindingEntry[]>;
    } = { vertex: {}, fragment: {}, compute: {} };

    /**
     * Tracks binding/group indices per groupName.
     * Three.js pattern: bindingsIndexes[groupName] = { binding, group }
     */
    bindingsIndexes: Record<string, { binding: number; group: number }> = {};

    /**
     * Cached bind groups after getBindings() is called.
     * Three.js pattern: populated by getBindings(), sorted by sortBindingGroups().
     */
    bindGroups: BindGroup[] | null = null;

    /**
     * Shared uniform binding entries keyed by groupName.
     * Three.js pattern: this.uniformGroups[groupName] = NodeUniformsGroup
     * A single BindingEntry is shared across all shader stages that use uniforms from this group.
     */
    uniformGroups: Record<string, BindingEntry> = {};

    /**
     * Shared texture binding entries keyed by textureId.
     * A single BindingEntry is shared across all shader stages that use this texture.
     */
    textureBindings: Record<string, BindingEntry> = {};

    /**
     * Shared sampler binding entries keyed by textureId.
     * A single BindingEntry is shared across all shader stages that use this sampler.
     */
    samplerBindings: Record<string, BindingEntry> = {};

    /**
     * Shared storage binding entries keyed by storage id.
     * A single BindingEntry is shared across all shader stages that use this storage buffer.
     */
    storageBindings: Record<string, BindingEntry> = {};

    // Legacy maps for name lookups during generate (will be populated from bindings)
    storageNames: Map<string, string> = new Map();

    fnNodes: Map<string, { fn: FnNode<WgslType>; traced: TracedFn }> = new Map();

    // All nodes seen (for expression lookup during generate)
    allNodes: Map<string, Node<WgslType>> = new Map();

    // Storage nodes inferred from compute trace (encounter order)
    _computeStorage: StorageNode<WgslType>[] = [];

    // Ordered lists of nodes needing lifecycle callbacks (post-order DFS).
    // Three equivalents: NodeBuilderState.updateBeforeNodes / updateAfterNodes / updateNodes.
    // _sequentialNodes mirrors three's builder.sequentialNodes (object-identity dedup set).
    // buildUpdateNodes() splits it into the three typed arrays (mirrors three buildUpdateNodes()).
    _sequentialNodes: Set<UpdateBeforeNode | UpdateAfterNode> = new Set();
    _updateBeforeNodes: UpdateBeforeNode[] = [];
    _updateAfterNodes:  UpdateAfterNode[]  = [];
    _updateNodes:       UpdateNode[]       = [];

    // Build results — populated by buildCode() (Three.js pattern)
    renderResult: CompileResult | null = null;
    computeResult: ComputeCompileResult | null = null;

    constructor(input: RenderInput | ComputeInput) {
        this.input = input;
    }

    // -----------------------------------------------------------------------
    // Top-level orchestrator: setup → analyze → generate → buildCode
    // (Parallel to three NodeBuilder.build())
    // -----------------------------------------------------------------------

    build(): this {
        this._registerRoots();

        // setup() -> stage 1: create possible new nodes and/or return an output reference node
        // analyze() -> stage 2: analyze nodes to possible optimization and validation
        // generate() -> stage 3: generate shader
        for (const stage of ['setup', 'analyze', 'generate'] as const) {
            this.buildStage = stage;
            const stages = this.input.kind === 'render'
                ? (['vertex', 'fragment'] as const)
                : (['compute'] as const);
            for (const shaderStage of stages) {
                this.shaderStage = shaderStage;
                for (const node of this.flowNodes[shaderStage]) {
                    if (stage === 'generate') {
                        const flowData = this.flowChildNode(node);
                        this.flowResults.set(node, flowData);
                    } else {
                        this._buildNode(node);
                    }
                }
            }
        }

        this.buildStage = null;
        this.shaderStage = null;

        // stage 4: build code for a specific output (Three.js pattern)
        this.buildCode();

        // Split _sequentialNodes into typed arrays (mirrors three buildUpdateNodes()).
        this._buildUpdateNodes();

        return this;
    }

    // -----------------------------------------------------------------------
    // buildCode — assemble final shader code (Three.js pattern)
    // Controls the code build of the shader stages.
    // Unified for both render and compute — mirrors Three.js WGSLNodeBuilder.buildCode()
    // -----------------------------------------------------------------------

    buildCode(): void {
        // ---------------------------------------------------------------------
        // Sort bind groups by groupNode.order — Three.js pattern
        // ---------------------------------------------------------------------
        this.sortBindingGroups();
        const bindGroups = this.getBindings();

        // ---------------------------------------------------------------------
        // Build entries from bind groups (shared by render and compute)
        // ---------------------------------------------------------------------
        const uniformGroups: UniformGroupBlock[] = [];
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
                    if (this.input.kind === 'render') {
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
                const block = this._buildUniformGroupBlock(group.groupNode, uniformsInGroup, groupIndex, 0);
                uniformGroups.push(block);
            }
        }

        // ---------------------------------------------------------------------
        // Build shader preamble — shared by all stages
        // ---------------------------------------------------------------------
        const structs = this.getStructs();
        const bindings = this._emitBindingsWGSL();
        const codes = this.getCodes();
        const preamble = [structs, bindings, codes].filter(s => s).join('\n\n');

        // ---------------------------------------------------------------------
        // Generate stage-specific code — Three.js pattern
        // ---------------------------------------------------------------------
        if (this.input.kind === 'render') {
            const vertexShaderData = this._buildVertexShaderData();
            const fragmentShaderData = this._buildFragmentShaderData();

            const vertexCode = this._getWGSLVertexCode(vertexShaderData);
            const fragmentCode = this._getWGSLFragmentCode(fragmentShaderData);

            const code = [preamble, vertexCode, fragmentCode].filter(s => s).join('\n\n');

            const attributes: AttributeEntry[] = [
                ...[...this.attributes.values()],
                ...this.bufferAttrs,
            ];
            const varyings = [...this.varyings.values()];

            // Legacy uniforms array
            const objectGroup = uniformGroups.find(g => g.groupNode.name === 'object');
            const legacyMaterialUniforms = objectGroup
                ? objectGroup.members.filter(m =>
                    m.uniformId !== 'modelWorldMatrix' && m.uniformId !== 'modelNormalMatrix')
                : [];
            const legacyUniformBlockEntry: UniformBlockEntry | null = legacyMaterialUniforms.length > 0
                ? { group: 1, binding: 0, members: legacyMaterialUniforms, totalBytes: objectGroup!.totalBytes }
                : null;

            this.renderResult = {
                code,
                attributes,
                varyings,
                uniforms: legacyUniformBlockEntry ? [legacyUniformBlockEntry] : [],
                uniformGroups,
                storage: storageEntries,
                textures: textureEntries,
                samplers: samplerEntries,
                builtinsUsed: new Set(this.builtinsUsed),
                updateBeforeNodes: this._updateBeforeNodes,
                updateAfterNodes: this._updateAfterNodes,
                updateNodes: this._updateNodes,
                inspectableNodes: [...this.allNodes.values()].filter(n => n._isInspectable),
            };
        } else {
            const computeShaderData = this._buildComputeShaderData();
            const computeCode = this._getWGSLComputeCode(computeShaderData);
            const code = [preamble, computeCode].filter(s => s).join('\n\n');

            this.computeResult = {
                code,
                storage: computeStorageEntries,
                workgroupSize: this.input.node.workgroupSize,
                builtinsUsed: new Set(this.builtinsUsed),
                uniformGroups,
            };
        }
    }

    // -----------------------------------------------------------------------
    // Register root nodes per stage
    // -----------------------------------------------------------------------

    private _registerRoots(): void {
        if (this.input.kind === 'render') {
            const { position, color, mask, depth } = this.input.slots;
            // Stage validation: fragment graph must not contain vertex-only nodes
            this._validateFragmentRoot(color);
            if (mask) this._validateFragmentRoot(mask);
            if (depth) this._validateFragmentRoot(depth);
            this.flowNodes.vertex.push(position);
            this.flowNodes.fragment.push(color);
            if (mask)  this.flowNodes.fragment.push(mask);
            if (depth) this.flowNodes.fragment.push(depth);
        } else {
            // Compute: trace Fn body, infer storage nodes from graph
            const { body, storage } = this.input.node.trace();
            this._computeStorage = storage;
            // Register storage nodes into allNodes so setup pass finds them
            for (const s of storage) {
                this.allNodes.set(s.id, s);
            }
            this.flowNodes.compute.push(body);
        }
    }

    private _validateFragmentRoot(root: Node<WgslType>): void {
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

    // -----------------------------------------------------------------------
    // getDataFromNode — WeakMap per-node-per-stage state
    // (Parallel to three NodeBuilder.getDataFromNode)
    // -----------------------------------------------------------------------

    getDataFromNode(node: Node<WgslType>, stage?: string): NodeStageData {
        const s = stage ?? this.shaderStage ?? 'any';
        let data = this.nodeData.get(node);
        if (!data) {
            data = {};
            this.nodeData.set(node, data);
        }
        const key = s as keyof NodeData;
        if (!data[key]) data[key] = {};
        return data[key]!;
    }

    // -----------------------------------------------------------------------
    // increaseUsage — called in analyze pass
    // (Parallel to three NodeBuilder.increaseUsage)
    // -----------------------------------------------------------------------

    increaseUsage(node: Node<WgslType>): number {
        const data = this.getDataFromNode(node);
        data.usageCount = (data.usageCount ?? 0) + 1;
        return data.usageCount;
    }

    // -----------------------------------------------------------------------
    // Flow accumulation helpers
    // (Parallel to three NodeBuilder.addLineFlowCode / addFlowCode)
    // -----------------------------------------------------------------------

    addLineFlowCode(code: string): void {
        this.flow.code += `    ${code};\n`;
    }

    addFlowCode(code: string): void {
        this.flow.code += code;
    }

    // -----------------------------------------------------------------------
    // getVarFromNode — register a VarNode's declaration into the per-stage
    // vars preamble dict. Deduplicates: safe to call multiple times for the
    // same node+stage — only the first call allocates and registers.
    // Returns the WGSL variable name (e.g. "nodeVar0" or the node's own varName).
    // (Parallel to three NodeBuilder.getVarFromNode)
    // -----------------------------------------------------------------------

    getVarFromNode(node: Node<WgslType>, varName: string, type: string): string {
        const stage = this.shaderStage ?? 'fn';
        const data = this.getDataFromNode(node, stage);

        if (data.varName === undefined) {
            // First registration for this node+stage: allocate into stageVars
            const vars = this.stageVars[stage] ?? (this.stageVars[stage] = []);
            vars.push({ name: varName, type });
            data.varName = varName;
        }

        return data.varName;
    }

    // -----------------------------------------------------------------------
    // getVars — serialize the per-stage vars dict to a WGSL declaration block.
    // Returns a string of "    var name : type;\n" lines (empty string if none).
    // (Parallel to three WGSLNodeBuilder.getVars)
    // -----------------------------------------------------------------------

    getVars(stage: string): string {
        const vars = this.stageVars[stage];
        if (!vars || vars.length === 0) return '';
        return vars.map((v) => `    var ${v.name} : ${v.type};`).join('\n') + '\n';
    }

    // -----------------------------------------------------------------------
    // Binding methods — Three.js aligned
    // -----------------------------------------------------------------------

    /**
     * Returns the bindings array for a group name and shader stage.
     * Creates the group if it doesn't exist.
     * Three.js pattern: NodeBuilder.getBindGroupArray()
     */
    getBindGroupArray(groupName: string, shaderStage: 'vertex' | 'fragment' | 'compute'): BindingEntry[] {
        const stageBindings = this.bindings[shaderStage];
        
        let bindGroup = stageBindings[groupName];
        
        if (bindGroup === undefined) {
            if (this.bindingsIndexes[groupName] === undefined) {
                this.bindingsIndexes[groupName] = {
                    binding: 0,
                    group: Object.keys(this.bindingsIndexes).length
                };
            }
            stageBindings[groupName] = bindGroup = [];
        }
        
        return bindGroup;
    }

    /**
     * Returns all bind groups merged from all shader stages.
     * Three.js pattern: NodeBuilder.getBindings()
     * 
     * Since uniform entries are shared objects (via uniformGroups), we use
     * includes() for deduplication - same object reference means same binding.
     */
    getBindings(): BindGroup[] {
        if (this.bindGroups !== null) {
            return this.bindGroups;
        }

        const groups: Record<string, BindingEntry[]> = {};
        const shaderStages = this.input.kind === 'render'
            ? ['vertex', 'fragment'] as const
            : ['compute'] as const;

        // Merge bindings from all stages
        // Three.js pattern: iterate all stages, use includes() for dedup
        for (const shaderStage of shaderStages) {
            const stageBindings = this.bindings[shaderStage];
            for (const groupName in stageBindings) {
                const bindings = stageBindings[groupName];
                const groupBindings = groups[groupName] || (groups[groupName] = []);
                
                for (const binding of bindings) {
                    // Three.js pattern: includes() works because we use shared object references
                    // for uniform entries (via uniformGroups cache)
                    if (!groupBindings.includes(binding)) {
                        groupBindings.push(binding);
                    }
                }
            }
        }

        // Create BindGroup objects
        const bindGroups: BindGroup[] = [];
        for (const groupName in groups) {
            const bindings = groups[groupName];
            if (bindings.length === 0) continue;
            
            bindGroups.push({
                name: groupName,
                index: this.bindingsIndexes[groupName]?.group ?? 0,
                bindings,
                groupNode: bindings[0].groupNode,
            });
        }

        this.bindGroups = bindGroups;
        return bindGroups;
    }

    /**
     * Sorts bind groups by groupNode.order and assigns final group indices.
     * Three.js pattern: NodeBuilder.sortBindingGroups()
     */
    sortBindingGroups(): void {
        const bindGroups = this.getBindings();
        
        // Sort by groupNode.order
        bindGroups.sort((a, b) => a.groupNode.order - b.groupNode.order);
        
        // Assign final group indices
        for (let i = 0; i < bindGroups.length; i++) {
            const bindGroup = bindGroups[i];
            this.bindingsIndexes[bindGroup.name].group = i;
            bindGroup.index = i;
        }
    }

    // -----------------------------------------------------------------------
    // flowChildNode — saves/installs/restores the flow buffer
    // (Parallel to three NodeBuilder.flowChildNode)
    // -----------------------------------------------------------------------

    flowChildNode(node: Node<WgslType>): { code: string; result: string | null } {
        const previousFlow = this.flow;
        this.flow = { code: '' };
        const result = this._buildNode(node);
        const flowData = { code: this.flow.code, result };
        this.flow = previousFlow;
        return flowData;
    }

    // -----------------------------------------------------------------------
    // flowNodeFromShaderStage — run a node in a different shader stage
    // Used by VaryingNode to compute vertex-side expressions from fragment context.
    // (Parallel to three NodeBuilder.flowNodeFromShaderStage)
    // -----------------------------------------------------------------------

    flowNodeFromShaderStage(
        stage: 'vertex' | 'fragment' | 'compute',
        node: Node<WgslType>,
        propertyName?: string,
    ): string | null {
        const previousStage = this.shaderStage;
        this.shaderStage = stage;
        const flowData = this.flowChildNode(node);
        // Append accumulated statements into the stage's preamble code
        if (propertyName && flowData.result !== null) {
            this.flowCode[stage] += `    ${propertyName} = ${flowData.result};\n`;
        }
        this.flowCode[stage] += flowData.code;
        this.shaderStage = previousStage;
        return flowData.result;
    }

    // -----------------------------------------------------------------------
    // _buildNode — single dispatch entry point
    // (Parallel to node.build(builder, output) in three)
    // -----------------------------------------------------------------------

    _buildNode(node: Node<WgslType>): string | null {
        if (this.buildStage === 'setup') {
            this._setupNode(node);
            return null;
        }
        if (this.buildStage === 'analyze') {
            this._analyzeNode(node);
            return null;
        }
        // Generate stage
        return this._generateNode(node);
    }

    // -----------------------------------------------------------------------
    // _buildUpdateNodes — split _sequentialNodes into typed arrays
    // Mirrors three NodeBuilder.buildUpdateNodes()
    // -----------------------------------------------------------------------

    _buildUpdateNodes(): void {
        for (const node of this._sequentialNodes) {
            if ('updateBeforeType' in node && (node as UpdateBeforeNode).updateBeforeType !== 'none') {
                this._updateBeforeNodes.push(node as UpdateBeforeNode);
            }
            if ('updateAfterType' in node && (node as UpdateAfterNode).updateAfterType !== 'none') {
                this._updateAfterNodes.push(node as UpdateAfterNode);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Setup pass — register resources, collect Fn/Struct nodes
    // -----------------------------------------------------------------------

    _setupNode(node: Node<WgslType>): void {
        const data = this.getDataFromNode(node, 'any');
        if (data.initialized) return;
        data.initialized = true;

        // Register node into allNodes for expression lookup
        if (!this.allNodes.has(node.id)) {
            this.allNodes.set(node.id, node);
        }

        // Visit children first (depth-first)
        for (const child of getChildren(node)) {
            this._setupNode(child);
        }

        // Delegate resource registration to compilerDefs
        compilerDefs[node.kind].setup?.(node as never, this);

        // Post-order: after children are set up, collect nodes needing lifecycle callbacks.
        // Mirrors three NodeBuilder.addSequentialNode() — object-identity dedup via Set.
        if ('updateBeforeType' in node) {
            const n = node as unknown as UpdateBeforeNode;
            if (n.updateBeforeType !== 'none') {
                this._sequentialNodes.add(n);
            }
        }
        if ('updateAfterType' in node) {
            const n = node as unknown as UpdateAfterNode;
            if (n.updateAfterType !== 'none') {
                this._sequentialNodes.add(n);
            }
        }
        // update() nodes go into a separate flat list (mirrors three builder.nodes → updateNodes)
        if ('updateType' in node) {
            const n = node as unknown as UpdateNode;
            if (n.updateType !== 'none' && !this._updateNodes.includes(n)) {
                this._updateNodes.push(n);
            }
        }
    }

    _setupFnNode(fn: FnNode<WgslType>): void {
        const data = this.getDataFromNode(fn as unknown as Node<WgslType>, 'any');
        if (data.initialized) return;
        data.initialized = true;

        const traced = fn.trace();
        this.fnNodes.set(fn.id, { fn, traced });

        // Register param nodes into allNodes
        for (const p of traced.params) {
            if (!this.allNodes.has(p.id)) this.allNodes.set(p.id, p);
        }

        // Walk the output expression graph
        const bodyGraph = collectGraph(traced.output);
        for (const [id, node] of bodyGraph.nodes) {
            if (!this.allNodes.has(id)) this.allNodes.set(id, node);
        }
        // Walk statement nodes
        const stackGraph = collectGraph(traced.body);
        for (const [id, node] of stackGraph.nodes) {
            if (!this.allNodes.has(id)) this.allNodes.set(id, node);
        }

        // Recurse into body to collect nested Fns and resources
        this._setupStackNode(traced.body);

        // Also recurse into the output expression
        for (const node of bodyGraph.nodes.values()) {
            if (node.kind === 'call') {
                const cn = node as CallNode<WgslType>;
                if (cn.fnNode && !this.fnNodes.has(cn.fnNode.id)) {
                    this._setupFnNode(cn.fnNode);
                }
            }
        }
    }

    private _setupStackNode(stack: Node<WgslType>): void {
        if (stack.kind !== 'stack') return;
        const s = stack as StackNode;
        for (const stmt of s.body) {
            this._setupNodeRecursive(stmt);
        }
    }

    private _setupNodeRecursive(node: Node<WgslType>): void {
        switch (node.kind) {
            case 'call': {
                const cn = node as CallNode<WgslType>;
                if (cn.fnNode && !this.fnNodes.has(cn.fnNode.id)) {
                    this._setupFnNode(cn.fnNode);
                }
                break;
            }
            case 'if': {
                const n = node as IfNode;
                this._setupStackNode(n.thenBody);
                if (n.elseBody) this._setupStackNode(n.elseBody);
                break;
            }
            case 'for': {
                const n = node as ForNode;
                this._setupStackNode(n.body);
                break;
            }
            case 'while': {
                const n = node as WhileNode;
                this._setupStackNode(n.body);
                break;
            }
            default:
                break;
        }
    }

    _registerStructDef(def: StructDef<StructSchema>): void {
        for (const nested of def.nestedDefs.values()) {
            this._registerStructDef(nested);
        }
        if (!this.structNodes.has(def.wgslType)) {
            this.structNodes.set(def.wgslType, def.node);
        }
    }

    // -----------------------------------------------------------------------
    // Analyze pass — count usages per stage
    // (Parallel to three Node.analyze calling increaseUsage)
    // -----------------------------------------------------------------------

    private _analyzeNode(node: Node<WgslType>): void {
        const count = this.increaseUsage(node);

        // Only recurse into children the first time we see this node (count === 1).
        // This is the same deduplication as three: if count > 1, we know we've
        // already walked the subtree, so we only need to mark the extra usage.
        if (count !== 1) return;

        for (const child of getChildren(node)) {
            this._analyzeNode(child);
        }

        // VaryingNode: also analyze its source in vertex stage
        if (node.kind === 'varying') {
            const vn = node as VaryingNode<WgslType>;
            const prevStage = this.shaderStage;
            this.shaderStage = 'vertex';
            this._analyzeNode(vn.source);
            this.shaderStage = prevStage;
        }

        // StackNode: analyze all body statements
        if (node.kind === 'stack') {
            const s = node as StackNode;
            for (const stmt of s.body) {
                this._analyzeNode(stmt);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Generate pass — main dispatch + CSE
    // (Parallel to TempNode.build in three)
    // -----------------------------------------------------------------------

    /**
     * Generate WGSL code for a node.
     * Three.js pattern: node.build(builder, output) where output is the requested type.
     * 
     * @param node - The node to generate
     * @param output - Optional requested output type (e.g., 'sampler' for texture nodes)
     */
    _generateNode(node: Node<WgslType>, output?: string): string | null {
        const data = this.getDataFromNode(node);
        const def  = compilerDefs[node.kind];

        // CSE hit: already emitted as a var (only if no special output requested)
        if (data.propertyName !== undefined && output === undefined) return data.propertyName;

        if (def.isStatement || def.isLeaf) return def.generate(node as never, this, output);

        if ((data.usageCount ?? 0) > 1 && output === undefined) {
            // CSE: emit a var and cache its name
            const snippet = def.generate(node as never, this, output)!;
            const varName = `_v${this.varCounter++}`;
            this.addLineFlowCode(`let ${varName} = ${snippet}`);
            data.propertyName = varName;
            return varName;
        }

        return def.generate(node as never, this, output);
    }

    // -----------------------------------------------------------------------
    // _emitStackIntoFlow — emit a StackNode's statements with a given indent
    // Used for nested blocks (if/else, for, while bodies).
    // -----------------------------------------------------------------------

    _emitStackIntoFlow(stack: StackNode, indent: string): void {
        const outerFlow = this.flow;
        this.flow = { code: '' };

        for (const stmt of stack.body) {
            this._buildNode(stmt);
        }

        // Re-indent the accumulated code by replacing the default 4-space indent
        // with the requested indent
        const indented = this.flow.code.replace(/^    /gm, indent);
        outerFlow.code += indented;
        this.flow = outerFlow;
    }

    // -----------------------------------------------------------------------
    // Fn declaration emitter
    // -----------------------------------------------------------------------

    private _emitFnDecl(fn: FnNode<WgslType>, traced: TracedFn): string {
        const { params, body, output } = traced;

        // Register param names so _generateNode resolves them
        for (const p of params) {
            const data = this.getDataFromNode(p);
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
        const prevBuildStage = this.buildStage;
        const prevShaderStage = this.shaderStage;
        const prevStageVars = this.stageVars;   // isolate vars for this fn body
        this.buildStage = 'generate';
        // Fn bodies are stage-agnostic — use 'any' stage for CSE
        this.shaderStage = null;
        this.stageVars = {};                    // fresh dict; VarNodes inside fn register here

        const bodyFlow = this.flowChildNode(body);
        const retExpr = this._generateNode(output) ?? '/* missing */';

        // Collect the fn-local vars preamble, then restore outer state
        const fnVarsPreamble = this.getVars('fn');
        this.buildStage = prevBuildStage;
        this.shaderStage = prevShaderStage;
        this.stageVars = prevStageVars;

        return [
            `fn ${fn.fnName}(${paramList}) -> ${fn.type} {`,
            ...(fnVarsPreamble ? [fnVarsPreamble.replace(/\n$/, '')] : []),
            bodyFlow.code.replace(/\n$/, ''), // strip trailing newline
            `    return ${retExpr};`,
            `}`,
        ].join('\n');
    }

    // -----------------------------------------------------------------------
    // Three.js aligned: getStructs(), getUniforms(), getCodes() for shader data
    // -----------------------------------------------------------------------

    /**
     * Returns user-defined struct declarations.
     * Three.js pattern: getStructs(shaderStage)
     */
    private getStructs(): string {
        const lines: string[] = [];
        for (const sn of this.structNodes.values()) {
            const members = sn.members.map((m) => `    ${m.name} : ${m.type},`).join('\n');
            lines.push(`struct ${sn.type} {\n${members}\n}`);
        }
        return lines.join('\n');
    }

    /**
     * Emits WGSL declarations for all bindings.
     * Three.js pattern: part of getUniforms() output in WGSLNodeBuilder
     */
    private _emitBindingsWGSL(): string {
        const lines: string[] = [];
        const bindGroups = this.getBindings();

        for (const group of bindGroups) {
            const groupIndex = group.index;
            let bindingIndex = 0;

            for (const entry of group.bindings) {
                if (entry.type === 'uniform' && entry.uniforms) {
                    // Uniform buffer - emit struct and var
                    const structTypeName = entry.groupNode.name + 'Struct';
                    const memberLines = entry.uniforms.map(u => `    ${u.name} : ${u.type},`).join('\n');
                    lines.push(`struct ${structTypeName} {\n${memberLines}\n}`);
                    lines.push(`@group(${groupIndex}) @binding(${bindingIndex}) var<uniform> ${entry.groupNode.name} : ${structTypeName};`);
                    bindingIndex++;
                } else if (entry.type === 'storage') {
                    const storageNode = entry.node as StorageNode<WgslType>;
                    const access = this.input.kind === 'render' ? 'read' : storageNode.access;
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

    /**
     * Returns user-defined function declarations.
     * Three.js pattern: getCodes(shaderStage)
     */
    private getCodes(): string {
        const lines: string[] = [];
        for (const { fn, traced } of this.fnNodes.values()) {
            lines.push(this._emitFnDecl(fn, traced));
        }
        return lines.join('\n\n');
    }

    // -----------------------------------------------------------------------
    // Stage-specific shader data builders — Three.js buildCode() pattern
    // -----------------------------------------------------------------------

    /**
     * Build VertexShaderData with all vertex-stage specific pieces.
     * Three.js pattern: buildCode() populates stageData for each stage.
     */
    private _buildVertexShaderData(): VertexShaderData {
        const varyingList = [...this.varyings.values()];
        const attrList = [...this.attributes.values()];

        // Build VertexInput struct
        const inputLines: string[] = [`struct VertexInput {`];
        for (const a of attrList) {
            inputLines.push(`    @location(${a.location}) ${a.name} : ${a.type},`);
        }
        for (const a of this.bufferAttrs) {
            inputLines.push(`    @location(${a.location}) ${a.name} : ${a.type},`);
        }
        if (this.builtinsUsed.has('instance_index')) {
            inputLines.push(`    @builtin(instance_index) instance_index : u32,`);
        }
        if (this.builtinsUsed.has('vertex_index')) {
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
        const vars = this.getVars('vertex') ?? '';

        // Build flow (position calculation + varying assignments)
        const flowLines: string[] = [];

        // Emit vertex-stage preamble (varying source assignments from flowNodeFromShaderStage)
        if (this.flowCode.vertex) {
            flowLines.push(this.flowCode.vertex.replace(/\n$/, ''));
        }

        // Emit the generated flow for the position root node
        const posRoot = this.input.kind === 'render' ? this.input.slots.position : null;
        if (posRoot) {
            const flowData = this.flowResults.get(posRoot);
            if (flowData) {
                if (flowData.code) flowLines.push(flowData.code.replace(/\n$/, ''));
                flowLines.push(`    out.position = ${flowData.result};`);
            }
        }

        // Assign varyings
        for (const v of varyingList) {
            const vn = this._findVaryingNodeByName(v.name);
            if (vn) {
                const prevBuildStage = this.buildStage;
                const prevShaderStage = this.shaderStage;
                this.buildStage = 'generate';
                this.shaderStage = 'vertex';
                const srcExpr = this._generateNode(vn.source) ?? '/* missing */';
                this.buildStage = prevBuildStage;
                this.shaderStage = prevShaderStage;
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

    /**
     * Build FragmentShaderData with all fragment-stage specific pieces.
     * Three.js pattern: buildCode() populates stageData for each stage.
     */
    private _buildFragmentShaderData(): FragmentShaderData {
        const varyingList = [...this.varyings.values()];
        const hasVaryings = varyingList.length > 0;

        const slots = this.input.kind === 'render' ? this.input.slots : null;
        const maskRoot = slots?.mask;
        const depthRoot = slots?.depth;
        const hasDepth = depthRoot !== undefined;
        const colorRoot = slots?.color ?? null;

        // Check if colorRoot is an OutputStructNode (MRT)
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

        // Determine if we need an output struct (MRT or depthNode)
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
        const vars = this.getVars('fragment') ?? '';

        // Build flow (mask, color, depth)
        const flowLines: string[] = [];

        // maskNode: evaluate, then emit early-discard
        if (maskRoot) {
            const maskFlowData = this.flowResults.get(maskRoot);
            if (maskFlowData) {
                if (maskFlowData.code) flowLines.push(maskFlowData.code.replace(/\n$/, ''));
                flowLines.push(`    if (!(${maskFlowData.result})) { discard; }`);
            }
        }

        if (colorRoot) {
            if (isMRT && mrtNode) {
                // MRT: generate each member expression and assign to output struct
                flowLines.push(`    var _out : FragmentOutput;`);

                for (let i = 0; i < mrtNode.members.length; i++) {
                    const member = mrtNode.members[i];
                    if (!member) continue;

                    const memberFlow = this.flowChildNode(member);
                    if (memberFlow.code) flowLines.push(memberFlow.code.replace(/\n$/, ''));

                    const name = (mrtNode instanceof MRTNode && mrtNode._resolvedNames[i])
                        ? mrtNode._resolvedNames[i]
                        : `output${i}`;
                    flowLines.push(`    _out.${name} = ${memberFlow.result};`);
                }

                // depthNode if present
                if (hasDepth && depthRoot) {
                    const depthFlowData = this.flowResults.get(depthRoot);
                    if (depthFlowData) {
                        if (depthFlowData.code) flowLines.push(depthFlowData.code.replace(/\n$/, ''));
                        flowLines.push(`    _out.frag_depth = ${depthFlowData.result};`);
                    }
                }

                flowLines.push(`    return _out;`);
            } else {
                // Single output
                const flowData = this.flowResults.get(colorRoot);
                if (flowData) {
                    if (flowData.code) flowLines.push(flowData.code.replace(/\n$/, ''));

                    if (hasDepth) {
                        const depthFlowData = this.flowResults.get(depthRoot!);
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

        // Determine return type
        const returnType = needsOutputStruct ? 'FragmentOutput' : '@location(0) vec4f';

        // Input param
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

    /**
     * Build a UniformGroupBlock from a bucket of UniformNodes.
     * Calculates std140 layout offsets.
     */
    private _buildUniformGroupBlock(
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

    /**
     * Returns a WGSL vertex shader based on the given shader data.
     * Three.js pattern: pure template function.
     */
    private _getWGSLVertexCode(shaderData: VertexShaderData): string {
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

    /**
     * Returns a WGSL fragment shader based on the given shader data.
     * Three.js pattern: pure template function.
     */
    private _getWGSLFragmentCode(shaderData: FragmentShaderData): string {
        const inputStructSection = shaderData.inputStruct ? `${shaderData.inputStruct}\n\n` : '';
        const outputStructSection = shaderData.outputStruct ? `${shaderData.outputStruct}\n\n` : '';
        const varsSection = shaderData.vars ? `\n${shaderData.vars}` : '';
        const flowSection = shaderData.flow ? `\n${shaderData.flow}` : '';

        return `${inputStructSection}${outputStructSection}@fragment
fn fs_main(${shaderData.varyings}) -> ${shaderData.returnType} {${varsSection}${flowSection}
}`;
    }

    /**
     * Build ComputeShaderData with all compute-stage specific pieces.
     * Three.js pattern: buildCode() populates stageData for each stage.
     */
    private _buildComputeShaderData(): ComputeShaderData {
        if (this.input.kind !== 'compute') throw new Error('_buildComputeShaderData called on render builder');

        // Build builtin params
        const paramParts: string[] = [];
        for (const [kind, info] of Object.entries(COMPUTE_BUILTIN_PARAM)) {
            if (this.builtinsUsed.has(kind)) {
                paramParts.push(`    @builtin(${info.attr}) ${kind} : ${info.type}`);
            }
        }
        const builtinParams = paramParts.length > 0 ? '\n' + paramParts.join(',\n') + '\n' : '';

        // Build vars
        const vars = this.getVars('compute') ?? '';

        // Build flow
        const flowLines: string[] = [];
        const bodyRoot = this.flowNodes.compute[0];
        if (bodyRoot) {
            const flowData = this.flowResults.get(bodyRoot);
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
            workgroupSize: this.input.node.workgroupSize,
            builtinParams,
        };
    }

    /**
     * Returns a WGSL compute shader based on the given shader data.
     * Three.js pattern: pure template function.
     */
    private _getWGSLComputeCode(shaderData: ComputeShaderData): string {
        const [wx, wy, wz] = shaderData.workgroupSize;
        const varsSection = shaderData.vars ? `\n${shaderData.vars}` : '';
        const flowSection = shaderData.flow ? `\n${shaderData.flow}` : '';

        return `@compute @workgroup_size(${wx}, ${wy}, ${wz})
fn cs_main(${shaderData.builtinParams}) {${varsSection}${flowSection}
}`;
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private _findVaryingNodeByName(name: string): VaryingNode<WgslType> | null {
        for (const node of this.allNodes.values()) {
            if (node.kind === 'varying') {
                const vn = node as VaryingNode<WgslType>;
                if (vn.name === name) return vn;
            }
        }
        return null;
    }
}

// ---------------------------------------------------------------------------
// compilerDefs — per-kind compilation behaviour (populated after WgslBuilder)
// ---------------------------------------------------------------------------

compilerDefs = {
    const: {
        isStatement: false, isLeaf: true,
        setup: null,
        generate: (node: ConstNode<WgslType>, _b: WgslBuilder) => constLiteral(node.type, node.value),
    },
    uniform: {
        isStatement: false, isLeaf: true,
        setup: (node: UniformNode<WgslType>, b: WgslBuilder) => {
            // Three.js pattern: use a single shared BindingEntry per group name
            const groupName = node.groupNode.name;
            const shaderStage = b.shaderStage ?? 'vertex';
            const bindings = b.getBindGroupArray(groupName, shaderStage);

            // Get or create the shared uniform entry for this group
            let uniformEntry = b.uniformGroups[groupName];
            if (uniformEntry === undefined) {
                uniformEntry = {
                    type: 'uniform',
                    name: groupName,
                    groupNode: node.groupNode,
                    node: node,
                    uniforms: [],
                };
                b.uniformGroups[groupName] = uniformEntry;
            }

            // Add the shared entry to this stage's bindings if not already present
            // Three.js pattern: same object reference added to multiple stages
            if (!bindings.includes(uniformEntry)) {
                bindings.push(uniformEntry);
            }

            // Add uniform to the shared group (dedup by name)
            if (!uniformEntry.uniforms!.some((n: UniformNode<WgslType>) => n.name === node.name)) {
                uniformEntry.uniforms!.push(node);
            }

            const uniformDef = lookupStructDefByName(node.type);
            if (uniformDef) b._registerStructDef(uniformDef);
        },
        generate: (node: UniformNode<WgslType>, _b: WgslBuilder) =>
            // Three.js-aligned property access: groupName.fieldName
            `${node.groupNode.name}.${node.name}`,
    },
    attribute: {
        isStatement: false, isLeaf: true,
        setup: (node: AttributeNode<WgslType>, b: WgslBuilder) => {
            if (!b.attributes.has(node.name)) {
                const totalLoc = b.attributes.size + b.bufferAttrs.length;
                b.attributes.set(node.name, { kind: 'geometry', name: node.name, type: node.type, location: totalLoc });
            }
        },
        generate: (node: AttributeNode<WgslType>, _b: WgslBuilder) => `in.${node.name}`,
    },
    buffer_attribute: {
        isStatement: false, isLeaf: true,
        setup: (node: BufferAttributeNode<WgslType>, b: WgslBuilder) => {
            if (!b.bufferAttrNames.has(node.id)) {
                const totalLoc = b.attributes.size + b.bufferAttrs.length;
                const name = `_buf${b.bufferAttrs.length}`;
                b.bufferAttrNames.set(node.id, name);
                b.bufferAttrs.push({ kind: 'buffer', node: node as unknown as BufferAttributeNode<WgslType>, name, type: node.type, location: totalLoc });
            }
        },
        generate: (node: BufferAttributeNode<WgslType>, b: WgslBuilder) => {
            const name = b.bufferAttrNames.get(node.id);
            return name ? `in.${name}` : `/* missing buffer attr ${node.id} */`;
        },
    },
    storage: {
        isStatement: false, isLeaf: true,
        setup: (node: StorageNode<WgslType>, b: WgslBuilder) => {
            const groupName = node.groupNode.name;
            const shaderStage = b.shaderStage ?? 'compute';
            const bindings = b.getBindGroupArray(groupName, shaderStage);

            // Get or create shared storage binding entry
            let storEntry = b.storageBindings[node.id];
            if (storEntry === undefined) {
                // Generate a unique name
                const existingStorageCount = Object.keys(b.storageBindings).length;
                const name = `_stor${existingStorageCount}`;
                b.storageNames.set(node.id, name);

                storEntry = {
                    type: 'storage',
                    name,
                    groupNode: node.groupNode,
                    node: node,
                };
                b.storageBindings[node.id] = storEntry;

                const storageDef = lookupStructDefByName(node.type);
                if (storageDef) b._registerStructDef(storageDef);
            }

            // Add shared entry to this stage's bindings if not already present
            if (!bindings.includes(storEntry)) {
                bindings.push(storEntry);
            }
        },
        generate: (node: StorageNode<WgslType>, b: WgslBuilder) => b.storageNames.get(node.id) ?? node.id,
    },
    texture: {
        isStatement: false, isLeaf: false,  // Not a leaf - has uvNode child
        setup: (node: TextureNode, b: WgslBuilder) => {
            // Register the base texture (follow referenceNode if present)
            const base = node.referenceNode ?? node;
            const key = String(base.textureId);

            const groupName = base.groupNode.name;
            const shaderStage = b.shaderStage ?? 'fragment';
            const bindings = b.getBindGroupArray(groupName, shaderStage);

            // Three.js pattern: PassMultipleTextureNode.setup() calls updateTexture()
            if (base instanceof PassMultipleTextureNode) {
                base.updateTexture();
                const passNode = base.passNode;
                if (passNode.updateBeforeType !== 'none') {
                    b._sequentialNodes.add(passNode);
                }
            }

            // Get or create shared texture binding entry
            let texEntry = b.textureBindings[key];
            if (texEntry === undefined) {
                texEntry = {
                    type: 'texture',
                    name: key,
                    groupNode: base.groupNode,
                    node: base,
                };
                b.textureBindings[key] = texEntry;
            }

            // Add shared entry to this stage's bindings if not already present
            if (!bindings.includes(texEntry)) {
                bindings.push(texEntry);
            }

            // Get or create shared sampler binding entry
            let sampEntry = b.samplerBindings[key];
            if (sampEntry === undefined) {
                sampEntry = {
                    type: 'sampler',
                    name: key,
                    groupNode: base.groupNode,
                    node: base,
                };
                b.samplerBindings[key] = sampEntry;
            }

            // Add shared entry to this stage's bindings if not already present
            if (!bindings.includes(sampEntry)) {
                bindings.push(sampEntry);
            }
        },
        generate: (node: TextureNode, b: WgslBuilder, output?: string) => {
            // Get the base texture for binding reference
            const base = node.referenceNode ?? node;
            
            // Three.js TextureNode.generate(): if output starts with 'sampler', return sampler name
            if (output !== undefined && /^sampler/.test(output)) {
                return `${base.textureId}_samp`;
            }
            
            const texName = `${base.textureId}_tex`;
            const sampName = `${base.textureId}_samp`;
            
            // Generate UV - use uvNode if provided, otherwise default to in.uv
            const uvExpr = node.uvNode ? b._generateNode(node.uvNode) : 'in.uv';
            
            // Three.js pattern: generate textureSample(texture, sampler, uv)
            return `textureSample(${texName}, ${sampName}, ${uvExpr})`;
        },
    },
    // Three.js ConvertNode: converts a node's output type to a target type.
    // generate() calls node.build(builder, type) which requests specific output.
    convert: {
        isStatement: false, isLeaf: false,
        setup: (node: ConvertNode, b: WgslBuilder) => {
            b._setupNode(node.node);
        },
        generate: (node: ConvertNode, b: WgslBuilder) => {
            // Three.js: const type = this.getNodeType(builder);
            // For simplicity, we use convertTo directly (no type length matching)
            const type = node.convertTo;

            // Three.js: const snippet = node.build(builder, type);
            const snippet = b._generateNode(node.node, type);

            // Three.js: return builder.format(snippet, type, output);
            // For now, just return snippet (no additional formatting)
            return snippet;
        },
    },
    varying: {
        isStatement: false, isLeaf: true,
        setup: (node: VaryingNode<WgslType>, b: WgslBuilder) => {
            if (!b.varyings.has(node.name)) {
                b.varyings.set(node.name, { name: node.name, type: node.type, location: b.varyings.size });
            }
            b._setupNode(node.source);
        },
        generate: (node: VaryingNode<WgslType>, b: WgslBuilder) => {
            if (b.shaderStage === 'fragment') {
                const varyingData = b.getDataFromNode(node as unknown as Node<WgslType>, 'fragment');
                if (varyingData.propertyName === undefined) {
                    b.flowNodeFromShaderStage('vertex', node.source);
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
        generate: (node: BinopNode<WgslType>, b: WgslBuilder) => {
            const l = b._generateNode(node.left) ?? '/* missing */';
            const r = b._generateNode(node.right) ?? '/* missing */';
            return `(${l} ${node.op} ${r})`;
        },
    },
    call: {
        isStatement: false, isLeaf: false,
        setup: (node: CallNode<WgslType>, b: WgslBuilder) => {
            if (node.fnNode && !b.fnNodes.has(node.fnNode.id)) {
                b._setupFnNode(node.fnNode);
            }
        },
        generate: (node: CallNode<WgslType>, b: WgslBuilder) => {
            const argExprs = node.args.map((a) => b._generateNode(a) ?? '/* missing */');
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
        generate: (node: RawNode<WgslType>, b: WgslBuilder) => {
            const depExprs = node.deps.map((d) => b._generateNode(d) ?? '/* missing */');
            // Handle $0, $1, etc. as well as $0_samp, $1_xxx for sampler refs
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
        generate: (node: AssignNode, b: WgslBuilder) => {
            const tgt = b._generateNode(node.target) ?? '/* missing */';
            const val = b._generateNode(node.value) ?? '/* missing */';
            b.addLineFlowCode(`${tgt} = ${val}`);
            return null;
        },
    },
    construct: {
        isStatement: false, isLeaf: false,
        setup: null,
        generate: (node: ConstructNode<WgslType>, b: WgslBuilder) => {
            const argExprs = node.args.map((a) => b._generateNode(a) ?? '/* missing */');
            return `${node.type}(${argExprs.join(', ')})`;
        },
    },
    struct: {
        isStatement: false, isLeaf: true,
        setup: (node: StructNode, b: WgslBuilder) => {
            const def = lookupStructDef(node);
            if (def) {
                b._registerStructDef(def);
            } else if (!b.structNodes.has(node.type)) {
                b.structNodes.set(node.type, node);
            }
        },
        generate: (node: StructNode, _b: WgslBuilder) => `/* struct ${node.type} */`,
    },
    field: {
        isStatement: false, isLeaf: false,
        setup: null,
        generate: (node: FieldNode<WgslType>, b: WgslBuilder) => {
            const obj = b._generateNode(node.object) ?? '/* missing */';
            return `${obj}.${node.fieldName}`;
        },
    },
    index: {
        isStatement: false, isLeaf: false,
        setup: null,
        generate: (node: IndexNode<WgslType>, b: WgslBuilder) => {
            const arr = b._generateNode(node.array) ?? '/* missing */';
            const idx = b._generateNode(node.index) ?? '/* missing */';
            return `${arr}[${idx}]`;
        },
    },
    builtin: {
        isStatement: false, isLeaf: true,
        setup: (node: BuiltinNode<WgslType>, b: WgslBuilder) => {
            // Only WGSL shader builtins remain here (instance_index, vertex_index, etc.)
            b.builtinsUsed.add(node.builtinKind);
        },
        generate: (node: BuiltinNode<WgslType>, b: WgslBuilder) => {
            const BUILTIN_VAR: Record<string, string> = {
                instance_index: 'instance_index',
                instance_data:  'instanceData',
                vertex_index:   'vertex_index',
            };
            const BUILTIN_VERTEX_INPUT = new Set(['instance_index', 'vertex_index']);
            if (b.shaderStage === 'compute') {
                return BUILTIN_VAR[node.builtinKind] ?? node.builtinKind;
            }
            if (BUILTIN_VERTEX_INPUT.has(node.builtinKind)) return `in.${BUILTIN_VAR[node.builtinKind] ?? node.builtinKind}`;
            return BUILTIN_VAR[node.builtinKind] ?? node.builtinKind;
        },
    },
    stack: {
        isStatement: true, isLeaf: false,
        setup: null,
        generate: (node: StackNode, b: WgslBuilder) => {
            for (const stmt of node.body) {
                b._buildNode(stmt);
            }
            return null;
        },
    },
    cond: {
        isStatement: false, isLeaf: false,
        setup: null,
        generate: (node: CondNode<WgslType>, b: WgslBuilder) => {
            const condExpr = b._generateNode(node.condition) ?? '/* missing */';
            const trueExpr = b._generateNode(node.ifTrue) ?? '/* missing */';
            const falseExpr = node.ifFalse
                ? b._generateNode(node.ifFalse) ?? '/* missing */'
                : `${node.type}()`;
            return `select(${falseExpr}, ${trueExpr}, ${condExpr})`;
        },
    },
    var: {
        isStatement: true, isLeaf: false,
        setup: null,
        generate: (node: VarNode<WgslType>, b: WgslBuilder) => {
            const name = b.getVarFromNode(node as unknown as Node<WgslType>, node.varName, node.type);
            const initExpr = b._generateNode(node.init) ?? '/* missing */';
            b.addLineFlowCode(`${name} = ${initExpr}`);
            return name;
        },
    },
    if: {
        isStatement: true, isLeaf: false,
        setup: null,
        generate: (node: IfNode, b: WgslBuilder) => {
            const condExpr = b._generateNode(node.condition) ?? '/* missing */';
            b.addFlowCode(`    if (${condExpr}) {\n`);
            b._emitStackIntoFlow(node.thenBody, '        ');
            if (node.elseBody) {
                b.addFlowCode(`    } else {\n`);
                b._emitStackIntoFlow(node.elseBody, '        ');
            }
            b.addFlowCode(`    }\n`);
            return null;
        },
    },
    for: {
        isStatement: true, isLeaf: false,
        setup: null,
        generate: (node: ForNode, b: WgslBuilder) => {
            const iName = `i_${b.forCounter++}`;
            const idxData = b.getDataFromNode(node.indexVar as unknown as Node<WgslType>);
            idxData.propertyName = iName;
            const getScalarExpr = (v: Node<WgslType> | number, _type: ScalarType) =>
                typeof v === 'number'
                    ? constLiteral(_type, v)
                    : b._generateNode(v as Node<WgslType>) ?? '/* missing */';
            const header = buildForHeader(node.range, iName, getScalarExpr);
            b.addFlowCode(`    ${header} {\n`);
            b._emitStackIntoFlow(node.body, '        ');
            b.addFlowCode(`    }\n`);
            return null;
        },
    },
    while: {
        isStatement: true, isLeaf: false,
        setup: null,
        generate: (node: WhileNode, b: WgslBuilder) => {
            const condExpr = b._generateNode(node.condition) ?? '/* missing */';
            b.addFlowCode(`    while (${condExpr}) {\n`);
            b._emitStackIntoFlow(node.body, '        ');
            b.addFlowCode(`    }\n`);
            return null;
        },
    },
    break: {
        isStatement: true, isLeaf: false,
        setup: null,
        generate: (_node: BreakNode, b: WgslBuilder) => {
            b.addLineFlowCode('break');
            return null;
        },
    },
    continue: {
        isStatement: true, isLeaf: false,
        setup: null,
        generate: (_node: ContinueNode, b: WgslBuilder) => {
            b.addLineFlowCode('continue');
            return null;
        },
    },
    fn: {
        isStatement: false, isLeaf: true,
        setup: null,
        generate: (node: FnNode<WgslType>, _b: WgslBuilder) => `/* fn ${node.type} */`,
    },
    param: {
        isStatement: false, isLeaf: true,
        setup: null,
        generate: (node: ParamNode<WgslType>, _b: WgslBuilder) => node.paramName ?? `p${node.paramIndex}`,
    },
    return: {
        isStatement: true, isLeaf: false,
        setup: null,
        generate: (node: ReturnNode<WgslType>, b: WgslBuilder) => {
            const valExpr = b._generateNode(node.value) ?? '/* missing */';
            b.addLineFlowCode(`return ${valExpr}`);
            return null;
        },
    },
    output_struct: {
        isStatement: false, isLeaf: false,
        setup: (node: OutputStructNode, b: WgslBuilder) => {
            // Setup all member nodes
            for (const member of node.members) {
                if (member) b._setupNode(member);
            }
        },
        generate: (node: OutputStructNode, _b: WgslBuilder) => {
            // OutputStructNode generation is handled specially in _getWGSLFragmentCode
            // When encountered during normal generation, just return a placeholder
            // that will be replaced by the fragment code emitter
            return `/* output_struct ${node.id} */`;
        },
    },
} as unknown as Record<NodeKind, NodeCompilerDef>;

// ---------------------------------------------------------------------------
// std140 layout helpers — only used by WgslBuilder._buildUniformBlock
// ---------------------------------------------------------------------------

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
