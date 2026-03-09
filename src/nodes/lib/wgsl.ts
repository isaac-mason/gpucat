import { computeId, Node } from './core';
import * as d from '../schema';

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
export class WgslNode<D extends d.WgslDesc> extends Node<D> {
    constructor(
        type: D,
        readonly wgsl: string,
        readonly deps: Node<d.WgslDesc>[]
    ) {
        super(computeId('wgsl', { type: type.wgslType, wgsl, deps: deps.map((n) => n.id) }), type);
    }

    /**
     * Returns a new WgslNode with additional unreferenced deps appended.
     * Useful for pulling nodes into the graph (e.g. varyings) without
     * emitting them in the WGSL expression string.
     */
    with(...extra: Node<d.WgslDesc>[]): WgslNode<D> {
        return new WgslNode<D>(this.type, this.wgsl, [...this.deps, ...extra]);
    }
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
export function wgsl<D extends d.WgslDesc>(desc: D): (strings: TemplateStringsArray, ...deps: Node<d.WgslDesc>[]) => WgslNode<D> {
    return (strings: TemplateStringsArray, ...deps: Node<d.WgslDesc>[]): WgslNode<D> => {
        const wgslStr = String.raw({ raw: strings }, ...deps.map((_, i) => `$${i}`));
        return new WgslNode(desc, wgslStr, deps);
    };
}
