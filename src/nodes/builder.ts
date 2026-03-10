import type { NodeFrame } from '../renderer/node-frame';
import {
    type Node,
    type ComputeNode,
    type StructDef,
    StackNode,
    BinopNode,
    CallNode,
    ConstructNode,
    FieldNode,
    IndexNode,
    ArrayNode,
    StructNode,
    AssignNode,
    InspectorNode,
    ConstNode,
    VarNode,
    IfNode,
    LoopNode,
    BreakNode,
    ContinueNode,
    CondNode,
    ReturnNode,
    FnNode,
    ParamNode
} from './lib/core';
import {
    type InterpolationType,
    type InterpolationSampling,
    VaryingNode
} from './lib/varying';
import { WgslNode } from './lib/wgsl';
import { AttributeNode, BufferAttributeNode } from './lib/attribute';
import { TextureNode, SamplerNode } from './lib/texture';
import { StorageNode } from './lib/storage';
import { UniformNode, UniformGroupNode } from './lib/uniform';
import { WgslFunctionNode } from './lib/wgsl-fn';
import { OutputStructNode, MRTNode } from './lib/mrt';
import { BuiltinNode, ComputeIndexNode } from './lib/builtin';
import * as d from './schema';
import type { StructSchema } from './schema';
import { constLiteral } from './wgsl-utils';

/* public apis */

