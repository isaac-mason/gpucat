import type * as d from '../../schema/schema';
import { Node, NodeKind } from './core';
/**
 * Inline raw-shader expression node.
 *
 * Used for embedding raw WGSL and/or GLSL expressions with node dependencies.
 * Each source string uses $0, $1, etc. as placeholders for `deps` (same deps,
 * same ordering, for both backends). The active backend picks its own source;
 * the emitter throws if the source for that backend is absent.
 *
 * @example
 * const expr = new WgslNode(d.f32, 'dot($0, $1)', [a, b]);
 * // WGSL: dot(a_expr, b_expr)
 */
export declare class WgslNode<D extends d.Any> extends Node<D> {
    /** Raw WGSL source with $0/$1 placeholders. Undefined for GLSL-only nodes. */
    readonly wgsl: string | undefined;
    readonly deps: Node<d.Any>[];
    /** Raw GLSL source with $0/$1 placeholders (companion). Undefined for WGSL-only nodes. */
    readonly glsl?: string | undefined;
    readonly kind = NodeKind.Wgsl;
    constructor(type: D, 
    /** Raw WGSL source with $0/$1 placeholders. Undefined for GLSL-only nodes. */
    wgsl: string | undefined, deps: Node<d.Any>[], 
    /** Raw GLSL source with $0/$1 placeholders (companion). Undefined for WGSL-only nodes. */
    glsl?: string | undefined);
    /**
     * Returns a new WgslNode with additional unreferenced deps appended.
     * Useful for pulling nodes into the graph (e.g. varyings) without
     * emitting them in the expression string.
     */
    with(...extra: Node<d.Any>[]): WgslNode<D>;
    /**
     * Attach a GLSL companion expression so this node also compiles on the WebGL
     * backend. The companion is a tagged template whose interpolations MUST be the
     * same dep nodes (any order); they are appended to `deps` and reindexed so the
     * `$N` placeholders in the GLSL string line up with the merged dep list.
     *
     * @example
     * const luma = wgsl(d.f32)`dot(${c}, vec3f(0.299, 0.587, 0.114))`
     *     .glslSource`dot(${c}, vec3(0.299, 0.587, 0.114))`;
     */
    glslSource(strings: TemplateStringsArray, ...deps: Node<d.Any>[]): WgslNode<D>;
}
/**
 * Create an inline WGSL expression node using a tagged template literal.
 *
 * @param desc - A descriptor specifying the result type
 *
 * @example
 * // With desc:
 * const expr = wgsl(d.f32)`dot(${a}, ${b})`;
 * const rgbaNode = wgsl(d.vec4f)`vec4f(${rgb}, 1.0)`;
 *
 * // Preserving input type:
 * const sinNode = <D extends d.WgslDesc>(a: Node<D>) => wgsl(a.type)`sin(${a})`;
 *
 * // Cross-backend (WGSL + GLSL companion) so one node runs on both backends:
 * const luma = wgsl(d.f32)`dot(${c}, vec3f(0.299, 0.587, 0.114))`
 *     .glslSource`dot(${c}, vec3(0.299, 0.587, 0.114))`;
 */
export declare function wgsl<D extends d.Any>(desc: D): (strings: TemplateStringsArray, ...deps: Node<d.Any>[]) => WgslNode<D>;
/**
 * Create an inline GLSL expression node using a tagged template literal.
 *
 * Mirrors `wgsl` but produces a GLSL-only node — it emits on the WebGL backend
 * and throws on the WebGPU (WGSL) backend. For a node that runs on BOTH backends,
 * use `wgsl(desc)\`...\`.glslSource\`...\`` instead.
 *
 * @param desc - A descriptor specifying the result type
 *
 * @example
 * const luma = glsl(d.f32)`dot(${c}, vec3(0.299, 0.587, 0.114))`;
 */
export declare function glsl<D extends d.Any>(desc: D): (strings: TemplateStringsArray, ...deps: Node<d.Any>[]) => WgslNode<D>;
