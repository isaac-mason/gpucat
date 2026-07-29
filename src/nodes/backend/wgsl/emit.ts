/**
 * backend/wgsl/emit.ts — the WGSL emitter.
 *
 * Consumes the backend-neutral node graph + discovered facts (carried on BuildContext) and produces
 * WGSL source strings. This is the first concrete shader backend; a future GLSL emitter is a sibling
 * module here. Nothing in this file touches GPUDevice or any runtime object — it is purely
 * node-graph → text. compile()/compileCompute() (in ../../builder) orchestrate discover → emit.
 */

import type { StructSchema } from '../../../schema/schema';
import * as d from '../../../schema/schema';
import type {
    AttributeEntry,
    CompileSlots,
    Discovery,
    NodeGraphInfo,
    SamplerEntry,
    StorageEntry,
    StorageTextureEntry,
    TextureEntry,
    UniformGroupBlock,
    UniformMember,
} from '../../builder';
import { type AnyNode, getChildren } from '../../graph';
import type { AttributeNode } from '../../lib/attribute';
import { type BuiltinNode, computeIndex } from '../../lib/builtin';
import {
    type CallNode,
    type ComputeNode,
    type FnNode,
    type IfNode,
    isNode,
    type LoopNode,
    type Node,
    NodeKind,
    type ParameterNode,
    type PrivateVarNode,
    type StackNode,
    type StructDef,
    type StructNode,
    type WorkgroupVarNode,
} from '../../lib/core';
import type { MRTNode } from '../../lib/mrt';
import type { StorageNode } from '../../lib/storage';
import {
    type ArrayTextureNode,
    type CubeTextureNode,
    type DepthTextureNode,
    SamplerNode,
    type StorageTextureBindingNode,
    type TextureBindingNode,
    type TextureNode,
} from '../../lib/texture';
import type { UniformGroup, UniformNode } from '../../lib/uniform';
import type { VaryingNode } from '../../lib/varying';
import type { WgslFunctionNode } from '../../lib/wgsl-fn';
import { constLiteral } from '../../wgsl-utils';

type ShaderStage = 'vertex' | 'fragment' | 'compute';

/** Traced FnNode data */
export type TracedFn = {
    params: ParameterNode<d.Any>[];
    body: StackNode;
    output: Node<d.Any>;
};

/** Build context - carries all state during code generation */
export type BuildContext = {
    stage: ShaderStage;
    isRender: boolean;

    // Collected bindings
    uniforms: Map<string, { node: UniformNode<d.Any>; group: UniformGroup }>;
    storages: Map<string, StorageNode<d.Any>>;
    storageNames: Map<number, string>; // node.id -> generated name
    textures: Map<string, TextureBindingNode>;
    storageTextures: Map<string, StorageTextureBindingNode>;
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
};

/**
 * A Discovery with every collection empty. Used only for the per-function-body sub-context in
 * emitDslFunctions, which feeds it to {@link createContext} after splicing in the subset of the
 * parent's maps that the body shares.
 */
function emptyDiscovery(): Discovery {
    return {
        nodeIdToUsages: new Map(),
        mutatedNodes: new Set(),
        fnDefs: new Map(),
        wgslFnDefs: new Map(),
        structDefs: new Map(),
        storageNames: new Map(),
        textures: new Map(),
        storageTextures: new Map(),
        samplers: new Map(),
        uniforms: new Map(),
        storages: new Map(),
        privateVars: new Map(),
        workgroupVars: new Map(),
        nodeIdToNode: new Map(),
        updateBeforeNodes: [],
        updateAfterNodes: [],
        updateNodes: [],
    };
}

/**
 * Context for a top-level shader stage. Emission scratch is fresh, but the discovered facts (bindings,
 * struct/fn tables, CSE usage counts) are referenced — not copied — directly from the single discovery
 * pass, so every context for one compile (vertex + fragment) shares one binding set. This matches the
 * prior behaviour where compile() aliased the discovered maps into both contexts. Emission still appends
 * to some of them (e.g. uniforms/textures registered on first encounter), so they are shared-mutable.
 */
