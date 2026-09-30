/**
 * backend/names.ts — shader identifier allocation, shared by the WGSL and GLSL emitters.
 *
 * Names in the emitted source are allocated per function scope rather than stamped with a node id.
 * A `Var('contrast', …)` becomes `contrast`, and only collides its way to `contrast_1` when the same
 * scope already holds that name. Two consequences beyond looking better:
 *
 *  - Emission is deterministic. Node ids come from a process-wide counter and function bodies are
 *    re-traced on every compile, so id-derived names differed between two compiles of the SAME graph.
 *    The WebGL program cache keys on the emitted source string, so that churn cost a redundant
 *    compile + link per shader.
 *  - The two backends agree. Both allocate from the same reserved set in the same traversal order, so
 *    a graph's WGSL and its GLSL name the same value the same way and can be read side by side.
 *
 * The reserved set is the UNION of both languages' keywords and built-ins, so any name that survives
 * allocation is safe on either backend — that union is what keeps the two in step.
 *
 * ## Where a name comes from
 *
 * Two kinds of naming field exist, and the difference decides whether this module may rename it:
 *
 *  - **`label`** — a HINT, which the emitters may adapt or suffix. It lives on the GPU resource
 *    (`GpuBuffer`, `GpuTexture`, `GpuSampler`, `Uniform`), or on the node itself when there is no
 *    resource to hang it on (a `Var`/`Let` local). A high-level wrapper exposes it as `name`
 *    (`Texture.name` forwards to `GpuTexture.label`), matching the rest of its API.
 *  - **`name` / `varName` / `textureId` / `bufferName` / `samplerId`** — IDENTITY, which must keep
 *    matching something outside the shader: a geometry buffer slot, the other stage's varying, a
 *    bind-group dedup key, a module-scope declaration. Emitted verbatim and never reallocated here.
 *
 * A node therefore carries at most ONE naming field. When it references a resource, the label lives
 * on the resource and the node holds only identity — which is why `UniformNode` reads
 * `node.uniform.label` rather than keeping a label of its own.
 */

import type * as d from '../../schema/schema';
import { type AnyNode, getChildren } from '../graph';
import { type CallNode, type FnNode, type Node, NodeKind } from '../lib/core';
import type { TracedFn } from './wgsl/emit';

/** Space-separated word lists, split once at module load — kept as prose for readability. */
const words = (s: string): string[] => s.split(' ');

/**
 * WGSL keywords plus its (long) reserved-word list. A reserved word is not usable as an identifier
 * even though nothing is declared with it, so it has to be here as well.
 */
const WGSL_KEYWORDS = words(
    'alias break case const const_assert continue continuing default diagnostic discard else enable false fn for if let loop override requires return struct switch true var while with ' +
        'NULL Self abstract active alignas alignof as asm asm_fragment async attribute auto await become binding_array cast catch class co_await co_return co_yield coherent column_major common compile compile_fragment concept const_cast consteval constexpr constinit crate debugger decltype delete demote demote_to_helper do dynamic_cast enum explicit export extends extern external fallthrough filter final finally friend from fxgroup get goto groupshared highp impl implements import inline instanceof interface layout lowp macro macro_rules match mediump meta mod module move mut mutable namespace new nil noexcept noinline nointerpolation non_coherent noncoherent noperspective null nullptr of operator package packoffset partition pass patch pixelfragment precise precision premerge priv protected pub public readonly ref regardless register reinterpret_cast require resource restrict self set shared sizeof smooth snorm static static_assert static_cast std subroutine super target template this thread_local throw trait try type typedef typeid typename typeof union unless unorm unsafe unsized use using varying virtual volatile wgsl where writeonly yield',
);

/** GLSL ES 3.00 keywords and reserved words (spec §3.6), including the desktop-only ones it reserves. */
const GLSL_KEYWORDS = words(
    'const uniform buffer shared attribute varying coherent volatile restrict readonly writeonly atomic_uint layout centroid flat smooth noperspective patch sample break continue do for while switch case default if else subroutine in out inout float double int void bool true false invariant precise discard return struct lowp mediump highp precision ' +
        'mat2 mat3 mat4 mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4 vec2 vec3 vec4 ivec2 ivec3 ivec4 bvec2 bvec3 bvec4 uvec2 uvec3 uvec4 dvec2 dvec3 dvec4 uint ' +
        'dmat2 dmat3 dmat4 dmat2x2 dmat2x3 dmat2x4 dmat3x2 dmat3x3 dmat3x4 dmat4x2 dmat4x3 dmat4x4 sampler3DRect ' +
        'sampler2D sampler3D samplerCube sampler2DShadow samplerCubeShadow sampler2DArray sampler2DArrayShadow isampler2D isampler3D isamplerCube isampler2DArray usampler2D usampler3D usamplerCube usampler2DArray ' +
        'common partition active asm class union enum typedef template this resource goto inline noinline public static extern external interface long short half fixed unsigned superp input output hvec2 hvec3 hvec4 fvec2 fvec3 fvec4 filter sizeof cast namespace using ' +
        'image1D image2D image3D imageCube iimage1D iimage2D iimage3D iimageCube uimage1D uimage2D uimage3D uimageCube image1DArray image2DArray iimage1DArray iimage2DArray uimage1DArray uimage2DArray imageBuffer iimageBuffer uimageBuffer ' +
        'sampler1D sampler1DShadow sampler1DArray sampler1DArrayShadow isampler1D isampler1DArray usampler1D usampler1DArray sampler2DRect sampler2DRectShadow isampler2DRect usampler2DRect ' +
        'samplerBuffer isamplerBuffer usamplerBuffer sampler2DMS isampler2DMS usampler2DMS sampler2DMSArray isampler2DMSArray usampler2DMSArray ' +
        // Not in the spec's list, but WebKit's compiler rejects them as reserved words.
        'packed row_major',
);

