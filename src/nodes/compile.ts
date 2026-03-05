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
    type SamplerNode,
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
    constLiteral,
    buildForHeader,
    lookupStructDef,
    lookupStructDefByName,
} from './nodes';
import { collectGraph, getChildren } from './collect';
import { type StructDef, type StructSchema } from './nodes';
import type { ComputeNode } from './nodes';
import type { RenderFrame } from '../renderer/render-frame';

// ---------------------------------------------------------------------------
// NodeUpdateType — re-export from nodes.ts for compile-level consumers
// ---------------------------------------------------------------------------

/**
 * Controls how often a node's update method is called.
 *
 * Re-exported as a type alias for compatibility with UpdateBeforeNode/UpdateAfterNode interfaces.
 * The canonical NodeUpdateType constant lives in nodes.ts.
 */
export type NodeUpdateType = NodeUpdateTypeValue;

// ---------------------------------------------------------------------------
// UpdateBeforeNode — interface for nodes with updateBefore() lifecycle
// ---------------------------------------------------------------------------

/**
 * Interface for nodes that need to execute GPU work before the final composite
 * quad each frame/render/object.
 *
 * Mirrors three's Node.updateBefore(frame) pattern.  The compiler discovers
 * nodes implementing this interface during the setup pass (post-order DFS) and
 * stores them in CompileResult.updateBeforeNodes.  The renderer iterates that
 * list with deduplication controlled by updateBeforeType.
 */
export type UpdateBeforeNode = {
    readonly id: string;
    readonly updateBeforeType: NodeUpdateType;
    /** Mirrors three Node.updateBefore(frame) — single argument. Returns false to cancel/revert. */
    updateBefore(frame: RenderFrame): boolean | void;
}

// ---------------------------------------------------------------------------
// UpdateAfterNode — interface for nodes with updateAfter() lifecycle
// ---------------------------------------------------------------------------

/**
 * Interface for nodes that need to execute GPU work after each draw call.
 *
 * Mirrors three's Node.updateAfter(frame) pattern.  Stored in
 * CompileResult.updateAfterNodes and called by the renderer after each
 * render pass with deduplication controlled by updateAfterType.
 */
export type UpdateAfterNode = {
    readonly id: string;
    readonly updateAfterType: NodeUpdateType;
    /** Mirrors three Node.updateAfter(frame) — single argument. Returns false to cancel/revert. */
    updateAfter(frame: RenderFrame): boolean | void;
}

// ---------------------------------------------------------------------------
// UpdateNode — interface for nodes with update() lifecycle (mid-frame uniform push)
// ---------------------------------------------------------------------------

/**
 * Interface for nodes that push CPU data into GPU uniforms each frame/render/object.
 *
 * Mirrors three's Node.update(frame) pattern.  Stored in
 * CompileResult.updateNodes and called by the renderer with deduplication
 * controlled by updateType.
 */
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
    node: SamplerNode;
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

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export function compile(slots: CompileSlots): CompileResult {
    const builder = new WgslBuilder({ kind: 'render', slots });
    builder.build();
    return builder._makeRenderResult();
}

export function compileCompute(node: ComputeNode): ComputeCompileResult {
    const builder = new WgslBuilder({ kind: 'compute', node });
    builder.build();
    return builder._makeComputeResult();
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

// Traced fn data stored alongside NodeData (keyed on fn.id in fnNodes map)
type TracedFn = ReturnType<FnNode<WgslType>['trace']>;

// ---------------------------------------------------------------------------
// compilerDefs — per-kind compilation behaviour
// ---------------------------------------------------------------------------

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
    generate: (node: NodeOf<K>, builder: WgslBuilder) => string | null;
};

// Forward-declare WgslBuilder for compilerDefs (class is defined below)
// eslint-disable-next-line prefer-const
let compilerDefs: Record<NodeKind, NodeCompilerDef>;

// ---------------------------------------------------------------------------
// Builder input discriminated union
// ---------------------------------------------------------------------------

type RenderInput = { kind: 'render'; slots: CompileSlots };
type ComputeInput = { kind: 'compute'; node: ComputeNode };

