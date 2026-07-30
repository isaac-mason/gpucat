/**
 * backend/glsl/emit.ts — the GLSL ES 3.00 emitter.
 *
 * A sibling of backend/wgsl/emit.ts. It consumes the SAME backend-neutral node graph +
 * discovered facts (from discover() in ../../builder) and translates them to GLSL ES 3.00 source
 * strings. gpucat's DSL is WGSL-native by design, so GLSL is purely a translation target: the WGSL
 * emitter is the reference for structure and semantics, and this file maps those to GLSL.
 *
 * This slice covers a "lit mesh" material (vertex attributes, camera/model uniform matrices grouped
 * into std140 UBOs, a varying, vec math, clip position + fragment color), textures (combined
 * samplers), and — the third slice — statements + control flow + user functions + select. Paths
 * outside that scope (compute/storage/atomics/storage-textures, and inline WGSL which can't be
 * translated) throw a clear error so they fail loudly rather than emit wrong GLSL.
 *
 * Nothing here touches GPUDevice or any runtime object — it is purely node-graph → text.
 */

import type { StructSchema } from '../../../schema/schema';
import * as d from '../../../schema/schema';
import { layoutAlignOf, layoutSizeOf } from '../../../schema/pack';
import type { CompileSlots, Discovery, SamplerEntry, TextureEntry, UniformGroupBlock, UniformMember } from '../../builder';
import type { TracedFn } from '../wgsl/emit';
import { type AnyNode, getChildren } from '../../graph';
import type { AttributeNode } from '../../lib/attribute';
import type { BuiltinNode } from '../../lib/builtin';
import {
    type CallNode,
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
    type WgslFunctionNodeRef,
} from '../../lib/core';
import type { MRTNode } from '../../lib/mrt';
import {
    type ArrayTextureNode,
    type CubeTextureNode,
    type DepthTextureNode,
    SamplerNode,
    type TextureBindingNode,
    type TextureNode,
} from '../../lib/texture';
import type { UniformGroup, UniformNode } from '../../lib/uniform';
import type { VaryingNode } from '../../lib/varying';

type ShaderStage = 'vertex' | 'fragment';

/**
 * Translate a schema descriptor's WGSL type to its GLSL ES 3.00 equivalent by reading the schema's
 * `glslType` companion. Only the subset the GLSL backend can translate (scalars, float/int/uint
 * vectors, square float matrices) carries a `glslType`; everything else (f16 variants, bool vectors,
 * textures, samplers, arrays, standalone structs) leaves it off, so this throws for them — a missing
 * mapping surfaces loudly, exactly as the old WGSL_TO_GLSL map did.
 */
function glslType(desc: d.Any): string {
    const glsl = (desc as { glslType?: string }).glslType;
    if (glsl === undefined) {
        throw new Error(`[glsl] type '${desc.wgslType}' not yet supported in the GLSL emitter`);
    }
    return glsl;
}

/** GLSL ES 3.00 integer scalar/vector types that MUST carry a `flat` interpolation qualifier. */
const GLSL_INTEGER_WGSL_TYPES = new Set([
    'i32',
    'u32',
    'vec2i',
    'vec3i',
    'vec4i',
    'vec2u',
    'vec3u',
    'vec4u',
]);

/**
 * Interpolation qualifier for a GLSL varying declaration, derived from the same `interpolationType`
 * the WGSL emitter reads. Returns a leading-space qualifier ('flat ' / 'smooth ') or '' for the
 * perspective-correct default. Integer-typed varyings are FORCED to `flat` even when unset — GLSL ES
 * 3.00 rejects a non-flat integer varying (the program will not link), and the WGSL side likewise
 * requires @interpolate(flat) for integers.
 */
function glslVaryingQualifier(node: VaryingNode<d.Any>): string {
    const isInteger = GLSL_INTEGER_WGSL_TYPES.has(node.type.wgslType);
    const interp = node.interpolationType;
    // 'linear' maps to `noperspective`, which is NOT part of GLSL ES 3.00 (desktop GLSL only) — reject
    // rather than silently perspective-interpolate.
    if (interp === 'linear') {
        throw new Error(
            `[glsl] varying '${node.name ?? ''}' uses linear (noperspective) interpolation, which is not supported on the WebGL2 backend`,
        );
    }
    // Integer varyings are illegal in GLSL ES 3.00 without `flat` (the program won't link), so force
    // it regardless of interpolationType. 'perspective' (or unset, for floats) is GLSL's default —
    // no qualifier.
    if (interp === 'flat' || isInteger) return 'flat ';
    return '';
}

/**
 * WGSL built-in function name → GLSL name, for the handful that differ. Most (dot, normalize, max,
 * cross, length, …) are spelled identically in GLSL. Only listed exceptions are rewritten.
 */
/**
 * WGSL relational/equality operators → GLSL ES built-in functions, used only when the operands are
 * VECTORS (componentwise → returns a bvec). Scalar comparisons keep the plain operator.
 */
const VEC_COMPARE_FN: Record<string, string> = {
    '<': 'lessThan',
    '<=': 'lessThanEqual',
    '>': 'greaterThan',
    '>=': 'greaterThanEqual',
    '==': 'equal',
    '!=': 'notEqual',
};

const CALL_RENAMES: Record<string, string> = {
    fract: 'fract',
    mix: 'mix',
    // Scalar/vector conversion "functions" are constructor calls in both languages, but spelled with
    // the WGSL type name (f32(x)) vs the GLSL type name (float(x)). Rewrite the type-named ones.
    f32: 'float',
    i32: 'int',
    u32: 'uint',
    vec2f: 'vec2',
    vec3f: 'vec3',
    vec4f: 'vec4',
    vec2i: 'ivec2',
    vec3i: 'ivec3',
    vec4i: 'ivec4',
    vec2u: 'uvec2',
    vec3u: 'uvec3',
    vec4u: 'uvec4',
    // Derivative builtins: WGSL spells them dpdx/dpdy; GLSL ES 3.00 uses dFdx/dFdy. fwidth is spelled
    // the same in both, listed for clarity. (The coarse/fine variants have no GLSL ES 3.00 form and
    // are rejected in generateCall below.)
    dpdx: 'dFdx',
    dpdy: 'dFdy',
    fwidth: 'fwidth',
    // WGSL and GLSL agree on the common math builtins used by the lit-mesh case; overrides go here.
};

/**
 * WGSL coarse/fine derivative variants have no GLSL ES 3.00 equivalent (that language exposes only the
 * plain dFdx/dFdy/fwidth). Emitting the bare name would produce an un-compilable shader, so the GLSL
 * emitter rejects them with a clear error rather than degrade silently.
 */
const UNSUPPORTED_DERIVATIVES = new Set([
    'dpdxCoarse',
    'dpdyCoarse',
    'fwidthCoarse',
    'dpdxFine',
    'dpdyFine',
    'fwidthFine',
]);

/** Emit a GLSL literal for a constant value of the given WGSL type. */
function glslLiteral(wgslType: string, value: number | number[] | string): string {
    if (typeof value === 'string') return value;

    const scalar = (t: string, v: number): string => {
        switch (t) {
            case 'f32':
                return Number.isInteger(v) ? `${v}.0` : `${v}`;
            case 'i32':
                return `${Math.trunc(v)}`;
            case 'u32':
                return `${Math.trunc(v)}u`;
            case 'bool':
                return v !== 0 ? 'true' : 'false';
            default:
                throw new Error(`[glsl] scalar literal of type '${t}' not yet supported in the GLSL emitter`);
        }
    };

    if (typeof value === 'number') return scalar(wgslType, value);

    // Vector / matrix literal: constructor of the GLSL type with per-component literals.
    const elemWgsl = wgslType.endsWith('f') ? 'f32' : wgslType.endsWith('i') ? 'i32' : wgslType.endsWith('u') ? 'u32' : 'f32';
    const components = value.map((v) => scalar(elemWgsl, v));
    // Resolve the GLSL type name from the schema descriptor's `glslType` companion. Unknown / GLSL-
    // untranslatable types have no `glslType`, so this throws — matching the old WGSL_TO_GLSL miss.
    const glsl = (d.descFromWgslType(wgslType) as { glslType?: string }).glslType;
    if (glsl === undefined) {
        throw new Error(`[glsl] literal of type '${wgslType}' not yet supported in the GLSL emitter`);
    }
    return `${glsl}(${components.join(', ')})`;
}

/**
 * GLSL build context — a sibling of the WGSL BuildContext, but slimmed to this slice. It carries the
 * discovered facts (referenced, not copied — one discovery pass feeds both vertex + fragment) plus
 * per-stage emission scratch (attributes, varyings, CSE vars, code lines).
 */
export type GlslBuildContext = {
    stage: ShaderStage;

    // Discovered facts (shared-mutable across stages).
    uniforms: Map<string, { node: UniformNode<d.Any>; group: UniformGroup }>;
    usageCount: Map<number, number>;
    mutatedNodes: Set<number>;
    privateVars: Map<number, PrivateVarNode<d.Any>>;
    fnDefs: Map<string, { fn: FnNode<d.Any>; traced: TracedFn }>;

    // Raw escape-hatch functions (wgslFn / glslFn), discovered from the graph. On the GLSL backend
    // each must carry a `glslCode` companion; emitted by emitGlslRawFunctions.
    rawFnDefs: Map<string, WgslFunctionNodeRef>;

    // Struct definitions, topologically ordered (nested deps first) by discover().
    structDefs: Map<string, StructDef<StructSchema>>;

    // Texture / sampler bindings.
    //
    // WGSL binds a texture and a sampler as two separate module-scope resources, but GLSL ES 3.00
    // has no standalone sampler type — a texture is sampled through ONE combined-sampler uniform
    // (`uniform sampler2D u_tName;`). So the GLSL emitter keys everything by the texture binding: it
    // ignores the SamplerNode as a code object and folds the sampler's settings into the combined
    // uniform's runtime metadata instead.
    textures: Map<string, TextureBindingNode>; // textureId -> binding node (insertion-ordered)
    textureSamplers: Map<string, SamplerNode<d.sampler | d.samplerComparison>>; // textureId -> its sampler

    // Per-stage emission scratch.
    attributes: Map<number, { shaderName: string; type: d.Any; location: number; node: AttributeNode<d.Any> }>;
    varyings: Map<string, { node: VaryingNode<d.Any>; vertexExpr: string }>;
    builtins: Set<string>;
    nodeVars: Map<number, string>;
    varCounter: number;
    // Indentation level for nested control flow (1 = main body, 2 = first nested block, …).
    indentLevel: number;
    code: string[];
};