/**
 * Built-in function names in either language. A local variable may legally shadow one, but that makes
 * every later call to it in the same scope a compile error, so they are treated as taken.
 */
const BUILTIN_FNS = words(
    'radians degrees sin cos tan asin acos atan atan2 sinh cosh tanh asinh acosh atanh pow exp log exp2 log2 sqrt inversesqrt inverseSqrt abs sign floor trunc round roundEven ceil fract mod modf min max clamp mix step smoothstep saturate isnan isinf ' +
        'floatBitsToInt floatBitsToUint intBitsToFloat uintBitsToFloat bitcast packSnorm2x16 unpackSnorm2x16 packUnorm2x16 unpackUnorm2x16 packHalf2x16 unpackHalf2x16 pack4x8snorm pack4x8unorm unpack4x8snorm unpack4x8unorm pack2x16float unpack2x16float ' +
        'length distance dot cross normalize faceforward reflect refract fma ldexp frexp countOneBits reverseBits firstLeadingBit firstTrailingBit extractBits insertBits ' +
        'matrixCompMult outerProduct transpose determinant inverse lessThan lessThanEqual greaterThan greaterThanEqual equal notEqual any all not select arrayLength ' +
        'textureSize texture textureProj textureLod textureOffset texelFetch texelFetchOffset textureProjOffset textureLodOffset textureProjLod textureProjLodOffset textureGrad textureGradOffset textureProjGrad textureProjGradOffset textureGather emitVertex endPrimitive ' +
        'textureSample textureSampleLevel textureSampleBias textureSampleGrad textureSampleCompare textureSampleCompareLevel textureLoad textureStore textureDimensions textureNumLayers textureNumLevels textureNumSamples ' +
        'dFdx dFdy fwidth dpdx dpdy dpdxCoarse dpdyCoarse dpdxFine dpdyFine ' +
        'atomicAdd atomicSub atomicMax atomicMin atomicAnd atomicOr atomicXor atomicStore atomicLoad atomicExchange atomicCompareExchangeWeak workgroupBarrier storageBarrier textureBarrier',
);

/**
 * Names the emitters themselves put in scope: the entry points, the stage I/O struct locals, the
 * compute builtin parameters, and the `gl_*` family GLSL predeclares.
 */
const EMITTER_GLOBALS = words(
    'main vs_main fs_main cs_main input output VertexInput VertexOutput FragmentInput FragmentOutput ' +
        'global_id local_id local_index workgroup_id num_workgroups computeIndex ' +
        'gl_Position gl_PointSize gl_FragCoord gl_FragDepth gl_FrontFacing gl_PointCoord gl_VertexID gl_InstanceID gl_FragColor gl_FragData',
);

/** Identifiers no allocated name may take, on either backend. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
    ...WGSL_KEYWORDS,
    ...GLSL_KEYWORDS,
    ...BUILTIN_FNS,
    ...EMITTER_GLOBALS,
]);

/**
 * The identifiers taken within one emission scope — a shader entry point, or one DSL function body.
 * Holds only what that scope claimed; {@link RESERVED_NAMES} is consulted alongside it rather than
 * copied into it, since a scope is created per stage AND per function body.
 *
 * Scope tracking is deliberately flat: a CSE temp can be hoisted to the body top from inside a block,
 * so a name freed at the end of a block would not actually be free. Two sibling loops therefore get
 * `i` and `i_1` rather than both taking `i`.
 */
export type NameScope = Set<string>;

/** A fresh, empty scope. */
export function createNameScope(): NameScope {
    return new Set();
}

/** Mark a name as already in scope (a binding, a parameter, a function). Never renames it. */
export function reserveName(scope: NameScope, name: string): void {
    scope.add(name);
}

