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
import { type FnNode, type Node } from '../lib/core';
import type { TracedFn } from './wgsl/emit';
/** Identifiers no allocated name may take, on either backend. */
export declare const RESERVED_NAMES: ReadonlySet<string>;
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
export declare function createNameScope(): NameScope;
/** Mark a name as already in scope (a binding, a parameter, a function). Never renames it. */
export declare function reserveName(scope: NameScope, name: string): void;
/** `preferred` if free, else `preferred_1`, `preferred_2`, … — and the result is now taken. */
export declare function allocName(scope: NameScope, preferred: string): string;
/** Strip anything not valid in a shader identifier and make sure the result cannot start with a digit. */
export declare function sanitizeIdentifier(name: string): string;
/**
 * Name to give a common-subexpression temp, derived from what the node computes: the callee for a
 * call, the operation for an operator, the type for a constructor. Always `_`-prefixed, which both
 * marks it as emitter-generated and keeps it clear of every keyword and built-in.
 */
export declare function cseBaseName(rawNode: Node<d.Any>): string;
/**
 * Name for a sampler with no label, from what actually distinguishes it. Samplers dedupe on their
 * settings and several textures share one, so naming it after a texture would mislead; its filter is
 * the thing a reader wants to know at the sample site.
 */
export declare function derivedSamplerName(sampler: {
    minFilter: string;
    magFilter: string;
}): string;
/** Preferred loop-counter name for a nesting depth (the allocator resolves any collision). */
export declare function loopVarName(depth: number): string;
/**
 * The DSL functions a traced body calls, in first-encounter order. Both emitters use this to emit
 * definitions callees-first: GLSL requires declaration before use, and WGSL — which permits any
 * module-scope order — reads the same way for free.
 *
 * Returns the function NODES, not just their names, because a callee reached only through another
 * body may not be in the emitter's function table yet — the caller can register it from this.
 */
export declare function tracedFnCallees(traced: TracedFn): FnNode<d.Any>[];
