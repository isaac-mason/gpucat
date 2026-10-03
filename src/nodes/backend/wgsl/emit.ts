/**
 * backend/wgsl/emit.ts — the WGSL emitter.
 *
 * Consumes the backend-neutral node graph + discovered facts (carried on BuildContext) and produces
 * WGSL source strings. This is the first concrete shader backend; a future GLSL emitter is a sibling
 * module here. Nothing in this file touches GPUDevice or any runtime object — it is purely
 * node-graph → text. compile()/compileCompute() (in ../../builder) orchestrate discover → emit.
 */

import { layoutAlignOf, layoutSizeOf } from '../../../schema/pack';
import type { StructSchema } from '../../../schema/schema';
import * as d from '../../../schema/schema';
import { assertUniformLayoutConformant } from '../../../schema/validate-layout';
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
    type LetNode,
    type LoopNode,
    type Node,
    NodeKind,
    type ParameterNode,
    type PrivateVarNode,
    type StackNode,
    type StructDef,
    type StructNode,
    type VarNode,
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
import {
    allocName,
    createNameScope,
    cseBaseName,
    derivedSamplerName,
    loopVarName,
    type NameScope,
    reserveName,
    tracedFnCallees,
} from '../names';
import { binaryPrec, Prec, paren, unary, wgslBinaryOperandMin } from '../print';

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
    textureNames: Map<string, string>; // textureId -> shader identifier
    samplerNames: Map<string, string>; // sampler settingsKey -> shader identifier
    uniformNames: Map<string, string>; // uniform identity -> block member identifier
    bindingNames: NameScope; // the scope those were allocated from (for bindings found during emission)
    textures: Map<string, TextureBindingNode>;
    storageTextures: Map<string, StorageTextureBindingNode>;
    samplers: Map<string, SamplerNode>; // keyed by settingsKey for deduplication
    attributes: Map<number, AttributeEntry>; // node.id -> entry
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

    /** node.id -> binding strength of the expression string generateExpr() produced for it. */
    precOf: Map<number, Prec>;

    /** Identifiers taken in this emission scope: locals, loop counters, CSE temps, and every global
     *  name already in scope (seeded from the discovery — see {@link seedGlobalNames}). */
    names: NameScope;

    // CSE hoisting: when >= 0, a function-scope-stable CSE temp is spliced into `code` at this index
    // (the body top) instead of pushed at first use — so a temp used across a block boundary is in
    // scope for every use. -1 disables hoisting (main shader bodies). See {@link isHoistStable}.
    hoistIndex: number;
    topScopeParamIds: Set<number>;
    hoistStableMemo: Map<number, boolean>;

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
        textureNames: new Map(),
        samplerNames: new Map(),
        uniformNames: new Map(),
        bindingNames: createNameScope(),
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
        textureNames: discovery.textureNames,
        samplerNames: discovery.samplerNames,
        uniformNames: discovery.uniformNames,
        bindingNames: discovery.bindingNames,
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
        varyings: new Map(),
        builtins: new Set(),
        structs: new Map(),
        nodeVars: new Map(),
        precOf: new Map(),
        names: seedGlobalNames(discovery),
        hoistIndex: -1,
        topScopeParamIds: new Set(),
        hoistStableMemo: new Map(),
        indentLevel: 1,
        code: [],
        graphNodes: new Map(),
        graphEdges: new Map(),
        graphInfo: new Map(),
    };
}

/**
 * A name scope holding every identifier the shader's GLOBALS already occupy, so a local allocated
 * later cannot take one. Bindings, module-scope variables and function names are all known from the
 * discovery pass, before a single statement is emitted; varyings are reserved as they are collected.
 */
