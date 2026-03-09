import { computeId, Node, type WgslType } from './core';


/**
 * SubBuildNode - wraps a node to build it in a specific sub-build context.
 * Used by VaryingNode to ensure source nodes are built in VERTEX stage.
 */

export class SubBuildNode<T extends WgslType> extends Node<T> {
    readonly isSubBuildNode = true;

    constructor(
        readonly node: Node<T>,
        readonly subBuildName: string,
        nodeType: T | null = null
    ) {
        super(
            computeId('subBuild', { node: node.id, name: subBuildName }),
            'subBuild',
            nodeType ?? node.type
        );
    }
}
// TODO: kill SubBuildNode? or keep?
/**
 * Creates a SubBuildNode wrapper.
 */

export function subBuild<T extends WgslType>(
    node: Node<T>,
    name: string,
    type: T | null = null
): SubBuildNode<T> {
    return new SubBuildNode(node, name, type);
}
