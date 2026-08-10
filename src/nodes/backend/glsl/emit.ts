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

import { layoutAlignOf, layoutSizeOf, layoutStrideOf, structFieldLayout } from '../../../schema/pack';
import type { StructSchema } from '../../../schema/schema';
import * as d from '../../../schema/schema';
import type { CompileSlots, Discovery, SamplerEntry, TextureEntry, UniformGroupBlock, UniformMember } from '../../builder';
import { type AnyNode, getChildren } from '../../graph';
import type { AttributeNode } from '../../lib/attribute';
import type { BuiltinNode } from '../../lib/builtin';
import {
    type CallNode,
    type FnNode,
    type IfNode,
    type IndexNode,
    isNode,
    type LoopNode,
    type Node,
    NodeKind,
    type ParameterNode,
    type PrivateVarNode,
    type StackNode,
    type StructDef,
    u32,
    type WgslFunctionNodeRef,
} from '../../lib/core';
import type { MRTNode } from '../../lib/mrt';
import {
    type ArrayTextureNode,
    type CubeTextureNode,
    type DepthTextureNode,
    decodeField,
    SamplerNode,
    type TextureBindingNode,
    type TextureNode,
} from '../../lib/texture';
import type { UniformGroup, UniformNode } from '../../lib/uniform';
import type { VaryingNode } from '../../lib/varying';
import type { TracedFn } from '../wgsl/emit';

type ShaderStage = 'vertex' | 'fragment';

/**
 * Translate a schema descriptor's WGSL type to its GLSL ES 3.00 equivalent by reading the schema's
 * `glslType` companion. Only the subset the GLSL backend can translate (scalars, float/int/uint
 * vectors, square float matrices) carries a `glslType`; everything else (f16 variants, bool vectors,
 * textures, samplers, arrays, standalone structs) leaves it off, so this throws for them — a missing
 * mapping surfaces loudly, exactly as the old WGSL_TO_GLSL map did.
 */
function glslType(desc: d.Any): string {
    if (!('glslType' in desc)) {
        throw new Error(`[glsl] type '${desc.wgslType}' not yet supported in the GLSL emitter`);
    }
    return desc.glslType;
}

/**
 * Component scalar kind of a scalar/vector WGSL type, or null for matrices/structs/arrays (which have
 * no single component kind for operand coercion). Used to detect and repair mixed-type binary ops:
 * GLSL ES 3.00 forbids implicit int/uint/float mixing, so an operand whose component kind differs from
 * the operation's type must be wrapped in an explicit conversion constructor (mirrors three.js's
 * OperatorNode operand coercion via `format`).
 */
/** Component kind (f32/i32/u32/bool) of a scalar/vector descriptor, read straight off its `scalar` field.
 *  null for f16 and for matrices/composites — the GLSL backend never routes those through the scalar and
 *  operator-coercion paths, and f16 has no GLSL ES 3.00 form. */
function glslScalarKind(desc: d.Any): 'f32' | 'i32' | 'u32' | 'bool' | null {
    // Gate on `len` (scalars/vectors only): matrices carry `scalar` too but must stay null here, since
    // this feeds the scalar/operator paths a matrix never takes. f16 has no GLSL ES 3.00 form.
    if (!('len' in desc) || desc.scalar === 'f16') return null;
    return desc.scalar;
}

/** Component count (1 for scalars, 2..4 for vectors) of a scalar/vector descriptor, or null otherwise. */
function glslVecLen(desc: d.Any): 1 | 2 | 3 | 4 | null {
    return 'len' in desc ? desc.len : null;
}

/** True for a bool VECTOR (vecN<bool>) — the result of a componentwise comparison and the condition of a
 *  vector select. GLSL routes both to bvec-specific forms (built-in relational fns / componentwise ternary). */
function isBoolVec(desc: d.Any): boolean {
    return 'len' in desc && desc.scalar === 'bool' && desc.len > 1;
}

/** GLSL constructor name for a given length + component kind (e.g. len 3 + i32 → `ivec3`). */
function glslCtorFor(len: 1 | 2 | 3 | 4, scalar: 'f32' | 'i32' | 'u32' | 'bool'): string {
    const prefix = scalar === 'f32' ? '' : scalar === 'i32' ? 'i' : scalar === 'u32' ? 'u' : 'b';
    if (len === 1) return scalar === 'f32' ? 'float' : scalar === 'i32' ? 'int' : scalar === 'u32' ? 'uint' : 'bool';
    return `${prefix}vec${len}`;
}

/**
 * Wrap an operand expression in a component-kind conversion if it differs from `target`, preserving the
 * operand's own vector length (so `vec3f * i32` coerces the scalar to `float`, not to `vec3`). Returns
 * the expression unchanged when kinds already match or the operand is not a plain scalar/vector.
 */
function coerceOperandScalar(node: Node<d.Any>, expr: string, target: 'f32' | 'i32' | 'u32'): string {
    const kind = glslScalarKind(node.type);
    if (kind === null || kind === target) return expr;
    const len = glslVecLen(node.type);
    if (len === null) return expr;
    return `${glslCtorFor(len, target)}(${expr})`;
}

/**
 * Interpolation qualifier for a GLSL varying declaration, derived from the same `interpolationType` /
 * `interpolationSampling` the WGSL emitter reads. Returns a leading-space qualifier ('flat ' /
 * 'centroid ') or '' for the perspective-correct default. The SAME qualifier must be emitted on the
 * vertex `out` and the fragment `in` for the program to link.
 *
 * Integer-typed varyings are FORCED to `flat` even when unset — GLSL ES 3.00 rejects a non-flat integer
 * varying (the program will not link), matching the WGSL side's @interpolate(flat) requirement. The
 * integer test is descriptor-derived (via {@link glslScalarKind}) so any integer scalar/vector type is
 * covered without maintaining a hand-written name list.
 */
function glslVaryingQualifier(node: VaryingNode<d.Any>): string {
    const scalarKind = glslScalarKind(node.type);
    const isInteger = scalarKind === 'i32' || scalarKind === 'u32';
    const interp = node.interpolationType;
    // 'linear' maps to `noperspective`, which is NOT part of GLSL ES 3.00 (desktop GLSL only) — reject
    // rather than silently perspective-interpolate.
    if (interp === 'linear') {
        throw new Error(
            `[glsl] varying '${node.name ?? ''}' uses linear (noperspective) interpolation, which is not supported on the WebGL2 backend`,
        );
    }
    // Integer varyings are illegal in GLSL ES 3.00 without `flat` (the program won't link), so force it
    // regardless of interpolationType. `flat` has no interpolation, so a sampling qualifier is
    // meaningless alongside it.
    if (interp === 'flat' || isInteger) return 'flat ';
    // Sampling qualifier (only meaningful for interpolated varyings). GLSL ES 3.00 has `centroid`;
    // `sample` (sample-rate shading) is ES 3.20+ and rejected. 'center'/'either'/unset are the default.
    const sampling = node.interpolationSampling;
    if (sampling === 'sample') {
        throw new Error(
            `[glsl] varying '${node.name ?? ''}' uses 'sample' interpolation (sample-rate shading), which is GLSL ES 3.20+ and not supported on the WebGL2 backend`,
        );
    }
    if (sampling === 'centroid') return 'centroid ';
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
    // Type-constructor conversions (f32(x) -> float(x), vec3u(...) -> uvec3(...)) are NOT listed here:
    // generateCall resolves them straight from the target descriptor's `glslType` field (a constructor
    // call is spelled with its result type's WGSL name), so this table holds only genuine builtin renames.
    // Derivative builtins: WGSL spells them dpdx/dpdy; GLSL ES 3.00 uses dFdx/dFdy. fwidth is spelled
    // the same in both, listed for clarity. (The coarse/fine variants have no GLSL ES 3.00 form and
    // are rejected in generateCall below.)
    dpdx: 'dFdx',
    dpdy: 'dFdy',
    fwidth: 'fwidth',
    // WGSL math builtins whose GLSL ES 3.00 spelling differs (same args, just renamed) — emitting the
    // WGSL name verbatim is a "no matching function" compile error otherwise. NOTE: the integer bit
    // builtins (countOneBits/reverseBits/firstLeadingBit/firstTrailingBit → bitCount/bitfieldReverse/
    // findMSB/findLSB) are GLSL ES 3.10 / desktop-4.0 only, NOT WebGL2's ES 3.00, so they are rejected
    // in generateCall rather than renamed (they'd fail to compile).
    atan2: 'atan', // GLSL's 2-arg atan(y, x) IS atan2
    inverseSqrt: 'inversesqrt',
    // WGSL and GLSL agree on the remaining common math builtins; further overrides go here.
};

