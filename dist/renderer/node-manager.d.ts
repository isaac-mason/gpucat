import type { RenderObject } from 'gpucat/dist/renderer/render-object';
import { NodeFrame } from 'gpucat/dist/renderer/node-frame';
import type { NodeBuilderState, BindingContext } from 'gpucat/dist/renderer/node-builder-state';
import type { CompileResult } from 'gpucat/dist/nodes/builder';
import type { ComputeNode } from 'gpucat/dist/nodes/nodes';
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
export declare function createNodeManagerState(): NodeManagerState;
/**
 * Get the NodeFrame for rendering a specific RenderObject.
 * Sets the frame's context properties from the RenderObject.
 */
export declare function getNodeFrameForRender(state: NodeManagerState, renderObject: RenderObject): NodeFrame;
/**
 * Get the NodeFrame with minimal context (for compute or non-object renders).
 */
export declare function getNodeFrame(state: NodeManagerState): NodeFrame;
/**
 * Get the NodeBuilderState for a RenderObject.
 * Returns null if not compiled yet.
 */
export declare function getNodeBuilderState(state: NodeManagerState, renderObject: RenderObject): NodeBuilderState | null;
/**
 * Set the NodeBuilderState for a RenderObject.
 */
export declare function setNodeBuilderState(state: NodeManagerState, renderObject: RenderObject, nodeState: NodeBuilderState): void;
/**
 * Compile and set the NodeBuilderState for a RenderObject.
 *
 * @param state the NodeManager state
 * @param renderObject the RenderObject to compile for
 * @param cacheKey the pipeline cache key
 * @returns the compiled NodeBuilderState and the raw CompileResult
 */
export declare function compileNodeState(state: NodeManagerState, renderObject: RenderObject, cacheKey: string): {
    nodeState: NodeBuilderState;
    compileResult: CompileResult;
};
/**
 * Check if a RenderObject needs node recompilation.
 *
 * Uses version comparison instead of string key comparison for performance.
 * Recompilation is needed when material or geometry version has changed
 * since last compilation.
 */
export declare function needsNodeUpdate(_state: NodeManagerState, renderObject: RenderObject): boolean;
/**
 * Run updateBefore for a RenderObject's nodes.
 *
 * updateBefore is called before the draw call for nodes that need to
 * perform GPU work (compute passes, render to texture, etc.)
 *
 * @param state the NodeManager state
 * @param renderObject the RenderObject
 */
export declare function updateBefore(state: NodeManagerState, renderObject: RenderObject): void;
/**
 * Run update for a RenderObject's nodes.
 *
 * update is called to execute node logic each frame/render/object.
 * (e.g., InspectorNode registering with inspector)
 *
 * @param state the NodeManager state
 * @param renderObject the RenderObject
 */
export declare function updateForRender(state: NodeManagerState, renderObject: RenderObject): void;
/**
 * Run updateAfter for a RenderObject's nodes.
 *
 * updateAfter is called after the draw call for cleanup, readback, etc.
 *
 * @param state the NodeManager state
 * @param renderObject the RenderObject
 */
export declare function updateAfter(state: NodeManagerState, renderObject: RenderObject): void;
/**
 * Get the NodeBuilderState for a ComputeNode.
 * Compiles the compute shader if not already compiled.
 *
 * @param state the NodeManager state
 * @param computeNode the ComputeNode
 * @param context the BindingContext for shared bind group caching
 * @returns the NodeBuilderState
 */
export declare function getForCompute(state: NodeManagerState, computeNode: ComputeNode, context: BindingContext): NodeBuilderState;
/**
 * Update uniform nodes for a ComputeNode before dispatch.
 * Calls the update() method on all updateNodes.
 *
 * Note: The node must already be compiled via getForCompute().
 *
 * @param state the NodeManager state
 * @param computeNode the ComputeNode
 */
export declare function updateForCompute(state: NodeManagerState, computeNode: ComputeNode): void;
/**
 * Remove the cached NodeBuilderState for a ComputeNode.
 * Called when a ComputeNode is disposed.
 *
 * @param state the NodeManager state
 * @param computeNode the ComputeNode being disposed
 */
export declare function deleteForCompute(state: NodeManagerState, computeNode: ComputeNode): void;
