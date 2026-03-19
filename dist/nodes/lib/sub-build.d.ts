import { Node } from './core';
import type { Any } from '../../schema/schema';
/**
 * SubBuildNode - wraps a node to build it in a specific sub-build context.
 * Used by VaryingNode to ensure source nodes are built in VERTEX stage.
 */
export declare class SubBuildNode<D extends Any> extends Node<D> {
    readonly node: Node<D>;
    readonly subBuildName: string;
    readonly isSubBuildNode = true;
    constructor(node: Node<D>, subBuildName: string, nodeType?: D | null);
}
/**
 * Creates a SubBuildNode wrapper.
 */
export declare function subBuild<D extends Any>(node: Node<D>, name: string, type?: D | null): SubBuildNode<D>;