/**
 * WGSL coarse/fine derivative variants have no GLSL ES 3.00 equivalent (that language exposes only the
 * plain dFdx/dFdy/fwidth). Emitting the bare name would produce an un-compilable shader, so the GLSL
 * emitter rejects them with a clear error rather than degrade silently.
 */
const UNSUPPORTED_DERIVATIVES = new Set(['dpdxCoarse', 'dpdyCoarse', 'fwidthCoarse', 'dpdxFine', 'dpdyFine', 'fwidthFine']);

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

    // Vector / matrix literal: constructor of the GLSL type with per-component literals. Component kind
    // and GLSL type name both come from the schema descriptor (its `scalar` + `glslType` fields) instead
    // of parsing the wgslType suffix. Unknown / GLSL-untranslatable types have no `glslType`, so this
    // throws — matching the old WGSL_TO_GLSL miss. Matrix and float/bool/f16 vector components format as
    // f32 literals; only integer vectors take i32/u32.
    const desc = d.descFromWgslType(wgslType);
    if (!('glslType' in desc)) {
        throw new Error(`[glsl] literal of type '${wgslType}' not yet supported in the GLSL emitter`);
    }
    const elemScalar = 'scalar' in desc && (desc.scalar === 'i32' || desc.scalar === 'u32') ? desc.scalar : 'f32';
    const components = value.map((v) => scalar(elemScalar, v));
    return `${desc.glslType}(${components.join(', ')})`;
}

/**
 * A read-only storage() buffer bound AS a texture for WebGL (which has no SSBO). `base` is a synthetic
 * sampler-less `TextureNode` whose binding carries the `GpuBuffer` itself (`storageBufferSource`); the
 * renderer reinterprets the buffer's bytes as rgba32uint texels. `width` is the texel width (for row
 * addressing), baked into the emitted texelFetch coordinates.
 */
export type StorageMirror = {
    base: TextureNode<d.FlatSampledTexture>;
    /** runtime texel-row width (`textureSize(base,0).x`), cached so CSE hoists the one `textureSize`
     *  call. Storage addressing uses this instead of a baked width, so value- and name-based storage
     *  compile to identical GLSL. */
    widthNode: Node<d.u32>;
};

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
    // Texture ids whose 2D samples are wrapped in the per-texture flipY conditional (`u_flipY_<id>`). This
    // is the two-level flip three.js does in TextureNode.setupUV: PRESENCE is baked per-backend (only this
    // GLSL emitter emits the wrap, the analog of three.js's compile-time `builder.isFlipY()` gate, so
    // WebGPU shaders never carry it), and ACTIVATION is a runtime per-draw uniform the renderer sets from
    // the bound texture's isRenderTargetTexture (the analog of three.js's `_flipYUniform.value`). WebGL's
    // bottom-left framebuffer origin flips the V order of a texture that was rendered into vs WebGPU.
    flipYTextures: Set<string>;
    /** Which flip HELPER functions (`_flipY2f`/`_flipY2i`/`_flipYd`) were actually referenced this stage,
     *  so only those are emitted (a shader that only `.sample()`s shouldn't carry the texelFetch/grad ones). */
    flipHelperFns: Set<string>;

    // Read-only storage() buffers reinterpreted as rgba32uint mirror textures (WebGL has no SSBO).
    // Keyed by StorageNode id → the mirror's base texture node + its texel width, so a `storage[i].field`
    // read lowers to the same `decodeField` path as `texture(t).load(schema, i)`. Populated by compileGlsl.
    storageMirrors: Map<number, StorageMirror>;
    /** Cache of storage-mirror data-texture ids (derived from `storageMirrors`), built once on first
     *  lookup. Storage mirrors are populated before emission and never change, so this is safe to memo. */
    storageMirrorTextureIds?: Set<string>;

    // Per-stage emission scratch.
    attributes: Map<number, { shaderName: string; type: d.Any; location: number; node: AttributeNode<d.Any> }>;
    varyings: Map<string, { node: VaryingNode<d.Any>; vertexExpr: string }>;
    builtins: Set<string>;
    nodeVars: Map<number, string>;
    varCounter: number;
    // Indentation level for nested control flow (1 = main body, 2 = first nested block, …).
    indentLevel: number;
    code: string[];
    // CSE locals hoisted to the FUNCTION-BODY TOP (see the CSE hoist in generateExpr). A multi-use node
    // first materialized inside a nested block but also read outside it would leak out of GLSL's block
    // scope; when the node depends only on always-in-scope inputs it is instead declared here, at the
    // top of the body, and its id recorded in hoistedIds so dependents can chain onto it safely. Both
    // are per-function (reset for each Fn sub-context) and prepended to `code` at body assembly.
    hoistBuffer: string[];
    hoistedIds: Set<number>;
    // Ids of the enclosing function's PARAMETERS — declared in the signature, so in scope from the
    // first body line. A loop index is ALSO a ParameterNode but is block-scoped (declared in the `for`
    // header), so kind alone can't tell them apart; only params registered here are top-hoist-safe.
    paramIds: Set<number>;
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
        flipYTextures: new Set(),
        flipHelperFns: new Set(),
        // Populated once by compileGlsl (shared across stages) — see storage() read-lowering.
        storageMirrors: new Map(),
        attributes: new Map(),
        varyings: new Map(),
        builtins: new Set(),
        nodeVars: new Map(),
        varCounter: 0,
        indentLevel: 1,
        code: [],
        hoistBuffer: [],
        hoistedIds: new Set(),
        paramIds: new Set(),
    };
}

/** Guard: reject node kinds outside this slice with a clear, uniform error. */
function unsupported(kind: string): never {
    throw new Error(`[glsl] ${kind} not yet supported in the GLSL emitter`);
}

/* expression generation */

/**
 * A resolved storage() read to lower: one field of an rgba32uint mirror texture, addressed exactly like
 * `texture(t).load(schema, i)`. `matchStorageRead` produces it; `lowerStorageRead` emits it. Splitting
 * "is this a storage read?" from "emit it" keeps each half small and independently testable.
 */
type StorageReadMatch = {
    base: TextureNode<d.FlatSampledTexture>;
    texelBase: Node<d.u32>;
    width: Node<d.u32>;
    byteOffset: number;
    type: d.Any;
};

/** The mirror texture for `idx`'s array, iff that array is a read-only storage buffer we've lowered. */
function storageMirrorOf(ctx: GlslBuildContext, idxNode: IndexNode<d.Any>): StorageMirror | null {
    const arr = idxNode.array as AnyNode;
    if (arr.kind !== NodeKind.Storage) return null;
    return ctx.storageMirrors.get(arr.id) ?? null;
}

/** Whether `id` is a storage-mirror data texture (a read-only `storage()` buffer lowered to a data
 *  texture). These hold uploaded linear data, never a rendered-into image, so their texelFetch reads
 *  must NOT get the render-target V-flip — and flipping by textureId would also make value- vs
 *  name-based storage emit divergent GLSL. The id set is memoized on the context (see the field doc). */
function isStorageMirrorTexture(ctx: GlslBuildContext, id: string): boolean {
    let ids = ctx.storageMirrorTextureIds;
    if (ids === undefined) {
        ids = new Set();
        for (const mirror of ctx.storageMirrors.values()) ids.add(mirror.base.bindingNode.textureId);
        ctx.storageMirrorTextureIds = ids;
    }
    return ids.has(id);
}

/**
 * Detection only: is `node` a read from a lowered read-only storage buffer? Handles `storage[i].field`
 * (a struct member, leaf-first) and bare `storage[i]` of any element type — scalar/vec/matrix or a whole
 * struct (which `decodeField` assembles into a struct constructor). Returns the resolved field to decode,
 * or null. No emission, no side effects — the caller decides whether/how to lower.
 */
function matchStorageRead(ctx: GlslBuildContext, node: AnyNode): StorageReadMatch | null {
    if (node.kind === NodeKind.Field) {
        const obj = node.object as AnyNode;
        if (obj.kind !== NodeKind.Index) return null;
        const idxNode = obj as IndexNode<d.Any>;
        const mirror = storageMirrorOf(ctx, idxNode);
        if (!mirror) return null;
        const elementSchema = idxNode.type; // IndexNode.type = the array element (the struct)
        if (!d.isStructDesc(elementSchema)) return null;
        const layout = structFieldLayout(elementSchema as unknown as d.StructDesc);
        const f = layout.fields.find((ff) => ff.name === node.fieldName);
        if (!f) return null;
        return {
            base: mirror.base,
            texelBase: storageTexelBase(idxNode.index, layout.texelStride),
            width: mirror.widthNode,
            byteOffset: f.byteOffset,
            type: f.type,
        };
    }
    if (node.kind === NodeKind.Index) {
        const idxNode = node as IndexNode<d.Any>;
        const mirror = storageMirrorOf(ctx, idxNode);
        if (!mirror) return null;
        // Any element type, struct or scalar/vec/matrix: a struct element read whole (materialized to
        // a var, or CSE-hoisted) decodes to a struct constructor via `decodeField`. Same texel-stride
        // formula for both (a struct's stride is a whole number of 16-byte texels). `storage[i].field`
        // is still resolved leaf-first by the Field case above; this is the bare-element fallback.
        const elementSchema = idxNode.type;
        const texelStride = Math.ceil(layoutStrideOf(elementSchema, 'std430') / 16);
        return {
            base: mirror.base,
            texelBase: storageTexelBase(idxNode.index, texelStride),
            width: mirror.widthNode,
            byteOffset: 0,
            type: elementSchema,
        };
    }
    return null;
}