export function createGlslContext(stage: ShaderStage, discovery: Discovery): GlslBuildContext {
    return {
        stage,
        uniforms: discovery.uniforms,
        usageCount: discovery.nodeIdToUsages,
        mutatedNodes: discovery.mutatedNodes,
        privateVars: discovery.privateVars,
        fnDefs: discovery.fnDefs,
        rawFnDefs: discovery.wgslFnDefs,
        structDefs: discovery.structDefs,
        // Fresh per-context: the emitter registers textures/samplers as it walks each stage.
        textures: new Map(),
        textureSamplers: new Map(),
        attributes: new Map(),
        varyings: new Map(),
        builtins: new Set(),
        nodeVars: new Map(),
        varCounter: 0,
        indentLevel: 1,
        code: [],
    };
}

/** Guard: reject node kinds outside this slice with a clear, uniform error. */
function unsupported(kind: string): never {
    throw new Error(`[glsl] ${kind} not yet supported in the GLSL emitter`);
}

/* expression generation */

function generateExpr(ctx: GlslBuildContext, rawNode: Node<d.Any>): string {
    const node = rawNode as AnyNode;

    // CSE: if already hoisted to a variable, return its name.
    if (ctx.nodeVars.has(node.id)) {
        return ctx.nodeVars.get(node.id)!;
    }

    let expr: string;

    switch (node.kind) {
        case NodeKind.Literal:
            expr = glslLiteral(node.type.wgslType, node.value);
            break;
        case NodeKind.Uniform:
            expr = generateUniform(ctx, node);
            break;
        case NodeKind.Attribute:
            expr = generateAttribute(ctx, node);
            break;
        case NodeKind.Varying:
            expr = generateVarying(ctx, node);
            break;
        case NodeKind.Builtin:
            expr = generateBuiltin(ctx, node);
            break;
        case NodeKind.BinaryOp: {
            const left = generateExpr(ctx, node.left);
            const right = generateExpr(ctx, node.right);
            // Componentwise vector comparisons: GLSL ES rejects the relational/equality OPERATORS on
            // vectors and instead provides built-in functions returning a bvec. Detect via the result
            // type being a bool vector (`vecN<bool>`); scalar comparisons keep the operator.
            const glslFn = VEC_COMPARE_FN[node.op];
            if (glslFn && node.type.wgslType.includes('<bool>')) {
                expr = `${glslFn}(${left}, ${right})`;
            } else {
                expr = `(${left} ${node.op} ${right})`;
            }
            break;
        }
        case NodeKind.Construct: {
            const args = node.args.map((a) => generateExpr(ctx, a));
            // A struct construct uses the struct's own name (e.g. `Foo(...)`), not a WGSL→GLSL scalar
            // mapping; the struct declaration is emitted ahead of use by emitGlslStructs.
            const typeName = d.isStructDesc(node.type) ? node.type.wgslType : glslType(node.type);
            expr = `${typeName}(${args.join(', ')})`;
            break;
        }
        case NodeKind.Array: {
            // Fixed-size array constructor. GLSL spells it `<elemType>[<N>](e0, e1, …)`.
            const elems = node.elements.map((e) => generateExpr(ctx, e));
            const elemType = glslType(node.type.element);
            expr = `${elemType}[${node.elements.length}](${elems.join(', ')})`;
            break;
        }
        case NodeKind.Pass: {
            // A PassNode used as an expression delegates to its underlying texture node (the render
            // target it samples). Depth-scope passes read the linear-depth node instead.
            const textureNode = node.scope === 'depth' ? node.getLinearDepthNode() : node.getTextureNode();
            expr = generateExpr(ctx, textureNode);
            break;
        }
        case NodeKind.Field: {
            const obj = generateExpr(ctx, node.object);
            expr = `${obj}.${node.fieldName}`;
            break;
        }
        case NodeKind.Index: {
            const arr = generateExpr(ctx, node.array);
            const idx = generateExpr(ctx, node.index);
            expr = `${arr}[${idx}]`;
            break;
        }
        case NodeKind.Call:
            expr = generateCall(ctx, node);
            break;
        case NodeKind.TextureBinding:
            // A bare texture handle used as an expression resolves to its combined-sampler name.
            expr = generateTextureBinding(ctx, node);
            break;
        case NodeKind.Sampler:
            // GLSL has no standalone sampler value; combined samplers subsume it. A Sampler node
            // reaching here means it was used outside a texture sample — not expressible in GLSL.
            unsupported('standalone sampler value (GLSL uses combined samplers)');
            break;
        case NodeKind.Texture:
            expr = generateTexture(ctx, node);
            break;
        case NodeKind.CubeTexture:
            expr = generateCubeTexture(ctx, node);
            break;
        case NodeKind.DepthTexture:
            expr = generateDepthTexture(ctx, node);
            break;
        case NodeKind.ArrayTexture:
            expr = generateArrayTexture(ctx, node);
            break;
        case NodeKind.Conditional: {
            // WGSL select(f, t, cond). GLSL has no `select`:
            //  - scalar bool cond → ternary `(cond ? t : f)`.
            //  - vector bool cond (componentwise select) → `mix(f, t, cond)`: GLSL ES 3.00's genBType
            //    `mix(x, y, a)` picks per component (a ? y : x), which matches select's semantics. A
            //    ternary is illegal here since GLSL requires a scalar bool condition.
            const cond = generateExpr(ctx, node.condition);
            const t = generateExpr(ctx, node.ifTrue);
            const f = node.ifFalse ? generateExpr(ctx, node.ifFalse) : `${glslType(node.type)}(0)`;
            expr = node.condition.type.wgslType.includes('<bool>') ? `mix(${f}, ${t}, ${cond})` : `(${cond} ? ${t} : ${f})`;
            break;
        }
        case NodeKind.Let:
        case NodeKind.Var: {
            // A Let/Var node used as an expression resolves to its variable name; if it hasn't been
            // emitted as a statement yet, emit its declaration now (lazy, like the WGSL emitter).
            if (!ctx.nodeVars.has(node.id)) {
                const ind = '    '.repeat(ctx.indentLevel);
                const init = generateExpr(ctx, node.init);
                ctx.code.push(`${ind}${glslLocalDecl(node.type, node.varName)} = ${init};`);
                ctx.nodeVars.set(node.id, node.varName);
            }
            expr = node.varName;
            break;
        }
        case NodeKind.PrivateVar:
            // Module-scope global; its declaration is emitted in emitGlslModuleScopeVars. Here it is
            // just a name reference.
            ctx.nodeVars.set(node.id, node.varName);
            expr = node.varName;
            break;
        case NodeKind.Parameter:
            expr = node.paramName ?? `p${node.paramIndex}`;
            break;
        case NodeKind.Wgsl: {
            // Inline raw-shader node: emit its GLSL companion. The WGSL source is ignored on this
            // backend; if no GLSL companion was provided, reject cleanly.
            if (node.glsl === undefined) {
                throw new Error(
                    `[glsl] this inline wgsl\`\` node has no \`glsl\` variant; add one (glsl\`\` or .glslSource\`\`) to run on the WebGL backend`,
                );
            }
            let glslStr = node.glsl;
            for (let i = 0; i < node.deps.length; i++) {
                const depExpr = generateExpr(ctx, node.deps[i]);
                glslStr = glslStr.replace(new RegExp(`\\$${i}`, 'g'), depExpr);
            }
            expr = glslStr;
            break;
        }
        case NodeKind.Inspector:
            // Inspector is transparent — emit the wrapped node.
            expr = generateExpr(ctx, node.wrappedNode);
            break;

        // Everything else is explicitly out-of-scope: fail loudly with a clear message rather than
        // emit wrong GLSL.
        default:
            unsupported(`node kind '${node.constructor.name}'`);
    }

    // CSE: hoist multi-use, non-trivial expressions into a local.
    const usage = ctx.usageCount.get(node.id) ?? 1;
    if (usage > 1 && !ctx.nodeVars.has(node.id) && !isTrivialExpr(node)) {
        const varName = `_v${ctx.varCounter++}`;
        // Mutated hoists must stay mutable; GLSL has no `let`/`const` distinction for this, so both
        // are plain typed locals (an immutable one could be `const` but a plain local is fine).
        const ind = '    '.repeat(ctx.indentLevel);
        ctx.code.push(`${ind}${glslLocalDecl(node.type, varName)} = ${expr};`);
        ctx.nodeVars.set(node.id, varName);
        return varName;
    }

    return expr;
}

/**
 * A GLSL local-variable declaration prefix (`<type> <name>`) for a value of the given descriptor.
 * Structs use their name; fixed-size arrays use GLSL's `<elemType> <name>[<N>]` array-of syntax
 * (the size sits after the variable, not the type). Everything else is a scalar/vec/mat via glslType.
 */
function glslLocalDecl(desc: d.Any, varName: string): string {
    if (d.isStructDesc(desc)) return `${desc.wgslType} ${varName}`;
    if (d.isSizedArrayDesc(desc)) return `${glslType(desc.element)} ${varName}[${desc.length}]`;
    return `${glslType(desc)} ${varName}`;
}

/** Trivial expressions (cheap to repeat / global names) are not worth hoisting. */
function isTrivialExpr(node: Node<d.Any>): boolean {
    return (
        node.kind === NodeKind.Literal ||
        node.kind === NodeKind.Builtin ||
        node.kind === NodeKind.Field ||
        node.kind === NodeKind.Uniform ||
        node.kind === NodeKind.Attribute ||
        // Variable / parameter references are already names — cheap to repeat.
        node.kind === NodeKind.Let ||
        node.kind === NodeKind.Var ||
        node.kind === NodeKind.PrivateVar ||
        node.kind === NodeKind.Parameter ||
        // A combined-sampler uniform is a global name — cheap to repeat, never worth hoisting.
        node.kind === NodeKind.TextureBinding
    );
}