export function compile(slots: CompileSlots): CompileResult {
    // create contexts for both stages
    const vertexCtx = createContext('vertex', true);
    const fragmentCtx = createContext('fragment', true);
    
    // collect all roots
    const roots = [slots.position, slots.color];
    if (slots.mask) roots.push(slots.mask);
    if (slots.depth) roots.push(slots.depth);
    
    // single discovery pass across all roots
    const discovered = discover(roots);
    vertexCtx.usageCount = discovered.usageCount;
    vertexCtx.mutatedNodes = discovered.mutatedNodes;
    vertexCtx.fnDefs = discovered.fnDefs;
    vertexCtx.wgslFnDefs = discovered.wgslFnDefs;
    vertexCtx.structDefs = discovered.structDefs;
    fragmentCtx.usageCount = discovered.usageCount;
    fragmentCtx.mutatedNodes = discovered.mutatedNodes;
    fragmentCtx.fnDefs = discovered.fnDefs;
    fragmentCtx.wgslFnDefs = discovered.wgslFnDefs;
    fragmentCtx.structDefs = discovered.structDefs;
    
    // pre-collect varyings from fragment roots (so vertex shader knows what to output)
    // fragment uses: color, mask (when present)
    const fragmentRoots: Node<d.Any>[] = [slots.color];
    if (slots.mask) fragmentRoots.push(slots.mask);
    collectVaryings(fragmentRoots, vertexCtx);
    
    // generate vertex shader
    const vertexBody = generateVertexShader(slots, vertexCtx);
    
    // generate fragment shader
    const fragmentBody = generateFragmentShader(slots, fragmentCtx, vertexCtx.varyings);
    
    // merge bindings from both stages
    for (const [k, v] of fragmentCtx.uniforms) vertexCtx.uniforms.set(k, v);
    for (const [k, v] of fragmentCtx.storages) vertexCtx.storages.set(k, v);
    for (const [k, v] of fragmentCtx.textures) vertexCtx.textures.set(k, v);
    for (const [k, v] of fragmentCtx.samplers) vertexCtx.samplers.set(k, v);
    
    // emit all bindings using Three.js pattern (each group gets its own @group index)
    const { wgsl: bindingsWgsl, uniformBlocks, storageEntries, textureEntries: textures, samplerEntries: samplers } = emitAllBindings(vertexCtx);
    
    // emit functions
    const wgslFnsCode = emitWgslFunctions(vertexCtx);
    const dslFnsCode = emitDslFunctions(vertexCtx);
    
    // assemble full shader
    const code = [
        '// Bindings (uniforms, storage, textures, samplers)',
        bindingsWgsl,
        '// WGSL Functions',
        wgslFnsCode,
        '// DSL Functions',
        dslFnsCode,
        '// Vertex Shader',
        vertexBody,
        '',
        '// Fragment Shader',
        fragmentBody,
    ].filter(Boolean).join('\n');
    
    // collect graph info
    const graphNodes = new Map<number, Node<d.Any>>();
    const graphEdges = new Map<number, readonly number[]>();
    const graphInfo = new Map<number, NodeGraphInfo>();
    
    for (const [id, node] of discovered.allNodes) {
        graphNodes.set(id, node);
        graphEdges.set(id, getChildren(node).map(c => c.id));
        graphInfo.set(id, {
            stages: [],
            cseVar: vertexCtx.nodeVars.get(id) ?? fragmentCtx.nodeVars.get(id),
            usageCount: discovered.usageCount.get(id) ?? 0,
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
    
    // Build attributes array including buffer attributes
    const allAttributes: AttributeEntry[] = Array.from(vertexCtx.attributes.values());
    for (const bufAttr of vertexCtx.bufferAttributes) {
        const bufName = vertexCtx.bufferAttrNames.get(bufAttr.id)!;
        const location = vertexCtx.attributes.size + vertexCtx.bufferAttributes.indexOf(bufAttr);
        allAttributes.push({
            kind: 'buffer',
            node: bufAttr,
            name: bufName,
            type: bufAttr.type.wgslType,
            location,
        });
    }
    
    return {
        code,
        vertexEntryPoint: 'vs_main',
        fragmentEntryPoint: 'fs_main',
        attributes: allAttributes,
        varyings: varyingEntries,
        uniformGroups: uniformBlocks,
        storage: storageEntries,
        textures,
        samplers,
        builtinsUsed: new Set([...vertexCtx.builtins, ...fragmentCtx.builtins]),
        updateBeforeNodes: [...vertexCtx.updateBeforeNodes, ...fragmentCtx.updateBeforeNodes],
        updateAfterNodes: [...vertexCtx.updateAfterNodes, ...fragmentCtx.updateAfterNodes],
        updateNodes: [...vertexCtx.updateNodes, ...fragmentCtx.updateNodes],
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
    ctx.usageCount = discovered.usageCount;
    ctx.mutatedNodes = discovered.mutatedNodes;
    ctx.fnDefs = discovered.fnDefs;
    ctx.wgslFnDefs = discovered.wgslFnDefs;
    ctx.structDefs = discovered.structDefs;
    
    // generate compute shader body
    const computeBody = generateComputeShader(node, ctx);
    
    // emit all bindings using Three.js pattern (each group gets its own @group index)
    const { wgsl: bindingsWgsl, uniformBlocks, storageEntries } = emitAllBindings(ctx);
    
    // emit functions
    const wgslFnsCode = emitWgslFunctions(ctx);
    const dslFnsCode = emitDslFunctions(ctx);
    
    // assemble full shader
    const code = [
        '// Bindings (uniforms, storage, textures, samplers)',
        bindingsWgsl,
        '// WGSL Functions',
        wgslFnsCode,
        '// DSL Functions',
        dslFnsCode,
        '// Compute Shader',
        computeBody,
    ].filter(Boolean).join('\n');
    
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

export type AttributeEntry =
    | {
          kind: 'geometry';
          name: string;
          type: string;
          location: number;
      }
    | {
          kind: 'buffer';
          node: BufferAttributeNode<d.Any>;
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

export type UniformMember = {
    uniformId: string;
    type: string;
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
    groupNode: UniformGroupNode;
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
    node: TextureNode;
};

export type SamplerEntry = {
    samplerId: string;
    type: 'sampler' | 'sampler_comparison';
    group: number;
    binding: number;
    textureNode: TextureNode;
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
    position: Node<d.Any>;
    color: Node<d.Any>;
    mask?: Node<d.Any>;
    depth?: Node<d.Any>;
};

export type CompileResult = {
    code: string;
    vertexEntryPoint: string;
    fragmentEntryPoint: string;
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
    params: ParamNode<d.Any>[];
    body: StackNode;
    output: Node<d.Any>;
};

/** Build context - carries all state during code generation */
interface BuildContext {
    stage: ShaderStage;
    isRender: boolean;
    
    // Collected bindings
    uniforms: Map<string, { node: UniformNode<d.Any>; group: UniformGroupNode }>;
    storages: Map<string, StorageNode<d.Any>>;
    storageNames: Map<number, string>; // node.id -> generated name
    textures: Map<string, TextureNode>;
    samplers: Map<string, TextureNode>; // sampler entries reference their texture
    attributes: Map<string, AttributeEntry>;
    bufferAttributes: BufferAttributeNode<d.Any>[];
    bufferAttrNames: Map<number, string>; // node.id -> generated name
    varyings: Map<string, { node: VaryingNode<d.Any>; vertexExpr: string }>;
    builtins: Set<string>;
    
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
    
    // Update nodes
    updateBeforeNodes: UpdateBeforeNode[];
    updateAfterNodes: UpdateAfterNode[];
    updateNodes: UpdateNode[];
    
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
        bufferAttributes: [],
        bufferAttrNames: new Map(),
        varyings: new Map(),
        builtins: new Set(),
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
        updateBeforeNodes: [],
        updateAfterNodes: [],
        updateNodes: [],
        graphNodes: new Map(),
        graphEdges: new Map(),
        graphInfo: new Map(),
    };
}

/** Get all child nodes for traversal */
function getChildren(node: Node<d.Any>): Node<d.Any>[] {
    const children: Node<d.Any>[] = [];
    
    if (node instanceof BinopNode) {
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
        children.push(node.node as unknown as Node<d.Any>);
    } else if (node instanceof AssignNode) {
        children.push(node.target, node.value);
    } else if (node instanceof VarNode) {
        children.push(node.init);
    } else if (node instanceof CondNode) {
        children.push(node.condition, node.ifTrue);
        if (node.ifFalse) children.push(node.ifFalse);
    } else if (node instanceof WgslNode) {
        children.push(...node.deps);
    } else if (node instanceof ReturnNode) {
        children.push(node.value);
    } else if (node instanceof InspectorNode) {
        children.push(node.wrappedNode);
    } else if (node instanceof TextureNode) {
        // TextureNode may have a uvNode that contains VaryingNode
        if (node.uvNode) {
            children.push(node.uvNode);
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

/** Single DFS pass that discovers all metadata needed before code generation. */
interface DiscoverResult {
    usageCount: Map<number, number>;
    mutatedNodes: Set<number>;
    fnDefs: Map<string, { fn: FnNode<d.Any>; traced: TracedFn }>;
    wgslFnDefs: Map<string, WgslFunctionNode>;
    structDefs: Map<string, StructDef<StructSchema>>;
    allNodes: Map<number, Node<d.Any>>;
}

function discover(roots: Node<d.Any>[]): DiscoverResult {
    const usageCount = new Map<number, number>();
    const mutatedNodes = new Set<number>();
    const fnDefs = new Map<string, { fn: FnNode<d.Any>; traced: TracedFn }>();
    const wgslFnDefs = new Map<string, WgslFunctionNode>();
    const structDefs = new Map<string, StructDef<StructSchema>>(); 
    const allNodes = new Map<number, Node<d.Any>>();
    const visited = new Set<number>();

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

    function visit(node: Node<d.Any>) {
        // usge counting
        usageCount.set(node.id, (usageCount.get(node.id) ?? 0) + 1);

        // exit if visited
        if (visited.has(node.id)) return;
        visited.add(node.id);

        // collect all nodes
        allNodes.set(node.id, node);

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

        // struct definition discovery
        if (node instanceof StorageNode) {
            const bufType = node.type;
            if (d.isStructDef(bufType)) {
                registerStructDef(bufType as unknown as StructDef<StructSchema>);
            } else if ((d.isArrayDesc(bufType) || d.isSizedArrayDesc(bufType)) && d.isStructDef(bufType.element)) {
                registerStructDef(bufType.element as unknown as StructDef<StructSchema>);
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

    return { usageCount, mutatedNodes, fnDefs, wgslFnDefs, structDefs, allNodes };
}

/** Pre-collect VaryingNodes from roots and generate their vertex expressions */
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
    
    if (node instanceof ConstNode) {
        expr = constLiteral(node.type.wgslType, node.value);
    } else if (node instanceof UniformNode) {
        expr = generateUniform(ctx, node);
    } else if (node instanceof AttributeNode) {
        expr = generateAttribute(ctx, node);
    } else if (node instanceof BufferAttributeNode) {
        expr = generateBufferAttribute(ctx, node);
    } else if (node instanceof StorageNode) {
        expr = generateStorage(ctx, node);
    } else if (node instanceof TextureNode) {
        expr = generateTexture(ctx, node);
    } else if (node instanceof SamplerNode) {
        expr = generateSampler(ctx, node);
    } else if (node instanceof VaryingNode) {
        expr = generateVarying(ctx, node);
    } else if (node instanceof BinopNode) {
        const left = generateExpr(ctx, node.left);
        const right = generateExpr(ctx, node.right);
        expr = `(${left} ${node.op} ${right})`;
    } else if (node instanceof CallNode) {
        expr = generateCall(ctx, node);
    } else if (node instanceof ArrayNode) {
        const args = node.elements.map(e => generateExpr(ctx, e));
        expr = `array<${node.type.element.wgslType}, ${node.elements.length}>(${args.join(', ')})`;
    } else if (node instanceof ConstructNode) {
        const args = node.args.map(a => generateExpr(ctx, a));
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
    } else if (node instanceof CondNode) {
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
    } else if (node instanceof VarNode) {
        // VarNode as expression returns the variable name
        // If not yet declared (e.g., toVar() called outside Fn body), emit the declaration now
        if (!ctx.nodeVars.has(node.id)) {
            const init = generateExpr(ctx, node.init);
            if (node.isConst) {
                ctx.code.push(`    let ${node.varName} = ${init};`);
            } else {
                ctx.code.push(`    var ${node.varName} = ${init};`);
            }
            ctx.nodeVars.set(node.id, node.varName);
        }
        expr = node.varName;
    } else if (node instanceof ParamNode) {
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
        node instanceof ConstNode ||
        node instanceof VarNode ||
        node instanceof ParamNode ||
        node instanceof BuiltinNode ||
        node instanceof FieldNode ||
        // binding references are global names
        node instanceof StorageNode ||
        node instanceof UniformNode ||
        node instanceof TextureNode ||
        node instanceof SamplerNode ||
        node instanceof BufferAttributeNode
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
    const group = node.groupNode;
    ctx.uniforms.set(name, { node, group });
    
    // register update node if needed
    if (node.updateType && node.updateType !== 'none') {
        const updateNode = node as unknown as UpdateNode;
        if (!ctx.updateNodes.find(n => n.id === updateNode.id)) {
            ctx.updateNodes.push(updateNode);
        }
    }
    
    return `uniforms_${group.name}.${name}`;
}

function generateAttribute(ctx: BuildContext, node: AttributeNode<d.Any>): string {
    if (ctx.stage !== 'vertex') {
        throw new Error(`[builder] AttributeNode used outside vertex stage`);
    }
    
    const name = node.name;
    if (!ctx.attributes.has(name)) {
        ctx.attributes.set(name, {
            kind: 'geometry',
            name,
            type: node.type.wgslType,
            location: ctx.attributes.size,
        });
    }
    
    return `input.${name}`;
}

function generateBufferAttribute(ctx: BuildContext, node: BufferAttributeNode<d.Any>): string {
    // check if already registered
    let name = ctx.bufferAttrNames.get(node.id);
    if (name) {
        return `input.${name}`;
    }
    
    // generate a name and register
    name = `_buf${ctx.bufferAttributes.length}`;
    ctx.bufferAttrNames.set(node.id, name);
    ctx.bufferAttributes.push(node);
    
    return `input.${name}`;
}

function generateStorage(ctx: BuildContext, node: StorageNode<d.Any>): string {
    // check if already registered
    let name = ctx.storageNames.get(node.id);
    if (name) {
        return name;
    }
    
    // generate a name and register
    name = `_storage${ctx.storages.size}`;
    ctx.storageNames.set(node.id, name);
    ctx.storages.set(name, node);
    
    return name;
}

function generateTexture(ctx: BuildContext, node: TextureNode): string {
    const name = node.textureId;
    if (!ctx.textures.has(name)) {
        ctx.textures.set(name, node);
    }
    
    // register sampler for this texture
    if (!ctx.samplers.has(name)) {
        ctx.samplers.set(name, node);
    }
    
    // register update node if needed
    if ('updateType' in node && (node as unknown as UpdateNode).updateType !== 'none') {
        const updateNode = node as unknown as UpdateNode;
        if (!ctx.updateNodes.find(n => n.id === updateNode.id)) {
            ctx.updateNodes.push(updateNode);
        }
    }
    
    // register updateBefore node if needed (e.g., PassTextureNode)
    if ('updateBeforeType' in node) {
        const beforeNode = node as unknown as UpdateBeforeNode;
        if (beforeNode.updateBeforeType !== 'none') {
            if (!ctx.updateBeforeNodes.find(n => n.id === beforeNode.id)) {
                ctx.updateBeforeNodes.push(beforeNode);
            }
        }
    }
    
    // Generate texture sample expression
    // Get UV coordinates - use uvNode if provided, otherwise default to input.uv
    let uvExpr: string;
    if (node.uvNode) {
        uvExpr = generateExpr(ctx, node.uvNode);
    } else {
        // Default to input.uv (standard varying UV coordinates)
        uvExpr = 'input.uv';
    }
    
    // Generate textureSample call
    const samplerName = `${name}_sampler`;
    return `textureSample(${name}, ${samplerName}, ${uvExpr})`;
}

function generateSampler(_ctx: BuildContext, node: SamplerNode): string {
    // SamplerNode is standalone - just return its sampler name
    // In practice, samplers are usually paired with textures via TextureNode
    // which registers both texture and sampler bindings
    return `${node.samplerId}_sampler`;
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
        'vertex_index': 'input.vertex_index',
        'instance_index': 'input.instance_index',
        'global_invocation_id': 'global_id',
        'local_invocation_id': 'local_id',
        'local_invocation_index': 'local_index',
        'workgroup_id': 'workgroup_id',
        'num_workgroups': 'num_workgroups',
        'position': ctx.stage === 'fragment' ? 'input.position' : 'output.position',
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
    
    const args = node.args.map(a => generateExpr(ctx, a));
    
    // handle special cases
    if (node.fn === 'negate' && args.length === 1) {
        return `(-${args[0]})`;
    }
    
    // atomic functions need pointer reference
    const atomicFns = [
        'atomicAdd', 'atomicSub', 'atomicMax', 'atomicMin',
        'atomicAnd', 'atomicOr', 'atomicXor',
        'atomicStore', 'atomicLoad', 'atomicExchange', 'atomicCompareExchangeWeak',
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
    
    if (node instanceof VarNode) {
        const init = generateExpr(ctx, node.init);
        if (node.isConst) {
            ctx.code.push(`${ind}let ${node.varName} = ${init};`);
        } else {
            ctx.code.push(`${ind}var ${node.varName} = ${init};`);
        }
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
        if (expr && !expr.startsWith('/*')) {
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
    } else if (config instanceof ConstNode || config instanceof UniformNode) {
        const endExpr = generateExpr(ctx, config as Node<d.Any>);
        loopHeader = `for (var ${wgslVarName}: i32 = 0i; ${wgslVarName} < ${endExpr}; ${wgslVarName}++)`;
    } else if (typeof config === 'object' && config !== null && !(config instanceof ConstNode) && !(config instanceof UniformNode)) {
        const cfg = config as {
            start?: Node<d.Any> | number;
            end?: Node<d.Any> | number;
            type?: d.ScalarType;
            condition?: '<' | '<=' | '>' | '>=';
            name?: string;
        };

        const type = cfg.type ?? 'i32';

        const getExpr = (v: Node<d.Any> | number | undefined): string | undefined => {
            if (v === undefined) return undefined;
            if (typeof v === 'number') return constLiteral(type, v);
            return generateExpr(ctx, v as Node<d.Any>);
        };

        const startExpr = getExpr(cfg.start) ?? '0i';
        const endExpr = getExpr(cfg.end) ?? '0i';
        const condition = cfg.condition ?? '<';

        loopHeader = `for (var ${wgslVarName}: ${type} = ${startExpr}; ${wgslVarName} ${condition} ${endExpr}; ${wgslVarName}++)`;
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
 * Binding group data structure for collecting all bindings per @group(N).
 * each named group gets its own @group index.
 */
type BindingGroupData = {
    groupNode: UniformGroupNode;
    groupIndex: number;
    uniforms: UniformNode<d.Any>[];
    storages: { name: string; node: StorageNode<d.Any> }[];
    textures: { name: string; node: TextureNode }[];
    samplers: { name: string; node: TextureNode }[];
};

/**
 * Emit all bindings (uniforms, storage, textures, samplers) following Three.js pattern.
 * 
 * Three.js pattern:
 * - Each named group (render, object, etc.) gets its own @group(N) index
 * - Groups are sorted by UniformGroupNode.order
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
    const getGroup = (groupNode: UniformGroupNode): BindingGroupData => {
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

    // collect textures and samplers
    for (const [name, node] of ctx.textures) {
        getGroup(node.groupNode).textures.push({ name, node });
        if (ctx.samplers.has(name)) {
            getGroup(node.groupNode).samplers.push({ name, node });
        }
    }

    // step 2: sort groups by their order, then assign sequential group indices
    // This follows Three.js pattern: @group(N) is the sorted array position
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
                    type: u.type.wgslType,
                    offset,
                    size,
                    node: u,
                });

                offset += size;
            }

            lines.push(`}`);
            lines.push(`@group(${groupIndex}) @binding(${bindingIndex}) var<uniform> uniforms_${groupName}: Uniforms_${groupName};`);
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

            lines.push(`@group(${groupIndex}) @binding(${bindingIndex}) var<storage, ${accessStr}> ${name}: ${node.storageType};`);

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
            lines.push(`@group(${groupIndex}) @binding(${bindingIndex}) var ${name}: ${node.textureType};`);
            textureEntries.push({
                textureId: name,
                type: node.textureType,
                group: groupIndex,
                binding: bindingIndex,
                node,
            });
            bindingIndex++;
        }

        for (const { name, node } of group.samplers) {
            // depth textures use sampler_comparison, others use sampler
            const isDepth = node.textureType.includes('depth');
            const samplerType = isDepth ? 'sampler_comparison' : 'sampler';
            lines.push(`@group(${groupIndex}) @binding(${bindingIndex}) var ${name}_sampler: ${samplerType};`);
            samplerEntries.push({
                samplerId: `${name}_sampler`,
                type: samplerType,
                group: groupIndex,
                binding: bindingIndex,
                textureNode: node,
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
        const params = traced.params.map((p, i) => {
            const pName = p.paramName ?? `p${i}`;
            return `${pName}: ${p.type.wgslType}`;
        }).join(', ');
        
        // generate function body
        const fnCtx = createContext(ctx.stage, ctx.isRender);
        fnCtx.usageCount = ctx.usageCount;
        fnCtx.fnDefs = ctx.fnDefs;
        fnCtx.wgslFnDefs = ctx.wgslFnDefs;
        
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
    
    // generate position expression
    const posExpr = generateExpr(ctx, slots.position);
    
    // check if we have any vertex inputs (attributes, buffer attributes, or builtins)
    const hasVertexIndex = ctx.builtins.has('vertex_index');
    const hasInstanceIndex = ctx.builtins.has('instance_index');
    const hasInputs = ctx.attributes.size > 0 || ctx.bufferAttributes.length > 0 || hasVertexIndex || hasInstanceIndex;
    
    // emit input struct only if we have inputs (WGSL structs must have at least one member)
    if (hasInputs) {
        lines.push('struct VertexInput {');
        for (const [name, attr] of ctx.attributes) {
            lines.push(`    @location(${attr.location}) ${name}: ${attr.type},`);
        }
        // emit buffer attributes
        for (const bufAttr of ctx.bufferAttributes) {
            const bufName = ctx.bufferAttrNames.get(bufAttr.id)!;
            const location = ctx.attributes.size + ctx.bufferAttributes.indexOf(bufAttr);
            lines.push(`    @location(${location}) ${bufName}: ${bufAttr.type.wgslType},`);
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
    lines.push(`    output.position = ${posExpr};`);
    
    // assign varyings
    for (const [name, { vertexExpr }] of ctx.varyings) {
        lines.push(`    output.${name} = ${vertexExpr};`);
    }
    
    lines.push('    return output;');
    lines.push('}');
    
    return lines.join('\n');
}

/* fragment shader generation */

function generateFragmentShader(slots: CompileSlots, ctx: BuildContext, varyings: Map<string, { node: VaryingNode<d.Any>; vertexExpr: string }>): string {
    const lines: string[] = [];
    
    // copy varyings from vertex stage
    for (const [name, data] of varyings) {
        if (!ctx.varyings.has(name)) {
            ctx.varyings.set(name, data);
        }
    }
    
    // generate color expression
    const colorExpr = generateExpr(ctx, slots.color);
    
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
    const isMRT = slots.color instanceof MRTNode;
    const mrtNode = isMRT ? slots.color as MRTNode : null;
    
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
        lines.push(`    return ${colorExpr};`);
    }
    
    lines.push('}');
    
    return lines.join('\n');
}

/* compute shader generation */

function generateComputeShader(node: ComputeNode, ctx: BuildContext): string {
    const lines: string[] = [];
    
    // trace the FnNode
    const fn = node.fn;
    const traced = fn.trace();
    
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
    
    // computeIndex requires global_invocation_id and num_workgroups
    ctx.builtins.add('global_invocation_id');
    ctx.builtins.add('num_workgroups');
    
    // emit private variable for computeIndex (like three.js instanceIndex)
    lines.push('var<private> computeIndex: u32;');
    lines.push('');
    
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
    
    // compute linearized index at start of function (like three.js)
    // computeIndex = global_id.x + global_id.y * (WX * num_workgroups.x) + global_id.z * (WX * num_workgroups.x) * (WY * num_workgroups.y)
    lines.push(`    computeIndex = global_id.x + global_id.y * (${WX}u * num_workgroups.x) + global_id.z * (${WX}u * num_workgroups.x) * (${WY}u * num_workgroups.y);`);
    
    lines.push(...ctx.code);
    lines.push('}');
    
    return lines.join('\n');
}
