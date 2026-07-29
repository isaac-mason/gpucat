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
import type { TracedFn } from '../wgsl/emit';
import type { AttributeNode } from '../../lib/attribute';
import { type FnNode, type Node, type PrivateVarNode, type StructDef, type WgslFunctionNodeRef } from '../../lib/core';
import { SamplerNode, type TextureBindingNode } from '../../lib/texture';
import type { UniformGroup, UniformNode } from '../../lib/uniform';
import type { VaryingNode } from '../../lib/varying';
type ShaderStage = 'vertex' | 'fragment';
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
export declare function emitGlslRawFunctions(ctx: GlslBuildContext): string;
export declare function emitGlslDslFunctions(ctx: GlslBuildContext): string;
export declare function collectGlslVaryings(roots: Node<d.Any>[], ctx: GlslBuildContext): void;
export declare function generateGlslVertexShader(slots: CompileSlots, ctx: GlslBuildContext): string;
export declare function generateGlslFragmentShader(fragmentNode: Node<d.Any>, ctx: GlslBuildContext, varyings: Map<string, {
    node: VaryingNode<d.Any>;
    vertexExpr: string;
}>): string;
export {};