function generateUniform(ctx: GlslBuildContext, node: UniformNode<d.Any>): string {
    ctx.uniforms.set(node.name, { node, group: node.group });
    // std140 UBO instance name mirrors the WGSL `uniforms_<group>` binding instance.
    return `uniforms_${node.group.name}.${node.name}`;
}

/**
 * The number of DISTINCT attributes registered (distinct `location`s). Because named attributes are
 * deduped by name (multiple node ids alias one entry), `ctx.attributes.size` overcounts — the next
 * location is the count of distinct locations, not the map size.
 */
function distinctAttributeCount(ctx: GlslBuildContext): number {
    const locations = new Set<number>();
    for (const entry of ctx.attributes.values()) locations.add(entry.location);
    return locations.size;
}

/**
 * The distinct attribute entries (one per location), ordered by location. Named attributes are deduped
 * by name so multiple node ids can alias the same entry — this collapses those aliases so each
 * `layout(location=N) in ...` declaration is emitted exactly once.
 */
function distinctAttributes(ctx: GlslBuildContext): { shaderName: string; type: d.Any; location: number }[] {
    const byLocation = new Map<number, { shaderName: string; type: d.Any; location: number }>();
    for (const entry of ctx.attributes.values()) {
        if (!byLocation.has(entry.location)) byLocation.set(entry.location, entry);
    }
    return Array.from(byLocation.values()).sort((a, b) => a.location - b.location);
}

/**
 * GLSL ES 3.00 reserved keywords + built-in function names. A user `Fn` named one of these can't be
 * declared (`vec4 step(...)` → "Name of a built-in function cannot be redeclared"), so such names are
 * mangled to `fn_<name>` at both the definition and every call site. Non-colliding names are left as-is
 * (so existing goldens don't move).
 */
const GLSL_RESERVED_NAMES = new Set([
    // Common built-in functions.
    'radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh',
    'asinh', 'acosh', 'atanh', 'pow', 'exp', 'log', 'exp2', 'log2', 'sqrt', 'inversesqrt',
    'abs', 'sign', 'floor', 'trunc', 'round', 'roundEven', 'ceil', 'fract', 'mod', 'modf',
    'min', 'max', 'clamp', 'mix', 'step', 'smoothstep', 'isnan', 'isinf',
    'floatBitsToInt', 'floatBitsToUint', 'intBitsToFloat', 'uintBitsToFloat',
    'fma', 'frexp', 'ldexp', 'packSnorm2x16', 'unpackSnorm2x16', 'packUnorm2x16', 'unpackUnorm2x16',
    'packHalf2x16', 'unpackHalf2x16', 'length', 'distance', 'dot', 'cross', 'normalize',
    'faceforward', 'reflect', 'refract', 'matrixCompMult', 'outerProduct', 'transpose',
    'determinant', 'inverse', 'lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual',
    'equal', 'notEqual', 'any', 'all', 'not', 'texture', 'textureProj', 'textureLod',
    'textureOffset', 'texelFetch', 'texelFetchOffset', 'textureProjOffset', 'textureLodOffset',
    'textureProjLod', 'textureProjLodOffset', 'textureGrad', 'textureGradOffset',
    'textureProjGrad', 'textureProjGradOffset', 'textureSize', 'textureGather',
    'dFdx', 'dFdy', 'fwidth', 'emitVertex', 'endPrimitive',
    // Keywords / reserved words.
    'const', 'uniform', 'buffer', 'shared', 'attribute', 'varying', 'coherent', 'volatile',
    'restrict', 'readonly', 'writeonly', 'layout', 'centroid', 'flat', 'smooth', 'noperspective',
    'patch', 'sample', 'break', 'continue', 'do', 'for', 'while', 'switch', 'case', 'default',
    'if', 'else', 'in', 'out', 'inout', 'float', 'int', 'void', 'bool', 'true', 'false',
    'invariant', 'precise', 'discard', 'return', 'mat2', 'mat3', 'mat4', 'vec2', 'vec3', 'vec4',
    'ivec2', 'ivec3', 'ivec4', 'bvec2', 'bvec3', 'bvec4', 'uint', 'uvec2', 'uvec3', 'uvec4',
    'lowp', 'mediump', 'highp', 'precision', 'sampler2D', 'sampler3D', 'samplerCube', 'struct',
    'main',
    // GLSL ES 3.00 reserved-for-future-use words — illegal as identifiers even though unused.
    'input', 'output', 'filter', 'sizeof', 'cast', 'namespace', 'using', 'common', 'partition',
    'active', 'asm', 'class', 'union', 'enum', 'typedef', 'template', 'this', 'resource', 'goto',
    'inline', 'noinline', 'public', 'static', 'extern', 'external', 'interface', 'long', 'short',
    'double', 'half', 'fixed', 'unsigned', 'superp', 'hvec2', 'hvec3', 'hvec4', 'dvec2', 'dvec3',
    'dvec4', 'fvec2', 'fvec3', 'fvec4', 'sampler1D', 'sampler1DShadow', 'sampler2DRectShadow',
    'row_major', 'packed',
]);

/**
 * Map a user `Fn` name to a GLSL-safe identifier: reserved / builtin names are prefixed `fn_`, all
 * others pass through unchanged. Must be applied consistently at the definition and every call site.
 */
function glslFnName(name: string): string {
    return GLSL_RESERVED_NAMES.has(name) ? `fn_${name}` : name;
}

/**
 * Map an MRT fragment-output name to a GLSL-safe identifier: reserved names (e.g. `output`) are
 * prefixed `out_`, all others pass through. The name is shader-local — the runtime binds render
 * targets by `layout(location)`, not by this identifier — so mangling is safe.
 */
function glslOutputName(name: string): string {
    return GLSL_RESERVED_NAMES.has(name) ? `out_${name}` : name;
}

function generateAttribute(ctx: GlslBuildContext, node: AttributeNode<d.Any>): string {
    if (ctx.stage !== 'vertex') {
        const attrName = node.name ?? `(unnamed attribute id=${node.id})`;
        throw new Error(
            `[glsl] AttributeNode '${attrName}' can only be used in vertex stage, but was used in ${ctx.stage} stage. ` +
                `Use varying() to pass vertex data to the fragment stage.`,
        );
    }

    const existing = ctx.attributes.get(node.id);
    if (existing) return existing.shaderName;

    // Named attributes (geometry inputs like `uv`) are declared ONCE by name: several distinct
    // `attribute('uv')` nodes (same name, different node ids) must share one `layout(location=N) in`
    // decl. If a named attribute with this name is already registered, alias this node's id to the
    // existing entry (reusing its location + shaderName) instead of allocating a new location — else
    // GLSL redefines `in a_uv` and fails to compile. Unnamed/buffer attributes stay deduped by id.
    if (node.isNamedReference && node.name) {
        for (const entry of ctx.attributes.values()) {
            if (entry.node.isNamedReference && entry.node.name === node.name) {
                ctx.attributes.set(node.id, entry);
                return entry.shaderName;
            }
        }
    }

    // Next location counts DISTINCT attributes (distinct locations), not aliased map entries — aliasing
    // multiple node ids to one entry would make `ctx.attributes.size` overcount.
    const location = distinctAttributeCount(ctx);
    // Prefix with `a_` so attribute names never collide with GLSL keywords or varyings.
    const shaderName = node.isNamedReference && node.name ? `a_${node.name}` : `a_buf_${location}`;
    ctx.attributes.set(node.id, { shaderName, type: node.type, location, node });
    return shaderName;
}

function generateVarying(ctx: GlslBuildContext, node: VaryingNode<d.Any>): string {
    const name = node.name ?? `v_${node.id}`;

    if (ctx.stage === 'vertex') {
        // In the vertex stage a varying evaluates to its source expression (assigned to `out` in main).
        const sourceNode = node.node.node;
        const sourceExpr = generateExpr(ctx, sourceNode);
        ctx.varyings.set(name, { node, vertexExpr: sourceExpr });
        return sourceExpr;
    }

    // In the fragment stage it reads the interpolated `in` variable.
    if (!ctx.varyings.has(name)) {
        ctx.varyings.set(name, { node, vertexExpr: '' });
    }
    return name;
}

function generateBuiltin(ctx: GlslBuildContext, node: BuiltinNode<d.Any>): string {
    ctx.builtins.add(node.builtinKind);
    switch (node.builtinKind) {
        // gl_VertexID / gl_InstanceID are signed `int` in GLSL, but the node's declared type is u32
        // (matching WGSL's @builtin(vertex_index)/instance_index). Wrap in uint(...) so the emitted
        // expression's type matches the node's u32 type and doesn't mismatch in a u32 context.
        case 'vertex_index':
            return 'uint(gl_VertexID)';
        case 'instance_index':
            // Base-inclusive, matching WebGPU's @builtin(instance_index) (which folds in firstInstance).
            // WebGL2's gl_InstanceID is 0-based per draw, so we add u_drawBase — a draw-scoped uniform
            // set to the sub-draw's firstInstance by the batched draw loop, and left 0 (its GL default)
            // for single draws. The declaration is emitted by generateGlslVertexShader /
            // generateGlslTransformFeedbackShader whenever this builtin is used.
            return '(u_drawBase + uint(gl_InstanceID))';
        case 'position':
            // Fragment position; the vertex clip position is written to gl_Position by main().
            if (ctx.stage === 'fragment') return 'gl_FragCoord';
            unsupported("builtin 'position' in vertex stage");
            break;
        default:
            unsupported(`builtin '${node.builtinKind}'`);
    }
}

/**
 * WGSL texture free functions (textureSample, textureLoad, …) that take a separate texture + sampler
 * as leading args. GLSL merges those into one combined sampler, so these need bespoke translation
 * rather than the generic name-and-args path.
 */
const TEXTURE_FNS = new Set([
    'textureSample',
    'textureSampleLevel',
    'textureSampleBias',
    'textureSampleGrad',
    'textureSampleCompare',
    'textureSampleCompareLevel',
    'textureLoad',
    'textureDimensions',
    'textureNumLevels',
    'textureNumLayers',
    'textureGather',
    'textureGatherCompare',
    'textureStore',
]);

