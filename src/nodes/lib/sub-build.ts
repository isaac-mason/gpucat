import type { Any } from '../../schema/schema';
import { Node, NodeKind } from './core';

/**
 * SubBuildNode - wraps a node to build it in a specific sub-build context.
 * Used by VaryingNode to ensure source nodes are built in VERTEX stage.
 */
export class SubBuildNode<D extends Any> extends Node<D> {
    readonly kind = NodeKind.SubBuild;

    constructor(
        readonly node: Node<D>,
        readonly subBuildName: string,
        nodeType: D | null = null,
    ) {
        super(nodeType ?? node.type);
    }
}

/**
 * Creates a SubBuildNode wrapper.
 */
export function subBuild<D extends Any>(node: Node<D>, name: string, type: D | null = null): SubBuildNode<D> {
    return new SubBuildNode(node, name, type);
}