/** Emit a matched storage read through the same `decodeField` path as `texture(t).load(schema, i)`. */
function lowerStorageRead(ctx: GlslBuildContext, m: StorageReadMatch): string {
    return generateExpr(ctx, decodeField(m.base, m.texelBase, m.width, m.byteOffset, m.type));
}

function storageTexelBase(indexNode: Node<d.Any>, texelStride: number): Node<d.u32> {
    const idx = u32(indexNode);
    return texelStride === 1 ? idx : idx.mul(u32(texelStride));
}

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
            let left = generateExpr(ctx, node.left);
            let right = generateExpr(ctx, node.right);
            // Operand coercion: GLSL ES 3.00 has no implicit numeric conversions, so a mixed-kind binary
            // op (int with uint, int/uint with float) is a hard compile error unless one side is wrapped
            // in an explicit conversion. Shifts are exempt — GLSL allows a differing-kind shift amount —
            // and comparisons/arithmetic coerce to the common kind (float wins; else the result kind).
            const leftKind = glslScalarKind(node.left.type);
            const rightKind = glslScalarKind(node.right.type);
            const isShift = node.op === '<<' || node.op === '>>';
            if (!isShift && leftKind && rightKind && leftKind !== rightKind && leftKind !== 'bool' && rightKind !== 'bool') {
                const target =
                    leftKind === 'f32' || rightKind === 'f32'
                        ? 'f32'
                        : ((glslScalarKind(node.type) as 'i32' | 'u32' | null) ?? 'i32');
                left = coerceOperandScalar(node.left, left, target);
                right = coerceOperandScalar(node.right, right, target);
            }
            // Componentwise vector comparisons: GLSL ES rejects the relational/equality OPERATORS on
            // vectors and instead provides built-in functions returning a bvec. Detect via the result
            // type being a bool vector (`vecN<bool>`); scalar comparisons keep the operator.
            const glslFn = VEC_COMPARE_FN[node.op];
            if (glslFn && isBoolVec(node.type)) {
                expr = `${glslFn}(${left}, ${right})`;
            } else if (node.op === '%' && node.type.wgslType.includes('f32')) {
                // GLSL ES 3.00 `%` is integer-only; the float remainder is the `mod()` builtin (WGSL/TSL
                // allow `%` on floats). Result type is f32/vecN<f32> ⇒ route to mod().
                expr = `mod(${left}, ${right})`;
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
            const storageRead = matchStorageRead(ctx, node);
            if (storageRead) {
                expr = lowerStorageRead(ctx, storageRead);
                break;
            }
            const obj = generateExpr(ctx, node.object);
            expr = `${obj}.${node.fieldName}`;
            break;
        }
        case NodeKind.Index: {
            const storageRead = matchStorageRead(ctx, node);
            if (storageRead) {
                expr = lowerStorageRead(ctx, storageRead);
                break;
            }
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
            //  - vector bool cond, FLOAT result (componentwise select) → `mix(f, t, cond)`: GLSL ES
            //    3.00's genType `mix(x, y, genBType a)` picks per component (a ? y : x). This overload
            //    exists ONLY for float genType in ES 3.00 — the int/uint/bool bvec-selector mix was added
            //    in ES 3.20, so an integer-vector select must expand to a componentwise ternary instead.
            const condIsVec = isBoolVec(node.condition.type);
            const resultScalar = glslScalarKind(node.type);
            if (condIsVec && resultScalar !== 'f32') {
                // Integer/uint/bool componentwise select. Hoist the three operands to temps (each is read
                // once per component, and may carry side effects / be expensive) then build the vector.
                const len = glslVecLen(node.type);
                if (len === null || len === 1 || resultScalar === null) {
                    unsupported(`componentwise select producing '${node.type.wgslType}'`);
                }
                const ind = '    '.repeat(ctx.indentLevel);
                const cv = `_sc${ctx.varCounter++}`;
                const tv = `_st${ctx.varCounter++}`;
                const fv = `_sf${ctx.varCounter++}`;
                const ifFalse = node.ifFalse;
                if (!ifFalse) unsupported(`componentwise select of '${node.type.wgslType}' without an ifFalse value`);
                ctx.code.push(`${ind}${glslLocalDecl(node.condition.type, cv)} = ${generateExpr(ctx, node.condition)};`);
                ctx.code.push(`${ind}${glslLocalDecl(node.type, tv)} = ${generateExpr(ctx, node.ifTrue)};`);
                ctx.code.push(`${ind}${glslLocalDecl(node.type, fv)} = ${generateExpr(ctx, ifFalse)};`);
                const comps = ['x', 'y', 'z', 'w'].slice(0, len).map((c) => `(${cv}.${c} ? ${tv}.${c} : ${fv}.${c})`);
                expr = `${glslCtorFor(len, resultScalar)}(${comps.join(', ')})`;
                break;
            }
            const cond = generateExpr(ctx, node.condition);
            const t = generateExpr(ctx, node.ifTrue);
            // A missing ifFalse only has a well-defined zero for scalar/vec/mat numeric types; struct and
            // array results have no `T(0)` form, so reject rather than emit un-compilable GLSL. (In
            // practice select() always carries an ifFalse — this guards the degenerate graph.)
            let f: string;
            if (node.ifFalse) {
                f = generateExpr(ctx, node.ifFalse);
            } else if (d.isStructDesc(node.type) || d.isSizedArrayDesc(node.type)) {
                unsupported(
                    `select without an ifFalse value producing '${node.type.wgslType}' (no zero literal for struct/array)`,
                );
            } else {
                f = `${glslType(node.type)}(0)`;
            }
            expr = condIsVec ? `mix(${f}, ${t}, ${cond})` : `(${cond} ? ${t} : ${f})`;
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
        const decl = glslLocalDecl(node.type, varName);
        // A CSE local first materialized inside a nested block (indentLevel > 1) but read again outside
        // it would be out of GLSL block scope. When the value depends ONLY on always-in-scope inputs
        // (params/uniforms/attributes/varyings/builtins/literals + already-top-hoisted locals), declare
        // it at the FUNCTION-BODY TOP instead so every use — inside or outside the block — resolves. A
        // value that reaches a Var/Let/loop index cannot be hoisted (its input is block-scoped), so it
        // stays at the current indent, exactly as before.
        if (ctx.indentLevel > 1 && isTopHoistable(ctx, node)) {
            ctx.hoistBuffer.push(`    ${decl} = ${expr};`);
            ctx.hoistedIds.add(node.id);
        } else {
            // Mutated hoists must stay mutable; GLSL has no `let`/`const` distinction for this, so both
            // are plain typed locals (an immutable one could be `const` but a plain local is fine).
            const ind = '    '.repeat(ctx.indentLevel);
            ctx.code.push(`${ind}${decl} = ${expr};`);
        }
        ctx.nodeVars.set(node.id, varName);
        return varName;
    }

    return expr;
}

/**
 * Whether a CSE candidate can be hoisted to the FUNCTION-BODY TOP: true iff every leaf it depends on is
 * in scope from the function's first line. Always-in-scope leaves are parameters, uniforms, attributes,
 * varyings, builtins, literals, samplers/textures, and module-scope globals — plus any CSE local ALREADY
 * hoisted to the top (chained). Reaching a materialized local that is NOT top-hoisted (a Var/Let, a loop
 * index, or a block-level CSE local) means the value is block-scoped and must stay where it is.
 */