function generateCall(ctx: GlslBuildContext, node: CallNode<d.Any>): string {
    // Raw escape-hatch functions (wgslFn / glslFn): emit the GLSL companion (defined by
    // emitGlslRawFunctions) and call it by name. Reject if there is no GLSL variant.
    if (node.wgslFnNode) {
        const fn = node.wgslFnNode;
        if (!fn.glslCode) {
            throw new Error(
                `[glsl] this wgslFn has no \`glsl\` variant; add one (wgslFn(src, { ..., glsl }) or glslFn) to run on the WebGL backend`,
            );
        }
        const args = node.args.map((a) => generateExpr(ctx, a));
        return `${node.fn}(${args.join(', ')})`;
    }

    // A call of a user Fn: register the traced definition (emitted by emitGlslDslFunctions) and call
    // it by name.
    if (node.fnNode) {
        const fn = node.fnNode;
        if (!ctx.fnDefs.has(fn.fnName)) {
            ctx.fnDefs.set(fn.fnName, { fn, traced: fn.trace() });
        }
        const args = node.args.map((a) => generateExpr(ctx, a));
        return `${glslFnName(fn.fnName)}(${args.join(', ')})`;
    }

    if (TEXTURE_FNS.has(node.fn)) {
        return generateTextureCall(ctx, node);
    }

    const args = node.args.map((a) => generateExpr(ctx, a));

    if (node.fn === 'negate' && args.length === 1) return `(-${args[0]})`;
    if (node.fn === 'not' && args.length === 1) return `(!${args[0]})`;

    if (UNSUPPORTED_DERIVATIVES.has(node.fn)) {
        throw new Error(
            `[glsl] ${node.fn} (coarse/fine derivative) is not supported on the WebGL2 backend; use dpdx/dpdy/fwidth`,
        );
    }

    const fn = CALL_RENAMES[node.fn] ?? node.fn;
    return `${fn}(${args.join(', ')})`;
}

/**
 * Translate a WGSL texture free function to its GLSL combined-sampler form. The first arg is the
 * TextureBindingNode; sampling variants carry a SamplerNode as the second arg (dropped in GLSL —
 * its settings live in the combined-sampler metadata instead).
 */
function generateTextureCall(ctx: GlslBuildContext, node: CallNode<d.Any>): string {
    const rawArgs = node.args as AnyNode[];
    const binding = rawArgs[0];
    if (!binding || binding.kind !== NodeKind.TextureBinding) {
        unsupported(`texture builtin '${node.fn}' whose first argument is not a texture binding`);
    }
    const tex = binding as TextureBindingNode;

    // Register the texture; comparison samplers become the combined sampler's runtime settings.
    const samplerArg = rawArgs[1];
    const sampler = samplerArg && samplerArg.kind === NodeKind.Sampler ? (samplerArg as SamplerNode) : null;
    const name = registerTexture(ctx, tex, sampler);

    const restFrom = (i: number) => rawArgs.slice(i).map((a) => generateExpr(ctx, a));

    switch (node.fn) {
        case 'textureSample': {
            // (t, s, coords [, offset]) → texture(name, coords). Offset unsupported.
            if (rawArgs.length > 3) throw new Error(`[glsl] textureSample offset not yet supported in the GLSL emitter`);
            return `texture(${name}, ${generateExpr(ctx, rawArgs[2])})`;
        }
        case 'textureSampleLevel': {
            if (rawArgs.length > 4) throw new Error(`[glsl] textureSampleLevel offset not yet supported in the GLSL emitter`);
            return `textureLod(${name}, ${generateExpr(ctx, rawArgs[2])}, ${generateExpr(ctx, rawArgs[3])})`;
        }
        case 'textureSampleBias': {
            if (rawArgs.length > 4) throw new Error(`[glsl] textureSampleBias offset not yet supported in the GLSL emitter`);
            return `texture(${name}, ${generateExpr(ctx, rawArgs[2])}, ${generateExpr(ctx, rawArgs[3])})`;
        }
        case 'textureSampleGrad': {
            if (rawArgs.length > 5) throw new Error(`[glsl] textureSampleGrad offset not yet supported in the GLSL emitter`);
            const [coords, ddx, ddy] = restFrom(2);
            return `textureGrad(${name}, ${coords}, ${ddx}, ${ddy})`;
        }
        case 'textureSampleCompare': {
            // (t, s, coords, depthRef [, offset]) → texture(shadowSampler, vec3(coords, depthRef)).
            if (rawArgs.length > 4) throw new Error(`[glsl] textureSampleCompare offset not yet supported in the GLSL emitter`);
            const coords = generateExpr(ctx, rawArgs[2]);
            const depthRef = generateExpr(ctx, rawArgs[3]);
            return `texture(${name}, vec3(${coords}, ${depthRef}))`;
        }
        case 'textureLoad': {
            // (t, coords, level) → texelFetch(name, ivec2(coords), level).
            const coords = generateExpr(ctx, rawArgs[1]);
            const level = rawArgs[2] ? generateExpr(ctx, rawArgs[2]) : '0';
            return `texelFetch(${name}, ivec2(${coords}), ${level})`;
        }
        case 'textureDimensions': {
            // (t [, level]) → textureSize(name [, level]). textureSize requires a level arg in
            // GLSL ES 3.00, so default to 0 when none was given.
            const level = rawArgs[1] ? generateExpr(ctx, rawArgs[1]) : '0';
            return `textureSize(${name}, ${level})`;
        }
        default:
            throw new Error(`[glsl] texture builtin '${node.fn}' not yet supported in the GLSL emitter`);
    }
}

/* texture + sampler generation
 *
 * WGSL's separate texture + sampler model maps to GLSL ES 3.00's single COMBINED sampler: each
 * texture binding becomes one `uniform sampler2D u_<textureId>;` at global scope, and `textureSample(
 * t, s, uv)` becomes `texture(u_<textureId>, uv)`. The SamplerNode carries no GLSL code — only its
 * runtime settings, folded into the texture's metadata. See {@link emitGlslTextures}.
 */

/** Combined-sampler uniform name for a texture binding. */
function samplerUniformName(textureId: string): string {
    // Collapse runs of underscores: texture ids that begin with '_' (e.g. a pass output like
    // '_pass0_output') would otherwise yield `u__…`, and GLSL ES reserves any '__' sequence.
    return `u_${textureId}`.replace(/_{2,}/g, '_');
}

/**
 * GLSL ES 3.00 combined-sampler type for a texture descriptor. Picks the shape (`2D`/`Cube`/
 * `2DArray`/`2DShadow`) from the descriptor's dimensionality, and the sample-type prefix (`i`/`u`)
 * from an integer sampleType. Depth-compare samplers are `sampler*Shadow`. Anything the GLSL
 * emitter can't express throws a clear "not yet supported" error.
 */
function glslSamplerType(desc: d.Texture): string {
    const type = desc.type;

    // Depth textures. A comparison sampler → shadow sampler; otherwise a plain float sampler
    // (GLSL ES 3.00 can read a depth texture through a regular sampler2D, returning depth in .r).
    if (d.isDepthTextureDesc(desc)) {
        switch (type) {
            case 'texture_depth_2d':
                return 'sampler2DShadow';
            default:
                throw new Error(`[glsl] depth texture '${type}' not yet supported in the GLSL emitter`);
        }
    }

    // Sample-type prefix for integer textures (isampler2D / usampler2D).
    const sampleType = (desc as d.SampledTexture).sampleType;
    const prefix = sampleType?.type === 'i32' ? 'i' : sampleType?.type === 'u32' ? 'u' : '';

    switch (type) {
        case 'texture_2d':
            return `${prefix}sampler2D`;
        case 'texture_cube':
            return `${prefix}samplerCube`;
        case 'texture_2d_array':
            return `${prefix}sampler2DArray`;
        case 'texture_3d':
            return `${prefix}sampler3D`;
        default:
            throw new Error(`[glsl] texture '${type}' not yet supported in the GLSL emitter`);
    }
}

/**
 * Register a texture binding + its sampler and return the combined-sampler uniform name. Both stages
 * share fresh per-context maps; registration is idempotent (keyed by textureId).
 */
function registerTexture(
    ctx: GlslBuildContext,
    binding: TextureBindingNode,
    samplerNode: SamplerNode<d.sampler | d.samplerComparison> | null,
): string {
    const id = binding.textureId;
    if (!ctx.textures.has(id)) {
        ctx.textures.set(id, binding);
    }
    if (samplerNode && !ctx.textureSamplers.has(id)) {
        ctx.textureSamplers.set(id, samplerNode);
    }
    return samplerUniformName(id);
}

/** Bare texture handle used as an expression → its combined-sampler uniform name. */
function generateTextureBinding(ctx: GlslBuildContext, node: TextureBindingNode): string {
    return registerTexture(ctx, node, null);
}

/** Ensure a texture node has a sampler (mirrors the WGSL emitter's default-sampler synthesis). */
function ensureSampler(node: {
    samplerNode: SamplerNode<d.sampler> | null;
    bindingNode: TextureBindingNode;
}): SamplerNode<d.sampler> {
    if (!node.samplerNode) {
        node.samplerNode = new SamplerNode(d.sampler, node.bindingNode.textureId, node.bindingNode.group);
    }
    return node.samplerNode;
}

