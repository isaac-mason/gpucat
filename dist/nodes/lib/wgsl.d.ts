import { Node, NodeKind } from './core';
import * as d from '../../schema/schema';
/**
 * Inline WGSL expression node.
 *
 * Used for embedding raw WGSL expressions with node dependencies.
 * The wgsl string uses $0, $1, etc. as placeholders for deps.
 *
 * @example
 * const expr = new WgslNode(d.f32, 'dot($0, $1)', [a, b]);
 * // generates: dot(a_expr, b_expr)
 */
export declare class WgslNode<D extends d.Any> extends Node<D> {
    readonly wgsl: string;
    readonly deps: Node<d.Any>[];
    readonly kind = NodeKind.Wgsl;
    constructor(type: D, wgsl: string, deps: Node<d.Any>[]);
    /**
     * Returns a new WgslNode with additional unreferenced deps appended.
     * Useful for pulling nodes into the graph (e.g. varyings) without
     * emitting them in the WGSL expression string.
     */
    with(...extra: Node<d.Any>[]): WgslNode<D>;
}
/**
 * Create an inline WGSL expression node using a tagged template literal.
 *
 * @param desc - A WgslDesc descriptor specifying the result type
 *
 * @example
 * // With WgslDesc:
 * const expr = wgsl(d.f32)`dot(${a}, ${b})`;
 * const rgbaNode = wgsl(d.vec4f)`vec4f(${rgb}, 1.0)`;
 *
 * // Preserving input type:
 * const sinNode = <D extends d.WgslDesc>(a: Node<D>) => wgsl(a.type)`sin(${a})`;
 */
export declare function wgsl<D extends d.Any>(desc: D): (strings: TemplateStringsArray, ...deps: Node<d.Any>[]) => WgslNode<D>;
