/**
 * compile.ts — Node graph → WGSL + binding metadata.
 *
 * Exports two pure entry-point functions:
 *   compile(slots)      → CompileResult        (render: vertex + fragment)
 *   compileCompute(node) → ComputeCompileResult (compute)
 *
 * Both functions create a single WgslBuilder internally. The builder follows
 * three.js NodeBuilder's three-pass architecture (setup → analyze → generate)
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
 * Key aligned patterns from three.js NodeBuilder:
 *   getDataFromNode(node, stage?)  — WeakMap<Node, NodeData> per-node-per-stage
 *   increaseUsage(node)            — called in analyze pass, replaces refCount()
 *   flow / addLineFlowCode         — code accumulation buffer
 *   flowChildNode / flowNodeFromShaderStage — for VaryingNode vertex-stage emit
 *   _buildNode(node)               — single dispatch entry (parallel to node.build(builder))
 *
 * What is NOT adopted from three.js:
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
    type AttributeNode,
    type CallNode,
    type FnNode,
    type ForNode,
    type IfNode,
    type InstancedBufferAttributeNode,
    type Node,
    type ParamDesc,
    type SamplerNode,
    type StorageNode,
    type StructNode,
    type TextureNode,
    type UniformNode,
    type VaryingNode,
    type WhileNode,
    type WgslType,
} from './nodes.js';
import { collectGraph, getChildren } from './collect.js';
import { type StructDef, type StructSchema } from './nodes.js';
import type { ComputeNode } from './compute-node.js';

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
          kind: 'instanced';
          node: InstancedBufferAttributeNode<WgslType>;
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
    uniforms: UniformBlockEntry[];
    storage: StorageEntry[];
    textures: TextureEntry[];
    samplers: SamplerEntry[];
    builtinsUsed: Set<string>;
};

export type CompileSlots = {
    position: Node<WgslType>;
    color: Node<WgslType>;
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
// Per-node state types (aligned with three.js getDataFromNode)
// ---------------------------------------------------------------------------

type NodeStageData = {
    usageCount?: number;       // populated in analyze pass
    propertyName?: string;     // CSE: var name when usageCount > 1
    initialized?: boolean;     // setup pass dedup guard
    varName?: string;          // registered var name (parallel to three.js nodeData.variable)
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
// Builder input discriminated union
// ---------------------------------------------------------------------------

type RenderInput = { kind: 'render'; slots: CompileSlots };
type ComputeInput = { kind: 'compute'; node: ComputeNode };

// ---------------------------------------------------------------------------
// WgslBuilder — the single unified builder class
// ---------------------------------------------------------------------------

export class WgslBuilder {
    // Build stage cursor (parallel to three.js NodeBuilder.buildStage)
    buildStage: 'setup' | 'analyze' | 'generate' | null = null;
    // Shader stage cursor (parallel to three.js NodeBuilder.shaderStage)
    shaderStage: 'vertex' | 'fragment' | 'compute' | null = null;

    // Per-node WeakMap state (parallel to three.js NodeBuilder.nodeData)
    nodeData: WeakMap<Node<WgslType>, NodeData> = new WeakMap();

    // Current writable code buffer (parallel to three.js NodeBuilder.flow)
    flow: { code: string } = { code: '' };
    // Per-stage accumulated code (from flowChildNode calls)
    flowCode: Record<string, string> = { vertex: '', fragment: '', compute: '' };

    // CSE var counter
    varCounter = 0;
    // For-loop index counter
    forCounter = 0;

    // Per-stage var declaration registry (parallel to three.js this.vars[shaderStage])
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
    instancedAttrs: Array<AttributeEntry & { kind: 'instanced' }> = [];
    instancedAttrNames: Map<string, string> = new Map();
    varyings: Map<string, VaryingEntry> = new Map();
    builtinsUsed: Set<string> = new Set();
    structNodes: Map<string, StructNode> = new Map();
    uniformNodes: Map<string, UniformNode<WgslType>> = new Map();
    storageNodes: Map<string, StorageNode<WgslType>> = new Map();
    storageNames: Map<string, string> = new Map();
    textureNodes: Map<string, TextureNode> = new Map();
    samplerNodes: Map<string, SamplerNode> = new Map();
    fnNodes: Map<string, { fn: FnNode<WgslType>; traced: TracedFn }> = new Map();

    // All nodes seen (for expression lookup during generate)
    allNodes: Map<string, Node<WgslType>> = new Map();

    constructor(input: RenderInput | ComputeInput) {
        this.input = input;
    }

    // -----------------------------------------------------------------------
    // Top-level orchestrator: setup → analyze → generate → buildCode
    // (Parallel to three.js NodeBuilder.build())
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
        return this;
    }

    // -----------------------------------------------------------------------
    // Register root nodes per stage
    // -----------------------------------------------------------------------

    private _registerRoots(): void {
        if (this.input.kind === 'render') {
            const { position, color } = this.input.slots;
            // Stage validation: fragment graph must not contain vertex-only nodes
            this._validateFragmentRoot(color);
            this.flowNodes.vertex.push(position);
            this.flowNodes.fragment.push(color);
        } else {
            // Compute: register builtin + storage nodes into allNodes pre-setup
            const { builtins, body } = this.input.node.trace();
            // Store the traced result on the ComputeNode's nodeData for later
            const data = this.getDataFromNode(this.input.node as unknown as Node<WgslType>, 'any');
            (data as NodeStageData & { _traced?: { builtins: typeof builtins; body: typeof body } })._traced = { builtins, body };

            for (const bNode of Object.values(builtins)) {
                this.allNodes.set(bNode.id, bNode as unknown as Node<WgslType>);
            }
            for (const s of this.input.node.storage) {
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
            if (node.kind === 'instanced_buffer_attribute') {
                throw new Error(
                    `[gpucat] instancedBufferAttribute() is a vertex-only node and cannot be used ` +
                    `in the fragment graph. Bridge it to the fragment stage with varying('<type>', '<name>', <node>).`,
                );
            }
        }
    }

    // -----------------------------------------------------------------------
    // getDataFromNode — WeakMap per-node-per-stage state
    // (Parallel to three.js NodeBuilder.getDataFromNode)
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
    // (Parallel to three.js NodeBuilder.increaseUsage)
    // -----------------------------------------------------------------------

    increaseUsage(node: Node<WgslType>): number {
        const data = this.getDataFromNode(node);
        data.usageCount = (data.usageCount ?? 0) + 1;
        return data.usageCount;
    }

    // -----------------------------------------------------------------------
    // Flow accumulation helpers
    // (Parallel to three.js NodeBuilder.addLineFlowCode / addFlowCode)
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
    // (Parallel to three.js NodeBuilder.getVarFromNode)
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
    // (Parallel to three.js WGSLNodeBuilder.getVars)
    // -----------------------------------------------------------------------

    getVars(stage: string): string {
        const vars = this.stageVars[stage];
        if (!vars || vars.length === 0) return '';
        return vars.map((v) => `    var ${v.name} : ${v.type};`).join('\n') + '\n';
    }

    // -----------------------------------------------------------------------
    // flowChildNode — saves/installs/restores the flow buffer
    // (Parallel to three.js NodeBuilder.flowChildNode)
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
    // (Parallel to three.js NodeBuilder.flowNodeFromShaderStage)
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
    // (Parallel to node.build(builder, output) in three.js)
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

        // Delegate resource registration to the node class
        node.setup(this);
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
    // (Parallel to three.js Node.analyze calling increaseUsage)
    // -----------------------------------------------------------------------

    private _analyzeNode(node: Node<WgslType>): void {
        const count = this.increaseUsage(node);

        // Only recurse into children the first time we see this node (count === 1).
        // This is the same deduplication as three.js: if count > 1, we know we've
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
    // (Parallel to TempNode.build in three.js)
    // -----------------------------------------------------------------------

    _generateNode(node: Node<WgslType>): string | null {
        const data = this.getDataFromNode(node);

        // CSE hit: already emitted as a var
        if (data.propertyName !== undefined) return data.propertyName;

        // Check if this is a statement-level node (should not be CSE'd)
        const isStatement = (
            node.kind === 'var' ||
            node.kind === 'assign' ||
            node.kind === 'if' ||
            node.kind === 'for' ||
            node.kind === 'while' ||
            node.kind === 'break' ||
            node.kind === 'continue' ||
            node.kind === 'return' ||
            node.kind === 'stack'
        );

        // Leaf nodes that produce a bare identifier (no computation) — skip CSE.
        // Re-emitting "camera" or "in.position" is free; extracting it to a let
        // binding would produce confusing output and break tests that check for
        // the literal identifier in the generated code.
        const isLeafIdentifier = (
            node.kind === 'const' ||
            node.kind === 'attribute' ||
            node.kind === 'instanced_buffer_attribute' ||
            node.kind === 'builtin' ||
            node.kind === 'uniform' ||
            node.kind === 'storage' ||
            node.kind === 'texture' ||
            node.kind === 'sampler' ||
            node.kind === 'param' ||
            node.kind === 'varying' ||
            node.kind === 'struct' ||
            node.kind === 'fn'
        );

        if (!isStatement && !isLeafIdentifier && (data.usageCount ?? 0) > 1) {
            // CSE: emit a var and cache its name
            const snippet = this._generateNodeExpr(node);
            const varName = `_v${this.varCounter++}`;
            this.addLineFlowCode(`let ${varName} = ${snippet}`);
            data.propertyName = varName;
            return varName;
        }

        return this._generateNodeExpr(node);
    }

    // -----------------------------------------------------------------------
    // _generateNodeExpr — delegate to node.generate(this)
    // -----------------------------------------------------------------------

    _generateNodeExpr(node: Node<WgslType>): string | null {
        return node.generate(this);
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

        // Struct declarations — only user-defined structs (Mesh is now flat bindings)
        for (const sn of this.structNodes.values()) {
            const members = sn.members.map((m) => `    ${m.name} : ${m.type},`).join('\n');
            lines.push(`struct ${sn.type} {\n${members}\n}`);
        }

        // Builtin UBO bindings — flat per-field, three.js style
        // Camera fields: bindings 0–4 (conditional on 'camera' being used)
        if (this.builtinsUsed.has('camera')) {
            lines.push(`@group(0) @binding(0) var<uniform> cameraProjectionMatrix : mat4x4f;`);
            lines.push(`@group(0) @binding(1) var<uniform> cameraViewMatrix : mat4x4f;`);
            lines.push(`@group(0) @binding(2) var<uniform> cameraPosition : vec3f;`);
            lines.push(`@group(0) @binding(3) var<uniform> cameraNear : f32;`);
            lines.push(`@group(0) @binding(4) var<uniform> cameraFar : f32;`);
        }
        // Time fields: bindings 5–6 (conditional on 'time' being used)
        if (this.builtinsUsed.has('time')) {
            lines.push(`@group(0) @binding(5) var<uniform> timeElapsed : f32;`);
            lines.push(`@group(0) @binding(6) var<uniform> timeDelta : f32;`);
        }
        // Mesh fields: bindings 0–1 at group 1 (conditional on 'mesh' being used)
        if (this.builtinsUsed.has('mesh')) {
            lines.push(`@group(1) @binding(0) var<uniform> meshModelMatrix : mat4x4f;`);
            lines.push(`@group(1) @binding(1) var<uniform> meshNormalMatrix : mat3x3f;`);
        }

        // Material resources — start at binding 2 (mesh bindings occupy 0 and 1)
        let matBinding = 2;

        const matUniforms = [...this.uniformNodes.values()];
        let uniformBlockEntry: UniformBlockEntry | null = null;
        if (matUniforms.length > 0) {
            uniformBlockEntry = this._buildUniformBlock(matUniforms, 1, matBinding);
            lines.push(this._emitMaterialUniformBlock(uniformBlockEntry));
            matBinding++;
        }

        const storageEntries: StorageEntry[] = [];
        for (const sn of this.storageNodes.values()) {
            const name = this.storageNames.get(sn.id)!;
            // Render shaders share a single WGSL module between vertex and fragment stages.
            // WGSL forbids var<storage, read_write> from being visible to the vertex stage,
            // so always emit read access in render shaders — the buffer can still be written
            // by a compute pass.  Only compute shaders get the true read_write access mode.
            const wgslAccess = 'read';
            storageEntries.push({ node: sn, name, type: sn.storageType, access: sn.access, group: 1, binding: matBinding });
            lines.push(`@group(1) @binding(${matBinding}) var<storage, ${wgslAccess}> ${name} : ${sn.storageType};`);
            matBinding++;
        }

        const textureEntries: TextureEntry[] = [];
        for (const tn of this.textureNodes.values()) {
            textureEntries.push({ textureId: tn.textureId, type: tn.type, group: 1, binding: matBinding, node: tn });
            lines.push(`@group(1) @binding(${matBinding}) var ${tn.textureId}_tex : ${tn.type};`);
            matBinding++;
        }

        const samplerEntries: SamplerEntry[] = [];
        for (const sn of this.samplerNodes.values()) {
            samplerEntries.push({ samplerId: sn.samplerId, type: sn.type, group: 1, binding: matBinding, node: sn });
            lines.push(`@group(1) @binding(${matBinding}) var ${sn.samplerId}_samp : ${sn.type};`);
            matBinding++;
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
            ...this.instancedAttrs,
        ];
        const varyings = [...this.varyings.values()];

        return {
            code: lines.join('\n'),
            attributes,
            varyings,
            uniforms: uniformBlockEntry ? [uniformBlockEntry] : [],
            storage: storageEntries,
            textures: textureEntries,
            samplers: samplerEntries,
            builtinsUsed: new Set(this.builtinsUsed),
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
        for (const a of this.instancedAttrs) {
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

        if (hasVaryings) {
            lines.push(`struct FragmentInput {`);
            for (const v of varyingList) {
                lines.push(`    @location(${v.location}) ${v.name} : ${v.type},`);
            }
            lines.push(`}`);
            lines.push('');
        }

        const inputParam = hasVaryings ? `in : FragmentInput` : ``;

        lines.push(`@fragment`);
        lines.push(`fn fs_main(${inputParam}) -> @location(0) vec4f {`);

        // Emit var declarations preamble (VarNode declarations for this stage)
        const fragmentVars = this.getVars('fragment');
        if (fragmentVars) lines.push(fragmentVars.replace(/\n$/, ''));

        const colorRoot = this.input.kind === 'render' ? this.input.slots.color : null;
        if (colorRoot) {
            const flowData = this.flowResults.get(colorRoot);
            if (flowData) {
                if (flowData.code) lines.push(flowData.code.replace(/\n$/, ''));
                lines.push(`    return ${flowData.result};`);
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

        // Storage bindings (group 0)
        const storageEntries: ComputeStorageEntry[] = [];
        for (let i = 0; i < this.input.node.storage.length; i++) {
            const s = this.input.node.storage[i];
            const name = this.storageNames.get(s.id) ?? `_cs${i}`;
            storageEntries.push({ node: s, name, type: s.storageType, access: s.access, binding: i });
            lines.push(`@group(0) @binding(${i}) var<storage, ${s.access}> ${name} : ${s.storageType};`);
        }
        if (storageEntries.length > 0) lines.push('');

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
        };
    }

    // -----------------------------------------------------------------------
    // Uniform block helpers
    // -----------------------------------------------------------------------

    private _buildUniformBlock(
        nodes: UniformNode<WgslType>[],
        group: 0 | 1,
        binding: number,
    ): UniformBlockEntry {
        const members: UniformMember[] = [];
        let offset = 0;
        for (const n of nodes) {
            const align = std140Align(n.type);
            const size = std140Size(n.type);
            offset = alignUp(offset, align);
            members.push({ uniformId: n.uniformId, type: n.type, offset, size, node: n });
            offset += size;
        }
        const totalBytes = alignUp(offset, 16);
        return { group, binding, members, totalBytes };
    }

    private _emitMaterialUniformBlock(block: UniformBlockEntry): string {
        const members = block.members.map((m) => `    ${m.uniformId} : ${m.type},`).join('\n');
        return [
            `struct MaterialUniforms {`,
            members,
            `}`,
            `@group(${block.group}) @binding(${block.binding}) var<uniform> materialUniforms : MaterialUniforms;`,
        ].join('\n');
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