function isTopHoistable(ctx: GlslBuildContext, rawNode: Node<d.Any>): boolean {
    const seen = new Set<number>();
    const walk = (raw: Node<d.Any>): boolean => {
        const node = raw as AnyNode;
        // Safe references: an already-top-hoisted CSE local, or an enclosing-function parameter (both
        // in scope from the first body line). Checked BEFORE the nodeVars test because params live in
        // nodeVars too — as does a block-scoped loop index of the very same ParameterNode kind.
        if (ctx.hoistedIds.has(node.id) || ctx.paramIds.has(node.id)) return true;
        // Any other MATERIALIZED local is block-scoped and hoisting above it would escape scope: a
        // Var/Let, a loop index, or a CSE local kept at block level. (The hoist buffer sits above every
        // body statement, so even a base-level Var declared mid-body is unreachable from it.)
        if (ctx.nodeVars.has(node.id)) return false;
        if (seen.has(node.id)) return true;
        seen.add(node.id);
        switch (node.kind) {
            // Non-memoized leaves declared at the top of the shader — in scope from the first line.
            case NodeKind.Uniform:
            case NodeKind.Attribute:
            case NodeKind.Varying:
            case NodeKind.Builtin:
            case NodeKind.Literal:
            case NodeKind.Sampler:
            case NodeKind.TextureBinding:
            case NodeKind.PrivateVar:
                return true;
            default:
                for (const child of getChildren(node)) {
                    if (!walk(child)) return false;
                }
                return true;
        }
    };
    return walk(rawNode);
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
    'radians',
    'degrees',
    'sin',
    'cos',
    'tan',
    'asin',
    'acos',
    'atan',
    'sinh',
    'cosh',
    'tanh',
    'asinh',
    'acosh',
    'atanh',
    'pow',
    'exp',
    'log',
    'exp2',
    'log2',
    'sqrt',
    'inversesqrt',
    'abs',
    'sign',
    'floor',
    'trunc',
    'round',
    'roundEven',
    'ceil',
    'fract',
    'mod',
    'modf',
    'min',
    'max',
    'clamp',
    'mix',
    'step',
    'smoothstep',
    'isnan',
    'isinf',
    'floatBitsToInt',
    'floatBitsToUint',
    'intBitsToFloat',
    'uintBitsToFloat',
    'fma',
    'frexp',
    'ldexp',
    'packSnorm2x16',
    'unpackSnorm2x16',
    'packUnorm2x16',
    'unpackUnorm2x16',
    'packHalf2x16',
    'unpackHalf2x16',
    'length',
    'distance',
    'dot',
    'cross',
    'normalize',
    'faceforward',
    'reflect',
    'refract',
    'matrixCompMult',
    'outerProduct',
    'transpose',
    'determinant',
    'inverse',
    'lessThan',
    'lessThanEqual',
    'greaterThan',
    'greaterThanEqual',
    'equal',
    'notEqual',
    'any',
    'all',
    'not',
    'texture',
    'textureProj',
    'textureLod',
    'textureOffset',
    'texelFetch',
    'texelFetchOffset',
    'textureProjOffset',
    'textureLodOffset',
    'textureProjLod',
    'textureProjLodOffset',
    'textureGrad',
    'textureGradOffset',
    'textureProjGrad',
    'textureProjGradOffset',
    'textureSize',
    'textureGather',
    'dFdx',
    'dFdy',
    'fwidth',
    'emitVertex',
    'endPrimitive',
    // Keywords / reserved words.
    'const',
    'uniform',
    'buffer',
    'shared',
    'attribute',
    'varying',
    'coherent',
    'volatile',
    'restrict',
    'readonly',
    'writeonly',
    'layout',
    'centroid',
    'flat',
    'smooth',
    'noperspective',
    'patch',
    'sample',
    'break',
    'continue',
    'do',
    'for',
    'while',
    'switch',
    'case',
    'default',
    'if',
    'else',
    'in',
    'out',
    'inout',
    'float',
    'int',
    'void',
    'bool',
    'true',
    'false',
    'invariant',
    'precise',
    'discard',
    'return',
    'mat2',
    'mat3',
    'mat4',
    'vec2',
    'vec3',
    'vec4',
    'ivec2',
    'ivec3',
    'ivec4',
    'bvec2',
    'bvec3',
    'bvec4',
    'uint',
    'uvec2',
    'uvec3',
    'uvec4',
    'lowp',
    'mediump',
    'highp',
    'precision',
    'sampler2D',
    'sampler3D',
    'samplerCube',
    'struct',
    'main',
    // GLSL ES 3.00 reserved-for-future-use words — illegal as identifiers even though unused.
    'input',
    'output',
    'filter',
    'sizeof',
    'cast',
    'namespace',
    'using',
    'common',
    'partition',
    'active',
    'asm',
    'class',
    'union',
    'enum',
    'typedef',
    'template',
    'this',
    'resource',
    'goto',
    'inline',
    'noinline',
    'public',
    'static',
    'extern',
    'external',
    'interface',
    'long',
    'short',
    'double',
    'half',
    'fixed',
    'unsigned',
    'superp',
    'hvec2',
    'hvec3',
    'hvec4',
    'dvec2',
    'dvec3',
    'dvec4',
    'fvec2',
    'fvec3',
    'fvec4',
    'sampler1D',
    'sampler1DShadow',
    'sampler2DRectShadow',
    'row_major',
    'packed',
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

    // Named attributes (geometry inputs like `uv`) are declared ONCE per (name, offset, stride): several
    // distinct `attribute('uv')` nodes referencing the SAME logical input (same name + view) must share one
    // `layout(location=N) in` decl, else GLSL redefines `in a_uv` and fails to compile. But same-NAME
    // attributes at DIFFERENT offsets are DISTINCT interleaved inputs (e.g. posU@0 and normalV@16 sharing
    // one 32-byte-stride buffer): they must get distinct locations, matching vertexBufferGroups. Aliasing
    // them by name alone collapses both to offset 0, so the second's data (which the VAO binds to its own
    // location) is silently dropped by the shader. Unnamed/buffer attributes stay deduped by id.
    let sameNameSeen = false;
    if (node.isNamedReference && node.name) {
        for (const entry of ctx.attributes.values()) {
            if (!entry.node.isNamedReference || entry.node.name !== node.name) continue;
            sameNameSeen = true;
            if (entry.node.offset === node.offset && entry.node.stride === node.stride) {
                ctx.attributes.set(node.id, entry);
                return entry.shaderName;
            }
        }
    }

    // Next location counts DISTINCT attributes (distinct locations), not aliased map entries — aliasing
    // multiple node ids to one entry would make `ctx.attributes.size` overcount.
    const location = distinctAttributeCount(ctx);
    // Prefix with `a_` so attribute names never collide with GLSL keywords or varyings. When a same-named
    // but distinct-offset attribute already exists, suffix with the location to keep the `in` decls unique
    // (the VAO binds by layout(location), so this identifier is cosmetic).
    const shaderName =
        node.isNamedReference && node.name
            ? sameNameSeen
                ? `a_${node.name}_${location}`
                : `a_${node.name}`
            : `a_buf_${location}`;
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
            //
            // Canonical orientation in gpucat is WebGPU's TOP-LEFT origin. gl_FragCoord.y is BOTTOM-up
            // on WebGL, so we flip it here (against the current render target height,
            // `u_fragCoordFlipHeight`, set per pass by the renderer) so @builtin(position) / screenUV /
            // any raw fragCoord read matches WebGPU. Without it a screen-space sample of a render target
            // (post-process, avatar/studio compositing) comes out mirrored — see the `screen-orient-*`
            // webgl-render cases.
            //
            // This DELIBERATELY differs from three.js, whose node system keeps the WebGL-native
            // bottom-left origin and flips the *WebGPU* side instead (getFragCoord returns raw
            // gl_FragCoord; ScreenNode flips when isFlipY()). We flip WebGL because WebGPU is the
            // primary path (zero overhead there), and flipping fragCoord globally — not just screenUV —
            // keeps EVERY position read backend-consistent. Do not "align with three.js" by removing
            // this; it would re-mirror every render-to-texture-then-present. The expression stays inline
            // (not a main() local) so it is valid inside emitted user Fn scopes too — gl_FragCoord and
            // the uniform are both GLSL globals. Declared by generateGlslFragmentShader when used.
            if (ctx.stage === 'fragment')
                return '(vec4(gl_FragCoord.x, u_fragCoordFlipHeight - gl_FragCoord.y, gl_FragCoord.z, gl_FragCoord.w))';
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
    // NDC depth → stored [0,1]. WebGL NDC z is [-1,1] (NO projection), so remap; WGSL passes through.
    if (node.fn === 'ndcDepthToStorage' && args.length === 1) return `((${args[0]}) * 0.5 + 0.5)`;

    if (UNSUPPORTED_DERIVATIVES.has(node.fn)) {
        throw new Error(
            `[glsl] ${node.fn} (coarse/fine derivative) is not supported on the WebGL2 backend; use dpdx/dpdy/fwidth`,
        );
    }

    // bitcast<T>(x): bit-reinterpret. WGSL spells it `bitcast<T>`; GLSL ES 3.00 uses type-directed
    // builtins for float↔int/uint (uintBitsToFloat / floatBitsToUint / intBitsToFloat / floatBitsToInt)
    // and plain int()/uint() for the (same-width) int↔uint reinterpret. Target T is in the fn name; the
    // source type comes from the single argument.
    const bc = node.fn.match(/^bitcast<(f32|u32|i32)>$/);
    if (bc && args.length === 1) {
        const to = bc[1];
        const from = (node.args[0] as { type: { wgslType: string } }).type.wgslType;
        if (to === 'f32') return `${from === 'i32' ? 'intBitsToFloat' : 'uintBitsToFloat'}(${args[0]})`;
        if (to === 'u32') return `${from === 'f32' ? 'floatBitsToUint' : 'uint'}(${args[0]})`;
        return `${from === 'f32' ? 'floatBitsToInt' : 'int'}(${args[0]})`; // to === 'i32'
    }

    // Packed unpack builtins. WGSL has all natively; GLSL ES 3.00 has the 2×16 family (renamed) but
    // NOT the 4×8 family — those are emulated with shift/mask. Component 0 is in the LOW bits,
    // matching the CPU encode (pack.ts `packedWriteExpr`).
    if (node.fn === 'unpack2x16float') return `unpackHalf2x16(${args[0]})`;
    if (node.fn === 'unpack2x16unorm') return `unpackUnorm2x16(${args[0]})`;
    if (node.fn === 'unpack2x16snorm') return `unpackSnorm2x16(${args[0]})`;
    if (node.fn === 'unpack4x8unorm') {
        const p = args[0];
        return `(vec4(uvec4(${p}&0xFFu,(${p}>>8u)&0xFFu,(${p}>>16u)&0xFFu,(${p}>>24u)&0xFFu))/255.0)`;
    }
    if (node.fn === 'unpack4x8snorm') {
        const p = args[0];
        return `max(vec4(ivec4(int(${p}<<24u)>>24,int(${p}<<16u)>>24,int(${p}<<8u)>>24,int(${p})>>24))/127.0,vec4(-1.0))`;
    }

    // Integer bit-count/scan builtins are GLSL ES 3.10+ / desktop-4.0 only — WebGL2 is ES 3.00, which
    // has no bitCount/bitfieldReverse/findMSB/findLSB. Reject with a clear message rather than emit a
    // name the driver won't resolve (would fail as an opaque "no matching function"). A polyfill could
    // be added if a material ever needs them.
    if (ES300_UNAVAILABLE_FNS.has(node.fn)) {
        throw new Error(
            `[glsl] '${node.fn}' has no GLSL ES 3.00 (WebGL2) builtin — the integer bit-count/scan ` +
                `functions are ES 3.10+ / desktop-only; not yet supported on the WebGL backend (needs a polyfill)`,
        );
    }

    // A type-constructor call (f32(x), vec3u(...), mat3x3f(...)) is spelled with the WGSL type name and
    // produces that type; emit the GLSL type name from the descriptor's `glslType` companion. Types with
    // no GLSL form (e.g. f16 vectors) lack `glslType` and fall through to the rename table / verbatim.
    if (node.fn === node.type.wgslType && 'glslType' in node.type) {
        return `${node.type.glslType}(${args.join(', ')})`;
    }

    const fn = CALL_RENAMES[node.fn] ?? node.fn;
    return `${fn}(${args.join(', ')})`;
}

