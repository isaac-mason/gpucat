import type { RenderObject } from './render-object';
import { NodeFrame, createNodeFrame } from './node-frame';
import type { NodeBuilderState, BindingContext } from './node-builder-state';
import type { CompileResult, UpdateNode } from '../nodes/builder';
import { compile, compileCompute } from '../nodes/builder';
import { createNodeBuilderState, createNodeBuilderStateForCompute } from './node-builder-state';
import type { ComputeNode } from '../nodes/nodes';

/** node compilation and updates state */
export type NodeManagerState = {
    /**
     * Per-RenderObject NodeBuilderState.
     * This is the compiled shader state.
     */
    nodeStates: WeakMap<RenderObject, NodeBuilderState>;

    /**
     * Per-ComputeNode NodeBuilderState.
     * Keyed by ComputeNode id string.
     */
    computeStates: Map<string, NodeBuilderState>;

    /** the NodeFrame instance for this manager */
    nodeFrame: NodeFrame;
};

/** create a new NodeManager state */
export function createNodeManagerState(): NodeManagerState {
    return {
        nodeStates: new WeakMap(),
        computeStates: new Map(),
        nodeFrame: createNodeFrame(),
    };
}

/**
 * Get the NodeFrame for rendering a specific RenderObject.
 * Sets the frame's context properties from the RenderObject.
 */
export function getNodeFrameForRender(state: NodeManagerState, renderObject: RenderObject): NodeFrame {
    const frame = state.nodeFrame;
    frame.object = renderObject.mesh;
    frame.camera = renderObject.camera;
    frame.material = renderObject.material;
    frame.scene = renderObject.scene;
    // renderer, encoder, width, height are set by the renderer before calling
    return frame;
}

/**
 * Get the NodeFrame with minimal context (for compute or non-object renders).
 */
export function getNodeFrame(state: NodeManagerState): NodeFrame {
    return state.nodeFrame;
}

/**
 * Get the NodeBuilderState for a RenderObject.
 * Returns null if not compiled yet.
 */
export function getNodeBuilderState(state: NodeManagerState, renderObject: RenderObject): NodeBuilderState | null {
    return state.nodeStates.get(renderObject) ?? null;
}

/**
 * Set the NodeBuilderState for a RenderObject.
 */
export function setNodeBuilderState(state: NodeManagerState, renderObject: RenderObject, nodeState: NodeBuilderState): void {
    state.nodeStates.set(renderObject, nodeState);
    renderObject.nodeBuilderState = nodeState;
}

/**
 * Compile and set the NodeBuilderState for a RenderObject.
 *
 * @param state the NodeManager state
 * @param renderObject the RenderObject to compile for
 * @param cacheKey the pipeline cache key
 * @returns the compiled NodeBuilderState and the raw CompileResult
 */
export function compileNodeState(
    state: NodeManagerState,
    renderObject: RenderObject,
    cacheKey: string,
): { nodeState: NodeBuilderState; compileResult: CompileResult } {
    console.log('[compileNodeState] called for material:', renderObject.material.name);
    const material = renderObject.material;

    // compile the material's node graph
    const compileResult: CompileResult = compile({
        position: material.vertexNode,
        color: material.fragmentNode,
        depth: material.depthNode,
    });

    // create NodeBuilderState from compile result (pass renderContext for shared bind group caching)
    const nodeState = createNodeBuilderState(compileResult, cacheKey, renderObject.renderContext);

    // store in manager and on render object
    setNodeBuilderState(state, renderObject, nodeState);

    // record versions at compilation time for change detection
    renderObject.materialVersion = material.version;
    renderObject.geometryVersion = renderObject.geometry.version;

    return { nodeState, compileResult };
}

/**
 * Check if a RenderObject needs node recompilation.
 *
 * Uses version comparison instead of string key comparison for performance.
 * Recompilation is needed when material or geometry version has changed
 * since last compilation.
 */
export function needsNodeUpdate(_state: NodeManagerState, renderObject: RenderObject): boolean {
    // No nodeBuilderState means never compiled
    if (!renderObject.nodeBuilderState) return true;

    // Check if material or geometry has changed since last compilation
    return (
        renderObject.material.version !== renderObject.materialVersion ||
        renderObject.geometry.version !== renderObject.geometryVersion
    );
}

