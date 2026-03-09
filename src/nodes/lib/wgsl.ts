import { computeId, Node, type WgslType } from './core';
import type { WgslDesc } from '../schema';

/**
 * Inline WGSL expression node.
 *
 * Used for embedding raw WGSL expressions with node dependencies.
 * The wgsl string uses $0, $1, etc. as placeholders for deps.
 *
 * @example
 * const expr = new WgslNode('f32', 'dot($0, $1)', [a, b]);
 * // generates: dot(a_expr, b_expr)
 */
export class WgslNode<T extends WgslType> extends Node<T> {
    constructor(
        type: T,
        readonly wgsl: string,
        readonly deps: Node<WgslType>[]
    ) {
        super(computeId('wgsl', { type, wgsl, deps: deps.map((n) => n.id) }), 'wgsl', type);
    }

    /**
     * Returns a new WgslNode with additional unreferenced deps appended.
     * Useful for pulling nodes into the graph (e.g. varyings) without
     * emitting them in the WGSL expression string.
     */
    with(...extra: Node<WgslType>[]): WgslNode<T> {
        return new WgslNode<T>(this.type as T, this.wgsl, [...this.deps, ...extra]);
    }
}

/**
 * Create an inline WGSL expression node using a tagged template literal.
 *
 * @param type - Either a WgslType string ('f32', 'vec3f', etc.) or a WgslDesc
 *
 * @example
 * // With type string:
 * const expr = wgsl('f32')`dot(${a}, ${b})`;
 *
 * // With WgslDesc:
 * const expr = wgsl(d.vec4f)`vec4f(${rgb}, 1.0)`;
 *
 * // Preserving input type:
 * const sinNode = <T extends WgslType>(a: Node<T>) => wgsl(a.type)`sin(${a})`;
 */
export const wgsl = <T extends WgslType>(type: T | WgslDesc<T>) => (strings: TemplateStringsArray, ...deps: Node<WgslType>[]): WgslNode<T> => {
    const wgslStr = String.raw({ raw: strings }, ...deps.map((_, i) => `$${i}`));
    const resolvedType = typeof type === 'string' ? type : type.wgslType;
    return new WgslNode(resolvedType as T, wgslStr, deps);
};