/** WGSL builtins with no GLSL ES 3.00 (WebGL2) counterpart — rejected clearly in generateCall. */
const ES300_UNAVAILABLE_FNS = new Set(['countOneBits', 'reverseBits', 'firstLeadingBit', 'firstTrailingBit']);

/**
 * Implicit-LOD sampling. GLSL ES 3.00's `texture()` (and its bias overload) derives the mip level from
 * screen-space derivatives, which exist ONLY in the fragment stage — calling it in a vertex shader is a
 * compile error. The vertex stage has no implicit LOD, so fall back to an explicit `textureLod(…, 0.0)`
 * at the base level (mirrors three.js's GLSLNodeBuilder). Any bias is dropped in the vertex stage since
 * it has no meaning without implicit derivatives.
 */
function implicitSample(ctx: GlslBuildContext, name: string, coord: string, bias?: string): string {
    if (ctx.stage === 'vertex') return `textureLod(${name}, ${coord}, 0.0)`;
    return bias !== undefined ? `texture(${name}, ${coord}, ${bias})` : `texture(${name}, ${coord})`;
}

/**
 * Translate a WGSL texture free function to its GLSL combined-sampler form. The first arg is the
 * TextureBindingNode; sampling variants carry a SamplerNode as the second arg (dropped in GLSL —
 * its settings live in the combined-sampler metadata instead).
 */