function generateTexture(ctx: GlslBuildContext, node: TextureNode): string {
    const binding = node.bindingNode;
    const id = binding.textureId;

    // textureLoad → texelFetch (no sampler filtering).
    if (node.samplingMode === 'load') {
        if (!node.loadCoords) throw new Error(`[glsl] TextureNode '${id}' in load mode has no loadCoords`);
        const name = registerTexture(ctx, binding, null);
        const coords = generateExpr(ctx, node.loadCoords);
        const level = node.loadLevel ? generateExpr(ctx, node.loadLevel) : '0';
        // WGSL loadCoords are already integer (vec2i); wrap defensively for GLSL's ivec2 texelFetch.
        return `texelFetch(${name}, ivec2(${coords}), ${level})`;
    }

    const name = registerTexture(ctx, binding, ensureSampler(node));

    if (!node.uvNode) throw new Error(`[glsl] TextureNode '${id}' has no uvNode. Use texture.sample(uv).`);
    const uv = generateExpr(ctx, node.uvNode);

    // GLSL's texture() has no const-offset overload we support here — reject rather than drop it.
    if (node.offsetNode) throw new Error(`[glsl] texture sampling offset not yet supported in the GLSL emitter`);

    switch (node.samplingMode) {
        case 'grad': {
            if (!node.gradNode) throw new Error(`[glsl] TextureNode '${id}' in grad mode has no gradNode`);
            const ddx = generateExpr(ctx, node.gradNode[0]);
            const ddy = generateExpr(ctx, node.gradNode[1]);
            return `textureGrad(${name}, ${uv}, ${ddx}, ${ddy})`;
        }
        case 'bias': {
            if (!node.biasNode) throw new Error(`[glsl] TextureNode '${id}' in bias mode has no biasNode`);
            return `texture(${name}, ${uv}, ${generateExpr(ctx, node.biasNode)})`;
        }
        case 'level': {
            if (!node.levelNode) throw new Error(`[glsl] TextureNode '${id}' in level mode has no levelNode`);
            return `textureLod(${name}, ${uv}, ${generateExpr(ctx, node.levelNode)})`;
        }
        default:
            return `texture(${name}, ${uv})`;
    }
}

function generateCubeTexture(ctx: GlslBuildContext, node: CubeTextureNode): string {
    const binding = node.bindingNode;
    const id = binding.textureId;
    const name = registerTexture(ctx, binding, ensureSampler(node));

    if (!node.directionNode) throw new Error(`[glsl] CubeTextureNode '${id}' has no directionNode. Use cube.sample(dir).`);
    // Mirror the WGSL emitter: negate the sample direction's X to un-do the CubeCamera's face swap.
    const dir = `((${generateExpr(ctx, node.directionNode)}) * vec3(-1.0, 1.0, 1.0))`;

    switch (node.samplingMode) {
        case 'grad': {
            if (!node.gradNode) throw new Error(`[glsl] CubeTextureNode '${id}' in grad mode has no gradNode`);
            const ddx = generateExpr(ctx, node.gradNode[0]);
            const ddy = generateExpr(ctx, node.gradNode[1]);
            return `textureGrad(${name}, ${dir}, ${ddx}, ${ddy})`;
        }
        case 'bias': {
            if (!node.biasNode) throw new Error(`[glsl] CubeTextureNode '${id}' in bias mode has no biasNode`);
            return `texture(${name}, ${dir}, ${generateExpr(ctx, node.biasNode)})`;
        }
        case 'level': {
            if (!node.levelNode) throw new Error(`[glsl] CubeTextureNode '${id}' in level mode has no levelNode`);
            return `textureLod(${name}, ${dir}, ${generateExpr(ctx, node.levelNode)})`;
        }
        default:
            return `texture(${name}, ${dir})`;
    }
}

function generateDepthTexture(_ctx: GlslBuildContext, _node: DepthTextureNode): string {
    // The DepthTextureNode.sample()/.level()/.load() surface maps to a GLSL shadow sampler, but a
    // shadow sampler needs a compare reference (`texture(sampler2DShadow, vec3(uv, ref))`) that this
    // node kind doesn't carry — a plain depth READ isn't expressible through it. Only compare
    // sampling via the free function textureSampleCompare (handled in generateTextureCall) is
    // supported. Reject the node-method path rather than emit wrong GLSL.
    throw new Error(
        `[glsl] plain depth-texture sampling not yet supported in the GLSL emitter; ` +
            `use textureSampleCompare for shadow comparison`,
    );
}

function generateArrayTexture(ctx: GlslBuildContext, node: ArrayTextureNode): string {
    const binding = node.bindingNode;
    const id = binding.textureId;
    const layer = generateExpr(ctx, node.layerNode);

    if (node.samplingMode === 'load') {
        if (!node.loadCoords) throw new Error(`[glsl] ArrayTextureNode '${id}' in load mode has no loadCoords`);
        const name = registerTexture(ctx, binding, null);
        const coords = generateExpr(ctx, node.loadCoords);
        const level = node.loadLevel ? generateExpr(ctx, node.loadLevel) : '0';
        // GLSL 2D-array texelFetch takes an ivec3 (uv, layer).
        return `texelFetch(${name}, ivec3(ivec2(${coords}), ${layer}), ${level})`;
    }

    const name = registerTexture(ctx, binding, ensureSampler(node));
    if (!node.uvNode) throw new Error(`[glsl] ArrayTextureNode '${id}' has no uvNode. Use array.sample(uv).`);
    const uv = generateExpr(ctx, node.uvNode);
    if (node.offsetNode) throw new Error(`[glsl] array texture sampling offset not yet supported in the GLSL emitter`);

    // GLSL folds the array layer into the coordinate: vec3(uv, layer).
    const coord = `vec3(${uv}, float(${layer}))`;

    switch (node.samplingMode) {
        case 'grad': {
            if (!node.gradNode) throw new Error(`[glsl] ArrayTextureNode '${id}' in grad mode has no gradNode`);
            const ddx = generateExpr(ctx, node.gradNode[0]);
            const ddy = generateExpr(ctx, node.gradNode[1]);
            return `textureGrad(${name}, ${coord}, ${ddx}, ${ddy})`;
        }
        case 'bias': {
            if (!node.biasNode) throw new Error(`[glsl] ArrayTextureNode '${id}' in bias mode has no biasNode`);
            return `texture(${name}, ${coord}, ${generateExpr(ctx, node.biasNode)})`;
        }
        case 'level': {
            if (!node.levelNode) throw new Error(`[glsl] ArrayTextureNode '${id}' in level mode has no levelNode`);
            return `textureLod(${name}, ${coord}, ${generateExpr(ctx, node.levelNode)})`;
        }
        default:
            return `texture(${name}, ${coord})`;
    }
}

/* struct declaration emission */

/**
 * Emit GLSL `struct <Name> { <type> <field>; … };` declarations for every struct discovered in the
 * graph. discover() populates ctx.structDefs in topological order (nested dependencies first), so a
 * plain iteration already emits nested structs before the structs that use them — GLSL requires a
 * struct to be declared before it is referenced. Member types are scalar/vec/mat via glslType, or a
 * nested struct's name; fixed-size array members use GLSL's `<elemType> <field>[<N>]` array syntax.
 */
export function emitGlslStructs(ctx: GlslBuildContext): string {
    const lines: string[] = [];
    for (const [, def] of ctx.structDefs) {
        lines.push(`struct ${def.wgslType} {`);
        for (const member of def.members) {
            lines.push(`    ${glslLocalDecl(member.type, member.name)};`);
        }
        lines.push(`};`);
        lines.push('');
    }
    return lines.length > 0 ? lines.join('\n') : '';
}

/* std140 uniform block (UBO) emission */

/**
 * Emit std140 UBO blocks, one per named uniform group. Mirrors emitAllBindings in the WGSL emitter:
 * groups are sorted by UniformGroup.order and the resulting index is the sorted array position.
 * Each group becomes `layout(std140) uniform <Block> { <members> } uniforms_<group>;`.
 */
export function emitGlslUniformBlocks(ctx: GlslBuildContext): { glsl: string; uniformBlocks: UniformGroupBlock[] } {
    // Collect uniforms per group.
    const groups = new Map<string, { group: UniformGroup; uniforms: UniformNode<d.Any>[] }>();
    for (const [, { node, group }] of ctx.uniforms) {
        let entry = groups.get(group.name);
        if (!entry) {
            entry = { group, uniforms: [] };
            groups.set(group.name, entry);
        }
        entry.uniforms.push(node);
    }

    const sorted = [...groups.values()].sort((a, b) => a.group.order - b.group.order);

    const lines: string[] = [];
    const uniformBlocks: UniformGroupBlock[] = [];

    sorted.forEach((entry, groupIndex) => {
        if (entry.uniforms.length === 0) return;
        const groupName = entry.group.name;

        lines.push(`layout(std140) uniform Uniforms_${groupName} {`);

        const members: UniformMember[] = [];
        let offset = 0;
        let structAlign = 4;
        for (const u of entry.uniforms) {
            // std140 offsets/sizes come from pack.ts — the single memory-layout authority.
            const align = layoutAlignOf(u.type, 'std140');
            const size = layoutSizeOf(u.type, 'std140');
            offset = Math.ceil(offset / align) * align;
            lines.push(`    ${glslType(u.type)} ${u.name};`);
            members.push({ uniformId: u.name, schema: u.type, offset, size, node: u });
            offset += size;
            structAlign = Math.max(structAlign, align);
        }

        lines.push(`} uniforms_${groupName};`);
        lines.push('');

        const totalBytes = Math.ceil(offset / structAlign) * structAlign;

        uniformBlocks.push({
            groupName,
            groupIndex,
            binding: 0,
            shared: entry.group.shared,
            members,
            totalBytes,
            group: entry.group,
        });
    });

    return { glsl: lines.join('\n'), uniformBlocks };
}

/* combined-sampler uniform emission */

/**
 * Emit the global-scope combined-sampler uniform declarations and build the texture + sampler
 * runtime metadata.
 *
 * WGSL binds a texture and a sampler separately; GLSL ES 3.00 samples through one combined-sampler
 * uniform. So a single texture binding produces:
 *   - one `uniform sampler2D u_<textureId>;` line at global scope (NOT inside a UBO), and
 *   - one {@link TextureEntry} + one {@link SamplerEntry}, both carrying the SAME `binding` value —
 *     the assigned texture unit — so the Phase-4 runtime binds the GPU texture and its sampler
 *     settings to that unit together.
 *
 * Texture-unit assignment mirrors how the WGSL emitter orders texture bindings: it groups textures
 * by their UniformGroup, sorts the groups by `UniformGroup.order`, and walks each group's textures
 * in first-encounter (insertion) order, assigning sequential unit indices starting from 0. GLSL has
 * no @group/@binding, so the unit is a single flat counter across all groups — but the ORDER matches
 * the WGSL emitter's texture ordering. `group` is retained on each entry for parity/debugging.
 */
