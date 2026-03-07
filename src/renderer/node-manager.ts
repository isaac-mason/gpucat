import type { RenderObject } from './render-object';
import { NodeFrame, createNodeFrame } from './node-frame';
import type { NodeBuilderState } from './node-builder-state';
import type { CompileResult, ComputeCompileResult, UpdateNode } from '../nodes/builder';
import { compile, compileCompute } from '../nodes/builder';
import { createNodeBuilderState } from './node-builder-state';
import type { ComputeNode } from '../nodes/nodes';

/**
 * ComputeBuilderState - Compiled shader state for a ComputeNode.
 * 
 * Similar to NodeBuilderState but for compute shaders.
 * Contains everything needed to create compute pipelines and run updates.
 */
export type ComputeBuilderState = {
    /** WGSL compute shader code. */
    code: string;

    /** The compute compile result (storage, uniforms, etc.). */
    compileResult: ComputeCompileResult;

    /** Nodes to update during compute dispatch. */
    updateNodes: UpdateNode[];

    /** Version of the ComputeNode when compiled. */
    version: number;

    readonly isComputeBuilderState: true;
};

/** node compilation and updates state */
export type NodeManagerState = {
    /**
     * Per-RenderObject NodeBuilderState.
     * This is the compiled shader state.
     */
    nodeStates: WeakMap<RenderObject, NodeBuilderState>;

    /**
     * Per-ComputeNode ComputeBuilderState.
     * Keyed by ComputeNode id string.
     */
    computeStates: Map<string, ComputeBuilderState>;

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
export function getNodeFrameForRender(
    state: NodeManagerState,
    renderObject: RenderObject,
): NodeFrame {
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
export function getNodeBuilderState(
    state: NodeManagerState,
    renderObject: RenderObject,
): NodeBuilderState | null {
    return state.nodeStates.get(renderObject) ?? null;
}

/**
 * Set the NodeBuilderState for a RenderObject.
 */
export function setNodeBuilderState(
    state: NodeManagerState,
    renderObject: RenderObject,
    nodeState: NodeBuilderState,
): void {
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
    const material = renderObject.material;

    // compile the material's node graph
    const compileResult: CompileResult = compile({
        position: material.vertexNode,
        color: material.fragmentNode,
        mask: material.maskNode,
        depth: material.depthNode,
    });

    // create NodeBuilderState from compile result
    const nodeState = createNodeBuilderState(compileResult, cacheKey);

    // store in manager and on render object
    setNodeBuilderState(state, renderObject, nodeState);

    return { nodeState, compileResult };
}

/**
 * Check if a RenderObject needs node recompilation.
 *
 * This compares the current cache key against the stored one.
 */
export function needsNodeUpdate(
    state: NodeManagerState,
    renderObject: RenderObject,
    newCacheKey: string,
): boolean {
    const nodeState = state.nodeStates.get(renderObject);
    if (!nodeState) return true;

    return nodeState.cacheKey !== newCacheKey;
}

/**
 * Delete the NodeBuilderState for a RenderObject.
 */
export function deleteNodeState(
    state: NodeManagerState,
    renderObject: RenderObject,
): void {
    state.nodeStates.delete(renderObject);
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
export function updateBefore(
    state: NodeManagerState,
    renderObject: RenderObject,
): void {
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
export function updateForRender(
    state: NodeManagerState,
    renderObject: RenderObject,
): void {
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
export function updateAfter(
    state: NodeManagerState,
    renderObject: RenderObject,
): void {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) return;

    const frame = getNodeFrameForRender(state, renderObject);

    for (const node of nodeState.updateAfterNodes) {
        frame.updateAfterNode(node);
    }
}

/**
 * Get the ComputeBuilderState for a ComputeNode.
 * Compiles the compute shader if not already compiled.
 *
 * @param state the NodeManager state
 * @param computeNode the ComputeNode
 * @returns the ComputeBuilderState
 */
export function getForCompute(
    state: NodeManagerState,
    computeNode: ComputeNode,
): ComputeBuilderState {
    let computeState = state.computeStates.get(computeNode.id);

    if (!computeState) {
        computeState = compileComputeNode(state, computeNode);
    }

    return computeState;
}

/**
 * Compile a ComputeNode and cache the result.
 *
 * @param state the NodeManager state
 * @param computeNode the ComputeNode to compile
 * @returns the compiled ComputeBuilderState
 */
function compileComputeNode(
    state: NodeManagerState,
    computeNode: ComputeNode,
): ComputeBuilderState {
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
                        const result = node.update!(frame);
                        if (result !== undefined) {
                            node.value = result as typeof node.value;
                            node.version++;
                        }
                        return true;
                    },
                });
            }
        }
    }

    const computeState: ComputeBuilderState = {
        code: compileResult.code,
        compileResult,
        updateNodes,
        version: 0, // ComputeNode doesn't have version tracking yet
        isComputeBuilderState: true,
    };

    state.computeStates.set(computeNode.id, computeState);

    return computeState;
}

/**
 * Run update for a ComputeNode's nodes.
 *
 * update is called to execute node logic each frame/render.
 * (e.g., time uniforms)
 *
 * @param state the NodeManager state
 * @param computeNode the ComputeNode
 */
export function updateForCompute(
    state: NodeManagerState,
    computeNode: ComputeNode,
): void {
    const computeState = state.computeStates.get(computeNode.id);
    if (!computeState) return;

    const frame = getNodeFrame(state);

    for (const node of computeState.updateNodes) {
        frame.updateNode(node);
    }
}

/**
 * Delete the ComputeBuilderState for a ComputeNode.
 *
 * @param state the NodeManager state
 * @param computeNode the ComputeNode
 */
export function deleteComputeState(
    state: NodeManagerState,
    computeNode: ComputeNode,
): void {
    state.computeStates.delete(computeNode.id);
}