function generateTextureCall(ctx: GlslBuildContext, node: CallNode<d.Any>): string {
    const rawArgs = node.args as AnyNode[];

    // textureGather's signature puts the component index FIRST (component, t, s, coords[, offset]); every
    // other builtin has the TextureBindingNode as arg 0. Resolve the binding position per builtin.
    const bindingIndex = node.fn === 'textureGather' ? 1 : 0;
    const binding = rawArgs[bindingIndex];
    if (!binding || binding.kind !== NodeKind.TextureBinding) {
        unsupported(`texture builtin '${node.fn}' whose texture argument is not a texture binding`);
    }
    const tex = binding as TextureBindingNode;

    // Register the texture; comparison samplers become the combined sampler's runtime settings.
    const samplerArg = rawArgs[bindingIndex + 1];
    const sampler = samplerArg && samplerArg.kind === NodeKind.Sampler ? (samplerArg as SamplerNode) : null;
    const name = registerTexture(ctx, tex, sampler);

    // Render-target V-flip — the SAME shared helper `generateTexture` uses. The free-function texture
    // builtins (notably `textureSampleCompare`, the only comparison/shadow entry point) must honor it too
    // or an RT texture sampled via a builtin comes out V-mirrored vs one sampled via `.sample()`.
    const f = textureFlip(ctx, tex);

    const restFrom = (i: number) => rawArgs.slice(i).map((a) => generateExpr(ctx, a));

    // A GLSL texture*Offset offset argument MUST be a constant expression. Accept only literal / const-
    // constructor nodes and reject anything the emitter can't prove constant (a clear error beats a
    // driver-side "not a constant expression").
    const constOffset = (i: number): string => {
        const off = rawArgs[i];
        if (off.kind !== NodeKind.Construct && off.kind !== NodeKind.Literal) {
            throw new Error(
                `[glsl] texture sampling offset must be a constant expression on the WebGL backend (got ${off.constructor.name})`,
            );
        }
        return generateExpr(ctx, off);
    };

    // NOTE: the render-target V-flip lives in `generateTexture` (the `.sample()`/`.load()` path), the
    // analog of three.js's `TextureNode.setupUV`. These low-level WGSL texture BUILTIN calls are not
    // flip-wrapped, matching three.js (its raw builtins bypass `setupUV` too).
    switch (node.fn) {
        case 'textureSample': {
            // (t, s, coords [, offset]) → texture(name, coords) — or textureLod at level 0 in the vertex
            // stage (no implicit derivatives there). With a const offset → textureOffset / textureLodOffset.
            const coords = f.uv(generateExpr(ctx, rawArgs[2]));
            if (rawArgs.length > 3) {
                const off = constOffset(3);
                return ctx.stage === 'vertex'
                    ? `textureLodOffset(${name}, ${coords}, 0.0, ${off})`
                    : `textureOffset(${name}, ${coords}, ${off})`;
            }
            return implicitSample(ctx, name, coords);
        }
        case 'textureSampleLevel': {
            const coords = f.uv(generateExpr(ctx, rawArgs[2]));
            const level = generateExpr(ctx, rawArgs[3]);
            if (rawArgs.length > 4) return `textureLodOffset(${name}, ${coords}, ${level}, ${constOffset(4)})`;
            return `textureLod(${name}, ${coords}, ${level})`;
        }
        case 'textureSampleBias': {
            // Bias only applies in the fragment stage; the vertex stage samples level 0.
            const coords = f.uv(generateExpr(ctx, rawArgs[2]));
            const bias = generateExpr(ctx, rawArgs[3]);
            if (rawArgs.length > 4) {
                const off = constOffset(4);
                return ctx.stage === 'vertex'
                    ? `textureLodOffset(${name}, ${coords}, 0.0, ${off})`
                    : `textureOffset(${name}, ${coords}, ${off}, ${bias})`;
            }
            return implicitSample(ctx, name, coords, bias);
        }
        case 'textureSampleGrad': {
            const [rawCoords, rawDdx, rawDdy] = restFrom(2);
            // Flip the uv and, under an active flip, negate the gradients' Y (v→1-v inverts dv/dscreen).
            const coords = f.uv(rawCoords);
            const ddx = f.grad(rawDdx);
            const ddy = f.grad(rawDdy);
            if (rawArgs.length > 5) return `textureGradOffset(${name}, ${coords}, ${ddx}, ${ddy}, ${constOffset(5)})`;
            return `textureGrad(${name}, ${coords}, ${ddx}, ${ddy})`;
        }
        case 'textureSampleCompare': {
            // (t, s, coords, depthRef [, offset]) → texture(shadowSampler, vec3(coords, depthRef)).
            const coords = f.uv(generateExpr(ctx, rawArgs[2]));
            const depthRef = generateExpr(ctx, rawArgs[3]);
            if (rawArgs.length > 4) return `textureOffset(${name}, vec3(${coords}, ${depthRef}), ${constOffset(4)})`;
            return `texture(${name}, vec3(${coords}, ${depthRef}))`;
        }
        case 'textureSampleCompareLevel': {
            // (t, s, coords, depthRef, level [, offset]) → shadow sample at an explicit LOD. Depth level
            // is i32; GLSL textureLod takes a float lod.
            const coords = f.uv(generateExpr(ctx, rawArgs[2]));
            const depthRef = generateExpr(ctx, rawArgs[3]);
            const level = `float(${generateExpr(ctx, rawArgs[4])})`;
            if (rawArgs.length > 5) return `textureLodOffset(${name}, vec3(${coords}, ${depthRef}), ${level}, ${constOffset(5)})`;
            return `textureLod(${name}, vec3(${coords}, ${depthRef}), ${level})`;
        }
        case 'textureGather':
        case 'textureGatherCompare': {
            // textureGather / textureGatherOffset / textureGatherCompare are GLSL ES 3.10 (and desktop
            // 4.0) builtins — WebGL2 is GLSL ES 3.00, where they do not exist. Emitting the call is a
            // hard "no matching overloaded function" compile error, so reject with a clear message (the
            // real-WebGL2 harness confirms the driver has no such overload).
            throw new Error(
                `[glsl] ${node.fn} is a GLSL ES 3.10 builtin with no GLSL ES 3.00 form; not supported on the WebGL2 backend`,
            );
        }
        case 'textureLoad': {
            // (t, coords, level) → texelFetch(name, ivec2(coords), level).
            const coords = generateExpr(ctx, rawArgs[1]);
            const level = rawArgs[2] ? generateExpr(ctx, rawArgs[2]) : '0';
            const coordExpr = f.texel(`ivec2(${coords})`, `textureSize(${name}, ${level}).y`);
            return `texelFetch(${name}, ${coordExpr}, ${level})`;
        }
        case 'textureDimensions': {
            // WGSL textureDimensions(t [, level:u32]) → vec{2,3}<u32>; GLSL textureSize(sampler, int) →
            // ivec{2,3}. textureSize requires a level (default 0), and its lod is int — a u32 level would
            // find no overload. Cast the lod to int, and the ivec result back to the node's u32 vector
            // type so downstream `.x`/`% `/`/ ` stay unsigned.
            const level = rawArgs[1] ? `int(${generateExpr(ctx, rawArgs[1])})` : '0';
            return `${glslType(node.type)}(textureSize(${name}, ${level}))`;
        }
        case 'textureNumLayers': {
            // Array layer count = the z of the array texture's dimensions. textureSize on a 2D-array
            // sampler returns ivec3(w, h, layers); cast the layer count to the node's u32 result.
            return `uint(textureSize(${name}, 0).z)`;
        }
        case 'textureNumLevels': {
            // No GLSL ES 3.00 form: the mip-count query (GL_TEXTURE_IMAGE_SIZE / textureQueryLevels) is
            // desktop GLSL 4.30+ only. Reject rather than emit an un-compilable call.
            throw new Error(`[glsl] textureNumLevels has no GLSL ES 3.00 builtin and is not supported on the WebGL2 backend`);
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

/** Per-texture flipY uniform name (a `bool` the renderer sets from the bound texture's render-target flag). */
function flipUniformName(textureId: string): string {
    return `u_flipY_${textureId}`.replace(/_{2,}/g, '_');
}

/**
 * Whether a texture's 2D samples should be wrapped in the flipY conditional. Only plain and depth 2D
 * textures can be render targets sampled with a 2D uv where a V flip is meaningful; cube / array / 3D
 * sampling uses a direction or layer, so they are left alone.
 */
function textureNeedsFlip(binding: TextureBindingNode): boolean {
    const type = binding.type.type;
    return type === 'texture_2d' || type === 'texture_depth_2d';
}

/**
 * The render-target V-flip for one texture binding, resolved once — the SINGLE source of truth every
 * texture-read generator routes coordinates through, so the flip rule can't drift between paths. (It
 * drifted before: `.sample()` flipped but the free-function builtins, `textureSampleCompare`, and plain
 * depth reads did not, so a shadow map sampled via the compare builtin came out V-mirrored vs one
 * sampled via `.sample()`.) `flip` is true only for a render-target-capable 2D / 2D-depth texture that
 * isn't a storage mirror; the wrappers emit the same `_flipY2f`/`_flipY2i`/`_flipYd` the renderer gates
 * at runtime via `u_flipY_<id>` (= isRenderTargetTexture), so they are no-ops for ordinary textures.
 * (2D-array render targets are not flipped yet — an unexercised path; see generateArrayTexture.)
 */
function textureFlip(ctx: GlslBuildContext, binding: TextureBindingNode) {
    const flip = textureNeedsFlip(binding) && !isStorageMirrorTexture(ctx, binding.textureId);
    const name = flipUniformName(binding.textureId);
    const wrap = (fn: string, ...args: string[]): string => {
        ctx.flipYTextures.add(binding.textureId);
        ctx.flipHelperFns.add(fn); // only emit the helper functions actually referenced
        return `${fn}(${name}, ${args.join(', ')})`;
    };
    return {
        flip,
        /** Normalized uv → `1 - v`. */
        uv: (uvExpr: string): string => (flip ? wrap('_flipY2f', uvExpr) : uvExpr),
        /** Integer texelFetch coord → `h - y - 1`; caller passes the sampled-level height expression. */
        texel: (coordExpr: string, heightExpr: string): string => (flip ? wrap('_flipY2i', coordExpr, heightExpr) : coordExpr),
        /** A grad derivative's Y is negated under an active flip (`v → 1-v` flips `dv/dscreen`). */
        grad: (gradExpr: string): string => (flip ? wrap('_flipYd', gradExpr) : gradExpr),
    };
}

/**
 * GLSL ES 3.00 combined-sampler type for a texture descriptor. Picks the shape (`2D`/`Cube`/
 * `2DArray`/`2DShadow`) from the descriptor's dimensionality, and the sample-type prefix (`i`/`u`)
 * from an integer sampleType. Depth-compare samplers are `sampler*Shadow`. Anything the GLSL
 * emitter can't express throws a clear "not yet supported" error.
 */
function glslSamplerType(desc: d.Texture, isComparison: boolean): string {
    const type = desc.type;

    // Depth textures. A comparison sampler → shadow sampler; otherwise a plain float sampler (GLSL ES
    // 3.00 reads a depth texture through a regular sampler2D, returning depth in .r). The shape (2D /
    // 2D-array / cube) picks the matching shadow-or-plain sampler.
    if (d.isDepthTextureDesc(desc)) {
        switch (type) {
            case 'texture_depth_2d':
                return isComparison ? 'sampler2DShadow' : 'sampler2D';
            case 'texture_depth_2d_array':
                return isComparison ? 'sampler2DArrayShadow' : 'sampler2DArray';
            case 'texture_depth_cube':
                return isComparison ? 'samplerCubeShadow' : 'samplerCube';
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

    // WebGL's bottom-left framebuffer origin flips the V order of a texture that was RENDERED INTO vs
    // WebGPU's top-left, so 2D samples of a render-target texture flip V. PRESENCE is baked per-backend
    // (only this GLSL emitter emits the wrap; WebGPU never does), ACTIVATION is the runtime `u_flipY_<id>`
    // the renderer sets from the bound texture's isRenderTargetTexture. Routed through the shared
    // `textureFlip` helper so every texture-read path flips identically. Non-2D (cube/array/3D) never flip.
    const f = textureFlip(ctx, binding);

    // textureLoad → texelFetch (no sampler filtering).
    if (node.samplingMode === 'load') {
        if (!node.loadCoords) throw new Error(`[glsl] TextureNode '${id}' in load mode has no loadCoords`);
        const name = registerTexture(ctx, binding, null);
        const coords = generateExpr(ctx, node.loadCoords);
        const level = node.loadLevel ? generateExpr(ctx, node.loadLevel) : '0';
        // WGSL loadCoords are already integer (vec2i); wrap defensively for GLSL's ivec2 texelFetch.
        const coordExpr = f.texel(`ivec2(${coords})`, `textureSize(${name}, ${level}).y`);
        return `texelFetch(${name}, ${coordExpr}, ${level})`;
    }

    const name = registerTexture(ctx, binding, ensureSampler(node));

    if (!node.uvNode) throw new Error(`[glsl] TextureNode '${id}' has no uvNode. Use texture.sample(uv).`);
    const uv = f.uv(generateExpr(ctx, node.uvNode));

    // GLSL's texture() has no const-offset overload we support here — reject rather than drop it.
    if (node.offsetNode) throw new Error(`[glsl] texture sampling offset not yet supported in the GLSL emitter`);

    switch (node.samplingMode) {
        case 'grad': {
            if (!node.gradNode) throw new Error(`[glsl] TextureNode '${id}' in grad mode has no gradNode`);
            // Under an active V-flip the uv derivative's Y sign inverts, so flip the gradients too.
            const ddx = f.grad(generateExpr(ctx, node.gradNode[0]));
            const ddy = f.grad(generateExpr(ctx, node.gradNode[1]));
            return `textureGrad(${name}, ${uv}, ${ddx}, ${ddy})`;
        }
        case 'bias': {
            if (!node.biasNode) throw new Error(`[glsl] TextureNode '${id}' in bias mode has no biasNode`);
            return implicitSample(ctx, name, uv, generateExpr(ctx, node.biasNode));
        }
        case 'level': {
            if (!node.levelNode) throw new Error(`[glsl] TextureNode '${id}' in level mode has no levelNode`);
            return `textureLod(${name}, ${uv}, ${generateExpr(ctx, node.levelNode)})`;
        }
        default:
            return implicitSample(ctx, name, uv);
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
            return implicitSample(ctx, name, dir, generateExpr(ctx, node.biasNode));
        }
        case 'level': {
            if (!node.levelNode) throw new Error(`[glsl] CubeTextureNode '${id}' in level mode has no levelNode`);
            return `textureLod(${name}, ${dir}, ${generateExpr(ctx, node.levelNode)})`;
        }
        default:
            return implicitSample(ctx, name, dir);
    }
}

function generateDepthTexture(ctx: GlslBuildContext, node: DepthTextureNode): string {
    // A DepthTextureNode carries a REGULAR (non-comparison) sampler — its .sample()/.level()/.load()
    // surface is a plain depth READ, not a shadow compare (that goes through textureSampleCompare with
    // a comparison sampler). GLSL ES 3.00 reads a depth texture through a regular sampler2D, returning
    // the depth in .r, so bind a plain sampler (→ glslSamplerType picks `sampler2D`) and take `.x`.
    const binding = node.bindingNode;
    const id = binding.textureId;
    // A depth attachment is a render-target texture (bottom-up storage on WebGL), so a plain depth read
    // needs the same V-flip as a color read — otherwise `pass.getViewZNode()`/SSAO/DoF depth reads come
    // out vertically mirrored vs WebGPU. Same shared helper as every other path.
    const f = textureFlip(ctx, binding);

    if (node.samplingMode === 'load') {
        if (!node.loadCoords) throw new Error(`[glsl] DepthTextureNode '${id}' in load mode has no loadCoords`);
        const name = registerTexture(ctx, binding, null);
        const coords = generateExpr(ctx, node.loadCoords);
        const level = node.loadLevel ? generateExpr(ctx, node.loadLevel) : '0';
        const coordExpr = f.texel(`ivec2(${coords})`, `textureSize(${name}, ${level}).y`);
        return `texelFetch(${name}, ${coordExpr}, ${level}).x`;
    }

    const name = registerTexture(ctx, binding, node.samplerNode);
    const uv = f.uv(generateExpr(ctx, node.uvNode));
    if (node.offsetNode) throw new Error(`[glsl] depth-texture sampling offset not yet supported in the GLSL emitter`);

    if (node.samplingMode === 'level') {
        if (!node.levelNode) throw new Error(`[glsl] DepthTextureNode '${id}' in level mode has no levelNode`);
        // Depth level is i32; GLSL textureLod takes a float lod.
        return `textureLod(${name}, ${uv}, float(${generateExpr(ctx, node.levelNode)})).x`;
    }
    return `${implicitSample(ctx, name, uv)}.x`;
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
            return implicitSample(ctx, name, coord, generateExpr(ctx, node.biasNode));
        }
        case 'level': {
            if (!node.levelNode) throw new Error(`[glsl] ArrayTextureNode '${id}' in level mode has no levelNode`);
            return `textureLod(${name}, ${coord}, ${generateExpr(ctx, node.levelNode)})`;
        }
        default:
            return implicitSample(ctx, name, coord);
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
        // A shared group backs one buffer reused across materials (cached by its uniform set),
        // so its layout must be deterministic for a given set no matter the per-material traversal
        // order. Order by stable node id (mirrors the WGSL emit and three.js). Non-shared groups
        // keep declaration order.
        const orderedUniforms = entry.group.shared ? [...entry.uniforms].sort((a, b) => a.id - b.id) : entry.uniforms;
        for (const u of orderedUniforms) {
            // std140 offsets/sizes come from pack.ts — the single memory-layout authority.
            const align = layoutAlignOf(u.type, 'std140');
            const size = layoutSizeOf(u.type, 'std140');
            offset = Math.ceil(offset / align) * align;
            // glslLocalDecl (not glslType) so struct and fixed-size-array members declare correctly: a
            // struct member uses its name, and an array member uses GLSL's `<elem> <name>[N]` syntax
            // (sized-array descriptors have no scalar `glslType`, so glslType() would throw on them).
            lines.push(`    ${glslLocalDecl(u.type, u.name)};`);
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
    // Distinct GLSL sampler types declared → one `precision highp <type>;` default each (below).
    const samplerTypes = new Set<string>();

    let unit = 0;
    sortedGroups.forEach((entry, groupIndex) => {
        for (const binding of entry.textures) {
            const id = binding.textureId;
            const name = samplerUniformName(id);
            // A depth texture's GLSL sampler shape depends on whether a COMPARISON sampler is bound to
            // it (shadow sampler) or a regular one (plain sampler2D read).
            const isComparison = Boolean(ctx.textureSamplers.get(id)?.compare);
            const samplerType = glslSamplerType(binding.type, isComparison);
            samplerTypes.add(samplerType);
            // Bare declaration; the `precision highp <type>;` default block below qualifies it.
            lines.push(`uniform ${samplerType} ${name};`);
            // Per-texture flipY flag: set by the renderer from the bound texture's render-target status
            // (see the flipNorm/flipTexel wrap in generateTextureCall). Declared only for textures whose
            // 2D samples are wrapped, so ordinary textures pay nothing.
            if (ctx.flipYTextures.has(id)) lines.push(`uniform bool ${flipUniformName(id)};`);

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

    // Default precision per distinct sampler type, three.js-style (see its `defaultPrecisions`). GLSL ES
    // 3.00 gives a built-in default only to sampler2D/samplerCube in the VERTEX stage and none in the
    // FRAGMENT stage; sampler2DArray / sampler3D / cube-array / shadow / integer samplers have no default
    // and MUST be qualified. Both stages share these declarations (emitGlslTextures runs once), so a
    // single `precision highp <type>;` line per type keeps the `uniform …;` lines bare and lets a future
    // per-texture precision override inline. `highp` is always valid — and integer + storage-mirror
    // (usampler2D) samplers require it to hold 32-bit texels.
    const precisionDefaults = [...samplerTypes].map((t) => `precision highp ${t};`);

    // Render-target flipY helpers. Pure functions (the coord expression is passed as an argument and
    // evaluated exactly once), all no-op when the runtime flag is false (an ordinary, non-render-target
    // texture is bound). Only the helpers actually referenced this stage are emitted — a shader that
    // only `.sample()`s carries `_flipY2f` but not the texelFetch (`_flipY2i`) or grad (`_flipYd`) forms.
    const flipHelperDefs: Record<string, string> = {
        _flipY2f: 'vec2 _flipY2f(bool f, vec2 uv) { return f ? vec2(uv.x, 1.0 - uv.y) : uv; }', // uv → 1 - v
        _flipY2i: 'ivec2 _flipY2i(bool f, ivec2 c, int h) { return f ? ivec2(c.x, h - c.y - 1) : c; }', // texel → h-y-1
        _flipYd: 'vec2 _flipYd(bool f, vec2 g) { return f ? vec2(g.x, -g.y) : g; }', // grad Y sign under flip
    };
    // Fixed key order for deterministic output regardless of reference order.
    const flipHelpers = (['_flipY2f', '_flipY2i', '_flipYd'] as const).filter((fn) => ctx.flipHelperFns.has(fn)).map((fn) => flipHelperDefs[fn]);
    return { glsl: [...precisionDefaults, ...lines, ...flipHelpers].join('\n'), textures, samplers };
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
export function emitGlslRawFunctions(ctx: GlslBuildContext, allow?: Set<WgslFunctionNodeRef>): string {
    const lines: string[] = [];
    const emitted = new Set<string>();

    const emitOne = (fn: WgslFunctionNodeRef) => {
        if (!fn.glslCode) {
            throw new Error(`[glsl] this wgslFn/glslFn has no \`glsl\` variant; add one to run on the WebGL backend`);
        }
        if (emitted.has(fn.glslCode)) return;
        lines.push(fn.glslCode.trim());
        lines.push('');
        emitted.add(fn.glslCode);
    };

    for (const [, fn] of ctx.rawFnDefs) {
        // When `allow` is given (per-stage emission), skip raw fns not reachable in this stage — their
        // reachable includes are already in `allow` (collectStageFns walks includes transitively).
        if (allow && !allow.has(fn)) continue;
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

/**
 * The DSL Fn names and raw (wgslFn/glslFn) functions reachable from a stage's root nodes, transitively
 * through called Fn bodies. Functions are emitted PER STAGE from this set (see the builder assembly) so
 * a Fn used only in the fragment stage — and possibly using a fragment-only feature (derivatives,
 * discard, gl_FragCoord) — is never emitted into the vertex shader (where it would fail to compile), and
 * is traced in its actual stage's context. Roots may include nulls (absent slots) for convenience.
 */
export function collectStageFns(
    ctx: GlslBuildContext,
    roots: (Node<d.Any> | null | undefined)[],
): { dsl: Set<string>; raw: Set<WgslFunctionNodeRef> } {
    const dsl = new Set<string>();
    const raw = new Set<WgslFunctionNodeRef>();
    const seen = new Set<number>();
    const visitRaw = (fn: WgslFunctionNodeRef): void => {
        if (raw.has(fn)) return;
        raw.add(fn);
        for (const inc of fn.includes) visitRaw(inc);
    };
    const walk = (rawNode: Node<d.Any> | null | undefined): void => {
        if (!rawNode) return;
        const node = rawNode as AnyNode;
        if (seen.has(node.id)) return;
        seen.add(node.id);
        // A VaryingNode is the vertex/fragment cut: the fragment reads its interpolated value as an
        // `in`, it does not recompute the source. Stop here so fragment reachability never pulls in a
        // fn used only to PRODUCE a varying (that fn belongs to the vertex stage). Vertex reachability
        // descends into varyings by seeding their source nodes directly (see the builder).
        if (node.kind === NodeKind.Varying) return;
        if (node.kind === NodeKind.Call) {
            const call = node as CallNode<d.Any>;
            if (call.fnNode && !dsl.has(call.fnNode.fnName)) {
                dsl.add(call.fnNode.fnName);
                // Recurse into the fn body so its own callees (DSL and raw) are reached too.
                const traced = ctx.fnDefs.get(call.fnNode.fnName)?.traced ?? call.fnNode.trace();
                walk(traced.body);
                walk(traced.output);
            }
            if (call.wgslFnNode) visitRaw(call.wgslFnNode);
        }
        for (const child of getChildren(node)) walk(child);
    };
    for (const root of roots) walk(root);
    return { dsl, raw };
}

export function emitGlslDslFunctions(ctx: GlslBuildContext, allow?: Set<string>): string {
    const lines: string[] = [];

    // Emit definitions in dependency order (callees before callers) so GLSL's definition-before-use
    // rule is satisfied. Post-order DFS over the call graph; a `visiting` guard tolerates self/mutual
    // recursion (emits each fn once, best-effort order — GLSL would need a prototype for true mutual
    // recursion, which the DSL doesn't produce). When `allow` is given (per-stage emission), only fns
    // reachable in that stage are seeded — a fn used only in the other stage is never emitted here.
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
    for (const name of ctx.fnDefs.keys()) {
        if (allow && !allow.has(name)) continue;
        visit(name);
    }

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
            hoistBuffer: [],
            hoistedIds: new Set(),
            paramIds: new Set(),
        };

        // Register param names so parameter references resolve to them (and mark them top-hoist-safe).
        for (const p of traced.params as ParameterNode<d.Any>[]) {
            fnCtx.nodeVars.set(p.id, p.paramName ?? `p${p.paramIndex}`);
            fnCtx.paramIds.add(p.id);
        }

        for (const stmt of traced.body.body) generateStmt(fnCtx, stmt);

        const retType = fn.type.wgslType === 'void' ? 'void' : glslType(fn.type);
        // Generate the return-expr STRING BEFORE flushing fnCtx.code: evaluating the return expr can
        // append CSE decls (`_vN = ...;`) to fnCtx.code, and those must land inside the function body
        // (before the return). Flushing first would drop them, leaving `_vN` undeclared.
        const retExpr = fn.type.wgslType !== 'void' ? generateExpr(fnCtx, traced.output) : null;
        lines.push(`${retType} ${glslFnName(name)}(${params}) {`);
        lines.push(...fnCtx.hoistBuffer);
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
    lines.push(...ctx.hoistBuffer);
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
const IMPLICIT_LOD_TEXTURE_FNS = new Set([
    'textureSample',
    'textureSampleBias',
    'textureSampleCompare',
    'textureGather',
    'textureGatherCompare',
]);

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
                throw new Error(
                    `[transformFeedback] 'discard' is a fragment-only op and can't be used in a transform-feedback kernel.`,
                );
            case NodeKind.Storage:
                throw new Error(
                    `[transformFeedback] storage() buffers are not part of the transform-feedback DSL; ` +
                        `use named attribute inputs / captured-varying outputs (or a WebGPU compute() for scatter/atomics).`,
                );
            case NodeKind.StorageTextureBinding:
                throw new Error(`[transformFeedback] storage textures are not supported in a transform-feedback kernel.`);
            case NodeKind.WorkgroupVar:
                throw new Error(
                    `[transformFeedback] workgroup variables are compute-only and can't be used in a transform-feedback kernel.`,
                );
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
                    throw new Error(
                        `[transformFeedback] '${call.fn}()' is compute-only and can't be used in a transform-feedback kernel.`,
                    );
                }
                if (call.fn.startsWith('atomic')) {
                    throw new Error(
                        `[transformFeedback] atomics ('${call.fn}') are not part of the transform-feedback DSL; use a WebGPU compute().`,
                    );
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
    // otherwise) — the same rule as render varyings, derived from the descriptor's scalar kind.
    for (const out of outputMeta) {
        const scalarKind = glslScalarKind(out.type);
        const flat = scalarKind === 'i32' || scalarKind === 'u32' ? 'flat ' : '';
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
    lines.push(...ctx.hoistBuffer);
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
    let mrtOutputs: { name: string; location: number; expr: string; type: string }[] | null = null;
    let colorExpr = '';
    if (mrtNode) {
        mrtOutputs = [];
        if (mrtNode.members.length > 0) {
            // Resolved members: the array index is the @location.
            for (let i = 0; i < mrtNode.members.length; i++) {
                const member = mrtNode.members[i];
                if (!member) continue; // sparse array possible
                const name = mrtNode._resolvedNames[i] || `output_${i}`;
                mrtOutputs.push({
                    name: glslOutputName(name),
                    location: i,
                    expr: generateExpr(ctx, member),
                    type: glslType(member.type),
                });
            }
        } else {
            // Unresolved: fall back to declaration order of the named outputs.
            let loc = 0;
            for (const name in mrtNode.outputNodes) {
                const member = mrtNode.outputNodes[name];
                mrtOutputs.push({
                    name: glslOutputName(name),
                    location: loc,
                    expr: generateExpr(ctx, member),
                    type: glslType(member.type),
                });
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
        // One `out <type>` per render target. The type comes from the member node (vec4 for a color
        // target, but ivec4/uvec4 for an integer G-buffer target), not a hardcoded vec4.
        for (const { name, location, type } of mrtOutputs) {
            lines.push(`layout(location = ${location}) out ${type} ${name};`);
        }
        lines.push('');
    } else if (hasColor) {
        lines.push('layout(location = 0) out vec4 fragColor;');
        lines.push('');
    }
    // @builtin(position) lowers to a Y-flipped gl_FragCoord (see generateBuiltin 'position'); declare
    // the render-target height uniform it reads when the builtin is used. The renderer sets it to the
    // framebuffer height each pass.
    if (ctx.builtins.has('position')) {
        lines.push('uniform highp float u_fragCoordFlipHeight;');
        lines.push('');
    }
    // A depth-only fragment stage (no color output) declares no `out` — it only writes gl_FragDepth.
    lines.push('void main() {');
    lines.push(...ctx.hoistBuffer);
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
