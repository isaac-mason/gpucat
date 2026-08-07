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
import type { CompileSlots, Discovery, SamplerEntry, TextureEntry, UniformGroupBlock } from '../../builder';
import type { AttributeNode } from '../../lib/attribute';
import { type FnNode, type Node, type PrivateVarNode, type StackNode, type StructDef, type WgslFunctionNodeRef } from '../../lib/core';
import { SamplerNode, type TextureBindingNode, type TextureNode } from '../../lib/texture';
import type { UniformGroup, UniformNode } from '../../lib/uniform';
import type { VaryingNode } from '../../lib/varying';
import type { TracedFn } from '../wgsl/emit';
type ShaderStage = 'vertex' | 'fragment';
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
    uniforms: Map<string, {
        node: UniformNode<d.Any>;
        group: UniformGroup;
    }>;
    usageCount: Map<number, number>;
    mutatedNodes: Set<number>;
    privateVars: Map<number, PrivateVarNode<d.Any>>;
    fnDefs: Map<string, {
        fn: FnNode<d.Any>;
        traced: TracedFn;
    }>;
    rawFnDefs: Map<string, WgslFunctionNodeRef>;
    structDefs: Map<string, StructDef<StructSchema>>;
    textures: Map<string, TextureBindingNode>;
    textureSamplers: Map<string, SamplerNode<d.sampler | d.samplerComparison>>;
    flipYTextures: Set<string>;
    storageMirrors: Map<number, StorageMirror>;
    /** Cache of storage-mirror data-texture ids (derived from `storageMirrors`), built once on first
     *  lookup. Storage mirrors are populated before emission and never change, so this is safe to memo. */
    storageMirrorTextureIds?: Set<string>;
    attributes: Map<number, {
        shaderName: string;
        type: d.Any;
        location: number;
        node: AttributeNode<d.Any>;
    }>;
    varyings: Map<string, {
        node: VaryingNode<d.Any>;
        vertexExpr: string;
    }>;
    builtins: Set<string>;
    nodeVars: Map<number, string>;
    varCounter: number;
    indentLevel: number;
    code: string[];
    hoistBuffer: string[];
    hoistedIds: Set<number>;
    paramIds: Set<number>;
};
export declare function createGlslContext(stage: ShaderStage, discovery: Discovery): GlslBuildContext;
/**
 * Emit GLSL `struct <Name> { <type> <field>; … };` declarations for every struct discovered in the
 * graph. discover() populates ctx.structDefs in topological order (nested dependencies first), so a
 * plain iteration already emits nested structs before the structs that use them — GLSL requires a
 * struct to be declared before it is referenced. Member types are scalar/vec/mat via glslType, or a
 * nested struct's name; fixed-size array members use GLSL's `<elemType> <field>[<N>]` array syntax.
 */
export declare function emitGlslStructs(ctx: GlslBuildContext): string;
/**
 * Emit std140 UBO blocks, one per named uniform group. Mirrors emitAllBindings in the WGSL emitter:
 * groups are sorted by UniformGroup.order and the resulting index is the sorted array position.
 * Each group becomes `layout(std140) uniform <Block> { <members> } uniforms_<group>;`.
 */
export declare function emitGlslUniformBlocks(ctx: GlslBuildContext): {
    glsl: string;
    uniformBlocks: UniformGroupBlock[];
};
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
export declare function emitGlslTextures(ctx: GlslBuildContext): {
    glsl: string;
    textures: TextureEntry[];
    samplers: SamplerEntry[];
};
/**
 * Emit GLSL global declarations for module-scope PrivateVar nodes: `<type> <name>[= <init>];`. GLSL
 * has no `var<private>` — a per-invocation module-scope variable is just a plain global. Initializers
 * must be const-expressions (literals / constructors), like the WGSL emitter requires.
 */
export declare function emitGlslModuleScopeVars(ctx: GlslBuildContext): string;
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
export declare function emitGlslRawFunctions(ctx: GlslBuildContext, allow?: Set<WgslFunctionNodeRef>): string;
/**
 * The DSL Fn names and raw (wgslFn/glslFn) functions reachable from a stage's root nodes, transitively
 * through called Fn bodies. Functions are emitted PER STAGE from this set (see the builder assembly) so
 * a Fn used only in the fragment stage — and possibly using a fragment-only feature (derivatives,
 * discard, gl_FragCoord) — is never emitted into the vertex shader (where it would fail to compile), and
 * is traced in its actual stage's context. Roots may include nulls (absent slots) for convenience.
 */
export declare function collectStageFns(ctx: GlslBuildContext, roots: (Node<d.Any> | null | undefined)[]): {
    dsl: Set<string>;
    raw: Set<WgslFunctionNodeRef>;
};
export declare function emitGlslDslFunctions(ctx: GlslBuildContext, allow?: Set<string>): string;
export declare function collectGlslVaryings(roots: Node<d.Any>[], ctx: GlslBuildContext): void;
export declare function generateGlslVertexShader(slots: CompileSlots, ctx: GlslBuildContext): string;
/**
 * A single captured-varying output of a transform-feedback kernel.
 */
export type TransformFeedbackOutput = {
    name: string;
    varyingName: string;
    type: d.Any;
    expr: string;
};
/**
 * Emit the transform-feedback vertex shader body (main() + attribute/varying declarations) into a
 * fresh GLSL sub-context that shares the parent's discovered facts. Returns the generated `void main`
 * body plus the ordered output metadata (for the caller to assemble the module + feedbackVaryings).
 *
 * The kernel body IS the vertex main(): the traced statements run, each output varying is assigned
 * `v_<name> = <expr>;`, and a dummy `gl_Position = vec4(0.0);` is written so the program links.
 */
export declare function generateGlslTransformFeedbackShader(ctx: GlslBuildContext, body: StackNode, outputs: {
    name: string;
    expr: Node<d.Any>;
}[]): {
    main: string;
    attributes: {
        shaderName: string;
        type: d.Any;
        location: number;
    }[];
    outputs: TransformFeedbackOutput[];
};
export declare function generateGlslFragmentShader(fragmentNode: Node<d.Any> | null, ctx: GlslBuildContext, varyings: Map<string, {
    node: VaryingNode<d.Any>;
    vertexExpr: string;
}>, depthNode?: Node<d.Any> | null): string;
export {};