/**
 * Run updateBefore for a RenderObject's nodes.
 *
 * updateBefore is called before the draw call for nodes that need to
 * perform GPU work (compute passes, render to texture, etc.)
 *
 * @param state the NodeManager state
 * @param renderObject the RenderObject
 */
export function updateBefore(state: NodeManagerState, renderObject: RenderObject): void {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) return;

    const frame = getNodeFrameForRender(state, renderObject);

    for (const node of nodeState.updateBeforeNodes) {
        frame.updateBeforeNode(node);
    }
}

/**
 * Run update for a RenderObject's nodes.
 *
 * update is called to execute node logic each frame/render/object.
 * (e.g., InspectorNode registering with inspector)
 *
 * @param state the NodeManager state
 * @param renderObject the RenderObject
 */
export function updateForRender(state: NodeManagerState, renderObject: RenderObject): void {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) return;

    const frame = getNodeFrameForRender(state, renderObject);

    for (const node of nodeState.updateNodes) {
        frame.updateNode(node);
    }
}

/**
 * Run updateAfter for a RenderObject's nodes.
 *
 * updateAfter is called after the draw call for cleanup, readback, etc.
 *
 * @param state the NodeManager state
 * @param renderObject the RenderObject
 */
export function updateAfter(state: NodeManagerState, renderObject: RenderObject): void {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) return;

    const frame = getNodeFrameForRender(state, renderObject);

    for (const node of nodeState.updateAfterNodes) {
        frame.updateAfterNode(node);
    }
}

/**
 * Get the NodeBuilderState for a ComputeNode.
 * Compiles the compute shader if not already compiled.
 *
 * @param state the NodeManager state
 * @param computeNode the ComputeNode
 * @param context the BindingContext for shared bind group caching
 * @returns the NodeBuilderState
 */
export function getForCompute(state: NodeManagerState, computeNode: ComputeNode, context: BindingContext): NodeBuilderState {
    let nodeState = state.computeStates.get(computeNode.id);

    if (!nodeState) {
        nodeState = compileComputeNode(state, computeNode, context);
    }

    return nodeState;
}

/**
 * Update uniform nodes for a ComputeNode before dispatch.
 * Calls the update() method on all updateNodes.
 *
 * Note: The node must already be compiled via getForCompute().
 *
 * @param state the NodeManager state
 * @param computeNode the ComputeNode
 */
export function updateForCompute(state: NodeManagerState, computeNode: ComputeNode): void {
    const nodeState = state.computeStates.get(computeNode.id);
    if (!nodeState) return; // Not compiled yet - should not happen in normal flow

    const frame = state.nodeFrame;

    for (const node of nodeState.updateNodes) {
        frame.updateNode(node);
    }
}

/**
 * Compile a ComputeNode and cache the result.
 *
 * @param state the NodeManager state
 * @param computeNode the ComputeNode to compile
 * @param context the BindingContext for shared bind group caching
 * @returns the compiled NodeBuilderState
 */
function compileComputeNode(state: NodeManagerState, computeNode: ComputeNode, context: BindingContext): NodeBuilderState {
    const compileResult = compileCompute(computeNode);

    // extract update nodes from the compile result
    // for compute, we use the uniform update callbacks
    const updateNodes: UpdateNode[] = [];
    for (const ug of compileResult.uniformGroups) {
        for (const member of ug.members) {
            const node = member.node;
            if (node.update) {
                updateNodes.push({
                    id: node.id,
                    updateType: node.updateType ?? 'frame',
                    update: (frame) => {
                        node.update!(frame);
                        return true;
                    },
                });
            }
        }
    }

    // Create NodeBuilderState for compute with context for shared bind group caching
    const nodeState = createNodeBuilderStateForCompute(compileResult, context);

    // Inject the extracted updateNodes
    (nodeState as { updateNodes: UpdateNode[] }).updateNodes = updateNodes;

    state.computeStates.set(computeNode.id, nodeState);

    return nodeState;
}

/**
 * Remove the cached NodeBuilderState for a ComputeNode.
 * Called when a ComputeNode is disposed.
 *
 * @param state the NodeManager state
 * @param computeNode the ComputeNode being disposed
 */
export function deleteForCompute(state: NodeManagerState, computeNode: ComputeNode): void {
    state.computeStates.delete(computeNode.id);
}