export function createContext(stage: ShaderStage, isRender: boolean, discovery: Discovery): BuildContext {
    return {
        stage,
        isRender,
        // Discovered facts — referenced directly (no throwaway empty maps).
        uniforms: discovery.uniforms,
        storages: discovery.storages,
        storageNames: discovery.storageNames,
        textures: discovery.textures,
        storageTextures: discovery.storageTextures,
        samplers: discovery.samplers,
        privateVars: discovery.privateVars,
        workgroupVars: discovery.workgroupVars,
        structDefs: discovery.structDefs,
        usageCount: discovery.nodeIdToUsages,
        mutatedNodes: discovery.mutatedNodes,
        fnDefs: discovery.fnDefs,
        wgslFnDefs: discovery.wgslFnDefs,
        // Per-stage emission scratch — fresh each call.
        attributes: new Map(),
        attrCounter: 0,
        varyings: new Map(),
        builtins: new Set(),
        structs: new Map(),
        nodeVars: new Map(),
        varCounter: 0,
        indentLevel: 1,
        code: [],
        graphNodes: new Map(),
        graphEdges: new Map(),
        graphInfo: new Map(),
    };
}

/** Pre-collect VaryingNodes from roots and generate their vertex expressions. */
export function collectVaryings(roots: Node<d.Any>[], ctx: BuildContext): void {
    const visited = new Set<number>();

    function visit(rawNode: Node<d.Any>) {
        const node = rawNode as AnyNode;
        if (visited.has(node.id)) return;
        visited.add(node.id);

        if (node.kind === NodeKind.Varying) {
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

function generateExpr(ctx: BuildContext, rawNode: Node<d.Any>): string {
    const node = rawNode as AnyNode;
    // Record node for graph
    ctx.graphNodes.set(node.id, node);

    // CSE: if already computed and multi-use, return variable name
    if (ctx.nodeVars.has(node.id)) {
        return ctx.nodeVars.get(node.id)!;
    }

    let expr: string;

    if (node.kind === NodeKind.Literal) {
        expr = constLiteral(node.type.wgslType, node.value);
    } else if (node.kind === NodeKind.Uniform) {
        expr = generateUniform(ctx, node);
    } else if (node.kind === NodeKind.Attribute) {
        expr = generateAttribute(ctx, node);
    } else if (node.kind === NodeKind.Storage) {
        expr = generateStorage(ctx, node);
    } else if (node.kind === NodeKind.Pass) {
        // PassNode used as expression delegates to its texture node
        const textureNode = node.scope === 'fragment' ? node.getTextureNode() : node.getLinearDepthNode();
        expr = generateExpr(ctx, textureNode);
    } else if (node.kind === NodeKind.TextureBinding) {
        expr = generateTextureBinding(ctx, node);
    } else if (node.kind === NodeKind.StorageTextureBinding) {
        expr = generateStorageTextureBinding(ctx, node);
    } else if (node.kind === NodeKind.Texture) {
        expr = generateTexture(ctx, node);
    } else if (node.kind === NodeKind.CubeTexture) {
        expr = generateCubeTexture(ctx, node);
    } else if (node.kind === NodeKind.DepthTexture) {
        expr = generateDepthTexture(ctx, node);
    } else if (node.kind === NodeKind.ArrayTexture) {
        expr = generateArrayTexture(ctx, node);
    } else if (node.kind === NodeKind.Sampler) {
        expr = generateSampler(ctx, node);
    } else if (node.kind === NodeKind.Varying) {
        expr = generateVarying(ctx, node);
    } else if (node.kind === NodeKind.BinaryOp) {
        const left = generateExpr(ctx, node.left);
        const right = generateExpr(ctx, node.right);
        expr = `(${left} ${node.op} ${right})`;
    } else if (node.kind === NodeKind.Call) {
        expr = generateCall(ctx, node);
    } else if (node.kind === NodeKind.Array) {
        const args = node.elements.map((e) => generateExpr(ctx, e));
        expr = `array<${node.type.element.wgslType}, ${node.elements.length}>(${args.join(', ')})`;
    } else if (node.kind === NodeKind.Construct) {
        const args = node.args.map((a) => generateExpr(ctx, a));
        expr = `${node.type.wgslType}(${args.join(', ')})`;
    } else if (node.kind === NodeKind.Field) {
        const obj = generateExpr(ctx, node.object);
        expr = `${obj}.${node.fieldName}`;
    } else if (node.kind === NodeKind.Index) {
        const arr = generateExpr(ctx, node.array);
        const idx = generateExpr(ctx, node.index);
        expr = `${arr}[${idx}]`;
    } else if (node.kind === NodeKind.Builtin) {
        expr = generateBuiltin(ctx, node);
    } else if (node.kind === NodeKind.ComputeIndex) {
        expr = 'computeIndex';
    } else if (node.kind === NodeKind.Conditional) {
        const cond = generateExpr(ctx, node.condition);
        const t = generateExpr(ctx, node.ifTrue);
        const f = node.ifFalse ? generateExpr(ctx, node.ifFalse) : `${node.type.wgslType}()`;
        expr = `select(${f}, ${t}, ${cond})`;
    } else if (node.kind === NodeKind.Wgsl) {
        // inline WGSL with $0, $1, ... placeholders
        if (node.wgsl === undefined) {
            throw new Error(
                `[wgsl] this inline node has only a GLSL variant (glsl\`\`); add a WGSL source to run on the WebGPU backend`,
            );
        }
        let wgsl = node.wgsl;
        for (let i = 0; i < node.deps.length; i++) {
            const depExpr = generateExpr(ctx, node.deps[i]);
            wgsl = wgsl.replace(new RegExp(`\\$${i}`, 'g'), depExpr);
        }
        expr = wgsl;
    } else if (node.kind === NodeKind.Let) {
        // LetNode as expression returns the variable name
        // If not yet declared, emit the declaration now
        if (!ctx.nodeVars.has(node.id)) {
            const init = generateExpr(ctx, node.init);
            ctx.code.push(`    let ${node.varName} = ${init};`);
            ctx.nodeVars.set(node.id, node.varName);
        }
        expr = node.varName;
    } else if (node.kind === NodeKind.Var) {
        // VarNode as expression returns the variable name
        // If not yet declared, emit the declaration now
        if (!ctx.nodeVars.has(node.id)) {
            const init = generateExpr(ctx, node.init);
            ctx.code.push(`    var ${node.varName} = ${init};`);
            ctx.nodeVars.set(node.id, node.varName);
        }
        expr = node.varName;
    } else if (node.kind === NodeKind.PrivateVar) {
        // PrivateVarNode is module-scope, emitted separately
        // Just return the variable name - declaration is in emitModuleScopeVars
        ctx.nodeVars.set(node.id, node.varName);
        expr = node.varName;
    } else if (node.kind === NodeKind.WorkgroupVar) {
        // WorkgroupVarNode is module-scope, emitted separately
        // Validate it's only used in compute shaders
        if (ctx.stage !== 'compute') {
            throw new Error(
                `[builder] WorkgroupVarNode '${node.varName}' can only be used in compute shaders, but was used in ${ctx.stage} stage.`,
            );
        }
        ctx.nodeVars.set(node.id, node.varName);
        expr = node.varName;
    } else if (node.kind === NodeKind.Parameter) {
        expr = node.paramName ?? `p${node.paramIndex}`;
    } else if (node.kind === NodeKind.Inspector) {
        // inspector is transparent - just generate the wrapped node
        expr = generateExpr(ctx, node.wrappedNode);
    } else if (node.kind === NodeKind.OutputStruct || node.kind === NodeKind.MRT) {
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
        node.kind === NodeKind.Literal ||
        node.kind === NodeKind.Let ||
        node.kind === NodeKind.Var ||
        node.kind === NodeKind.PrivateVar ||
        node.kind === NodeKind.WorkgroupVar ||
        node.kind === NodeKind.Parameter ||
        node.kind === NodeKind.Builtin ||
        node.kind === NodeKind.Field ||
        // binding references are global names
        node.kind === NodeKind.Storage ||
        node.kind === NodeKind.Uniform ||
        node.kind === NodeKind.TextureBinding ||
        node.kind === NodeKind.Sampler ||
        node.kind === NodeKind.Attribute
    );
}

/** Check if a node's type cannot be copied into a let binding */
function isNonCopyable(node: Node<d.Any>): boolean {
    if (containsAtomics(node.type)) return true;
    if (isStorageElementAccess(node)) return true;
    return false;
}

/** Check if node is an access into storage (IndexNode into StorageNode, or FieldNode/IndexNode chain from one) */
function isStorageElementAccess(rawNode: Node<d.Any>): boolean {
    const node = rawNode as AnyNode;
    if (node.kind === NodeKind.Index) {
        if (node.array.kind === NodeKind.Storage) return true;
        // Also check if indexing into something that's itself a storage access
        return isStorageElementAccess(node.array);
    }
    if (node.kind === NodeKind.Field) return isStorageElementAccess(node.object);
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
    }
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

function generateStorageTextureBinding(ctx: BuildContext, node: StorageTextureBindingNode): string {
    const name = node.textureId;
    if (!ctx.storageTextures.has(name)) {
        ctx.storageTextures.set(name, node);
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
        samplerNode = new SamplerNode(d.sampler, name, binding.group);
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
        samplerNode = new SamplerNode(d.sampler, name, binding.group);
        node.samplerNode = samplerNode;
    }

    // Register the sampler (this handles deduplication by settingsKey)
    const samplerName = generateSampler(ctx, samplerNode);

    // Cube textures require a direction vector (vec3f)
    if (!node.directionNode) {
        throw new Error(`[builder] CubeTextureNode '${name}' has no directionNode. Use cubeTexture.sample(direction).`);
    }
    // Always negate the sample direction's X for WebGPU cube sampling. The CubeCamera stores
    // faces with swapped X (by design), and negating the sample direction un-does the swap so
    // the correct face is selected by the hardware.
    const rawDir = generateExpr(ctx, node.directionNode);
    const sampleDir = `((${rawDir}) * vec3f(-1.0, 1.0, 1.0))`;

    // Cube textures do NOT support offset

    // textureSampleGrad (vec3f gradients for cube textures)
    if (node.samplingMode === 'grad') {
        if (!node.gradNode) {
            throw new Error(`[builder] CubeTextureNode '${name}' in grad mode has no gradNode`);
        }
        const ddx = generateExpr(ctx, node.gradNode[0]);
        const ddy = generateExpr(ctx, node.gradNode[1]);
        return `textureSampleGrad(${name}, ${samplerName}, ${sampleDir}, ${ddx}, ${ddy})`;
    }

    // textureSampleBias
    if (node.samplingMode === 'bias') {
        if (!node.biasNode) {
            throw new Error(`[builder] CubeTextureNode '${name}' in bias mode has no biasNode`);
        }
        const bias = generateExpr(ctx, node.biasNode);
        return `textureSampleBias(${name}, ${samplerName}, ${sampleDir}, ${bias})`;
    }

    // textureSampleLevel
    if (node.samplingMode === 'level') {
        if (!node.levelNode) {
            throw new Error(`[builder] CubeTextureNode '${name}' in level mode has no levelNode`);
        }
        const level = generateExpr(ctx, node.levelNode);
        return `textureSampleLevel(${name}, ${samplerName}, ${sampleDir}, ${level})`;
    }

    // textureSample (default)
    return `textureSample(${name}, ${samplerName}, ${sampleDir})`;
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
        samplerNode = new SamplerNode(d.sampler, name, binding.group);
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
        samplerNode = new SamplerNode(d.sampler, name, binding.group);
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
        if (!fn.code) {
            throw new Error(
                `[wgsl] this function has only a GLSL variant (glslFn); add a WGSL source to run on the WebGPU backend`,
            );
        }
        if (!ctx.wgslFnDefs.has(fn.code)) {
            ctx.wgslFnDefs.set(fn.code, fn);
            // also register includes
            for (const inc of fn.includes) {
                if (inc.kind === NodeKind.WgslFunction && !ctx.wgslFnDefs.has(inc.code)) {
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

function generateStmt(ctx: BuildContext, rawNode: Node<d.Any>): void {
    const node = rawNode as AnyNode;
    const ind = '    '.repeat(ctx.indentLevel);

    if (node.kind === NodeKind.Let) {
        const init = generateExpr(ctx, node.init);
        ctx.code.push(`${ind}let ${node.varName} = ${init};`);
        ctx.nodeVars.set(node.id, node.varName);
    } else if (node.kind === NodeKind.Var) {
        const init = generateExpr(ctx, node.init);
        ctx.code.push(`${ind}var ${node.varName} = ${init};`);
        ctx.nodeVars.set(node.id, node.varName);
    } else if (node.kind === NodeKind.Assign) {
        const target = generateExpr(ctx, node.target);
        const value = generateExpr(ctx, node.value);
        ctx.code.push(`${ind}${target} = ${value};`);
    } else if (node.kind === NodeKind.If) {
        generateIfStmt(ctx, node);
    } else if (node.kind === NodeKind.Loop) {
        generateLoopStmt(ctx, node);
    } else if (node.kind === NodeKind.Break) {
        ctx.code.push(`${ind}break;`);
    } else if (node.kind === NodeKind.Continue) {
        ctx.code.push(`${ind}continue;`);
    } else if (node.kind === NodeKind.Discard) {
        ctx.code.push(`${ind}discard;`);
    } else if (node.kind === NodeKind.Return) {
        if (node.value.type.wgslType === 'void') {
            ctx.code.push(`${ind}return;`);
        } else {
            const val = generateExpr(ctx, node.value);
            ctx.code.push(`${ind}return ${val};`);
        }
    } else if (node.kind === NodeKind.Stack) {
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
    } else if (isNode(config) && (config.kind === NodeKind.Literal || config.kind === NodeKind.Uniform)) {
        const endExpr = generateExpr(ctx, config as Node<d.Any>);
        loopHeader = `for (var ${wgslVarName}: i32 = 0i; ${wgslVarName} < ${endExpr}; ${wgslVarName}++)`;
    } else if (isNode(config)) {
        // Bare expression node (from `While(cond, …)`): a condition-driven
        // loop. WGSL re-evaluates the header condition every iteration, so a
        // body that mutates variables used in `cond` terminates correctly.
        loopHeader = `while (${generateExpr(ctx, config as Node<d.Any>)})`;
    } else if (typeof config === 'object' && config !== null) {
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
export function emitModuleScopeVars(ctx: BuildContext): string {
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
function generateModuleScopeInitExpr(rawNode: Node<d.Any>): string {
    const node = rawNode as AnyNode;
    if (node.kind === NodeKind.Literal) {
        return constLiteral(node.type.wgslType, node.value);
    } else if (node.kind === NodeKind.Construct) {
        const args = node.args.map((a) => generateModuleScopeInitExpr(a));
        return `${node.type.wgslType}(${args.join(', ')})`;
    } else if (node.kind === NodeKind.BinaryOp) {
        const left = generateModuleScopeInitExpr(node.left);
        const right = generateModuleScopeInitExpr(node.right);
        return `(${left} ${node.op} ${right})`;
    } else if (node.kind === NodeKind.Call) {
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
    group: UniformGroup;
    groupIndex: number;
    uniforms: UniformNode<d.Any>[];
    storages: { name: string; node: StorageNode<d.Any> }[];
    textures: { name: string; node: TextureBindingNode }[];
    storageTextures: { name: string; node: StorageTextureBindingNode }[];
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
export function emitAllBindings(ctx: BuildContext): {
    wgsl: string;
    uniformBlocks: UniformGroupBlock[];
    storageEntries: StorageEntry[];
    textureEntries: TextureEntry[];
    storageTextureEntries: StorageTextureEntry[];
    samplerEntries: SamplerEntry[];
} {
    // step 1: collect all resources by their group
    const groupsByName = new Map<string, BindingGroupData>();

    // helper to get or create a group
    const getGroup = (group: UniformGroup): BindingGroupData => {
        const name = group.name;
        if (!groupsByName.has(name)) {
            groupsByName.set(name, {
                group,
                groupIndex: group.order, // temporary, will be reassigned after sorting
                uniforms: [],
                storages: [],
                textures: [],
                storageTextures: [],
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
        getGroup(node.group).storages.push({ name, node });
    }

    // collect textures
    for (const [name, node] of ctx.textures) {
        getGroup(node.group).textures.push({ name, node });
    }

    // collect storage textures
    for (const [name, node] of ctx.storageTextures) {
        getGroup(node.group).storageTextures.push({ name, node });
    }

    // collect samplers (deduplicated by settingsKey)
    for (const [_settingsKey, node] of ctx.samplers) {
        const name = node.samplerId;
        getGroup(node.group).samplers.push({ name, node });
    }

    // step 2: sort groups by their order, then assign sequential group indices
    // @group(N) is the sorted array position
    const sortedGroups = [...groupsByName.values()].sort((a, b) => a.group.order - b.group.order);

    // Reassign groupIndex to be the sorted array position
    for (let i = 0; i < sortedGroups.length; i++) {
        sortedGroups[i].groupIndex = i;
    }

    // step 3: emit WGSL and build result arrays
    const lines: string[] = [];
    const uniformBlocks: UniformGroupBlock[] = [];
    const storageEntries: StorageEntry[] = [];
    const textureEntries: TextureEntry[] = [];
    const storageTextureEntries: StorageTextureEntry[] = [];
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

    for (const bindGroup of sortedGroups) {
        const groupIndex = bindGroup.groupIndex;
        const groupName = bindGroup.group.name;
        let bindingIndex = 0;

        // emit uniform struct and binding (if any uniforms)
        if (bindGroup.uniforms.length > 0) {
            lines.push(`struct Uniforms_${groupName} {`);

            const members: UniformMember[] = [];
            let offset = 0;

            for (const u of bindGroup.uniforms) {
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
            for (const u of bindGroup.uniforms) {
                structAlign = Math.max(structAlign, wgslAlign(u.type.wgslType));
            }
            // Round up totalBytes to struct alignment
            const totalBytes = Math.ceil(offset / structAlign) * structAlign;

            uniformBlocks.push({
                groupName,
                groupIndex,
                binding: bindingIndex,
                shared: bindGroup.group.shared,
                members,
                totalBytes,
                group: bindGroup.group,
            });

            bindingIndex++;
        }

        // emit storage bindings
        for (const { name, node } of bindGroup.storages) {
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
        for (const { name, node } of bindGroup.textures) {
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

        // emit storage texture bindings
        for (const { name, node } of bindGroup.storageTextures) {
            // WGSL forbids write/read_write storage textures outside compute. Force read in
            // render stages so the emitted var access matches the bind-group layout access.
            const access = ctx.stage === 'compute' ? node.access : 'read';
            if (access !== node.access && node.access !== 'read') {
                throw new Error(
                    `[gpucat] storage texture '${name}' uses access '${node.access}' but is referenced in a ` +
                        `${ctx.stage} shader; write/read_write storage textures are compute-only.`,
                );
            }
            const wgslType = `texture_storage_${node.dim}<${node.format}, ${access}>`;
            lines.push(`@group(${groupIndex}) @binding(${bindingIndex}) var ${name}: ${wgslType};`);
            storageTextureEntries.push({
                textureId: name,
                type: wgslType,
                format: node.format,
                access,
                dim: node.dim,
                group: groupIndex,
                binding: bindingIndex,
                node,
            });
            bindingIndex++;
        }

        for (const { name, node } of bindGroup.samplers) {
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
        storageTextureEntries,
        samplerEntries,
    };
}

export function emitWgslFunctions(ctx: BuildContext): string {
    const lines: string[] = [];
    const emitted = new Set<string>();

    // emit wgslFn functions in dependency order
    for (const [_code, fn] of ctx.wgslFnDefs) {
        // emit includes first
        for (const inc of fn.includes) {
            if (inc.kind === NodeKind.WgslFunction && !emitted.has(inc.code)) {
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

export function emitDslFunctions(ctx: BuildContext): string {
    const lines: string[] = [];

    for (const [name, { fn, traced }] of ctx.fnDefs) {
        // build parameter list
        const params = traced.params
            .map((p, i) => {
                const pName = p.paramName ?? `p${i}`;
                return `${pName}: ${p.type.wgslType}`;
            })
            .join(', ');

        // Fresh emission scope for this function body: its own CSE vars / code / indentation, but it
        // shares the parent's bindings + function tables so references resolve to the same WGSL names.
        // Deliberately does NOT share mutatedNodes or module-scope vars — the body has its own CSE scope.
        const fnDiscovery = emptyDiscovery();
        fnDiscovery.nodeIdToUsages = ctx.usageCount;
        fnDiscovery.fnDefs = ctx.fnDefs;
        fnDiscovery.wgslFnDefs = ctx.wgslFnDefs;
        fnDiscovery.textures = ctx.textures;
        fnDiscovery.samplers = ctx.samplers;
        fnDiscovery.uniforms = ctx.uniforms;
        fnDiscovery.storages = ctx.storages;
        fnDiscovery.storageNames = ctx.storageNames;
        const fnCtx = createContext(ctx.stage, ctx.isRender, fnDiscovery);

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

export function generateVertexShader(slots: CompileSlots, ctx: BuildContext): string {
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

export function generateFragmentShader(
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
    const isMRT = fragmentNode.kind === NodeKind.MRT;
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

export function generateComputeShader(node: ComputeNode, traced: ReturnType<FnNode<d.Any>['trace']>, ctx: BuildContext): string {
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
