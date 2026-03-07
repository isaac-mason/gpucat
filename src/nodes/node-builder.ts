import type { NodeFrame } from '../renderer/node-frame';
import type {
    BufferAttributeNode,
    ComputeNode,
    FnNode,
    IfNode,
    LoopNode,
    Node,
    OutputStructNode,
    StackNode,
    StorageNode,
    StructDef,
    StructNode,
    TextureNode,
    UniformGroupNode,
    WgslFnNode,
    WgslType,
    InterpolationType,
    InterpolationSampling,
} from './nodes';
import {
    expression,
    MRTNode,
    popStack,
    pushStack,
    StackNode as StackNodeClass,
    ConstNode,
    UniformNode,
    AttributeNode,
    BinopNode,
    CallNode,
    BuiltinNode,
    VaryingNode,
    FieldNode,
} from './nodes';
import type { StructSchema } from './schema';

/** Interface for nodes that need to execute GPU work before the final composite quad each frame/render/object */
export type UpdateBeforeNode = {
    readonly id: string;
    readonly updateBeforeType: NodeUpdateType;
    updateBefore(frame: NodeFrame): boolean | void;
};

/** Interface for nodes that need to execute GPU work after each draw call */
export type UpdateAfterNode = {
    readonly id: string;
    readonly updateAfterType: NodeUpdateType;
    updateAfter(frame: NodeFrame): boolean | void;
};

/** Interface for nodes that push CPU data into GPU uniforms each frame/render/object */
export type UpdateNode = {
    readonly id: string;
    readonly updateType: NodeUpdateType;
    update(frame: NodeFrame): boolean | void;
};

export type NodeUpdateType = 'none' | 'frame' | 'render' | 'object';

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
    interpolationType: InterpolationType | null;
    interpolationSampling: InterpolationSampling | null;
};

/**
 * VaryingData - data stored for a varying node (Three.js: NodeVarying pattern)
 */
export type VaryingData = {
    name: string;
    type: string;
    interpolationType: InterpolationType | null;
    interpolationSampling: InterpolationSampling | null;
    needsInterpolation: boolean;
};

export type UniformMember = {
    uniformId: string;
    type: string;
    offset: number;
    size: number;
    node: UniformNode<WgslType>;
};

