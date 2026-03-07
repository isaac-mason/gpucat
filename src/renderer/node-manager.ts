/**
 * node-manager.ts - Node compilation and update scheduling.
 *
 * Three.js aligned: mirrors renderers/common/nodes/NodeManager.js
 *
 * The NodeManager coordinates:
 * 1. Getting/creating NodeBuilderState for RenderObjects
 * 2. Running update lifecycle callbacks at appropriate times
 * 3. Detecting when recompilation is needed
 *
 * The NodeFrame instance is owned by the NodeManager and carries:
 * - Timing state (frameId, renderId, time, deltaTime)
 * - Render context (renderer, camera, object, scene, material)
 * - Deduplication maps for update calls
 */

import type { RenderObject } from './render-object';
import { NodeFrame, createNodeFrame } from './node-frame';
import type { NodeBuilderState } from './node-builder-state';
import type { CompileResult } from '../nodes/compile';
import { compile } from '../nodes/compile';
import { createNodeBuilderState } from './node-builder-state';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * NodeManager state - manages node compilation and updates.
 */
export type NodeManagerState = {
    /**
     * Per-RenderObject NodeBuilderState.
     * This is the compiled shader state.
     */
    nodeStates: WeakMap<RenderObject, NodeBuilderState>;

    /**
     * The NodeFrame instance for this manager.
     * Three.js aligned: NodeManager owns a single NodeFrame.
     */
    nodeFrame: NodeFrame;

    /**
     * Environment cache key - invalidated when global state changes.
     * (e.g., lighting, fog, environment maps - deferred for now)
     */
    environmentCacheKey: number;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new NodeManager state.
 */
export function createNodeManagerState(): NodeManagerState {
    return {
        nodeStates: new WeakMap(),
        nodeFrame: createNodeFrame(),
        environmentCacheKey: 0,
    };
}

// ---------------------------------------------------------------------------
// NodeFrame Access
// ---------------------------------------------------------------------------

/**
 * Get the NodeFrame for rendering a specific RenderObject.
 * Sets the frame's context properties from the RenderObject.
 *
 * Three.js aligned: NodeManager.getNodeFrameForRender()
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
 *
 * Three.js aligned: NodeManager.getNodeFrame()
 */
export function getNodeFrame(state: NodeManagerState): NodeFrame {
    return state.nodeFrame;
}

// ---------------------------------------------------------------------------
// Node State Access
// ---------------------------------------------------------------------------

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
 * @param state - The NodeManager state
 * @param renderObject - The RenderObject to compile for
 * @param cacheKey - The pipeline cache key
 * @returns The compiled NodeBuilderState
 */
export function compileNodeState(
    state: NodeManagerState,
    renderObject: RenderObject,
    cacheKey: string,
): NodeBuilderState {
    const material = renderObject.material;

    // Compile the material's node graph
    const compileResult: CompileResult = compile({
        position: material.vertexNode,
        color: material.fragmentNode,
        mask: material.maskNode,
        depth: material.depthNode,
    });

    // Create NodeBuilderState from compile result
    const nodeState = createNodeBuilderState(compileResult, cacheKey);

    // Store in manager and on render object
    setNodeBuilderState(state, renderObject, nodeState);

    return nodeState;
}

// ---------------------------------------------------------------------------
// Recompilation Detection
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Update Lifecycle (Three.js aligned)
// ---------------------------------------------------------------------------

/**
 * Run updateBefore for a RenderObject's nodes.
 *
 * updateBefore is called before the draw call for nodes that need to
 * perform GPU work (compute passes, render to texture, etc.)
 *
 * Three.js aligned: NodeManager.updateBefore()
 *
 * @param state - The NodeManager state
 * @param renderObject - The RenderObject
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
 * Three.js aligned: NodeManager.updateForRender()
 *
 * @param state - The NodeManager state
 * @param renderObject - The RenderObject
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
 * Three.js aligned: NodeManager.updateAfter()
 *
 * @param state - The NodeManager state
 * @param renderObject - The RenderObject
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

// ---------------------------------------------------------------------------
// Environment Cache Key
// ---------------------------------------------------------------------------

/**
 * Invalidate the environment cache key.
 *
 * Call this when global state changes (lighting, fog, environment maps).
 * This will cause all RenderObjects to recompile.
 */
export function invalidateEnvironment(state: NodeManagerState): void {
    state.environmentCacheKey++;
}

/**
 * Get the current environment cache key.
 */
export function getEnvironmentCacheKey(state: NodeManagerState): number {
    return state.environmentCacheKey;
}
