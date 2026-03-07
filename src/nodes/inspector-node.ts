/**
 * InspectorNode — A wrapper node that registers itself with the inspector on each frame.
 *
 * Three.js aligned: mirrors src/nodes/core/InspectorNode.js
 *
 * Instead of flagging nodes with _isInspectable and manually iterating in the renderer,
 * InspectorNode leverages the existing node update system (updateType = FRAME) to
 * automatically call inspector.inspect() every frame.
 *
 * Usage:
 *   const albedo = texture('texture_2d<f32>', 'albedo').inspect('Albedo');
 *
 * The .inspect() method on Node creates an InspectorNode wrapper and attaches it
 * via node.before(), so it gets built and updated alongside the original node.
 */

import type { NodeFrame } from '../renderer/node-frame';
import { Node, NodeUpdateType, type WgslType } from './nodes';

let _inspectorNodeCounter = 0;

/**
 * InspectorNode wraps a node and registers it with the inspector every frame.
 *
 * Key properties:
 * - `wrappedNode`: The original node being inspected
 * - `inspectorName`: Display name for the inspector UI
 * - `updateType = FRAME`: Ensures update() is called once per frame
 */
export class InspectorNode<T extends WgslType> extends Node<T> {
    /** The original node being inspected. */
    readonly wrappedNode: Node<T>;

    /** Display name for the inspector UI. */
    readonly inspectorName: string;

    /** Marker for type checking. */
    readonly isInspectorNode = true;

    constructor(node: Node<T>, name?: string) {
        // Generate a unique ID for this inspector node
        const id = `inspector_${_inspectorNodeCounter++}_${node.id}`;
        super(id, 'inspector', node.type);

        this.wrappedNode = node;
        this.inspectorName = name ?? node.id;

        // Key: use the FRAME update type so update() is called every frame
        this.updateType = NodeUpdateType.FRAME;
    }

    /**
     * Called by the node update system every frame.
     * Registers this node with the renderer's inspector.
     */
    override update = (frame: NodeFrame): void => {
        frame.renderer!.inspector.inspect(this as Node<WgslType>);
    };

    /**
     * Returns the display name for the inspector.
     * Three.js aligned: getName() method.
     */
    getName(): string {
        return this.inspectorName;
    }
}