// ---------------------------------------------------------------------------
// WgslBuilder — the single unified builder class
// ---------------------------------------------------------------------------

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
    /**
     * Uniforms bucketed by groupNode.name (e.g. 'render', 'object').
     * Each entry contains the groupNode and ordered list of UniformNodes.
     */
    uniformGroupBuckets: Map<string, { groupNode: UniformGroupNode; nodes: UniformNode<WgslType>[] }> = new Map();
    storageNodes: Map<string, StorageNode<WgslType>> = new Map();
    storageNames: Map<string, string> = new Map();
    textureNodes: Map<string, TextureNode> = new Map();
    samplerNodes: Map<string, SamplerNode> = new Map();
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

    constructor(input: RenderInput | ComputeInput) {
        this.input = input;
    }

    // -----------------------------------------------------------------------
    // Top-level orchestrator: setup → analyze → generate → buildCode
    // (Parallel to three NodeBuilder.build())
    // -----------------------------------------------------------------------

    build(): this {
        this._registerRoots();

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

        // Split _sequentialNodes into typed arrays (mirrors three buildUpdateNodes()).
        this._buildUpdateNodes();

        return this;
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

    _generateNode(node: Node<WgslType>): string | null {
        const data = this.getDataFromNode(node);
        const def  = compilerDefs[node.kind];

        // CSE hit: already emitted as a var
        if (data.propertyName !== undefined) return data.propertyName;

        if (def.isStatement || def.isLeaf) return def.generate(node as never, this);

        if ((data.usageCount ?? 0) > 1) {
            // CSE: emit a var and cache its name
            const snippet = def.generate(node as never, this)!;
            const varName = `_v${this.varCounter++}`;
            this.addLineFlowCode(`let ${varName} = ${snippet}`);
            data.propertyName = varName;
            return varName;
        }

        return def.generate(node as never, this);
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
    // buildCode — assemble the final WGSL string(s)
    // -----------------------------------------------------------------------

    _makeRenderResult(): CompileResult {
        if (this.input.kind !== 'render') throw new Error('_makeRenderResult called on compute builder');

        const lines: string[] = [];

        // Struct declarations — only user-defined structs
        for (const sn of this.structNodes.values()) {
            const members = sn.members.map((m) => `    ${m.name} : ${m.type},`).join('\n');
            lines.push(`struct ${sn.type} {\n${members}\n}`);
        }

        // ---------------------------------------------------------------------
        // Build uniform groups from buckets — Three.js aligned struct-based UBOs
        // Sort groups by order, then assign @group indices
        // ---------------------------------------------------------------------
        const uniformGroups: UniformGroupBlock[] = [];
        const sortedBuckets = [...this.uniformGroupBuckets.values()]
            .sort((a, b) => a.groupNode.order - b.groupNode.order);

        // Assign group indices based on sorted order
        // render (order=0) → @group(0), object (order=1) → @group(1)
        let groupIndex = 0;
        for (const bucket of sortedBuckets) {
            if (bucket.nodes.length === 0) continue;

            const block = this._buildUniformGroupBlock(bucket.groupNode, bucket.nodes, groupIndex, 0);
            uniformGroups.push(block);

            // Emit struct definition + var declaration
            // Struct type name gets "Struct" suffix to avoid shadowing the variable name
            // (mirrors Three.js WGSLNodeBuilder._getWGSLStructBinding pattern)
            const structTypeName = bucket.groupNode.name + 'Struct';
            const memberLines = block.members.map(m => `    ${m.uniformId} : ${m.type},`).join('\n');
            lines.push(`struct ${structTypeName} {\n${memberLines}\n}`);
            lines.push(`@group(${groupIndex}) @binding(0) var<uniform> ${bucket.groupNode.name} : ${structTypeName};`);

            groupIndex++;
        }

        // Object group resources (textures, samplers, storage) belong to the object group.
        // Three.js aligned: if object group has uniforms, use its assigned index.
        // If not, textures/samplers/storage go in the next available group index.
        const objectUniformGroup = uniformGroups.find(g => g.groupNode.name === 'object');
        const objectGroupIndex = objectUniformGroup?.groupIndex ?? groupIndex;
        // If object group exists, binding 0 is the uniform struct; otherwise start at 0
        let objectBinding = objectUniformGroup ? 1 : 0;

        const storageEntries: StorageEntry[] = [];
        for (const sn of this.storageNodes.values()) {
            const name = this.storageNames.get(sn.id)!;
            // Render shaders share a single WGSL module between vertex and fragment stages.
            // WGSL forbids var<storage, read_write> from being visible to the vertex stage,
            // so always emit read access in render shaders — the buffer can still be written
            // by a compute pass.  Only compute shaders get the true read_write access mode.
            const wgslAccess = 'read';
            storageEntries.push({ node: sn, name, type: sn.storageType, access: sn.access, group: objectGroupIndex as 0 | 1, binding: objectBinding });
            lines.push(`@group(${objectGroupIndex}) @binding(${objectBinding}) var<storage, ${wgslAccess}> ${name} : ${sn.storageType};`);
            objectBinding++;
        }

        const textureEntries: TextureEntry[] = [];
        for (const tn of this.textureNodes.values()) {
            textureEntries.push({ textureId: String(tn.textureId), type: tn.type, group: objectGroupIndex as 0 | 1, binding: objectBinding, node: tn });
            lines.push(`@group(${objectGroupIndex}) @binding(${objectBinding}) var ${tn.textureId}_tex : ${tn.type};`);
            objectBinding++;
        }

        const samplerEntries: SamplerEntry[] = [];
        for (const sn of this.samplerNodes.values()) {
            samplerEntries.push({ samplerId: String(sn.samplerId), type: sn.type, group: objectGroupIndex as 0 | 1, binding: objectBinding, node: sn });
            lines.push(`@group(${objectGroupIndex}) @binding(${objectBinding}) var ${sn.samplerId}_samp : ${sn.type};`);
            objectBinding++;
        }

        if (lines.length > 0) lines.push('');

        // User-defined Fn declarations
        for (const { fn, traced } of this.fnNodes.values()) {
            lines.push(this._emitFnDecl(fn, traced));
            lines.push('');
        }

        // Vertex entry
        lines.push(this._getWGSLVertexCode());
        lines.push('');

        // Fragment entry
        lines.push(this._getWGSLFragmentCode());

        const attributes: AttributeEntry[] = [
            ...[...this.attributes.values()],
            ...this.bufferAttrs,
        ];
        const varyings = [...this.varyings.values()];

        // Legacy uniforms array — extract material uniforms from object group for backwards compat
        const objectGroup = uniformGroups.find(g => g.groupNode.name === 'object');
        const legacyMaterialUniforms = objectGroup
            ? objectGroup.members.filter(m =>
                m.uniformId !== 'modelWorldMatrix' && m.uniformId !== 'modelNormalMatrix')
            : [];
        const legacyUniformBlockEntry: UniformBlockEntry | null = legacyMaterialUniforms.length > 0
            ? { group: 1, binding: 0, members: legacyMaterialUniforms, totalBytes: objectGroup!.totalBytes }
            : null;

        return {
            code: lines.join('\n'),
            attributes,
            varyings,
            uniforms: legacyUniformBlockEntry ? [legacyUniformBlockEntry] : [],
            uniformGroups,
            storage: storageEntries,
            textures: textureEntries,
            samplers: samplerEntries,
            builtinsUsed: new Set(this.builtinsUsed),
            updateBeforeNodes: this._updateBeforeNodes,
            updateAfterNodes:  this._updateAfterNodes,
            updateNodes:       this._updateNodes,
            inspectableNodes:  [...this.allNodes.values()].filter(n => n._isInspectable),
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

    private _getWGSLVertexCode(): string {
        const lines: string[] = [];
        const varyingList = [...this.varyings.values()];
        const attrList = [...this.attributes.values()];

        lines.push(`struct VertexInput {`);
        for (const a of attrList) {
            lines.push(`    @location(${a.location}) ${a.name} : ${a.type},`);
        }
        for (const a of this.bufferAttrs) {
            lines.push(`    @location(${a.location}) ${a.name} : ${a.type},`);
        }
        if (this.builtinsUsed.has('instance_index')) {
            lines.push(`    @builtin(instance_index) instance_index : u32,`);
        }
        if (this.builtinsUsed.has('vertex_index')) {
            lines.push(`    @builtin(vertex_index) vertex_index : u32,`);
        }
        lines.push(`}`);
        lines.push('');

        lines.push(`struct VertexOutput {`);
        lines.push(`    @builtin(position) position : vec4f,`);
        for (const v of varyingList) {
            lines.push(`    @location(${v.location}) ${v.name} : ${v.type},`);
        }
        lines.push(`}`);
        lines.push('');

        lines.push(`@vertex`);
        lines.push(`fn vs_main(in : VertexInput) -> VertexOutput {`);
        lines.push(`    var out : VertexOutput;`);

        // Emit var declarations preamble (VarNode declarations for this stage)
        const vertexVars = this.getVars('vertex');
        if (vertexVars) lines.push(vertexVars.replace(/\n$/, ''));

        // Emit vertex-stage preamble (varying source assignments from flowNodeFromShaderStage)
        if (this.flowCode.vertex) {
            lines.push(this.flowCode.vertex.replace(/\n$/, ''));
        }

        // Emit the generated flow for the position root node
        const posRoot = this.input.kind === 'render' ? this.input.slots.position : null;
        if (posRoot) {
            const flowData = this.flowResults.get(posRoot);
            if (flowData) {
                if (flowData.code) lines.push(flowData.code.replace(/\n$/, ''));
                lines.push(`    out.position = ${flowData.result};`);
            }
        }

        // Assign varyings
        for (const v of varyingList) {
            const vn = this._findVaryingNodeByName(v.name);
            if (vn) {
                // Source expression was collected into flowCode.vertex via flowNodeFromShaderStage
                // We need to find the expression for it. Re-generate with saved state.
                // The vertex-side source result is stored when flowNodeFromShaderStage ran.
                // We use a fresh generate call here to get the expression (CSE will return cached name).
                const prevBuildStage = this.buildStage;
                const prevShaderStage = this.shaderStage;
                this.buildStage = 'generate';
                this.shaderStage = 'vertex';
                const srcExpr = this._generateNode(vn.source) ?? '/* missing */';
                this.buildStage = prevBuildStage;
                this.shaderStage = prevShaderStage;
                lines.push(`    out.${v.name} = ${srcExpr};`);
            }
        }

        lines.push(`    return out;`);
        lines.push(`}`);

        return lines.join('\n');
    }

    private _getWGSLFragmentCode(): string {
        const lines: string[] = [];
        const varyingList = [...this.varyings.values()];
        const hasVaryings = varyingList.length > 0;

        const slots = this.input.kind === 'render' ? this.input.slots : null;
        const maskRoot  = slots?.mask;
        const depthRoot = slots?.depth;
        const hasDepth  = depthRoot !== undefined;

        if (hasVaryings) {
            lines.push(`struct FragmentInput {`);
            for (const v of varyingList) {
                lines.push(`    @location(${v.location}) ${v.name} : ${v.type},`);
            }
            lines.push(`}`);
            lines.push('');
        }

        // When depthNode is set, use a named output struct so we can attach
        // @builtin(frag_depth) alongside the colour attachment.
        if (hasDepth) {
            lines.push(`struct FragmentOutput {`);
            lines.push(`    @location(0) color : vec4f,`);
            lines.push(`    @builtin(frag_depth) frag_depth : f32,`);
            lines.push(`}`);
            lines.push('');
        }

        const inputParam = hasVaryings ? `in : FragmentInput` : ``;
        const returnType = hasDepth ? `-> FragmentOutput` : `-> @location(0) vec4f`;

        lines.push(`@fragment`);
        lines.push(`fn fs_main(${inputParam}) ${returnType} {`);

        // Emit var declarations preamble (VarNode declarations for this stage)
        const fragmentVars = this.getVars('fragment');
        if (fragmentVars) lines.push(fragmentVars.replace(/\n$/, ''));

        // maskNode: evaluate, then emit early-discard
        if (maskRoot) {
            const maskFlowData = this.flowResults.get(maskRoot);
            if (maskFlowData) {
                if (maskFlowData.code) lines.push(maskFlowData.code.replace(/\n$/, ''));
                lines.push(`    if (!(${maskFlowData.result})) { discard; }`);
            }
        }

        const colorRoot = slots?.color ?? null;
        if (colorRoot) {
            const flowData = this.flowResults.get(colorRoot);
            if (flowData) {
                if (flowData.code) lines.push(flowData.code.replace(/\n$/, ''));

                if (hasDepth) {
                    // depthNode: evaluate and emit into the output struct
                    const depthFlowData = this.flowResults.get(depthRoot!);
                    lines.push(`    var _out : FragmentOutput;`);
                    lines.push(`    _out.color = ${flowData.result};`);
                    if (depthFlowData) {
                        if (depthFlowData.code) lines.push(depthFlowData.code.replace(/\n$/, ''));
                        lines.push(`    _out.frag_depth = ${depthFlowData.result};`);
                    }
                    lines.push(`    return _out;`);
                } else {
                    lines.push(`    return ${flowData.result};`);
                }
            }
        }

        lines.push(`}`);
        return lines.join('\n');
    }

    _makeComputeResult(): ComputeCompileResult {
        if (this.input.kind !== 'compute') throw new Error('_makeComputeResult called on render builder');

        const lines: string[] = [];

        // Struct declarations
        for (const sn of this.structNodes.values()) {
            const members = sn.members.map((m) => `    ${m.name} : ${m.type},`).join('\n');
            lines.push(`struct ${sn.type} {\n${members}\n}`);
        }
        if (this.structNodes.size > 0) lines.push('');

        // Storage bindings (group 0) — inferred in _registerRoots
        const storageEntries: ComputeStorageEntry[] = [];
        for (let i = 0; i < this._computeStorage.length; i++) {
            const s = this._computeStorage[i];
            const name = this.storageNames.get(s.id) ?? `_cs${i}`;
            storageEntries.push({ node: s, name, type: s.storageType, access: s.access, binding: i });
            lines.push(`@group(0) @binding(${i}) var<storage, ${s.access}> ${name} : ${s.storageType};`);
        }
        if (storageEntries.length > 0) lines.push('');

        // ---------------------------------------------------------------------
        // Build uniform groups from buckets — same as render shaders
        // For compute: only render group (time uniforms), no object group
        // Storage is group 0, so uniforms go to group 1
        // ---------------------------------------------------------------------
        const uniformGroups: UniformGroupBlock[] = [];
        const sortedBuckets = [...this.uniformGroupBuckets.values()]
            .sort((a, b) => a.groupNode.order - b.groupNode.order);

        // For compute shaders: group 0 = storage, group 1 = render uniforms (time)
        let groupIndex = 1; // Start at 1 since storage is group 0
        for (const bucket of sortedBuckets) {
            if (bucket.nodes.length === 0) continue;

            const block = this._buildUniformGroupBlock(bucket.groupNode, bucket.nodes, groupIndex, 0);
            uniformGroups.push(block);

            // Emit struct definition + var declaration
            // Struct type name gets "Struct" suffix to avoid shadowing the variable name
            // (mirrors Three.js WGSLNodeBuilder._getWGSLStructBinding pattern)
            const structTypeName = bucket.groupNode.name + 'Struct';
            const memberLines = block.members.map(m => `    ${m.uniformId} : ${m.type},`).join('\n');
            lines.push(`struct ${structTypeName} {\n${memberLines}\n}`);
            lines.push(`@group(${groupIndex}) @binding(0) var<uniform> ${bucket.groupNode.name} : ${structTypeName};`);

            groupIndex++;
        }
        if (uniformGroups.length > 0) lines.push('');

        // User-defined Fn declarations
        for (const { fn, traced } of this.fnNodes.values()) {
            lines.push(this._emitFnDecl(fn, traced));
            lines.push('');
        }

        // @compute entry point
        const [wx, wy, wz] = this.input.node.workgroupSize;
        lines.push(`@compute @workgroup_size(${wx}, ${wy}, ${wz})`);

        const paramParts: string[] = [];
        for (const [kind, info] of Object.entries(COMPUTE_BUILTIN_PARAM)) {
            if (this.builtinsUsed.has(kind)) {
                paramParts.push(`    @builtin(${info.attr}) ${kind} : ${info.type}`);
            }
        }
        const paramList = paramParts.length > 0 ? '\n' + paramParts.join(',\n') + '\n' : '';
        lines.push(`fn cs_main(${paramList}) {`);

        // Emit var declarations preamble (VarNode declarations for this stage)
        const computeVars = this.getVars('compute');
        if (computeVars) lines.push(computeVars.replace(/\n$/, ''));

        // Emit the body StackNode
        const bodyRoot = this.flowNodes.compute[0];
        if (bodyRoot) {
            const flowData = this.flowResults.get(bodyRoot);
            if (flowData?.code) {
                lines.push(flowData.code.replace(/\n$/, ''));
            }
        }

        lines.push(`}`);

        return {
            code: lines.join('\n'),
            storage: storageEntries,
            workgroupSize: this.input.node.workgroupSize,
            builtinsUsed: new Set(this.builtinsUsed),
            uniformGroups,
        };
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
            // Bucket by groupNode.name — this is the new Three.js-aligned approach
            const groupName = node.groupNode.name;
            let bucket = b.uniformGroupBuckets.get(groupName);
            if (!bucket) {
                bucket = { groupNode: node.groupNode, nodes: [] };
                b.uniformGroupBuckets.set(groupName, bucket);
            }
            // Dedup by name (the WGSL field name)
            if (!bucket.nodes.some(n => n.name === node.name)) {
                bucket.nodes.push(node);
            }

            const uniformDef = lookupStructDefByName(node.type);
            if (uniformDef) b._registerStructDef(uniformDef);
        },
        generate: (node: UniformNode<WgslType>, _b: WgslBuilder) =>
            // New Three.js-aligned property access: groupName.fieldName
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
            if (!b.storageNodes.has(node.id)) {
                if (b.input.kind === 'compute') {
                    const idx = b._computeStorage.findIndex((s: StorageNode<WgslType>) => s.id === node.id);
                    const name = idx >= 0 ? `_cs${idx}` : `_cs${b.storageNodes.size}`;
                    b.storageNodes.set(node.id, node as unknown as StorageNode<WgslType>);
                    b.storageNames.set(node.id, name);
                } else {
                    const name = `_stor${b.storageNodes.size}`;
                    b.storageNodes.set(node.id, node as unknown as StorageNode<WgslType>);
                    b.storageNames.set(node.id, name);
                }
            }
            const storageDef = lookupStructDefByName(node.type);
            if (storageDef) b._registerStructDef(storageDef);
        },
        generate: (node: StorageNode<WgslType>, b: WgslBuilder) => b.storageNames.get(node.id) ?? node.id,
    },
    texture: {
        isStatement: false, isLeaf: true,
        setup: (node: TextureNode, b: WgslBuilder) => {
            const key = String(node.textureId);
            if (!b.textureNodes.has(key)) {
                b.textureNodes.set(key, node);
            }
        },
        generate: (node: TextureNode, _b: WgslBuilder) => `${node.textureId}_tex`,
    },
    sampler: {
        isStatement: false, isLeaf: true,
        setup: (node: SamplerNode, b: WgslBuilder) => {
            const key = String(node.samplerId);
            if (!b.samplerNodes.has(key)) {
                b.samplerNodes.set(key, node);
            }
        },
        generate: (node: SamplerNode, _b: WgslBuilder) => `${node.samplerId}_samp`,
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
            return node.wgsl.replace(/\$(\d+)/g, (_, i) => depExprs[parseInt(i, 10)] ?? `/* dep${i} */`);
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