export function emitGlslTextures(ctx: GlslBuildContext): {
    glsl: string;
    textures: TextureEntry[];
    samplers: SamplerEntry[];
} {
    // Group textures by UniformGroup, preserving first-encounter order within each group.
    const groups = new Map<string, { group: UniformGroup; textures: TextureBindingNode[] }>();
    for (const [, binding] of ctx.textures) {
        let entry = groups.get(binding.group.name);
        if (!entry) {
            entry = { group: binding.group, textures: [] };
            groups.set(binding.group.name, entry);
        }
        entry.textures.push(binding);
    }

    const sortedGroups = [...groups.values()].sort((a, b) => a.group.order - b.group.order);

    const lines: string[] = [];
    const textures: TextureEntry[] = [];
    const samplers: SamplerEntry[] = [];

    let unit = 0;
    sortedGroups.forEach((entry, groupIndex) => {
        for (const binding of entry.textures) {
            const id = binding.textureId;
            const name = samplerUniformName(id);
            const samplerType = glslSamplerType(binding.type);
            // Depth-compare shadow samplers must be highp in GLSL ES 3.00.
            const precision = samplerType.includes('Shadow') ? 'highp ' : '';
            lines.push(`uniform ${precision}${samplerType} ${name};`);

            textures.push({
                textureId: id,
                // The declared combined-sampler type — the GLSL analogue of WGSL's texture var type.
                type: samplerType,
                group: groupIndex,
                binding: unit,
                node: binding,
            });

            // Fold the paired sampler's settings into the same texture unit. If the texture was only
            // used as a bare handle (no sample), no sampler was registered — skip its SamplerEntry.
            const samplerNode = ctx.textureSamplers.get(id);
            if (samplerNode) {
                samplers.push({
                    samplerId: `${id}_sampler`,
                    type: samplerNode.compare ? 'sampler_comparison' : 'sampler',
                    group: groupIndex,
                    binding: unit,
                    samplerNode,
                });
            }

            unit++;
        }
    });

    return { glsl: lines.join('\n'), textures, samplers };
}

/* statement generation
 *
 * Mirrors generateStmt/generateIfStmt/generateLoopStmt in the WGSL emitter, translating the
 * control-flow / variable-declaration statements to GLSL ES 3.00. Statement nodes append lines to
 * ctx.code at the current ctx.indentLevel; nested blocks bump the level and restore it.
 */

function generateStmt(ctx: GlslBuildContext, rawNode: Node<d.Any>): void {
    const node = rawNode as AnyNode;
    const ind = '    '.repeat(ctx.indentLevel);

    switch (node.kind) {
        case NodeKind.Let: {
            const init = generateExpr(ctx, node.init);
            // GLSL ES 3.00 has `const`, but a Let init here is a runtime expression (not a const-
            // expression), which `const` forbids. Emit a plain typed local — immutable by convention.
            ctx.code.push(`${ind}${glslLocalDecl(node.type, node.varName)} = ${init};`);
            ctx.nodeVars.set(node.id, node.varName);
            break;
        }
        case NodeKind.Var: {
            const init = generateExpr(ctx, node.init);
            ctx.code.push(`${ind}${glslLocalDecl(node.type, node.varName)} = ${init};`);
            ctx.nodeVars.set(node.id, node.varName);
            break;
        }
        case NodeKind.Assign: {
            const target = generateExpr(ctx, node.target);
            const value = generateExpr(ctx, node.value);
            ctx.code.push(`${ind}${target} = ${value};`);
            break;
        }
        case NodeKind.If:
            generateIfStmt(ctx, node);
            break;
        case NodeKind.Loop:
            generateLoopStmt(ctx, node);
            break;
        case NodeKind.Break:
            ctx.code.push(`${ind}break;`);
            break;
        case NodeKind.Continue:
            ctx.code.push(`${ind}continue;`);
            break;
        case NodeKind.Discard:
            if (ctx.stage !== 'fragment') {
                throw new Error(`[glsl] discard is only valid in the fragment stage, but was used in the ${ctx.stage} stage`);
            }
            ctx.code.push(`${ind}discard;`);
            break;
        case NodeKind.Return: {
            if (node.value.type.wgslType === 'void') {
                ctx.code.push(`${ind}return;`);
            } else {
                ctx.code.push(`${ind}return ${generateExpr(ctx, node.value)};`);
            }
            break;
        }
        case NodeKind.Stack:
            for (const child of node.body) generateStmt(ctx, child);
            break;
        default: {
            // Treat as an expression statement. If the node was hoisted to a CSE var, its side
            // effect was already emitted in the declaration — re-emitting a bare `_vN;` here would
            // be dead code, so skip it.
            const expr = generateExpr(ctx, node);
            const hoisted = ctx.nodeVars.get(node.id);
            if (expr && !expr.startsWith('/*') && expr !== hoisted) {
                ctx.code.push(`${ind}${expr};`);
            }
        }
    }
}

function generateIfStmt(ctx: GlslBuildContext, node: IfNode): void {
    const ind = '    '.repeat(ctx.indentLevel);
    const cond = generateExpr(ctx, node.condition);
    ctx.code.push(`${ind}if (${cond}) {`);

    ctx.indentLevel++;
    for (const child of node.thenBody.body) generateStmt(ctx, child);
    ctx.indentLevel--;

    for (const branch of node.elseIfBranches) {
        const branchCond = generateExpr(ctx, branch.condition);
        ctx.code.push(`${ind}} else if (${branchCond}) {`);
        ctx.indentLevel++;
        for (const child of branch.body.body) generateStmt(ctx, child);
        ctx.indentLevel--;
    }

    if (node.elseBody && node.elseBody.body.length > 0) {
        ctx.code.push(`${ind}} else {`);
        ctx.indentLevel++;
        for (const child of node.elseBody.body) generateStmt(ctx, child);
        ctx.indentLevel--;
    }

    ctx.code.push(`${ind}}`);
}

/**
 * Lower a Loop node to a GLSL `for`. Matches the WGSL emitter's lowering: a numeric range or a
 * literal/uniform bound becomes a counted `for (int i = 0; i < n; i++)`; a bare condition node (from
 * `While`) becomes `while (cond)`; a `{ start, end, type, condition }` object becomes a fully-formed
 * counted loop. The loop variable is registered so references inside the body resolve to its name.
 */
function generateLoopStmt(ctx: GlslBuildContext, node: LoopNode): void {
    const { config, loopVar, body } = node;

    // Unique loop-variable name per nesting depth (mirrors the WGSL emitter's naming).
    const depth = ctx.indentLevel - 1;
    const varName = `i_${depth}_${ctx.varCounter++}`;
    ctx.nodeVars.set(loopVar.id, varName);

    let loopHeader: string;

    if (typeof config === 'number') {
        loopHeader = `for (int ${varName} = 0; ${varName} < ${config}; ${varName}++)`;
    } else if (isNode(config) && (config.kind === NodeKind.Literal || config.kind === NodeKind.Uniform)) {
        const endExpr = generateExpr(ctx, config as Node<d.Any>);
        loopHeader = `for (int ${varName} = 0; ${varName} < ${endExpr}; ${varName}++)`;
    } else if (isNode(config)) {
        // Bare condition node (from `While(cond, …)`): GLSL re-evaluates the header condition every
        // iteration, so a body that mutates variables used in `cond` terminates correctly.
        loopHeader = `while (${generateExpr(ctx, config as Node<d.Any>)})`;
    } else if (typeof config === 'object' && config !== null) {
        const cfg = config as {
            start?: Node<d.Any> | number;
            end?: Node<d.Any> | number;
            type?: d.Scalar;
            condition?: '<' | '<=' | '>' | '>=';
        };

        const typeDesc = cfg.type ?? d.i32;
        const typeStr = glslType(typeDesc);

        const getExpr = (v: Node<d.Any> | number | undefined): string | undefined => {
            if (v === undefined) return undefined;
            if (typeof v === 'number') return glslLiteral(typeDesc.wgslType, v);
            return generateExpr(ctx, v as Node<d.Any>);
        };

        const startExpr = getExpr(cfg.start) ?? '0';
        const endExpr = getExpr(cfg.end) ?? '0';
        const condition = cfg.condition ?? '<';

        loopHeader = `for (${typeStr} ${varName} = ${startExpr}; ${varName} ${condition} ${endExpr}; ${varName}++)`;
    } else {
        loopHeader = `/* unknown loop range type */`;
    }

    const ind = '    '.repeat(ctx.indentLevel);
    ctx.code.push(`${ind}${loopHeader} {`);
    ctx.indentLevel++;
    for (const stmt of body.body) generateStmt(ctx, stmt);
    ctx.indentLevel--;
    ctx.code.push(`${ind}}`);
}

/* module-scope variable + user-function emission */

/**
 * Emit GLSL global declarations for module-scope PrivateVar nodes: `<type> <name>[= <init>];`. GLSL
 * has no `var<private>` — a per-invocation module-scope variable is just a plain global. Initializers
 * must be const-expressions (literals / constructors), like the WGSL emitter requires.
 */
