import type * as d from '../../schema/schema';
import { Node, NodeKind } from './core';

/**
 * A vertex position marked invariant: WGSL's `@invariant`, GLSL's `invariant gl_Position`. See {@link invariant}.
 * As a value it is the position it wraps.
 */
export class InvariantNode extends Node<d.vec4f> {
    readonly kind = NodeKind.Invariant;

    readonly node: Node<d.vec4f>;

    constructor(position: Node<d.vec4f>) {
        super(position.type);
        this.node = position;
    }
}

/**
 * Marks `position` invariant when it is a material's `vertex`: two programs computing it from the same data the same
 * way write the same bits, which a pass testing depth for equality against another's needs (`depthCompare: 'equal'`
 * after a depth prepass). Both programs must mark it. As a value anywhere else, it is `position`.
 *
 * @example
 * const clipPos = invariant(cameraProjectionMatrix.mul(viewPosition));
 * const prepass = new Material({ vertex: clipPos, fragment: cutout });
 * const lit = new Material({ vertex: clipPos, fragment: colour, depthWrite: false, depthCompare: 'equal' });
 */
export function invariant(position: Node<d.vec4f>): InvariantNode {
    return new InvariantNode(position);
}

/** whether `vertex`, a material's vertex slot, is a position marked invariant */
export function isInvariantPosition(vertex: Node<d.Any>): boolean {
    return vertex.kind === NodeKind.Invariant;
}