/** `preferred` if free, else `preferred_1`, `preferred_2`, … — and the result is now taken. */
export function allocName(scope: NameScope, preferred: string): string {
    const base = sanitizeIdentifier(preferred);
    if (!scope.has(base) && !RESERVED_NAMES.has(base)) {
        scope.add(base);
        return base;
    }
    for (let n = 1; ; n++) {
        const candidate = `${base}_${n}`;
        if (!scope.has(candidate) && !RESERVED_NAMES.has(candidate)) {
            scope.add(candidate);
            return candidate;
        }
    }
}

/** Longest identifier a derived (non-user-supplied) name may reach before being cut. */
const MAX_DERIVED_LENGTH = 28;

/** Strip anything not valid in a shader identifier and make sure the result cannot start with a digit. */
export function sanitizeIdentifier(name: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_');
    if (cleaned === '' || cleaned === '_') return 'v';
    return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

const BINARY_OP_WORD: Record<string, string> = {
    '+': 'add',
    '-': 'sub',
    '*': 'mul',
    '/': 'div',
    '%': 'mod',
    '<': 'lt',
    '>': 'gt',
    '<=': 'le',
    '>=': 'ge',
    '==': 'eq',
    '!=': 'ne',
    '&&': 'and',
    '||': 'or',
    '&': 'bitAnd',
    '|': 'bitOr',
    '^': 'bitXor',
    '<<': 'shl',
    '>>': 'shr',
};

/**
 * Name to give a common-subexpression temp, derived from what the node computes: the callee for a
 * call, the operation for an operator, the type for a constructor. Always `_`-prefixed, which both
 * marks it as emitter-generated and keeps it clear of every keyword and built-in.
 */
export function cseBaseName(rawNode: Node<d.Any>): string {
    const node = rawNode as AnyNode;
    let base: string;
    switch (node.kind) {
        case NodeKind.Call:
            base = node.fn;
            break;
        case NodeKind.BinaryOp:
            base = BINARY_OP_WORD[node.op] ?? 'op';
            break;
        case NodeKind.Construct:
            base = node.type.wgslType;
            break;
        case NodeKind.Field:
            // A swizzle (`.xyz`) says nothing about the value; anything else is a real field name.
            base = /^[xyzwrgba]{1,4}$/.test(node.fieldName) ? 'swizzle' : node.fieldName;
            break;
        case NodeKind.Index:
            base = 'elem';
            break;
        case NodeKind.Conditional:
            base = 'sel';
            break;
        case NodeKind.Array:
            base = 'arr';
            break;
        case NodeKind.Wgsl:
            base = 'inline';
            break;
        default:
            base = 'v';
    }
    base = sanitizeIdentifier(base);
    // `FxaaSample` → `fxaaSample`: emitter temps read as values, not as the types/functions they came from.
    if (/^[A-Z]/.test(base)) base = base[0].toLowerCase() + base.slice(1);
    return `_${base.slice(0, MAX_DERIVED_LENGTH)}`;
}

/**
 * Name for a sampler with no label, from what actually distinguishes it. Samplers dedupe on their
 * settings and several textures share one, so naming it after a texture would mislead; its filter is
 * the thing a reader wants to know at the sample site.
 */
export function derivedSamplerName(sampler: { minFilter: string; magFilter: string }): string {
    const filter = sampler.minFilter === sampler.magFilter ? sampler.minFilter : `${sampler.minFilter}${sampler.magFilter}`;
    return `${filter}Sampler`;
}

/** Conventional counter names by nesting depth, so the common single/double loop reads as `i` / `j`. */
const LOOP_VAR_NAMES = ['i', 'j', 'k', 'l'];

/** Preferred loop-counter name for a nesting depth (the allocator resolves any collision). */
export function loopVarName(depth: number): string {
    return LOOP_VAR_NAMES[depth] ?? 'i';
}

/**
 * The DSL functions a traced body calls, in first-encounter order. Both emitters use this to emit
 * definitions callees-first: GLSL requires declaration before use, and WGSL — which permits any
 * module-scope order — reads the same way for free.
 *
 * Returns the function NODES, not just their names, because a callee reached only through another
 * body may not be in the emitter's function table yet — the caller can register it from this.
 */
export function tracedFnCallees(traced: TracedFn): FnNode<d.Any>[] {
    const callees: FnNode<d.Any>[] = [];
    const seen = new Set<number>();
    const walk = (rawNode: Node<d.Any>): void => {
        const node = rawNode as AnyNode;
        if (seen.has(node.id)) return;
        seen.add(node.id);
        if (node.kind === NodeKind.Call) {
            const fnNode = (node as CallNode<d.Any>).fnNode;
            if (fnNode) callees.push(fnNode);
        }
        for (const child of getChildren(node)) walk(child);
    };
    walk(traced.body);
    walk(traced.output);
    return callees;
}