export function emitGlslModuleScopeVars(ctx: GlslBuildContext): string {
    const lines: string[] = [];
    for (const [, node] of ctx.privateVars) {
        if (node.init) {
            lines.push(`${glslType(node.type)} ${node.varName} = ${glslModuleScopeInitExpr(node.init)};`);
        } else {
            lines.push(`${glslType(node.type)} ${node.varName};`);
        }
    }
    return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

/** Const-expression for a module-scope initializer (literals / constructors / const-eval builtins). */
function glslModuleScopeInitExpr(rawNode: Node<d.Any>): string {
    const node = rawNode as AnyNode;
    if (node.kind === NodeKind.Literal) {
        return glslLiteral(node.type.wgslType, node.value);
    }
    if (node.kind === NodeKind.Construct) {
        const args = node.args.map((a) => glslModuleScopeInitExpr(a));
        return `${glslType(node.type)}(${args.join(', ')})`;
    }
    if (node.kind === NodeKind.BinaryOp) {
        return `(${glslModuleScopeInitExpr(node.left)} ${node.op} ${glslModuleScopeInitExpr(node.right)})`;
    }
    if (node.kind === NodeKind.Call) {
        const args = node.args.map((a) => glslModuleScopeInitExpr(a));
        return `${node.fn}(${args.join(', ')})`;
    }
    throw new Error(
        `[glsl] module-scope variable initializer must be a const-expression (literal / constructor / ` +
            `const-evaluable builtin); got ${node.constructor.name}`,
    );
}

/**
 * Emit GLSL definitions for user Fn nodes: `<retType> <name>(<params>) { <body> return <expr>; }`.
 * Each function body gets its OWN emission sub-context (fresh CSE vars / code / indentation) that
 * still shares the parent's binding + function tables, so references resolve to the same names —
 * mirroring emitDslFunctions in the WGSL emitter. GLSL params carry no in/out qualifier here (all
 * `in` by default), matching the value-parameter semantics of the DSL.
 */
/**
 * Emit the GLSL companion source for raw escape-hatch functions (wgslFn with a `glsl` companion, or
 * glslFn). Mirrors emitWgslFunctions on the WGSL side: includes first, in dependency order, deduped.
 * A raw function reaching this backend WITHOUT a GLSL companion throws — that is the missing-variant
 * seam for the WebGL backend.
 */
export function emitGlslRawFunctions(ctx: GlslBuildContext): string {
    const lines: string[] = [];
    const emitted = new Set<string>();

    const emitOne = (fn: WgslFunctionNodeRef) => {
        if (!fn.glslCode) {
            throw new Error(
                `[glsl] this wgslFn/glslFn has no \`glsl\` variant; add one to run on the WebGL backend`,
            );
        }
        if (emitted.has(fn.glslCode)) return;
        lines.push(fn.glslCode.trim());
        lines.push('');
        emitted.add(fn.glslCode);
    };

    for (const [, fn] of ctx.rawFnDefs) {
        // Includes first so callees are defined before callers.
        for (const inc of fn.includes) {
            if ((inc as { kind?: NodeKind }).kind === NodeKind.WgslFunction) emitOne(inc);
        }
        emitOne(fn);
    }

    return lines.join('\n');
}

/**
 * The fn names DIRECTLY called by a traced fn (via a Call node with an `fnNode`). Used to order
 * definitions so callees precede callers — GLSL ES 3.00 requires definition-before-use, unlike WGSL
 * (which allows out-of-order module functions). Discovery registers callers before callees, so without
 * this reorder a `step` that calls `wrap` would emit `step` first and fail ("no matching function").
 */
function tracedFnCallees(traced: TracedFn): string[] {
    const callees: string[] = [];
    const seen = new Set<number>();
    const walk = (rawNode: Node<d.Any>): void => {
        const node = rawNode as AnyNode;
        if (seen.has(node.id)) return;
        seen.add(node.id);
        if (node.kind === NodeKind.Call) {
            const fnNode = (node as CallNode<d.Any>).fnNode;
            if (fnNode) callees.push(fnNode.fnName);
        }
        for (const child of getChildren(node)) walk(child);
    };
    walk(traced.body);
    walk(traced.output);
    return callees;
}

export function emitGlslDslFunctions(ctx: GlslBuildContext): string {
    const lines: string[] = [];

    // Emit definitions in dependency order (callees before callers) so GLSL's definition-before-use
    // rule is satisfied. Post-order DFS over the call graph; a `visiting` guard tolerates self/mutual
    // recursion (emits each fn once, best-effort order — GLSL would need a prototype for true mutual
    // recursion, which the DSL doesn't produce).
    const orderedNames: string[] = [];
    const done = new Set<string>();
    const visiting = new Set<string>();
    const visit = (name: string): void => {
        if (done.has(name) || visiting.has(name)) return;
        visiting.add(name);
        const entry = ctx.fnDefs.get(name);
        if (entry) {
            for (const callee of tracedFnCallees(entry.traced)) visit(callee);
        }
        visiting.delete(name);
        done.add(name);
        orderedNames.push(name);
    };
    for (const name of ctx.fnDefs.keys()) visit(name);

    for (const name of orderedNames) {
        const entry = ctx.fnDefs.get(name);
        if (!entry) continue;
        const { fn, traced } = entry;
        const params = traced.params
            .map((p, i) => {
                const pName = p.paramName ?? `p${i}`;
                return `${glslType(p.type)} ${pName}`;
            })
            .join(', ');

        // Fresh sub-context for the body: its own CSE / code / indentation, sharing the parent's
        // discovered facts (uniforms, textures, fn table) so names resolve consistently.
        const fnCtx: GlslBuildContext = {
            ...ctx,
            attributes: new Map(),
            varyings: new Map(),
            builtins: ctx.builtins,
            nodeVars: new Map(),
            varCounter: 0,
            indentLevel: 1,
            code: [],
        };

        // Register param names so parameter references resolve to them.
        for (const p of traced.params as ParameterNode<d.Any>[]) {
            fnCtx.nodeVars.set(p.id, p.paramName ?? `p${p.paramIndex}`);
        }

        for (const stmt of traced.body.body) generateStmt(fnCtx, stmt);

        const retType = fn.type.wgslType === 'void' ? 'void' : glslType(fn.type);
        // Generate the return-expr STRING BEFORE flushing fnCtx.code: evaluating the return expr can
        // append CSE decls (`_vN = ...;`) to fnCtx.code, and those must land inside the function body
        // (before the return). Flushing first would drop them, leaving `_vN` undeclared.
        const retExpr = fn.type.wgslType !== 'void' ? generateExpr(fnCtx, traced.output) : null;
        lines.push(`${retType} ${glslFnName(name)}(${params}) {`);
        lines.push(...fnCtx.code);
        if (retExpr !== null) lines.push(`    return ${retExpr};`);
        lines.push(`}`);
        lines.push('');
    }

    return lines.join('\n');
}

/* varying pre-collection (mirrors collectVaryings in the WGSL emitter) */

export function collectGlslVaryings(roots: Node<d.Any>[], ctx: GlslBuildContext): void {
    const visited = new Set<number>();

    function visit(rawNode: Node<d.Any>) {
        const node = rawNode as AnyNode;
        if (visited.has(node.id)) return;
        visited.add(node.id);

        if (node.kind === NodeKind.Varying) {
            const name = node.name ?? `v_${node.id}`;
            if (!ctx.varyings.has(name)) {
                const sourceExpr = generateExpr(ctx, node.node.node);
                ctx.varyings.set(name, { node, vertexExpr: sourceExpr });
            }
        }

        for (const child of getChildren(node)) visit(child);
    }

    for (const root of roots) visit(root);
}

/* vertex shader generation */

export function generateGlslVertexShader(slots: CompileSlots, ctx: GlslBuildContext): string {
    const lines: string[] = [];

    const clipExpr = generateExpr(ctx, slots.vertex);

    // Attribute inputs (deduped by location — named attributes may alias several node ids to one entry).
    const renderAttributes = distinctAttributes(ctx);
    for (const attr of renderAttributes) {
        lines.push(`layout(location = ${attr.location}) in ${glslType(attr.type)} ${attr.shaderName};`);
    }
    if (renderAttributes.length > 0) lines.push('');

    // Varying outputs (interpolated to the fragment stage). GLSL ES 3.00 matches varyings between
    // stages by NAME, not location — `layout(location=N)` is illegal on a varying here (it is only
    // valid on vertex `in` attributes and fragment `out` targets), so emit a bare `out`.
    for (const [name, { node }] of ctx.varyings) {
        lines.push(`${glslVaryingQualifier(node)}out ${glslType(node.type)} ${name};`);
    }
    if (ctx.varyings.size > 0) lines.push('');

    // Batched-draw base: when instanceIndex is used, it lowers to `u_drawBase + gl_InstanceID`
    // (base-inclusive, matching WebGPU). The batched draw loop sets this per sub-draw; it is 0 by
    // default (GL uniform default) for single draws.
    if (ctx.builtins.has('instance_index')) {
        lines.push('uniform highp uint u_drawBase;');
        lines.push('');
    }

    lines.push('void main() {');
    lines.push(...ctx.code);
    for (const [name, { vertexExpr }] of ctx.varyings) {
        lines.push(`    ${name} = ${vertexExpr};`);
    }
    lines.push(`    gl_Position = ${clipExpr};`);
    lines.push('}');

    return lines.join('\n');
}

/* transform-feedback vertex shader generation */

/** Derivative call names that are only valid in a fragment shader (undefined in the vertex stage). */
const FRAGMENT_ONLY_DERIVATIVES = new Set([
    'dpdx',
    'dpdy',
    'fwidth',
    'dpdxCoarse',
    'dpdyCoarse',
    'fwidthCoarse',
    'dpdxFine',
    'dpdyFine',
    'fwidthFine',
]);

/**
 * Texture free functions that pick their mip level from screen-space derivatives (implicit LOD). Those
 * derivatives don't exist in a transform-feedback vertex kernel, so require the explicit-LOD form
 * (`textureLod` / `textureLoad`) instead.
 */
const IMPLICIT_LOD_TEXTURE_FNS = new Set(['textureSample', 'textureSampleBias', 'textureSampleCompare', 'textureGather', 'textureGatherCompare']);

/**
 * Reject body constructs that can't run in a transform-feedback vertex kernel. Walks the traced body
 * + output expressions, throwing a clear `[transformFeedback]` / `[glsl]` error naming the fix.
 */
function validateTransformFeedbackBody(roots: Node<d.Any>[]): void {
    const seen = new Set<number>();
    const walk = (rawNode: Node<d.Any>): void => {
        const node = rawNode as AnyNode;
        if (seen.has(node.id)) return;
        seen.add(node.id);

        switch (node.kind) {
            case NodeKind.Discard:
                throw new Error(`[transformFeedback] 'discard' is a fragment-only op and can't be used in a transform-feedback kernel.`);
            case NodeKind.Storage:
                throw new Error(
                    `[transformFeedback] storage() buffers are not part of the transform-feedback DSL; ` +
                        `use named attribute inputs / captured-varying outputs (or a WebGPU compute() for scatter/atomics).`,
                );
            case NodeKind.StorageTextureBinding:
                throw new Error(`[transformFeedback] storage textures are not supported in a transform-feedback kernel.`);
            case NodeKind.WorkgroupVar:
                throw new Error(`[transformFeedback] workgroup variables are compute-only and can't be used in a transform-feedback kernel.`);
            case NodeKind.Call: {
                const call = node as CallNode<d.Any>;
                if (FRAGMENT_ONLY_DERIVATIVES.has(call.fn)) {
                    throw new Error(
                        `[transformFeedback] '${call.fn}' is a fragment-only derivative and can't be used in a transform-feedback kernel.`,
                    );
                }
                if (IMPLICIT_LOD_TEXTURE_FNS.has(call.fn)) {
                    throw new Error(
                        `[transformFeedback] '${call.fn}' uses implicit-LOD sampling (screen-space derivatives), which is undefined in a ` +
                            `transform-feedback vertex kernel; use textureLoad() or textureSampleLevel() with an explicit lod.`,
                    );
                }
                if (call.fn === 'workgroupBarrier' || call.fn === 'storageBarrier' || call.fn === 'textureBarrier') {
                    throw new Error(`[transformFeedback] '${call.fn}()' is compute-only and can't be used in a transform-feedback kernel.`);
                }
                if (call.fn.startsWith('atomic')) {
                    throw new Error(`[transformFeedback] atomics ('${call.fn}') are not part of the transform-feedback DSL; use a WebGPU compute().`);
                }
                break;
            }
        }

        for (const child of getChildren(node)) walk(child);
    };
    for (const root of roots) walk(root);
}

/**
 * A single captured-varying output of a transform-feedback kernel.
 */
export type TransformFeedbackOutput = { name: string; varyingName: string; type: d.Any; expr: string };

/**
 * Emit the transform-feedback vertex shader body (main() + attribute/varying declarations) into a
 * fresh GLSL sub-context that shares the parent's discovered facts. Returns the generated `void main`
 * body plus the ordered output metadata (for the caller to assemble the module + feedbackVaryings).
 *
 * The kernel body IS the vertex main(): the traced statements run, each output varying is assigned
 * `v_<name> = <expr>;`, and a dummy `gl_Position = vec4(0.0);` is written so the program links.
 */
export function generateGlslTransformFeedbackShader(
    ctx: GlslBuildContext,
    body: StackNode,
    outputs: { name: string; expr: Node<d.Any> }[],
): { main: string; attributes: { shaderName: string; type: d.Any; location: number }[]; outputs: TransformFeedbackOutput[] } {
    if (ctx.stage !== 'vertex') {
        throw new Error(`[transformFeedback] the kernel body must be emitted in the vertex stage (got '${ctx.stage}').`);
    }

    // Validation over the full traced graph (body + every output expression).
    validateTransformFeedbackBody([body, ...outputs.map((o) => o.expr)]);

    // Emit body statements first (they may hoist CSE locals into ctx.code / register attributes).
    for (const stmt of body.body) generateStmt(ctx, stmt);

    // Then the output expressions — evaluating them registers any remaining attributes and appends any
    // CSE locals they hoist, exactly like the varying pre-eval in the render path.
    const outputMeta: TransformFeedbackOutput[] = outputs.map((o) => {
        const type = validateTransformFeedbackOutputType(o.name, o.expr.type);
        return { name: o.name, varyingName: `v_${o.name}`, type, expr: generateExpr(ctx, o.expr) };
    });

    const lines: string[] = [];

    // Attribute inputs (registered while emitting the body / outputs above), ordered by location and
    // deduped (named attributes may alias several node ids to one entry).
    const attributeList = distinctAttributes(ctx);
    for (const attr of attributeList) {
        lines.push(`layout(location = ${attr.location}) in ${glslType(attr.type)} ${attr.shaderName};`);
    }
    if (attributeList.length > 0) lines.push('');

    // Captured-varying outputs. Integer-typed varyings must be `flat` (GLSL ES 3.00 won't link them
    // otherwise) — the same rule as render varyings.
    for (const out of outputMeta) {
        const flat = GLSL_INTEGER_WGSL_TYPES.has(out.type.wgslType) ? 'flat ' : '';
        lines.push(`${flat}out ${glslType(out.type)} ${out.varyingName};`);
    }
    if (outputMeta.length > 0) lines.push('');

    // instanceIndex lowers to `u_drawBase + gl_InstanceID`; declare u_drawBase when it is used.
    // A transform-feedback kernel never sets it, so it stays 0 (correct: base 0 + gl_InstanceID).
    if (ctx.builtins.has('instance_index')) {
        lines.push('uniform highp uint u_drawBase;');
        lines.push('');
    }

    lines.push('void main() {');
    lines.push(...ctx.code);
    for (const out of outputMeta) {
        lines.push(`    ${out.varyingName} = ${out.expr};`);
    }
    // Dummy clip position so the program links (rasterization is discarded at run time).
    lines.push('    gl_Position = vec4(0.0);');
    lines.push('}');

    return {
        main: lines.join('\n'),
        attributes: attributeList.map((a) => ({ shaderName: a.shaderName, type: a.type, location: a.location })),
        outputs: outputMeta,
    };
}

/**
 * Validate a transform-feedback output schema for v1 scope: scalar / vec2 / vec4 / (u)int-vectors only.
 * vec3 and struct outputs are rejected (throws naming the fix), > 4 outputs is checked by the caller.
 */
function validateTransformFeedbackOutputType(name: string, type: d.Any): d.Any {
    if (d.isStructDesc(type)) {
        throw new Error(
            `[transformFeedback] output '${name}' is a struct, which is not supported (v1); return the fields as separate scalar/vec2/vec4 outputs.`,
        );
    }
    const wgsl = type.wgslType;
    if (wgsl === 'vec3f' || wgsl === 'vec3i' || wgsl === 'vec3u') {
        throw new Error(
            `[transformFeedback] output '${name}' is a vec3 (${wgsl}), which does not round-trip cleanly through transform feedback (v1); use vec4f.`,
        );
    }
    // glslType() throws for anything without a GLSL companion (bool vectors, f16, matrices, …).
    glslType(type);
    return type;
}

/* fragment shader generation */

export function generateGlslFragmentShader(
    fragmentNode: Node<d.Any> | null,
    ctx: GlslBuildContext,
    varyings: Map<string, { node: VaryingNode<d.Any>; vertexExpr: string }>,
    depthNode: Node<d.Any> | null = null,
): string {
    const lines: string[] = [];

    const hasColor = fragmentNode != null;
    const hasDepth = depthNode != null;

    // Inherit varyings discovered by the vertex stage so `in` locations match.
    for (const [name, data] of varyings) {
        if (!ctx.varyings.has(name)) ctx.varyings.set(name, data);
    }

    // MRT (multiple render targets): the fragment root is an MRTNode carrying several vec4 outputs.
    // WGSL emits one fragment-output struct with several @location(N) fields; GLSL ES 3.00 has no
    // fragment-output struct, so each output becomes its own `layout(location = N) out vec4 <name>;`
    // global, assigned in main() at the matching location. A single output stays `fragColor` at 0.
    const mrtNode = hasColor && fragmentNode.kind === NodeKind.MRT ? (fragmentNode as MRTNode) : null;

    // Pre-generate the output expressions BEFORE emitting main()'s body so any CSE locals they hoist
    // are already appended to ctx.code (mirrors the WGSL emitter's ordering).
    let mrtOutputs: { name: string; location: number; expr: string }[] | null = null;
    let colorExpr = '';
    if (mrtNode) {
        mrtOutputs = [];
        if (mrtNode.members.length > 0) {
            // Resolved members: the array index is the @location.
            for (let i = 0; i < mrtNode.members.length; i++) {
                const member = mrtNode.members[i];
                if (!member) continue; // sparse array possible
                const name = mrtNode._resolvedNames[i] || `output_${i}`;
                mrtOutputs.push({ name: glslOutputName(name), location: i, expr: generateExpr(ctx, member) });
            }
        } else {
            // Unresolved: fall back to declaration order of the named outputs.
            let loc = 0;
            for (const name in mrtNode.outputNodes) {
                mrtOutputs.push({ name: glslOutputName(name), location: loc, expr: generateExpr(ctx, mrtNode.outputNodes[name]) });
                loc++;
            }
        }
    } else if (hasColor) {
        colorExpr = generateExpr(ctx, fragmentNode);
    }

    // Pre-generate the frag_depth override expression (assigned to gl_FragDepth in main). Built into
    // GLSL ES 3.00 fragment shaders — no `out` declaration, no extension.
    const depthExpr = hasDepth ? generateExpr(ctx, depthNode) : '';

    // Varying inputs — matched to the vertex stage by NAME (see the vertex emitter). No
    // `layout(location)`: illegal on a fragment varying `in` in GLSL ES 3.00. The mandatory default
    // `precision` declarations are emitted at the top of the fragment module (see builder assembly),
    // ahead of the struct/UBO sections so their float members are covered.
    for (const [name, { node }] of ctx.varyings) {
        lines.push(`${glslVaryingQualifier(node)}in ${glslType(node.type)} ${name};`);
    }
    if (ctx.varyings.size > 0) lines.push('');

    if (mrtOutputs) {
        // One `out vec4` per render target (MRT outputs are always vec4-shaped).
        for (const { name, location } of mrtOutputs) {
            lines.push(`layout(location = ${location}) out vec4 ${name};`);
        }
        lines.push('');
    } else if (hasColor) {
        lines.push('layout(location = 0) out vec4 fragColor;');
        lines.push('');
    }
    // A depth-only fragment stage (no color output) declares no `out` — it only writes gl_FragDepth.
    lines.push('void main() {');
    lines.push(...ctx.code);
    if (mrtOutputs) {
        for (const { name, expr } of mrtOutputs) {
            lines.push(`    ${name} = ${expr};`);
        }
    } else if (hasColor) {
        lines.push(`    fragColor = ${colorExpr};`);
    }
    if (hasDepth) {
        lines.push(`    gl_FragDepth = ${depthExpr};`);
    }
    lines.push('}');

    return lines.join('\n');
}
