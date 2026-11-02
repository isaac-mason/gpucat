import type * as d from '../../schema/schema';
import { Node, NodeKind } from './core';
/**
 * A vertex position marked invariant: WGSL's `@invariant`, GLSL's `invariant gl_Position`. See {@link invariant}.
 * As a value it is the position it wraps.
 */
export declare class InvariantNode extends Node<d.vec4f> {
    readonly kind = NodeKind.Invariant;
    readonly node: Node<d.vec4f>;
    constructor(position: Node<d.vec4f>);
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
export declare function invariant(position: Node<d.vec4f>): InvariantNode;
/** whether `vertex`, a material's vertex slot, is a position marked invariant */
export declare function isInvariantPosition(vertex: Node<d.Any>): boolean;