export type UniformGroupBlock = {
    groupName: string;
    groupIndex: number;
    binding: number;
    shared: boolean;
    members: UniformMember[];
    totalBytes: number;
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

export type ComputeStorageEntry = {
    node: StorageNode<WgslType>;
    name: string;
    type: string;
    access: 'read' | 'read_write';
    group: number;
    binding: number;
};

/** Types of bindings that can be in a bind group */
type BindingType = 'uniform' | 'storage' | 'texture' | 'sampler';

/** A single binding entry in a bind group */
export type BindingEntry = {
    type: BindingType;
    name: string;
    groupNode: UniformGroupNode;
    node: UniformNode<WgslType> | StorageNode<WgslType> | TextureNode;
    uniforms?: UniformNode<WgslType>[];
};

/** A bind group containing multiple bindings */
export type BindGroup = {
    name: string;
    index: number;
    bindings: BindingEntry[];
    groupNode: UniformGroupNode;
};

/** Per-node data collected for the inspector graph */
export type NodeGraphInfo = {
    stages: ReadonlyArray<'vertex' | 'fragment' | 'compute'>;
    cseVar: string | undefined;
    usageCount: number;
    expression: string | undefined;
};

export type CompileResult = {
    code: string;
    attributes: AttributeEntry[];
    varyings: VaryingEntry[];
    uniformGroups: UniformGroupBlock[];
    storage: StorageEntry[];
    textures: TextureEntry[];
    samplers: SamplerEntry[];
    builtinsUsed: Set<string>;
    updateBeforeNodes: UpdateBeforeNode[];
    updateAfterNodes: UpdateAfterNode[];
    updateNodes: UpdateNode[];
    graphNodes: ReadonlyMap<string, Node<WgslType>>;
    graphEdges: ReadonlyMap<string, readonly string[]>;
    graphInfo: ReadonlyMap<string, NodeGraphInfo>;
};

export type CompileSlots = {
    position: Node<WgslType>;
    color: Node<WgslType>;
    mask?: Node<WgslType>;
    depth?: Node<WgslType>;
};

export type ComputeCompileResult = {
    code: string;
    storage: ComputeStorageEntry[];
    workgroupSize: [number, number, number];
    builtinsUsed: Set<string>;
    uniformGroups: UniformGroupBlock[];
};

type RenderInput = { kind: 'render'; slots: CompileSlots };
type ComputeInput = { kind: 'compute'; node: ComputeNode };

// ---------------------------------------------------------------------------
// NodeProperties — per-node state that persists across build stages
// ---------------------------------------------------------------------------

export type NodeProperties = {
    outputNode?: Node<WgslType> | null;
    initialized?: boolean;
    stackNode?: StackNode;
    [key: `node${number}`]: Node<WgslType> | undefined;
    [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// NodeData — lower-level per-node data
// ---------------------------------------------------------------------------

export type NodeData = {
    usageCount?: number;
    propertyName?: string;
    varName?: string;
    snippet?: string;
    type?: string;
    typeFromOutput?: Record<string, string>;
    initialized?: boolean;
    generated?: boolean;
    buildStages?: Record<string, boolean>;
    properties?: NodeProperties;
    stackNode?: unknown;
    stages?: Record<string, Node<WgslType>[]>;
    varying?: VaryingData;
    /** Cached NodeFunction for FunctionNode (Three.js aligned) */
    nodeFunction?: unknown;
    /** Cached NodeCode for CodeNode/FunctionNode (Three.js aligned) */
    code?: NodeCode;
};

export type NodeStageDataMap = {
    vertex?: NodeData;
    fragment?: NodeData;
    compute?: NodeData;
    any?: NodeData;
    fn?: NodeData;
};

type TracedFn = ReturnType<FnNode<WgslType>['trace']>;

// ---------------------------------------------------------------------------
// NodeCode — Three.js aligned: represents native shader code portions
// ---------------------------------------------------------------------------

/**
 * NodeBuilder creates instances of this class during the build process of nodes.
 * They represent user-defined, native shader code portions that are injected by
 * the builder. A dictionary of node codes is maintained in NodeBuilder.codes.
 * 
 * Three.js aligned: three/src/nodes/core/NodeCode.js
 */
export class NodeCode {
    /** The name of the code (function name). */
    name: string;
    
    /** The node type (return type). */
    type: string;
    
    /** The native shader code. */
    code: string;

    /** Type marker for runtime checking. */
    readonly isNodeCode = true;

    constructor(name: string, type: string, code = '') {
        this.name = name;
        this.type = type;
        this.code = code;
    }
}

// ---------------------------------------------------------------------------
// NodeCache — Three.js aligned cache for node data
// ---------------------------------------------------------------------------

let _nodeCacheId = 0;

/**
 * This utility class is used in NodeBuilder as an internal
 * cache data structure for node data.
 * Three.js aligned: exact copy of NodeCache.
 */
export class NodeCache {
    /** The id of the cache. */
    readonly id: number;

    /** A weak map for managing node data. */
    nodesData: WeakMap<Node<WgslType>, NodeData> = new WeakMap();

    /** Reference to a parent node cache. */
    parent: NodeCache | null;

    constructor(parent: NodeCache | null = null) {
        this.id = _nodeCacheId++;
        this.parent = parent;
    }

    /**
     * Returns the data for the given node.
     */
    getData(node: Node<WgslType>): NodeData | undefined {
        let data = this.nodesData.get(node);

        if (data === undefined && this.parent !== null) {
            data = this.parent.getData(node);
        }

        return data;
    }

    /**
     * Sets the data for a given node.
     */
    setData(node: Node<WgslType>, data: NodeData): void {
        this.nodesData.set(node, data);
    }
}

// Builtin WGSL variable names for compute stage
const COMPUTE_BUILTIN_PARAM: Record<string, { attr: string; type: string }> = {
    global_invocation_id: { attr: 'global_invocation_id', type: 'vec3u' },
    local_invocation_id: { attr: 'local_invocation_id', type: 'vec3u' },
    local_invocation_index: { attr: 'local_invocation_index', type: 'u32' },
    workgroup_id: { attr: 'workgroup_id', type: 'vec3u' },
    num_workgroups: { attr: 'num_workgroups', type: 'vec3u' },
};

// ---------------------------------------------------------------------------
// NodeBuilder class — THE single compilation context
// ---------------------------------------------------------------------------

/**
 * NodeBuilder provides the Three.js-aligned API for node compilation.
 * This is the SINGLE class holding ALL state and orchestrating compilation.
 */
export class NodeBuilder {
    // =========================================================================
    // Build/Shader stage cursors
    // =========================================================================
    
    buildStage: 'setup' | 'analyze' | 'generate' | null = null;
    shaderStage: 'vertex' | 'fragment' | 'compute' | null = null;

    // =========================================================================
    // Per-node data storage (WeakMap for GC)
    // =========================================================================
    
    private nodeDataMap: WeakMap<Node<WgslType>, NodeStageDataMap> = new WeakMap();

    // =========================================================================
    // Stack management
    // =========================================================================
    
    private stackArray: StackNode[] = [];
    stack: StackNode | null = null;

    // =========================================================================
    // Flow code buffers
    // =========================================================================
    
    flow: { code: string } = { code: '' };
    flowCode: Record<string, string> = { vertex: '', fragment: '', compute: '' };
    tab: string = '    ';

    // =========================================================================
    // Counters
    // =========================================================================
    
    varCounter: number = 0;
    forCounter: number = 0;

    // =========================================================================
    // Chain for cycle detection
    // =========================================================================
    
    private chain: Node<WgslType>[] = [];

    // =========================================================================
    // Input
    // =========================================================================
    
    input: RenderInput | ComputeInput | null = null;

    // =========================================================================
    // Root nodes per stage
    // =========================================================================
    
    flowNodes: {
        vertex: Node<WgslType>[];
        fragment: Node<WgslType>[];
        compute: Node<WgslType>[];
    } = { vertex: [], fragment: [], compute: [] };

    // Accumulated flow results per root node
    flowResults: Map<Node<WgslType>, { code: string; result: string | null }> = new Map();

    // =========================================================================
    // Per-stage var declaration registry
    // =========================================================================
    
    stageVars: Record<string, { name: string; type: string }[]> = {};

    // =========================================================================
    // Collected resources
    // =========================================================================
    
    attributes: Map<string, AttributeEntry & { kind: 'geometry' }> = new Map();
    bufferAttrs: Array<AttributeEntry & { kind: 'buffer' }> = [];
    bufferAttrNames: Map<string, string> = new Map();
    varyings: Map<string, VaryingEntry> = new Map();
    builtinsUsed: Set<string> = new Set();
    structNodes: Map<string, StructNode> = new Map();

    // =========================================================================
    // WGSL enable-directives per shader stage
    // =========================================================================
    
    directives: {
        vertex: Set<string>;
        fragment: Set<string>;
        compute: Set<string>;
    } = {
        vertex: new Set(),
        fragment: new Set(),
        compute: new Set(),
    };

    // =========================================================================
    // Bindings
    // =========================================================================
    
    bindings: {
        vertex: Record<string, BindingEntry[]>;
        fragment: Record<string, BindingEntry[]>;
        compute: Record<string, BindingEntry[]>;
    } = { vertex: {}, fragment: {}, compute: {} };

    bindingsIndexes: Record<string, { binding: number; group: number }> = {};
    bindGroups: BindGroup[] | null = null;
    uniformGroups: Record<string, BindingEntry> = {};
    textureBindings: Record<string, BindingEntry> = {};
    samplerBindings: Record<string, BindingEntry> = {};
    storageBindings: Record<string, BindingEntry> = {};
    storageNames: Map<string, string> = new Map();

    // =========================================================================
    // Function nodes
    // =========================================================================
    
    fnNodes: Map<string, { fn: FnNode<WgslType>; traced: TracedFn }> = new Map();
    
    /**
     * Three.js aligned: per-stage array of NodeCode objects.
     * CodeNode.generate() registers functions into codes[shaderStage].
     * getCodes(shaderStage) joins them for emission into the shader.
     */
    codes: Record<string, NodeCode[]> = {};

    // =========================================================================
    // All nodes seen (for expression lookup during generate)
    // =========================================================================
    
    allNodes: Map<string, Node<WgslType>> = new Map();

    // =========================================================================
    // Storage nodes inferred from compute trace
    // =========================================================================
    
    computeStorage: StorageNode<WgslType>[] = [];

    // =========================================================================
    // Lifecycle callback nodes
    // =========================================================================
    
    sequentialNodes: Set<UpdateBeforeNode | UpdateAfterNode> = new Set();
    updateBeforeNodes: UpdateBeforeNode[] = [];
    updateAfterNodes: UpdateAfterNode[] = [];
    updateNodes: UpdateNode[] = [];

    // =========================================================================
    // Three.js aligned: nodes list and hash map
    // =========================================================================

    /** All nodes added during build (Three.js: nodes) */
    nodes: Node<WgslType>[] = [];

    /** Hash map for node deduplication (Three.js: hashNodes) */
    hashNodes: Record<string, Node<WgslType>> = {};

    // =========================================================================
    // Three.js aligned: context and cache
    // =========================================================================

    /** Builder context object (Three.js: context) */
    context: Record<string, unknown> = {};

    /** Node cache for current build (Three.js: cache) */
    cache: NodeCache = new NodeCache();

    /** Global node cache shared across builds (Three.js: globalCache) */
    globalCache: NodeCache = new NodeCache();

    // =========================================================================
    // Three.js aligned: sub-build layers (for VaryingNode cross-stage building)
    // =========================================================================

    /** Stack of sub-build layer names (Three.js: subBuildLayers) */
    subBuildLayers: string[] = [];

    // =========================================================================
    // Build results
    // =========================================================================
    
    renderResult: CompileResult | null = null;
    computeResult: ComputeCompileResult | null = null;

    // =========================================================================
    // Constructor
    // =========================================================================

    constructor(input?: RenderInput | ComputeInput) {
        if (input) {
            this.input = input;
        }
    }

    // =========================================================================
    // Main build() entry point — Three.js aligned
    // =========================================================================

    /**
     * Main compilation entry point. Orchestrates the full build process:
     *   1. registerRoots() — register root nodes per stage
     *   2. setup pass — walk from roots, register resources
     *   3. analyze pass — count usage for CSE
     *   4. generate pass — emit WGSL code
     *   5. buildCode() — assemble final shader strings
     */
    build(): void {
        this.registerRoots();

        // setup() -> stage 1: create possible new nodes and/or return an output reference node
        // analyze() -> stage 2: analyze nodes to possible optimization and validation
        // generate() -> stage 3: generate shader

        const buildStages = ['setup', 'analyze', 'generate'] as const;
        const shaderStages = this.input!.kind === 'render' 
            ? (['vertex', 'fragment'] as const) 
            : (['compute'] as const);

        for (const buildStage of buildStages) {
            this.setBuildStage(buildStage);

            for (const shaderStage of shaderStages) {
                this.setShaderStage(shaderStage);

                const flowNodes = this.flowNodes[shaderStage];

                for (const node of flowNodes) {
                    if (buildStage === 'generate') {
                        this.flowNode(node);
                    } else {
                        node.build(this);
                    }
                }
            }
        }

        this.setBuildStage(null);
        this.setShaderStage(null);

        // stage 4: build code for a specific output
        this.buildCode();
        this.buildUpdateNodes();
    }

    /**
     * Executes the flow for a node.
     * Three.js aligned: NodeBuilder.flowNode().
     */
    flowNode(node: Node<WgslType>): { code: string; result: string | null } {
        const output = node.getNodeType(this);
        const flowData = this.flowChildNode(node, output);
        this.flowResults.set(node, flowData);
        return flowData;
    }

    // =========================================================================
    // Per-node data access (Three.js: getDataFromNode)
    // =========================================================================

    getDataFromNode(node: Node<WgslType>, shaderStage?: string): NodeData {
        let stageMap = this.nodeDataMap.get(node);
        if (!stageMap) {
            stageMap = {};
            this.nodeDataMap.set(node, stageMap);
        }

        const stage = (shaderStage ?? this.shaderStage ?? 'any') as keyof NodeStageDataMap;
        let data = stageMap[stage];
        if (!data) {
            data = {};
            stageMap[stage] = data;
        }

        return data;
    }

    getNodeProperties(node: Node<WgslType>, shaderStage?: string): NodeProperties {
        const data = this.getDataFromNode(node, shaderStage);
        if (!data.properties) {
            data.properties = { outputNode: null };
        }
        return data.properties;
    }

    /**
     * Returns an instance of NodeCode for the given code node.
     * Three.js aligned: NodeBuilder.getCodeFromNode()
     * 
     * Idempotent registration — if already registered, returns existing NodeCode.
     * 
     * @param node - The CodeNode/FunctionNode
     * @param type - The node type (return type)
     * @param shaderStage - The shader stage to register into (defaults to current)
     */
    getCodeFromNode(node: Node<WgslType>, type: string, shaderStage: string = this.shaderStage ?? 'fragment'): NodeCode {
        const nodeData = this.getDataFromNode(node);

        let nodeCode = nodeData.code;

        if (nodeCode === undefined) {
            const codes = this.codes[shaderStage] || (this.codes[shaderStage] = []);
            const index = codes.length;

            nodeCode = new NodeCode('nodeCode' + index, type);

            codes.push(nodeCode);

            nodeData.code = nodeCode;
        }

        return nodeCode;
    }

    // =========================================================================
    // Usage tracking (Three.js: increaseUsage)
    // =========================================================================

    increaseUsage(node: Node<WgslType>): number {
        const data = this.getDataFromNode(node);
        data.usageCount = (data.usageCount ?? 0) + 1;
        return data.usageCount;
    }

    getUsageCount(node: Node<WgslType>): number {
        const data = this.getDataFromNode(node);
        return data.usageCount ?? 0;
    }

    // =========================================================================
    // Node management (Three.js aligned)
    // =========================================================================

    /**
     * Sets the given node with the given hash into the hash map.
     * Three.js aligned: NodeBuilder.setHashNode().
     */
    setHashNode(node: Node<WgslType>, hash: string): void {
        this.hashNodes[hash] = node;
    }

    /**
     * Adds a node to this builder.
     * Three.js aligned: NodeBuilder.addNode().
     */
    addNode(node: Node<WgslType>): void {
        if (this.nodes.includes(node) === false) {
            this.nodes.push(node);
            this.setHashNode(node, node.getHash(this));
            
            // gpucat: auto-detect f16 types and enable directive
            if (node.type && this.requiresF16Directive(node.type)) {
                this.enableDirective('f16');
            }
        }
    }

    /**
     * Returns a node from the hash map by its hash.
     * Three.js aligned: NodeBuilder.getNodeFromHash().
     */
    getNodeFromHash(hash: string): Node<WgslType> | undefined {
        return this.hashNodes[hash];
    }

    /**
     * Adds a node to sequential nodes for update callbacks.
     * Three.js aligned: NodeBuilder.addSequentialNode().
     */
    addSequentialNode(node: Node<WgslType>): void {
        const updateBeforeType = node.updateBeforeType;
        const updateAfterType = node.updateAfterType;

        if (updateBeforeType !== 'none' || updateAfterType !== 'none') {
            if (!this.sequentialNodes.has(node as unknown as UpdateBeforeNode | UpdateAfterNode)) {
                this.sequentialNodes.add(node as unknown as UpdateBeforeNode | UpdateAfterNode);
            }
        }
    }

    // =========================================================================
    // Context management (Three.js aligned)
    // =========================================================================

    /**
     * Sets builder's context.
     * Three.js aligned: NodeBuilder.setContext().
     */
    setContext(context: Record<string, unknown>): void {
        this.context = context;
    }

    /**
     * Returns the builder's current context.
     * Three.js aligned: NodeBuilder.getContext().
     */
    getContext(): Record<string, unknown> {
        return this.context;
    }

    /**
     * Adds context data to the builder's current context.
     * Three.js aligned: NodeBuilder.addContext().
     */
    addContext(context: Record<string, unknown>): Record<string, unknown> {
        const previousContext = this.getContext();
        this.setContext({ ...this.context, ...context });
        return previousContext;
    }

    // =========================================================================
    // Cache management (Three.js aligned)
    // =========================================================================

    /**
     * Sets builder's cache.
     * Three.js aligned: NodeBuilder.setCache().
     */
    setCache(cache: NodeCache): void {
        this.cache = cache;
    }

    /**
     * Returns the builder's current cache.
     * Three.js aligned: NodeBuilder.getCache().
     */
    getCache(): NodeCache {
        return this.cache;
    }

    // =========================================================================
    // Stack management (Three.js: addStack / removeStack)
    // =========================================================================

    addStack(stack: StackNode): StackNode {
        if (this.stack) {
            this.stackArray.push(this.stack);
        }
        this.stack = stack;
        return stack;
    }

    removeStack(): StackNode | null {
        const lastStack = this.stack;
        this.stack = this.stackArray.pop() ?? null;
        return lastStack;
    }

    // =========================================================================
    // Flow code generation
    // =========================================================================

    addFlowCode(code: string): this {
        this.flow.code += code;
        return this;
    }

    addLineFlowCode(line: string): this {
        if (!line.trim()) return this;
        const trimmed = line.trimEnd();
        const needsSemi = !trimmed.endsWith(';') && !trimmed.endsWith('{') && !trimmed.endsWith('}');
        this.flow.code += this.tab + trimmed + (needsSemi ? ';\n' : '\n');
        return this;
    }

    addFlowTab(): this {
        this.tab += '    ';
        return this;
    }

    removeFlowTab(): this {
        this.tab = this.tab.slice(0, -4);
        return this;
    }

    // =========================================================================
    // Variable management
    // =========================================================================

    getVarFromNode(node: Node<WgslType>, name: string | null, type: string): string {
        const stage = this.shaderStage ?? 'fn';
        const data = this.getDataFromNode(node, stage);

        if (data.varName === undefined) {
            const vars = this.stageVars[stage] ?? (this.stageVars[stage] = []);
            const varName = name ?? `_v${this.varCounter++}`;
            vars.push({ name: varName, type });
            data.varName = varName;
        }

        return data.varName;
    }

    getUniqueVarName(): string {
        return `_v${this.varCounter++}`;
    }

    getNextForIndex(): number {
        return this.forCounter++;
    }

    // =========================================================================
    // Type formatting (Three.js aligned)
    // =========================================================================

    /**
     * Formats the given snippet with a type conversion if needed.
     * Three.js aligned: NodeBuilder.format().
     */
    format(snippet: string, fromType: string, toType?: string | null): string {
        fromType = this.getVectorType(fromType);
        toType = toType ? this.getVectorType(toType) : null;

        if (fromType === toType || toType === null || this.isReference(toType)) {
            return snippet;
        }

        const fromTypeLength = this.getTypeLength(fromType);
        const toTypeLength = this.getTypeLength(toType);

        if (fromTypeLength === 16 && toTypeLength === 9) {
            return `${this.getType(toType)}(${snippet}[0].xyz, ${snippet}[1].xyz, ${snippet}[2].xyz)`;
        }

        if (fromTypeLength === 9 && toTypeLength === 4) {
            return `${this.getType(toType)}(${snippet}[0].xy, ${snippet}[1].xy)`;
        }

        if (fromTypeLength > 4) { // fromType is matrix-like
            // @TODO: ignore for now
            return snippet;
        }

        if (toTypeLength > 4 || toTypeLength === 0) { // toType is matrix-like or unknown
            // @TODO: ignore for now
            return snippet;
        }

        if (fromTypeLength === toTypeLength) {
            return `${this.getType(toType)}(${snippet})`;
        }

        if (fromTypeLength > toTypeLength) {
            snippet = toType === 'bool' ? `all(${snippet})` : `${snippet}.${'xyz'.slice(0, toTypeLength)}`;
            return this.format(snippet, this.getTypeFromLength(toTypeLength, this.getComponentType(fromType)), toType);
        }

        if (toTypeLength === 4 && fromTypeLength > 1) { // toType is vec4-like
            return `${this.getType(toType)}(${this.format(snippet, fromType, 'vec3')}, 1.0)`;
        }

        if (fromTypeLength === 2) { // fromType is vec2-like and toType is vec3-like
            return `${this.getType(toType)}(${this.format(snippet, fromType, 'vec2')}, 0.0)`;
        }

        if (fromTypeLength === 1 && toTypeLength > 1 && fromType !== this.getComponentType(toType)) {
            // convert a number value to vector type, e.g:
            // vec3( 1u ) -> vec3( float( 1u ) )
            snippet = `${this.getType(this.getComponentType(toType))}(${snippet})`;
        }

        return `${this.getType(toType)}(${snippet})`; // fromType is float-like
    }

    /**
     * Returns the vector type for the given type.
     * Three.js aligned: NodeBuilder.getVectorType().
     */
    getVectorType(type: string): string {
        // In WGSL, types are already vector types (vec2f, vec3f, etc.)
        return type;
    }

    /**
     * Returns whether the type is a reference type.
     * Three.js aligned: NodeBuilder.isReference().
     */
    isReference(type: string): boolean {
        return type === 'void' || type === 'OutputType';
    }

    /**
     * Returns the length of the given type.
     * Three.js aligned: NodeBuilder.getTypeLength().
     */
    getTypeLength(type: string): number {
        if (type === 'f32' || type === 'i32' || type === 'u32' || type === 'bool' || type === 'f16') return 1;
        if (type.startsWith('vec2')) return 2;
        if (type.startsWith('vec3')) return 3;
        if (type.startsWith('vec4')) return 4;
        if (type.startsWith('mat2x2')) return 4;
        if (type.startsWith('mat3x3')) return 9;
        if (type.startsWith('mat4x4')) return 16;
        if (type.startsWith('mat2x3') || type.startsWith('mat3x2')) return 6;
        if (type.startsWith('mat2x4') || type.startsWith('mat4x2')) return 8;
        if (type.startsWith('mat3x4') || type.startsWith('mat4x3')) return 12;
        return 0; // unknown
    }

    /**
     * Returns the WGSL type string.
     * Three.js aligned: NodeBuilder.getType().
     */
    getType(type: string): string {
        return type;
    }

    /**
     * Returns a type with the given length and component type.
     * Three.js aligned: NodeBuilder.getTypeFromLength().
     */
    getTypeFromLength(length: number, componentType: string): string {
        if (length === 1) return componentType;
        const suffix = componentType === 'f32' ? 'f' : componentType === 'i32' ? 'i' : componentType === 'u32' ? 'u' : componentType === 'f16' ? 'h' : '';
        if (length === 2) return `vec2${suffix}`;
        if (length === 3) return `vec3${suffix}`;
        if (length === 4) return `vec4${suffix}`;
        return componentType;
    }

    /**
     * Returns the component type of the given type.
     * Three.js aligned: NodeBuilder.getComponentType().
     */
    getComponentType(type: string): string {
        if (type.endsWith('f') || type === 'f32') return 'f32';
        if (type.endsWith('i') || type === 'i32') return 'i32';
        if (type.endsWith('u') || type === 'u32') return 'u32';
        if (type.endsWith('h') || type === 'f16') return 'f16';
        if (type === 'bool' || type.includes('bool')) return 'bool';
        return 'f32'; // default
    }

    // =========================================================================
    // Chain management for cycle detection
    // =========================================================================

    addChain(node: Node<WgslType>): void {
        this.chain.push(node);
    }

    removeChain(_node: Node<WgslType>): void {
        this.chain.pop();
    }

    isInChain(node: Node<WgslType>): boolean {
        return this.chain.includes(node);
    }

    // =========================================================================
    // Build stage management
    // =========================================================================

    setBuildStage(stage: 'setup' | 'analyze' | 'generate' | null): void {
        this.buildStage = stage;
    }

    getBuildStage(): 'setup' | 'analyze' | 'generate' | null {
        return this.buildStage;
    }

    setShaderStage(stage: 'vertex' | 'fragment' | 'compute' | null): void {
        this.shaderStage = stage;
    }

    getShaderStage(): 'vertex' | 'fragment' | 'compute' | null {
        return this.shaderStage;
    }

    // =========================================================================
    // Directives
    // =========================================================================

    enableDirective(name: string, stage?: 'vertex' | 'fragment' | 'compute'): void {
        if (stage) {
            this.directives[stage].add(name);
        } else {
            const currentStage = this.shaderStage;
            if (currentStage) {
                this.directives[currentStage].add(name);
            } else {
                if (this.input?.kind === 'render') {
                    this.directives.vertex.add(name);
                    this.directives.fragment.add(name);
                } else {
                    this.directives.compute.add(name);
                }
            }
        }
    }

    getDirectives(stage: 'vertex' | 'fragment' | 'compute'): string {
        const directives = this.directives[stage];
        if (directives.size === 0) return '';
        return [...directives].map((d) => `enable ${d};`).join('\n') + '\n';
    }

    // =========================================================================
    // Bindings management
    // =========================================================================

    getBindGroupArray(groupName: string, shaderStage: 'vertex' | 'fragment' | 'compute'): BindingEntry[] {
        const stageBindings = this.bindings[shaderStage];

        let bindGroup = stageBindings[groupName];

        if (bindGroup === undefined) {
            if (this.bindingsIndexes[groupName] === undefined) {
                this.bindingsIndexes[groupName] = {
                    binding: 0,
                    group: Object.keys(this.bindingsIndexes).length,
                };
            }
            stageBindings[groupName] = bindGroup = [];
        }

        return bindGroup;
    }

    getBindings(): BindGroup[] {
        if (this.bindGroups !== null) {
            return this.bindGroups;
        }

        const groups: Record<string, BindingEntry[]> = {};
        const shaderStages = this.input?.kind === 'render' ? (['vertex', 'fragment'] as const) : (['compute'] as const);

        for (const shaderStage of shaderStages) {
            const stageBindings = this.bindings[shaderStage];
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

        const BINDING_ORDER: Record<BindingEntry['type'], number> = { uniform: 0, storage: 1, texture: 2, sampler: 3 };
        const bindGroups: BindGroup[] = [];
        for (const groupName in groups) {
            const bindings = groups[groupName];
            if (bindings.length === 0) continue;

            bindings.sort((a, b) => BINDING_ORDER[a.type] - BINDING_ORDER[b.type]);

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

    sortBindingGroups(): void {
        const bindGroups = this.getBindings();

        bindGroups.sort((a, b) => a.groupNode.order - b.groupNode.order);

        for (let i = 0; i < bindGroups.length; i++) {
            const bindGroup = bindGroups[i];
            this.bindingsIndexes[bindGroup.name].group = i;
            bindGroup.index = i;
        }
    }

    // =========================================================================
    // Flow child node (saves/installs/restores the flow buffer)
    // =========================================================================

    /**
     * Executes the flow of a child node.
     * Three.js aligned: NodeBuilder.flowChildNode().
     *
     * @param node - The node to execute.
     * @param output - Expected output type. For example 'vec3'.
     * @return The code flow.
     */
    flowChildNode(node: Node<WgslType>, output: string | null = null): { code: string; result: string | null } {
        const previousFlow = this.flow;

        const flow = {
            code: ''
        };

        this.flow = flow;

        const result = node.build(this, output ?? undefined);

        this.flow = previousFlow;

        return { code: flow.code, result: typeof result === 'string' ? result : null };
    }

    /**
     * Flows a node from a specific shader stage.
     * Three.js aligned: NodeBuilder.flowNodeFromShaderStage()
     */
    flowNodeFromShaderStage(
        shaderStage: 'vertex' | 'fragment' | 'compute',
        node: Node<WgslType>,
        output: string | null = null,
        propertyName: string | null = null,
    ): { code: string; result: string | null } | null {
        const previousTab = this.tab;
        const previousCache = this.cache;
        const previousShaderStage = this.shaderStage;
        const previousContext = this.context;

        this.setShaderStage(shaderStage);

        const context = { ...this.context };
        delete context.nodeBlock;

        this.cache = this.globalCache;
        this.tab = '\t';
        this.context = context;

        let result: { code: string; result: string | null } | null = null;

        if (this.buildStage === 'generate') {
            const flowData = this.flowChildNode(node, output);

            if (propertyName !== null) {
                flowData.code += `${this.tab}${propertyName} = ${flowData.result};\n`;
            }

            this.flowCode[shaderStage] = this.flowCode[shaderStage] + flowData.code;

            result = flowData;
        } else {
            node.build(this);
        }

        this.setShaderStage(previousShaderStage);

        this.cache = previousCache;
        this.tab = previousTab;
        this.context = previousContext;

        return result;
    }

    // =========================================================================
    // Three.js aligned: sub-build layer management
    // =========================================================================

    /**
     * Adds a sub-build layer to the node builder.
     * Three.js aligned: NodeBuilder.addSubBuild()
     */
    addSubBuild(subBuild: string): void {
        this.subBuildLayers.push(subBuild);
    }

    /**
     * Removes the last sub-build layer from the node builder.
     * Three.js aligned: NodeBuilder.removeSubBuild()
     */
    removeSubBuild(): string | undefined {
        return this.subBuildLayers.pop();
    }

    /**
     * Gets or creates a varying from a node.
     * Three.js aligned: NodeBuilder.getVaryingFromNode()
     */
    getVaryingFromNode(
        node: Node<WgslType>,
        name: string | null = null,
        type: string = node.getNodeType(this),
        interpolationType: InterpolationType | null = null,
        interpolationSampling: InterpolationSampling | null = null,
    ): VaryingData {
        const nodeData = this.getDataFromNode(node, 'any');

        let nodeVarying = nodeData.varying as VaryingData | undefined;

        if (nodeVarying === undefined) {
            const index = this.varyings.size;

            if (name === null) {
                name = 'nodeVarying' + index;
            }

            nodeVarying = {
                name,
                type,
                interpolationType,
                interpolationSampling,
                needsInterpolation: false,
            };

            // Also register in our existing varyings map for code generation
            this.varyings.set(name, {
                name,
                type,
                location: index,
                interpolationType,
                interpolationSampling,
            });

            nodeData.varying = nodeVarying;
        }

        return nodeVarying;
    }

    // =========================================================================
    // Vars serialization
    // =========================================================================

    getVars(stage: string): string {
        const vars = this.stageVars[stage];
        if (!vars || vars.length === 0) return '';
        return vars.map((v) => `    var ${v.name} : ${v.type};`).join('\n') + '\n';
    }

    // =========================================================================
    // Struct registration
    // =========================================================================

    registerStructDef(def: StructDef<StructSchema>): void {
        for (const nested of def.nestedDefs.values()) {
            this.registerStructDef(nested);
        }
        if (!this.structNodes.has(def.wgslType)) {
            this.structNodes.set(def.wgslType, def.node);
        }
    }

    // =========================================================================
    // Node registration
    // =========================================================================

    registerNode(node: Node<WgslType>): void {
        if (!this.allNodes.has(node.id)) {
            this.allNodes.set(node.id, node);
        }
    }

    // =========================================================================
    // Build dispatch — calls node methods based on stage
    // =========================================================================

    buildNode(node: Node<WgslType>): string | null {
        if (this.buildStage === 'setup') {
            this.setupNode(node);
            return null;
        }
        if (this.buildStage === 'analyze') {
            this.analyzeNode(node);
            return null;
        }
        return this.generateNode(node);
    }

    // =========================================================================
    // Setup phase
    // =========================================================================

    setupNode(node: Node<WgslType>): void {
        const data = this.getDataFromNode(node, 'any');
        if (data.initialized) return;
        data.initialized = true;

        this.registerNode(node);

        // Visit children first (depth-first)
        for (const child of node.getChildren()) {
            this.setupNode(child);
        }

        // Auto-detect f16 types and enable directive
        if (node.type === undefined) {
            console.error('[gpucat] node with undefined type — kind:', node.kind, 'id:', node.id, node);
            return;
        }
        if (this.requiresF16Directive(node.type)) {
            this.enableDirective('f16');
        }

        // Call node's setup method (Three.js style)
        node.setup(this);

        // Post-order: collect nodes needing lifecycle callbacks
        if ('updateBeforeType' in node) {
            const n = node as unknown as UpdateBeforeNode;
            if (n.updateBeforeType !== 'none') {
                this.sequentialNodes.add(n);
            }
        }
        if ('updateAfterType' in node) {
            const n = node as unknown as UpdateAfterNode;
            if (n.updateAfterType !== 'none') {
                this.sequentialNodes.add(n);
            }
        }
        if ('updateType' in node) {
            const n = node as unknown as UpdateNode;
            if (n.updateType !== 'none' && !this.updateNodes.includes(n)) {
                this.updateNodes.push(n);
            }
        }
    }

    // =========================================================================
    // Analyze phase
    // =========================================================================

    analyzeNode(node: Node<WgslType>): void {
        const count = this.increaseUsage(node);

        if (count !== 1) return;

        for (const child of node.getChildren()) {
            this.analyzeNode(child);
        }

        // VaryingNode: also analyze its source in vertex stage
        // The source is wrapped in SubBuildNode at vn.node, unwrapped source at vn.node.node
        if (node.kind === 'varying') {
            const vn = node as VaryingNode<WgslType>;
            const prevStage = this.shaderStage;
            this.shaderStage = 'vertex';
            this.analyzeNode(vn.node.node);
            this.shaderStage = prevStage;
        }

        // StackNode: analyze all body statements
        if (node.kind === 'stack') {
            const s = node as StackNode;
            for (const stmt of s.body) {
                this.analyzeNode(stmt);
            }
        }
    }

    // =========================================================================
    // Generate phase
    // =========================================================================

    /**
     * Generate a node's WGSL code. Three.js aligned: delegates to node.build().
     * 
     * This method is called during the generate phase to get the WGSL snippet
     * for a node. It delegates to node.build() which handles stage forcing
     * (ensuring setup/analyze were done first).
     */
    generateNode(node: Node<WgslType>, output?: string): string | null {
        // Three.js aligned: call node.build() which handles all stages
        const result = node.build(this, output);
        // build() returns string in generate stage
        return typeof result === 'string' ? result : null;
    }

    // =========================================================================
    // Emit stack into flow
    // =========================================================================

    emitStackIntoFlow(stack: StackNode, indent: string): void {
        const outerFlow = this.flow;
        this.flow = { code: '' };

        for (const stmt of stack.body) {
            stmt.build(this);
        }

        const indented = this.flow.code.replace(/^ {4}/gm, indent);
        outerFlow.code += indented;
        this.flow = outerFlow;
    }

    // =========================================================================
    // Helper methods
    // =========================================================================

    requiresF16Directive(wgslType: string): boolean {
        if (wgslType === 'f16') return true;
        if (wgslType.startsWith('vec') && wgslType.endsWith('h')) return true;
        if (wgslType.startsWith('mat') && wgslType.endsWith('h')) return true;
        return false;
    }

    // =========================================================================
    // Build lifecycle callback arrays
    // =========================================================================

    buildUpdateNodes(): void {
        for (const node of this.sequentialNodes) {
            if ('updateBeforeType' in node && (node as UpdateBeforeNode).updateBeforeType !== 'none') {
                this.updateBeforeNodes.push(node as UpdateBeforeNode);
            }
            if ('updateAfterType' in node && (node as UpdateAfterNode).updateAfterType !== 'none') {
                this.updateAfterNodes.push(node as UpdateAfterNode);
            }
        }
    }

    // =========================================================================
    // Register root nodes per stage
    // =========================================================================

    private registerRoots(): void {
        if (this.input!.kind === 'render') {
            const { position, color, mask, depth } = this.input!.slots;
            // Stage validation: fragment graph must not contain vertex-only nodes
            this.validateFragmentRoot(color);
            if (mask) this.validateFragmentRoot(mask);
            if (depth) this.validateFragmentRoot(depth);
            this.flowNodes.vertex.push(position);
            this.flowNodes.fragment.push(color);
            if (mask) this.flowNodes.fragment.push(mask);
            if (depth) this.flowNodes.fragment.push(depth);
        } else {
            // Compute: trace Fn body, infer storage nodes from graph
            const { body, storage } = this.input!.node.trace();
            this.computeStorage = storage;
            // Register storage nodes into allNodes so setup pass finds them
            for (const s of storage) {
                this.allNodes.set(s.id, s);
            }
            this.flowNodes.compute.push(body);
        }
    }

    private validateFragmentRoot(root: Node<WgslType>): void {
        root.traverse((node) => {
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
        });
    }

    // =========================================================================
    // FnNode setup helpers
    // =========================================================================

    setupFnNode(fn: FnNode<WgslType>): void {
        const data = this.getDataFromNode(fn as unknown as Node<WgslType>, 'any');
        if (data.initialized) return;
        data.initialized = true;

        const traced = fn.trace();
        this.fnNodes.set(fn.id, { fn, traced });

        // register param nodes into allNodes
        for (const p of traced.params) {
            if (!this.allNodes.has(p.id)) this.allNodes.set(p.id, p);
        }

        // Collect all nodes from output expression and statement body
        const bodyNodes: Node<WgslType>[] = [];
        traced.output.traverse((node) => {
            if (!this.allNodes.has(node.id)) this.allNodes.set(node.id, node);
            bodyNodes.push(node);
        });

        const stackNodes: Node<WgslType>[] = [];
        traced.body.traverse((node) => {
            if (!this.allNodes.has(node.id)) this.allNodes.set(node.id, node);
            stackNodes.push(node);
        });

        // recurse into body to collect nested Fns and resources
        this.setupStackNode(traced.body);

        // recurse into the output expression for call deps
        for (const node of bodyNodes) {
            if (node.kind === 'call') {
                const cn = node as CallNode<WgslType>;
                if (cn.fnNode) {
                    this.setupCallNodeFn(cn.fnNode);
                }
            }
        }

        // recurse into the statement body for call deps
        for (const node of stackNodes) {
            if (node.kind === 'call') {
                const cn = node as CallNode<WgslType>;
                if (cn.fnNode) {
                    this.setupCallNodeFn(cn.fnNode);
                }
            }
        }
    }

    /**
     * Setup a traced JS function node (FnNode).
     * Note: WgslFnNode is deprecated - use FunctionNode which self-registers via getCodeFromNode.
     */
    setupCallNodeFn(fnNode: FnNode<WgslType>): void {
        if (fnNode.kind === 'fn' && !this.fnNodes.has(fnNode.id)) {
            this.setupFnNode(fnNode as FnNode<WgslType>);
        }
    }

    private setupStackNode(stack: Node<WgslType>): void {
        if (stack.kind !== 'stack') return;
        const s = stack as StackNode;
        for (const stmt of s.body) {
            this.setupNodeRecursive(stmt);
        }
    }

    private setupNodeRecursive(node: Node<WgslType>): void {
        switch (node.kind) {
            case 'call': {
                const cn = node as CallNode<WgslType>;
                if (cn.fnNode) {
                    this.setupCallNodeFn(cn.fnNode);
                }
                break;
            }
            case 'if': {
                const n = node as IfNode;
                this.setupStackNode(n.thenBody);
                if (n.elseBody) this.setupStackNode(n.elseBody);
                break;
            }
            case 'loop': {
                const n = node as LoopNode;
                const data = this.getDataFromNode(n);
                
                if (data.stackNode !== undefined) break;
                
                const inputs: Record<string, Node<WgslType>> = {};
                const params = n.params;
                
                for (let i = 0, l = params.length - 1; i < l; i++) {
                    const param = params[i];
                    const name = (!this.isNode(param) && typeof param === 'object' && param !== null && 'name' in param)
                        ? (param as { name?: string }).name || n.getVarName(i)
                        : n.getVarName(i);
                    const type = (!this.isNode(param) && typeof param === 'object' && param !== null && 'type' in param)
                        ? (param as { type?: string }).type || 'i32'
                        : 'i32';
                    inputs[name] = expression(name, type as WgslType);
                }
                
                const stack = new StackNodeClass();
                const prev = pushStack(stack);
                try {
                    const callback = params[params.length - 1] as (inputs: Record<string, Node<WgslType>>) => void;
                    if (typeof callback === 'function') {
                        callback(inputs);
                    }
                } finally {
                    popStack(prev);
                }
                
                data.stackNode = stack;
                this.setupStackNode(stack);
                break;
            }
            default:
                break;
        }
    }

    private isNode(v: unknown): v is Node<WgslType> {
        return v !== null && typeof v === 'object' && 'kind' in v;
    }

    // =========================================================================
    // Find varying node by name
    // =========================================================================

    findVaryingNodeByName(name: string): VaryingNode<WgslType> | null {
        for (const node of this.allNodes.values()) {
            if (node.kind === 'varying') {
                const vn = node as VaryingNode<WgslType>;
                if (vn.name === name) return vn;
            }
        }
        return null;
    }

    // =========================================================================
    // FnNode emit declaration
    // =========================================================================

    emitFnDecl(fn: FnNode<WgslType>, traced: TracedFn): string {
        const { params, body, output } = traced;

        // Register param names
        for (const p of params) {
            const data = this.getDataFromNode(p);
            data.propertyName = p.paramName ?? `p${p.paramIndex}`;
        }

        const paramList = params
            .map((p, i) => {
                const name = p.paramName ?? `p${i}`;
                const desc = fn.paramDescs[i];
                const wgslType = 'name' in desc ? (desc as { type: { wgslType: string } }).type.wgslType : (desc as { wgslType: string }).wgslType;
                return `${name} : ${wgslType}`;
            })
            .join(', ');

        const prevBuildStage = this.buildStage;
        const prevShaderStage = this.shaderStage;
        const prevStageVars = this.stageVars;
        this.buildStage = 'generate';
        this.shaderStage = null;
        this.stageVars = {};

        const bodyFlow = this.flowChildNode(body);
        const retExpr = this.generateNode(output) ?? '/* missing */';

        const fnVarsPreamble = this.getVars('fn');
        this.buildStage = prevBuildStage;
        this.shaderStage = prevShaderStage;
        this.stageVars = prevStageVars;

        return [
            `fn ${fn.fnName}(${paramList}) -> ${fn.type} {`,
            ...(fnVarsPreamble ? [fnVarsPreamble.replace(/\n$/, '')] : []),
            bodyFlow.code.replace(/\n$/, ''),
            `    return ${retExpr};`,
            `}`,
        ].join('\n');
    }

    // =========================================================================
    // buildCode — assemble final WGSL shader strings
    // =========================================================================

    private buildCode(): void {
        this.sortBindingGroups();
        const bindGroups = this.getBindings();

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
                    if (this.input!.kind === 'render') {
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
                const block = this.buildUniformGroupBlock(group.groupNode, uniformsInGroup, groupIndex, 0);
                uniformGroupBlocks.push(block);
            }
        }

        // Build shader preamble
        const structs = this.getStructs();
        const bindings = this.emitBindingsWGSL();
        const codes = this.getCodes();
        const preamble = [structs, bindings, codes].filter((s) => s).join('\n\n');

        // Generate stage-specific code
        if (this.input!.kind === 'render') {
            const vertexShaderData = this.buildVertexShaderData();
            const fragmentShaderData = this.buildFragmentShaderData();

            const vertexCode = this.getWGSLVertexCode(vertexShaderData);
            const fragmentCode = this.getWGSLFragmentCode(fragmentShaderData);

            const allDirectives = new Set([...this.directives.vertex, ...this.directives.fragment]);
            const directivesCode = allDirectives.size > 0 ? [...allDirectives].map((d) => `enable ${d};`).join('\n') + '\n\n' : '';

            const code = directivesCode + [preamble, vertexCode, fragmentCode].filter((s) => s).join('\n\n');

            const attributes: AttributeEntry[] = [...[...this.attributes.values()], ...this.bufferAttrs];
            const varyings = [...this.varyings.values()];

            const { graphEdges, graphInfo } = this.buildGraphData(['vertex', 'fragment']);

            this.renderResult = {
                code,
                attributes,
                varyings,
                uniformGroups: uniformGroupBlocks,
                storage: storageEntries,
                textures: textureEntries,
                samplers: samplerEntries,
                builtinsUsed: new Set(this.builtinsUsed),
                updateBeforeNodes: this.updateBeforeNodes,
                updateAfterNodes: this.updateAfterNodes,
                updateNodes: this.updateNodes,
                graphNodes: this.allNodes,
                graphEdges,
                graphInfo,
            };
        } else {
            const computeShaderData = this.buildComputeShaderData();
            const computeCode = this.getWGSLComputeCode(computeShaderData);

            const directivesCode = this.getDirectives('compute');
            const directivesSection = directivesCode ? directivesCode + '\n' : '';

            const code = directivesSection + [preamble, computeCode].filter((s) => s).join('\n\n');

            this.computeResult = {
                code,
                storage: computeStorageEntries,
                workgroupSize: this.input!.node.workgroupSize,
                builtinsUsed: new Set(this.builtinsUsed),
                uniformGroups: uniformGroupBlocks,
            };
        }
    }

    // =========================================================================
    // Shader data builders
    // =========================================================================

    private buildVertexShaderData(): VertexShaderData {
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
            const interpolateAttr = this.buildInterpolateAttr(v);
            outputLines.push(`    @location(${v.location})${interpolateAttr} ${v.name} : ${v.type},`);
        }
        outputLines.push(`}`);
        const outputStruct = outputLines.join('\n');

        // Build vars
        const vars = this.getVars('vertex') ?? '';

        // Build flow
        const flowLines: string[] = [];

        if (this.flowCode.vertex) {
            flowLines.push(this.flowCode.vertex.replace(/\n$/, ''));
        }

        const posRoot = this.input!.kind === 'render' ? this.input!.slots.position : null;
        if (posRoot) {
            const flowData = this.flowResults.get(posRoot);
            if (flowData) {
                if (flowData.code) flowLines.push(flowData.code.replace(/\n$/, ''));
                flowLines.push(`    out.position = ${flowData.result};`);
            }
        }

        // Assign varyings
        for (const v of varyingList) {
            const vn = this.findVaryingNodeByName(v.name);
            if (vn) {
                const prevBuildStage = this.buildStage;
                const prevShaderStage = this.shaderStage;
                this.buildStage = 'generate';
                this.shaderStage = 'vertex';
                // VaryingNode.node is SubBuildNode, .node.node is the unwrapped source
                const srcExpr = this.generateNode(vn.node.node) ?? '/* missing */';
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

    private buildFragmentShaderData(): FragmentShaderData {
        const varyingList = [...this.varyings.values()];
        const hasVaryings = varyingList.length > 0;
        const needsFragPosition = this.builtinsUsed.has('position');
        const needsInputStruct = hasVaryings || needsFragPosition;

        const slots = this.input!.kind === 'render' ? this.input!.slots : null;
        const maskRoot = slots?.mask;
        const depthRoot = slots?.depth;
        const hasDepth = depthRoot !== undefined;
        const colorRoot = slots?.color ?? null;

        const isMRT = colorRoot !== null && 'members' in colorRoot;
        const mrtNode = isMRT ? (colorRoot as OutputStructNode) : null;

        // Build FragmentInput struct
        let inputStruct = '';
        if (needsInputStruct) {
            const inputLines: string[] = [`struct FragmentInput {`];
            if (needsFragPosition) {
                inputLines.push(`    @builtin(position) position : vec4f,`);
            }
            for (const v of varyingList) {
                const interpolateAttr = this.buildInterpolateAttr(v);
                inputLines.push(`    @location(${v.location})${interpolateAttr} ${v.name} : ${v.type},`);
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
                    const name = mrtNode instanceof MRTNode && mrtNode._resolvedNames[i] ? mrtNode._resolvedNames[i] : `output${i}`;
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

        // Build flow
        const flowLines: string[] = [];

        if (maskRoot) {
            const maskFlowData = this.flowResults.get(maskRoot);
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

                    const memberFlow = this.flowChildNode(member);
                    if (memberFlow.code) flowLines.push(memberFlow.code.replace(/\n$/, ''));

                    const name = mrtNode instanceof MRTNode && mrtNode._resolvedNames[i] ? mrtNode._resolvedNames[i] : `output${i}`;
                    flowLines.push(`    _out.${name} = ${memberFlow.result};`);
                }

                if (hasDepth && depthRoot) {
                    const depthFlowData = this.flowResults.get(depthRoot);
                    if (depthFlowData) {
                        if (depthFlowData.code) flowLines.push(depthFlowData.code.replace(/\n$/, ''));
                        flowLines.push(`    _out.frag_depth = ${depthFlowData.result};`);
                    }
                }

                flowLines.push(`    return _out;`);
            } else {
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

        const returnType = needsOutputStruct ? 'FragmentOutput' : '@location(0) vec4f';
        const varyingsParam = needsInputStruct ? 'in : FragmentInput' : '';

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

    private buildComputeShaderData(): ComputeShaderData {
        if (this.input!.kind !== 'compute') throw new Error('buildComputeShaderData called on render builder');

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
            workgroupSize: this.input!.node.workgroupSize,
            builtinParams,
        };
    }

    // =========================================================================
    // WGSL code generation helpers
    // =========================================================================

    private getStructs(): string {
        const lines: string[] = [];
        for (const sn of this.structNodes.values()) {
            const members = sn.members.map((m) => `    ${m.name} : ${m.type},`).join('\n');
            lines.push(`struct ${sn.type} {\n${members}\n}`);
        }
        return lines.join('\n');
    }

    private emitBindingsWGSL(): string {
        const lines: string[] = [];
        const bindGroups = this.getBindings();

        for (const group of bindGroups) {
            const groupIndex = group.index;
            let bindingIndex = 0;

            for (const entry of group.bindings) {
                if (entry.type === 'uniform' && entry.uniforms) {
                    const varName = entry.groupNode.name;
                    const structName = varName + 'Struct';
                    const memberLines = entry.uniforms.map((u) => `    ${u.name} : ${u.type},`).join('\n');
                    lines.push(`struct ${structName} {\n${memberLines}\n}`);
                    lines.push(`@group(${groupIndex}) @binding(${bindingIndex}) var<uniform> ${varName} : ${structName};`);
                    bindingIndex++;
                } else if (entry.type === 'storage') {
                    const storageNode = entry.node as StorageNode<WgslType>;
                    const access = this.input!.kind === 'render' ? 'read' : storageNode.access;
                    lines.push(
                        `@group(${groupIndex}) @binding(${bindingIndex}) var<storage, ${access}> ${entry.name} : ${storageNode.storageType};`,
                    );
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

    private getCodes(): string {
        const lines: string[] = [];

        // Emit raw WGSL functions first
        for (const wgslFn of this.wgslFnNodes.values()) {
            lines.push(wgslFn.wgslSource);
        }

        // Emit traced JS functions
        for (const { fn, traced } of this.fnNodes.values()) {
            lines.push(this.emitFnDecl(fn, traced));
        }

        return lines.join('\n\n');
    }

    private getWGSLVertexCode(shaderData: VertexShaderData): string {
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

    private getWGSLFragmentCode(shaderData: FragmentShaderData): string {
        const inputStructSection = shaderData.inputStruct ? `${shaderData.inputStruct}\n\n` : '';
        const outputStructSection = shaderData.outputStruct ? `${shaderData.outputStruct}\n\n` : '';
        const varsSection = shaderData.vars ? `\n${shaderData.vars}` : '';
        const flowSection = shaderData.flow ? `\n${shaderData.flow}` : '';

        return `${inputStructSection}${outputStructSection}@fragment
fn fs_main(${shaderData.varyings}) -> ${shaderData.returnType} {${varsSection}${flowSection}
}`;
    }

    private getWGSLComputeCode(shaderData: ComputeShaderData): string {
        const [wx, wy, wz] = shaderData.workgroupSize;
        const varsSection = shaderData.vars ? `\n${shaderData.vars}` : '';
        const flowSection = shaderData.flow ? `\n${shaderData.flow}` : '';

        return `@compute @workgroup_size(${wx}, ${wy}, ${wz})
fn cs_main(${shaderData.builtinParams}) {${varsSection}${flowSection}
}`;
    }

    // =========================================================================
    // Uniform group block builder
    // =========================================================================

    private buildUniformGroupBlock(
        groupNode: UniformGroupNode,
        nodes: UniformNode<WgslType>[],
        groupIndex: number,
        binding: number,
    ): UniformGroupBlock {
        const members: UniformMember[] = [];
        let offset = 0;
        for (const n of nodes) {
            const align = this.std140Align(n.type);
            const size = this.std140Size(n.type);
            offset = this.alignUp(offset, align);
            members.push({ uniformId: n.name, type: n.type, offset, size, node: n });
            offset += size;
        }
        const totalBytes = this.alignUp(offset, 16);
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

    // =========================================================================
    // Interpolation attribute builder
    // =========================================================================

    private buildInterpolateAttr(v: VaryingEntry): string {
        const itype = v.interpolationType;
        const isampling = v.interpolationSampling;

        if (itype !== null) {
            return isampling !== null ? ` @interpolate(${itype}, ${isampling})` : ` @interpolate(${itype})`;
        }

        if (this.isIntegerWgslType(v.type)) {
            return ' @interpolate(flat, either)';
        }

        return '';
    }

    private isIntegerWgslType(type: string): boolean {
        return /^(u32|i32|vec[234][ui]|vec[234]<\s*(u32|i32)\s*>)$/.test(type);
    }

    // =========================================================================
    // Graph data builder for inspector
    // =========================================================================

    private buildGraphData(
        stages: ReadonlyArray<'vertex' | 'fragment' | 'compute'>,
    ): {
        graphEdges: ReadonlyMap<string, readonly string[]>;
        graphInfo: ReadonlyMap<string, NodeGraphInfo>;
    } {
        const graphEdges = new Map<string, readonly string[]>();
        const graphInfo = new Map<string, NodeGraphInfo>();

        for (const [id, node] of this.allNodes) {
            const children = [...node.getChildren()];
            if (children.length > 0) {
                graphEdges.set(id, children.map((c: Node<WgslType>) => c.id));
            }

            let totalUsage = 0;
            let cseVar: string | undefined;
            const nodeStages: Array<'vertex' | 'fragment' | 'compute'> = [];

            for (const stage of stages) {
                const stageData = this.getDataFromNode(node, stage);
                if (stageData) {
                    if ((stageData.usageCount ?? 0) > 0) {
                        nodeStages.push(stage);
                        totalUsage += stageData.usageCount ?? 0;
                    }
                    if (stageData.propertyName !== undefined) {
                        cseVar = stageData.propertyName;
                    }
                }
            }

            const anyData = this.getDataFromNode(node, 'any');
            if (anyData && (anyData.usageCount ?? 0) > 0) {
                totalUsage += anyData.usageCount ?? 0;
                if (anyData.propertyName !== undefined) cseVar = anyData.propertyName;
            }

            const expression = this.nodeDisplayExpression(node, cseVar);

            graphInfo.set(id, {
                stages: nodeStages,
                cseVar,
                usageCount: totalUsage,
                expression,
            });
        }

        return { graphEdges, graphInfo };
    }

    private nodeDisplayExpression(node: Node<WgslType>, cseVar: string | undefined): string | undefined {
        if (cseVar !== undefined) return cseVar;
        
        if (node instanceof ConstNode) {
            const v = node.value;
            const s = Array.isArray(v) ? `${node.type}(${v.join(', ')})` : String(v);
            return s.length > 40 ? s.slice(0, 40) + '…' : s;
        }
        if (node instanceof UniformNode) {
            return node.name ?? 'uniform';
        }
        if (node instanceof AttributeNode) {
            return `attr:${node.name}`;
        }
        if (node instanceof BinopNode) {
            return `… ${node.op} …`;
        }
        if (node instanceof CallNode) {
            return `${node.fn}(…)`;
        }
        if (node instanceof BuiltinNode) {
            return `@builtin(${node.builtinKind})`;
        }
        if (node instanceof VaryingNode) {
            return `varying:${node.name}`;
        }
        if (node instanceof FieldNode) {
            return `.${node.fieldName}`;
        }
        if (node.kind === 'buffer_attribute') {
            return `bufAttr:${node.id.slice(0, 8)}`;
        }
        if (node.kind === 'storage') {
            return `storage:${node.id.slice(0, 8)}`;
        }
        return undefined;
    }

    // =========================================================================
    // std140 layout helpers
    // =========================================================================

    private std140Size(type: string): number {
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

    private std140Align(type: string): number {
        switch (type) {
            case 'f32': case 'i32': case 'u32': case 'bool': return 4;
            case 'vec2f': case 'vec2i': case 'vec2u': case 'vec2<bool>': return 8;
            case 'vec3f': case 'vec3i': case 'vec3u': case 'vec3<bool>': return 16;
            case 'vec4f': case 'vec4i': case 'vec4u': case 'vec4<bool>': return 16;
            case 'mat2x2f': case 'mat3x2f': case 'mat4x2f': return 8;
            case 'mat2x3f': case 'mat3x3f': case 'mat4x3f': return 16;
            case 'mat2x4f': case 'mat3x4f': case 'mat4x4f': return 16;
            default: return 16;
        }
    }

    private alignUp(offset: number, align: number): number {
        return Math.ceil(offset / align) * align;
    }

    // =========================================================================
    // Reset for new compilation
    // =========================================================================

    reset(): void {
        this.buildStage = null;
        this.shaderStage = null;
        this.nodeDataMap = new WeakMap();
        this.stackArray = [];
        this.stack = null;
        this.flow = { code: '' };
        this.flowCode = { vertex: '', fragment: '', compute: '' };
        this.tab = '    ';
        this.varCounter = 0;
        this.forCounter = 0;
        this.chain = [];
        this.input = null;
        this.flowNodes = { vertex: [], fragment: [], compute: [] };
        this.flowResults = new Map();
        this.stageVars = {};
        this.attributes = new Map();
        this.bufferAttrs = [];
        this.bufferAttrNames = new Map();
        this.varyings = new Map();
        this.builtinsUsed = new Set();
        this.structNodes = new Map();
        this.directives = { vertex: new Set(), fragment: new Set(), compute: new Set() };
        this.bindings = { vertex: {}, fragment: {}, compute: {} };
        this.bindingsIndexes = {};
        this.bindGroups = null;
        this.uniformGroups = {};
        this.textureBindings = {};
        this.samplerBindings = {};
        this.storageBindings = {};
        this.storageNames = new Map();
        this.fnNodes = new Map();
        this.wgslFnNodes = new Map();
        this.allNodes = new Map();
        this.computeStorage = [];
        this.sequentialNodes = new Set();
        this.updateBeforeNodes = [];
        this.updateAfterNodes = [];
        this.updateNodes = [];
        this.nodes = [];
        this.hashNodes = {};
        this.context = {};
        this.cache = new NodeCache();
        this.globalCache = new NodeCache();
        this.renderResult = null;
        this.computeResult = null;
    }
}

// ---------------------------------------------------------------------------
// Shader data types
// ---------------------------------------------------------------------------

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

type VertexShaderData = ShaderData & {
    inputStruct: string;
    outputStruct: string;
};

type FragmentShaderData = ShaderData & {
    inputStruct: string;
    outputStruct: string;
};

type ComputeShaderData = ShaderData & {
    workgroupSize: [number, number, number];
    builtinParams: string;
};

export function compile(slots: CompileSlots): CompileResult {
    const builder = new NodeBuilder({ kind: 'render', slots });
    builder.build();
    return builder.renderResult!;
}

export function compileCompute(node: ComputeNode): ComputeCompileResult {
    const builder = new NodeBuilder({ kind: 'compute', node });
    builder.build();
    return builder.computeResult!;
}