function seedGlobalNames(discovery: Discovery): NameScope {
    const names = createNameScope();
    for (const name of discovery.storageNames.values()) reserveName(names, name);
    for (const name of discovery.textureNames.values()) reserveName(names, name);
    for (const name of discovery.samplerNames.values()) reserveName(names, name);
    for (const { group } of discovery.uniforms.values()) reserveName(names, `uniforms_${group.name}`);
    for (const node of discovery.privateVars.values()) reserveName(names, node.varName);
    for (const node of discovery.workgroupVars.values()) reserveName(names, node.varName);
    for (const fnName of discovery.fnDefs.keys()) reserveName(names, fnName);
    return names;
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

// Leaf node kinds that are IMMUTABLE and available for the whole function/stage: constants, uniforms,
// stage inputs. Deliberately excludes mutable/order-sensitive state (private/workgroup vars, storage,
// textures) — reading those and hoisting across a barrier or write would change results.
const HOIST_LEAF_KINDS = new Set<NodeKind>([
    NodeKind.Literal,
    NodeKind.Uniform,
    NodeKind.Builtin,
    NodeKind.ComputeIndex,
    NodeKind.Attribute,
]);
// Pure, side-effect-free operator kinds whose stability follows from their operands. Deliberately
// excludes Call (may be a side-effecting builtin — atomicAdd, textureStore) and Index (a storage read),
// which must not be reordered.
const HOIST_TRANSPARENT_KINDS = new Set<NodeKind>([
    NodeKind.BinaryOp,
    NodeKind.Construct,
    NodeKind.Field,
    NodeKind.Array,
    NodeKind.Conditional,
    NodeKind.Struct,
]);

/**
 * Whether a node's value is stable at the function-body top: built ONLY from immutable, side-effect-free
 * inputs — constants, uniforms, stage inputs, and THIS function's params — via pure arithmetic. Loop
 * variables are ParameterNodes too, but are block-scoped, so they're excluded by id (only the fn's own
 * param ids are passed in). Used to decide if a CSE temp used across a block boundary can be hoisted to
 * the body top — fixing the out-of-scope `_vN` bug — without moving a block-scoped binding, a mutable
 * read, or a side effect. Conservative: anything not clearly pure resolves to false (stays at first use).
 */
function isHoistStable(node: AnyNode, paramIds: Set<number>, memo: Map<number, boolean>): boolean {
    const cached = memo.get(node.id);
    if (cached !== undefined) return cached;
    memo.set(node.id, false); // break cycles conservatively
    let result: boolean;
    if (node.kind === NodeKind.Parameter) result = paramIds.has(node.id);
    else if (HOIST_LEAF_KINDS.has(node.kind)) result = true;
    else if (HOIST_TRANSPARENT_KINDS.has(node.kind))
        result = getChildren(node).every((c) => isHoistStable(c as AnyNode, paramIds, memo));
    else result = false;
    memo.set(node.id, result);
    return result;
}

/**
 * Binding strength of the string {@link generateExpr} returned for `node`, recorded by that function
 * as it emits. Reading it back — rather than re-deriving it from the node kind — keeps the two in step
 * by construction: a branch cannot change shape without changing what it records.
 *
 * Only meaningful AFTER generateExpr(node) has run; before that (and for a node whose branch never
 * recorded one) it answers `Prec.Lowest`, which parenthesises unconditionally.
 */
function emittedPrec(ctx: BuildContext, node: Node<d.Any>): Prec {
    // A node bound to a name — a CSE temp, a Let/Var, a loop counter, a parameter — emits as a bare
    // identifier. Several of those are registered outside generateExpr, so this is checked first.
    if (ctx.nodeVars.has(node.id)) return Prec.Postfix;
    return ctx.precOf.get(node.id) ?? Prec.Lowest;
}

/** Generate an operand and wrap it if it binds looser than `min`. */
function generateOperand(ctx: BuildContext, node: Node<d.Any>, min: Prec): string {
    const expr = generateExpr(ctx, node);
    return paren(expr, emittedPrec(ctx, node), min);
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
    // Binding strength of `expr`, recorded into ctx.precOf at the bottom so callers can decide whether
    // to parenthesise it. Nearly every branch below emits a name, a call, a constructor or a member
    // chain, so Postfix is the default; a branch that emits anything looser MUST say so.
    let prec: Prec = Prec.Postfix;

    if (node.kind === NodeKind.Literal) {
        expr = constLiteral(node.type.wgslType, node.value);
        // A negative scalar literal lexes as unary minus applied to a literal.
        if (typeof node.value === 'number' && node.value < 0) prec = Prec.Unary;
    } else if (node.kind === NodeKind.Uniform) {
        expr = generateUniform(ctx, node);
    } else if (node.kind === NodeKind.Attribute) {
        expr = generateAttribute(ctx, node);
    } else if (node.kind === NodeKind.Storage) {
        expr = generateStorage(ctx, node);
    } else if (node.kind === NodeKind.RenderTexture) {
        // RenderTextureNode used as expression delegates to its texture node
        const textureNode = node.read === 'depth' ? node.getLinearDepthNode() : node.getTextureNode();
        expr = generateExpr(ctx, textureNode);
        prec = emittedPrec(ctx, textureNode);
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
        // In the vertex stage a varying emits its SOURCE expression rather than a name.
        if (ctx.stage === 'vertex') prec = emittedPrec(ctx, node.node.node);
    } else if (node.kind === NodeKind.BinaryOp) {
        const rawLeft = generateExpr(ctx, node.left);
        const rawRight = generateExpr(ctx, node.right);
        let leftPrec = emittedPrec(ctx, node.left);
        let rightPrec = emittedPrec(ctx, node.right);
        const [left, right] = coerceBinaryOperands(node, rawLeft, rawRight);
        // A coerced operand has been wrapped in a conversion constructor, so it no longer needs parens.
        if (left !== rawLeft) leftPrec = Prec.Postfix;
        if (right !== rawRight) rightPrec = Prec.Postfix;
        prec = binaryPrec(node.op);
        const [leftMin, rightMin] = wgslBinaryOperandMin(prec);
        expr = `${paren(left, leftPrec, leftMin)} ${node.op} ${paren(right, rightPrec, rightMin)}`;
    } else if (node.kind === NodeKind.Call) {
        expr = generateCall(ctx, node);
        prec = callPrec(ctx, node);
    } else if (node.kind === NodeKind.Array) {
        const args = node.elements.map((e) => generateExpr(ctx, e));
        expr = `array<${node.type.element.wgslType}, ${node.elements.length}>(${args.join(', ')})`;
    } else if (node.kind === NodeKind.Construct) {
        const folded = foldScalarConversion(node);
        const identity = identityConversionArg(node);
        if (folded !== undefined) {
            expr = constLiteral(node.type.wgslType, folded);
            if (folded < 0) prec = Prec.Unary;
        } else if (identity) {
            expr = generateExpr(ctx, identity);
            prec = emittedPrec(ctx, identity);
        } else {
            const args = node.args.map((a) => generateExpr(ctx, a));
            expr = `${node.type.wgslType}(${args.join(', ')})`;
        }
    } else if (node.kind === NodeKind.Field) {
        expr = `${generateOperand(ctx, node.object, Prec.Postfix)}.${node.fieldName}`;
    } else if (node.kind === NodeKind.Index) {
        const arr = generateOperand(ctx, node.array, Prec.Postfix);
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
        // Hand-written source of unknown shape: wrap it wherever it lands, so a template holding
        // `a + b` cannot silently re-associate against the operator it is spliced into.
        prec = Prec.Lowest;
    } else if (node.kind === NodeKind.Let || node.kind === NodeKind.Var) {
        // A Let/Var used as an expression resolves to its name; if the statement that declares it has
        // not run yet, declare it here.
        expr = ctx.nodeVars.get(node.id) ?? declareLocal(ctx, node, '    ');
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
        prec = emittedPrec(ctx, node.wrappedNode);
    } else if (node.kind === NodeKind.OutputStruct || node.kind === NodeKind.MRT) {
        // these are handled specially at the fragment output level
        expr = `/* OutputStruct */`;
    } else {
        console.warn(`[builder] Unknown node kind for expr: ${node.constructor.name}`, node);
        expr = `/* unknown: ${node.constructor.name} */`;
        prec = Prec.Lowest;
    }

    ctx.precOf.set(node.id, prec);

    // CSE: if multi-use, extract to variable
    const usage = ctx.usageCount.get(node.id) ?? 1;
    if (usage > 1 && !ctx.nodeVars.has(node.id) && !isTrivialExpr(ctx, node) && !isNonCopyable(node)) {
        const varName = allocName(ctx.names, cseBaseName(node));
        const keyword = ctx.mutatedNodes.has(node.id) ? 'var' : 'let';
        const decl = `${keyword} ${varName} = ${expr};`;
        // A pure temp used more than once may be used across a block boundary (e.g. inside an if AND
        // after it). Declaring it at first use would leave it out of scope for the later use, so if it's
        // stable at body top, splice it there. Only immutable (`let`) values built from function-scope
        // inputs qualify; anything touching a loop var or a block-local `let`/`var` stays at first use.
        if (ctx.hoistIndex >= 0 && keyword === 'let' && isHoistStable(node, ctx.topScopeParamIds, ctx.hoistStableMemo)) {
            // The body top is always one level in, whatever block the temp was first reached from.
            ctx.code.splice(ctx.hoistIndex, 0, `    ${decl}`);
            ctx.hoistIndex++;
        } else {
            // Declared where it is first used, so it takes the indentation of THAT block — not the
            // body's. (This read `    ` regardless, so a temp inside an if landed a level out.)
            ctx.code.push(`${'    '.repeat(ctx.indentLevel)}${decl}`);
        }
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

/** Component kind of a numeric SCALAR descriptor (not a vector, not bool), else null. */
function numericScalarKind(desc: d.Any): string | null {
    if (!('len' in desc) || desc.len !== 1) return null;
    return desc.scalar === 'bool' ? null : desc.scalar;
}

/**
 * The value a numeric scalar conversion of a literal collapses to, or undefined if the node is not
 * one. `u32(0.0)` means `0u`, which is what an array index should look like; the constructor form only
 * obscured it. Bool is excluded on both sides — those conversions are value tests, not a respelling.
 */
function foldScalarConversion(node: { args: readonly Node<d.Any>[]; type: d.Any }): number | undefined {
    if (node.args.length !== 1 || numericScalarKind(node.type) === null) return undefined;
    const arg = node.args[0] as AnyNode;
    if (arg.kind !== NodeKind.Literal || typeof arg.value !== 'number') return undefined;
    return numericScalarKind(arg.type) === null ? undefined : arg.value;
}

/**
 * The operand of a one-argument conversion whose target type is ALREADY the argument's type — a
 * `vec2i(v)` where `v` is a vec2i, which spells out nothing. Mirrors three.js's NodeBuilder.format(),
 * which returns the operand untouched when the two types match.
 *
 * Composites are excluded: a one-field struct or array constructor is a construction, not a respelling.
 */
function identityConversionArg(node: { args: readonly Node<d.Any>[]; type: d.Any }): Node<d.Any> | undefined {
    if (node.args.length !== 1) return undefined;
    if (d.isStructDesc(node.type) || d.isArrayDesc(node.type) || d.isSizedArrayDesc(node.type)) return undefined;
    const arg = node.args[0];
    return arg.type.wgslType === node.type.wgslType ? arg : undefined;
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
function isTrivialExpr(ctx: BuildContext, node: Node<d.Any>): boolean {
    return (
        node.kind === NodeKind.Literal ||
        // A varying READ is `input.name`, as cheap to repeat as an attribute. In the VERTEX stage it
        // is the varying's whole source expression instead, which is not.
        (node.kind === NodeKind.Varying && ctx.stage !== 'vertex') ||
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
    const group = node.group;
    ctx.uniforms.set(node.name, { node, group });
    return `uniforms_${group.name}.${uniformMemberName(ctx, node)}`;
}

/**
 * The block-member spelling for a uniform, allocated on first sight. `node.name` is identity — for a
 * value-based uniform that is a node-id placeholder, which must never reach the source: node ids come
 * from a process-wide counter, so emitting one makes the shader text differ between two compiles of
 * the same graph (and the WebGL program cache keys on that text).
 */
function uniformMemberName(ctx: BuildContext, node: UniformNode<d.Any>): string {
    const existing = ctx.uniformNames.get(node.name);
    if (existing !== undefined) return existing;
    const name = allocName(ctx.bindingNames, node.uniform.label || `uniform${ctx.uniformNames.size}`);
    ctx.uniformNames.set(node.name, name);
    return name;
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

    if (node.isNamedReference) {
        const geomName = node.name!;
        // A VertexInput member, so it cannot collide with anything outside the struct; only distinct
        // attributes sharing a geometry name need separating, which the suffix below handles.
        const shaderName = uniqueAttributeName(ctx, geomName);
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
    const shaderName = uniqueAttributeName(ctx, 'buf');
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

/** `name`, or `name_1`, `name_2`, … if the VertexInput struct already has a member spelled that way. */
function uniqueAttributeName(ctx: BuildContext, name: string): string {
    const taken = new Set<string>();
    for (const attr of ctx.attributes.values()) taken.add(attr.shaderName);
    if (!taken.has(name)) return name;
    for (let n = 1; ; n++) {
        if (!taken.has(`${name}_${n}`)) return `${name}_${n}`;
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

/**
 * The shader spelling for a texture binding, allocating one if this is the first time it has been
 * seen. Discovery names everything it can reach, but a texture sampled only inside an Fn body first
 * appears when that body is traced during emission — so the name is allocated here, from the same
 * scope, and recorded for the declaration pass that follows.
 */
function textureShaderName(ctx: BuildContext, node: TextureBindingNode | StorageTextureBindingNode, prefix: string): string {
    const existing = ctx.textureNames.get(node.textureId);
    if (existing !== undefined) return existing;
    const name = allocName(ctx.bindingNames, node.value?.label || `${prefix}${ctx.textureNames.size}`);
    ctx.textureNames.set(node.textureId, name);
    return name;
}

function generateTextureBinding(ctx: BuildContext, node: TextureBindingNode): string {
    if (!ctx.textures.has(node.textureId)) {
        ctx.textures.set(node.textureId, node);
    }
    return textureShaderName(ctx, node, 't');
}

function generateStorageTextureBinding(ctx: BuildContext, node: StorageTextureBindingNode): string {
    if (!ctx.storageTextures.has(node.textureId)) {
        ctx.storageTextures.set(node.textureId, node);
    }
    return textureShaderName(ctx, node, 'st');
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
    // If no samplerNode exists (e.g. a pass-sourced texture), create a default one
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

    // textureSample (default). Implicit-LOD sampling needs fragment-stage derivatives and is forbidden
    // in the vertex stage, so sample at the base level there.
    if (ctx.stage === 'vertex') {
        return `textureSampleLevel(${name}, ${samplerName}, ${uvExpr}, 0.0${offsetSuffix})`;
    }
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
    const sampleDir = `${generateOperand(ctx, node.directionNode, Prec.Multiplicative)} * vec3f(-1.0, 1.0, 1.0)`;

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

    // textureSample (default). Implicit LOD is vertex-forbidden — sample at base level there.
    if (ctx.stage === 'vertex') {
        return `textureSampleLevel(${name}, ${samplerName}, ${sampleDir}, 0.0)`;
    }
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

    // textureSample (default), returns f32. Implicit LOD is vertex-forbidden — sample base level (i32
    // level for depth textures) there.
    if (ctx.stage === 'vertex') {
        return `textureSampleLevel(${name}, ${samplerName}, ${uvExpr}, 0${offsetSuffix})`;
    }
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

    // textureSample(t, s, coords, array_index [, offset]). Implicit LOD is vertex-forbidden — base level.
    if (ctx.stage === 'vertex') {
        return `textureSampleLevel(${name}, ${samplerName}, ${uvExpr}, ${layerExpr}, 0.0${offsetSuffix})`;
    }
    return `textureSample(${name}, ${samplerName}, ${uvExpr}, ${layerExpr}${offsetSuffix})`;
}

function generateSampler(ctx: BuildContext, node: SamplerNode): string {
    const key = node.settingsKey;

    // Register sampler for binding emission (deduplicated by settings)
    if (!ctx.samplers.has(key)) {
        ctx.samplers.set(key, node);
    }

    // The registered sampler's name — deduplicated by settings, so several textures share one.
    return samplerShaderName(ctx, ctx.samplers.get(key)!, key);
}

/** The shader spelling for a sampler, allocated on first sight (see {@link textureShaderName}). */
function samplerShaderName(ctx: BuildContext, node: SamplerNode, settingsKey: string): string {
    const existing = ctx.samplerNames.get(settingsKey);
    if (existing !== undefined) return existing;
    const name = allocName(ctx.bindingNames, node.value.label || derivedSamplerName(node));
    ctx.samplerNames.set(settingsKey, name);
    return name;
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

/**
 * Binding strength of what {@link generateCall} emits. Every call is a `f(…)` postfix form except the
 * three lowerings below, which spell out an operator instead — keep this in step with them.
 */
function callPrec(ctx: BuildContext, node: CallNode<d.Any>): Prec {
    if (node.fn === node.type.wgslType) {
        const folded = foldScalarConversion(node);
        if (folded !== undefined) return folded < 0 ? Prec.Unary : Prec.Postfix;
        const identity = identityConversionArg(node);
        if (identity) return emittedPrec(ctx, identity);
    }
    if (node.args.length === 1) {
        if (node.fn === 'negate' || node.fn === 'not') return Prec.Unary;
        // A passthrough forwards its operand's spelling verbatim, so it inherits its strength.
        if (node.fn === 'ndcDepthToStorage') return emittedPrec(ctx, node.args[0]);
    }
    return Prec.Postfix;
}

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

    if (node.fn === node.type.wgslType) {
        // A scalar conversion of a literal (`u32(0.0)`) is that literal in the target type (`0u`).
        const folded = foldScalarConversion(node);
        if (folded !== undefined) return constLiteral(node.type.wgslType, folded);
        // A conversion to the type the operand already has spells out nothing.
        const identity = identityConversionArg(node);
        if (identity) return generateExpr(ctx, identity);
    }

    const args = node.args.map((a) => generateExpr(ctx, a));

    // handle special cases
    if (node.fn === 'negate' && args.length === 1) {
        return unary('-', args[0], emittedPrec(ctx, node.args[0]));
    }
    if (node.fn === 'not' && args.length === 1) {
        return unary('!', args[0], emittedPrec(ctx, node.args[0]));
    }
    // NDC depth → stored [0,1]. WebGPU NDC z is already [0,1] (ZO projection) — passthrough; GLSL remaps.
    if (node.fn === 'ndcDepthToStorage' && args.length === 1) {
        return args[0];
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
        // atomicLoad takes the pointer alone, so the remaining args may be empty.
        return `${node.fn}(${[`&${ptr}`, ...rest].join(', ')})`;
    }

    return `${node.fn}(${args.join(', ')})`;
}

/**
 * Emit the declaration for a Let/Var and bind its node to the allocated name. The author's label is
 * only a preference — the scope decides the final identifier, so two `Var('t', …)` in one function
 * become `t` and `t_1` instead of both being stamped with their node ids.
 */
function declareLocal(ctx: BuildContext, node: LetNode<d.Any> | VarNode<d.Any>, indent: string): string {
    const init = generateExpr(ctx, node.init);
    const name = allocName(ctx.names, node.label ?? 'v');
    const keyword = node.kind === NodeKind.Var ? 'var' : 'let';
    ctx.code.push(`${indent}${keyword} ${name} = ${init};`);
    ctx.nodeVars.set(node.id, name);
    return name;
}

/* statement generation */

function generateStmt(ctx: BuildContext, rawNode: Node<d.Any>): void {
    const node = rawNode as AnyNode;
    const ind = '    '.repeat(ctx.indentLevel);

    if (node.kind === NodeKind.Let || node.kind === NodeKind.Var) {
        declareLocal(ctx, node, ind);
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

    // Conventional counter name for the nesting depth; the scope resolves any collision.
    const depth = ctx.indentLevel - 1;
    const wgslVarName = allocName(ctx.names, loopVarName(depth));

    // Register the loop variable so references resolve to the WGSL name
    ctx.nodeVars.set(loopVar.id, wgslVarName);

    // Build loop header based on config type
    let loopHeader: string;

    if (typeof config === 'number') {
        loopHeader = `for (var ${wgslVarName}: i32 = 0i; ${wgslVarName} < ${config}i; ${wgslVarName}++)`;
    } else if (isNode(config) && (config.kind === NodeKind.Literal || config.kind === NodeKind.Uniform)) {
        const endExpr = generateOperand(ctx, config as Node<d.Any>, Prec.Relational + 1);
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
            // Both land beside the loop variable in a comparison or an initialiser.
            return generateOperand(ctx, v as Node<d.Any>, Prec.Relational + 1);
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
        const [left, right] = coerceBinaryOperands(
            node,
            generateModuleScopeInitExpr(node.left),
            generateModuleScopeInitExpr(node.right),
        );
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

    // collect textures (`name` is the shader spelling, the map key is the binding's identity)
    for (const [, node] of ctx.textures) {
        getGroup(node.group).textures.push({ name: textureShaderName(ctx, node, 't'), node });
    }

    // collect storage textures
    for (const [, node] of ctx.storageTextures) {
        getGroup(node.group).storageTextures.push({ name: textureShaderName(ctx, node, 'st'), node });
    }

    // collect samplers (deduplicated by settingsKey)
    for (const [settingsKey, node] of ctx.samplers) {
        getGroup(node.group).samplers.push({ name: samplerShaderName(ctx, node, settingsKey), node });
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

    // emit struct definitions (topological order). A field wrapped in `d.align(n, ...)` emits `@align(n)`
    // so the author can make a struct valid in a uniform (e.g. push a member after a nested struct onto
    // a 16-byte boundary). One decl serves every address space; the layout validator enforces validity.
    for (const [_typeName, def] of ctx.structDefs) {
        lines.push(`struct ${def.wgslType} {`);
        for (const member of def.members) {
            const customAlign = d.getCustomAlign(member.type);
            const attr = customAlign !== undefined ? `@align(${customAlign}) ` : '';
            lines.push(`    ${attr}${member.name}: ${member.type.wgslType},`);
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

            // A shared group backs one buffer reused across materials and is cached by its
            // uniform set (order-independent), so its byte layout must be deterministic for a
            // given set no matter the per-material graph traversal order; otherwise the cached
            // block mismatches a material compiled in a different order. Order by stable node id
            // (mirrors three.js NodeBuilder._getBindGroup). Non-shared groups are per-object and
            // cloned, so their declaration order is fine.
            const orderedUniforms = bindGroup.group.shared
                ? [...bindGroup.uniforms].sort((a, b) => a.id - b.id)
                : bindGroup.uniforms;

            // This block wrapper is gpucat's, not the user's, so gpucat owns its uniform-address-space
            // layout: a struct/array member (and any member following one) starts on a 16-byte boundary,
            // pinned with @align/@size so every driver matches the packer. Member *internal* layout is
            // std430 (the one WGSL layout) — a user makes a nested struct uniform-valid with d.align.
            let prevAggregate = false;
            for (const u of orderedUniforms) {
                const isAggregate = d.isStructDesc(u.type) || d.isSizedArrayDesc(u.type) || d.isArrayDesc(u.type);
                let align = layoutAlignOf(u.type, 'wgsl-uniform');
                if (isAggregate || prevAggregate) align = Math.max(align, 16);
                const size = layoutSizeOf(u.type, 'wgsl-uniform');

                // align offset
                offset = Math.ceil(offset / align) * align;

                const memberName = uniformMemberName(ctx, u);
                lines.push(`    @align(${align}) @size(${size}) ${memberName}: ${u.type.wgslType},`);
                members.push({
                    uniformId: u.name,
                    schema: u.type,
                    offset,
                    size,
                    node: u,
                });

                offset += size;
                prevAggregate = isAggregate;
            }

            lines.push(`}`);
            lines.push(
                `@group(${groupIndex}) @binding(${bindingIndex}) var<uniform> uniforms_${groupName}: Uniforms_${groupName};`,
            );
            lines.push('');

            // A uniform block is a 16-aligned struct (like std140/three.js, which pads every UBO to
            // a 16-byte chunk), so its size rounds up to at least 16 — a block of only small members
            // (e.g. a single vec2f) must still allocate a 16-byte buffer.
            const totalBytes = Math.ceil(offset / 16) * 16;

            // Fail a non-conformant layout at emit time on every browser, rather than only at runtime
            // on naga (Firefox). Backstops the pack.ts uniform-layout rules.
            assertUniformLayoutConformant(`Uniforms_${groupName}`, members, totalBytes, 'wgsl-uniform');

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
                textureId: node.textureId,
                shaderName: name,
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
                textureId: node.textureId,
                shaderName: name,
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
            lines.push(`@group(${groupIndex}) @binding(${bindingIndex}) var ${name}: ${samplerType};`);
            samplerEntries.push({
                samplerId: name,
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

/**
 * The DSL function table, closed over the call graph and ordered callee-before-caller. WGSL accepts
 * module-scope declarations in any order, so the ordering is purely so the source reads bottom-up
 * like the GLSL backend's does. A `visiting` guard tolerates self/mutual recursion by emitting each
 * function once.
 *
 * Closing the table matters: discovery only sees the graph as written, and a function called solely
 * from ANOTHER function's body first appears when that body is traced. Emission used to pick those up
 * by iterating the live table as it grew; ordering needs the full set up front, so the walk traces and
 * registers each callee it meets, exactly as {@link generateCall} would have.
 */
function orderedFnDefs(ctx: BuildContext): [string, { fn: FnNode<d.Any>; traced: TracedFn }][] {
    const ordered: [string, { fn: FnNode<d.Any>; traced: TracedFn }][] = [];
    const done = new Set<string>();
    const visiting = new Set<string>();
    const visit = (name: string): void => {
        if (done.has(name) || visiting.has(name)) return;
        visiting.add(name);
        const entry = ctx.fnDefs.get(name);
        if (entry) {
            for (const callee of tracedFnCallees(entry.traced)) {
                if (!ctx.fnDefs.has(callee.fnName)) {
                    ctx.fnDefs.set(callee.fnName, { fn: callee, traced: callee.trace() });
                }
                visit(callee.fnName);
            }
        }
        visiting.delete(name);
        done.add(name);
        if (entry) ordered.push([name, entry]);
    };
    for (const name of [...ctx.fnDefs.keys()]) visit(name);
    return ordered;
}

export function emitDslFunctions(ctx: BuildContext): string {
    const lines: string[] = [];

    for (const [name, { fn, traced }] of orderedFnDefs(ctx)) {
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
        fnDiscovery.textureNames = ctx.textureNames;
        fnDiscovery.uniformNames = ctx.uniformNames;
        fnDiscovery.samplerNames = ctx.samplerNames;
        fnDiscovery.bindingNames = ctx.bindingNames;
        // Spliced in for name reservation only (the body may READ a module-scope variable, so a local
        // must not take its name); emitModuleScopeVars runs on the stage context, never on this one.
        fnDiscovery.privateVars = ctx.privateVars;
        fnDiscovery.workgroupVars = ctx.workgroupVars;
        const fnCtx = createContext(ctx.stage, ctx.isRender, fnDiscovery);

        // Allocated rather than taken verbatim, matching the GLSL emitter: a user's name can be
        // reserved in either language.
        const paramDecls: string[] = [];
        for (const p of traced.params) {
            const paramName = allocName(fnCtx.names, p.paramName ?? `p${p.paramIndex}`);
            fnCtx.nodeVars.set(p.id, paramName);
            paramDecls.push(`${paramName}: ${p.type.wgslType}`);
        }
        const params = paramDecls.join(', ');

        // Enable CSE hoisting to this body's top (params are the top-scope stable inputs).
        fnCtx.topScopeParamIds = new Set(traced.params.map((p) => p.id));
        fnCtx.hoistIndex = fnCtx.code.length;
        fnCtx.hoistStableMemo = new Map();

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

/**
 * Coerce a binary op's operands to a common scalar kind. WGSL forbids mixing scalar kinds in an operator
 * (`5u + 3i` is an error), so wrap the operand whose kind differs from the target in a length-preserving
 * conversion constructor (`u32(x)` / `vec3f(x)` …). Target = the op's result kind for arithmetic, or the
 * promoted operand kind for comparisons (which produce bool). Bool operands (logical ops) are left alone, and so
 * are shifts: their amount is always unsigned, whatever the value's kind.
 */
function coerceBinaryOperands(
    node: { op: string; left: Node<d.Any>; right: Node<d.Any>; type: d.Any },
    left: string,
    right: string,
): [string, string] {
    if (node.op === '<<' || node.op === '>>') return [left, right];
    const lk = (node.left.type as { scalar?: string }).scalar;
    const rk = (node.right.type as { scalar?: string }).scalar;
    if (!lk || !rk || lk === rk || lk === 'bool' || rk === 'bool') return [left, right];

    const resultKind = (node.type as { scalar?: string }).scalar;
    let target: string | undefined;
    if (resultKind && resultKind !== 'bool') target = resultKind;
    else if (lk === 'f32' || rk === 'f32') target = 'f32';
    else if (lk === 'f16' || rk === 'f16') target = 'f16';
    else if (lk === 'u32' || rk === 'u32') target = 'u32';
    else target = 'i32';
    if (target !== 'f32' && target !== 'f16' && target !== 'u32' && target !== 'i32') return [left, right];

    const conv = (kind: string, operandType: d.Any, expr: string) =>
        kind === target ? expr : `${d.numericDescOf(operandType, target as 'f32' | 'f16' | 'u32' | 'i32').wgslType}(${expr})`;
    return [conv(lk, node.left.type, left), conv(rk, node.right.type, right)];
}

/**
 * WGSL `@interpolate(...)` attribute for a varying (leading space), or '' for the default. Integer
 * varyings are forced to `flat` even when unset — WGSL requires it for integer I/O (naga rejects a
 * non-flat integer varying) — mirroring the GLSL backend's `glslVaryingQualifier`.
 */
function varyingInterpolateAttr(node: VaryingNode<d.Any>): string {
    const scalarKind = (node.type as { scalar?: string }).scalar;
    const isInteger = scalarKind === 'i32' || scalarKind === 'u32';
    const type = node.interpolationType ?? (isInteger ? 'flat' : null);
    if (!type) return '';
    return node.interpolationSampling ? ` @interpolate(${type}, ${node.interpolationSampling})` : ` @interpolate(${type})`;
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
        lines.push(`    @location(${varyingLoc})${varyingInterpolateAttr(node)} ${name}: ${node.type.wgslType},`);
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
    fragmentNode: Node<d.Any> | null,
    ctx: BuildContext,
    varyings: Map<string, { node: VaryingNode<d.Any>; vertexExpr: string }>,
    depthNode: Node<d.Any> | null = null,
): string {
    const lines: string[] = [];

    // copy varyings from vertex stage
    for (const [name, data] of varyings) {
        if (!ctx.varyings.has(name)) {
            ctx.varyings.set(name, data);
        }
    }

    const hasColor = fragmentNode != null;
    const hasDepth = depthNode != null;

    // check for MRT
    const isMRT = hasColor && fragmentNode.kind === NodeKind.MRT;
    const mrtNode = isMRT ? (fragmentNode as MRTNode) : null;

    // GENERATE EVERY OUTPUT EXPRESSION BEFORE THE INPUT STRUCT IS EMITTED.
    // `ctx.builtins` and `ctx.varyings` are populated as a SIDE EFFECT of walking an
    // expression, so FragmentInput can only be written once everything that might
    // reference `@builtin(position)` or a varying has been walked.
    //
    // An MRT node's members are not reached by generating the node itself, so while
    // these were generated further down the function, a member using `fragCoord`
    // registered the position builtin too late: the struct had already been emitted
    // without it, and the body then referenced `input.position` against it. Tint
    // reports that as `struct member position not found`.
    //
    // Pre-generating also keeps the CSE let-declarations in `ctx.code` ahead of the
    // body, which is what the original ordering was reaching for. Relative order
    // between the color, MRT and depth walks is unchanged, so non-MRT output is
    // byte-identical.
    const fragmentExpr = hasColor && !isMRT ? generateExpr(ctx, fragmentNode) : '';

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

    const depthExpr = hasDepth ? generateExpr(ctx, depthNode) : '';

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
            lines.push(`    @location(${varyingLoc})${varyingInterpolateAttr(node)} ${name}: ${node.type.wgslType},`);
            varyingLoc++;
        }
        lines.push('}');
        lines.push('');
    }

    // When a frag_depth override is present, the fragment output can no longer be a bare
    // `-> @location(0) vec4f`: a @builtin(frag_depth) must ride alongside the color output(s) in a
    // FragmentOutput struct. Also used for the depth-only case (struct with just the frag_depth
    // member). Without a depth override the emitted shape is unchanged (byte-identical goldens).
    const useStruct = isMRT || hasDepth;
    const frag_depth_name = 'frag_depth';

    if (useStruct) {
        lines.push('struct FragmentOutput {');
        if (isMRT && mrtNode) {
            // use members array (populated by resolveOutputs) for @location order
            // fall back to outputNodes keys if members not resolved yet
            if (mrtNode.members.length > 0) {
                // members are resolved - use them in order. The field type comes from the member node
                // (vec4f for a color target, vec4u/vec4i for an integer G-buffer target) so it matches the
                // assigned value — same as the GLSL emitter, which derives its `out` type the same way.
                for (let i = 0; i < mrtNode.members.length; i++) {
                    const member = mrtNode.members[i];
                    if (!member) continue; // sparse array possible
                    const name = mrtNode._resolvedNames[i] || `output_${i}`;
                    lines.push(`    @location(${i}) ${name}: ${member.type.wgslType},`);
                }
            } else {
                // fallback: use outputNodes directly (unresolved order)
                let loc = 0;
                for (const name in mrtNode.outputNodes) {
                    lines.push(`    @location(${loc}) ${name}: ${mrtNode.outputNodes[name].type.wgslType},`);
                    loc++;
                }
            }
        } else if (hasColor) {
            // Single color output alongside the frag_depth override.
            lines.push(`    @location(0) color: vec4f,`);
        }
        if (hasDepth) {
            lines.push(`    @builtin(frag_depth) ${frag_depth_name}: f32,`);
        }
        lines.push('}');
    }

    // One blank line before the entry point, whether or not an I/O struct just closed one.
    if (lines[lines.length - 1] !== '') lines.push('');

    // emit main function - omit input parameter if no inputs
    lines.push('@fragment');
    if (useStruct) {
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

    if (useStruct) {
        if (isMRT && mrtExprs) {
            // Use pre-generated expressions (generated before ctx.code was emitted)
            for (const { name, expr } of mrtExprs) {
                lines.push(`    output.${name} = ${expr};`);
            }
        } else if (hasColor) {
            lines.push(`    output.color = ${fragmentExpr};`);
        }
        if (hasDepth) {
            lines.push(`    output.${frag_depth_name} = ${depthExpr};`);
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

    // Enable CSE hoisting to this body's top (see the DSL-function path).
    ctx.topScopeParamIds = new Set(traced.params.map((p) => p.id));
    ctx.hoistIndex = ctx.code.length;
    ctx.hoistStableMemo = new Map();

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
