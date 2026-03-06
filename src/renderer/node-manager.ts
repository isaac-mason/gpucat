/**
 * node-manager.ts - Node compilation and update scheduling.
 *
 * Aligned with Three.js Nodes/NodeFrame concepts:
 * - Manages node compilation per RenderObject
 * - Schedules update callbacks (updateBefore, update, updateAfter)
 * - Handles frame/render/object-level deduplication
 *
 * The NodeManager coordinates:
 * 1. Getting/creating NodeBuilderState for RenderObjects
 * 2. Running update lifecycle callbacks at appropriate times
 * 3. Detecting when recompilation is needed
 */

import type { RenderObject } from './render-object';
import type { RenderFrame } from './render-frame';
import type { NodeBuilderState } from './node-builder-state';
import type {
    CompileResult,
    UpdateBeforeNode,
    UpdateAfterNode,
    UpdateNode,
} from '../nodes/compile';
import { compile } from '../nodes/compile';
import { createNodeBuilderState } from './node-builder-state';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Update tracking maps for deduplication.
 */
type UpdateMaps = {
    frameId: number;
    renderId: number;
};

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
     * Update deduplication maps for updateBefore nodes.
     */
    updateBeforeMap: WeakMap<UpdateBeforeNode, UpdateMaps>;

    /**
     * Update deduplication maps for updateAfter nodes.
     */
    updateAfterMap: WeakMap<UpdateAfterNode, UpdateMaps>;

    /**
     * Update deduplication maps for update nodes.
     */
    updateMap: WeakMap<UpdateNode, UpdateMaps>;

    /**
     * Environment cache key - invalidated when global state changes.
     * (e.g., lighting, fog, environment maps - deferred for now)
     */
    environmentCacheKey: number;

    /**
     * Current frame ID for deduplication.
     */
    frameId: number;

    /**
     * Current render ID for deduplication (incremented per render() call).
     */
    renderId: number;
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
        updateBeforeMap: new WeakMap(),
        updateAfterMap: new WeakMap(),
        updateMap: new WeakMap(),
        environmentCacheKey: 0,
        frameId: 0,
        renderId: 0,
    };
}

// ---------------------------------------------------------------------------
// Frame/Render ID Management
// ---------------------------------------------------------------------------

/**
 * Increment frame ID at the start of each animation frame.
 */
export function incrementFrameId(state: NodeManagerState): void {
    state.frameId++;
}

/**
 * Increment render ID at the start of each render() call.
 */
export function incrementRenderId(state: NodeManagerState): void {
    state.renderId++;
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
// Update Lifecycle
// ---------------------------------------------------------------------------

/**
 * Get or create update maps for deduplication.
 */
function getUpdateMaps<T extends object>(
    map: WeakMap<T, UpdateMaps>,
    node: T,
): UpdateMaps {
    let maps = map.get(node);
    if (!maps) {
        maps = { frameId: -1, renderId: -1 };
        map.set(node, maps);
    }
    return maps;
}

/**
 * Run updateBefore for a RenderObject's nodes.
 *
 * updateBefore is called before the draw call for nodes that need to
 * perform GPU work (compute passes, render to texture, etc.)
 *
 * @param state - The NodeManager state
 * @param renderObject - The RenderObject
 * @param frame - The render frame context
 */
export function updateBefore(
    state: NodeManagerState,
    renderObject: RenderObject,
    frame: RenderFrame,
): void {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) return;

    for (const node of nodeState.updateBeforeNodes) {
        const updateType = node.updateBeforeType;
        if (updateType === 'none') continue;

        const maps = getUpdateMaps(state.updateBeforeMap, node);

        if (updateType === 'frame') {
            if (maps.frameId !== state.frameId) {
                const prev = maps.frameId;
                maps.frameId = state.frameId;
                if (node.updateBefore(frame) === false) {
                    maps.frameId = prev;
                }
            }
        } else if (updateType === 'render') {
            if (maps.renderId !== state.renderId) {
                const prev = maps.renderId;
                maps.renderId = state.renderId;
                if (node.updateBefore(frame) === false) {
                    maps.renderId = prev;
                }
            }
        } else if (updateType === 'object') {
            node.updateBefore(frame);
        }
    }
}

/**
 * Run update for a RenderObject's nodes.
 *
 * update is called to push CPU data into GPU uniforms before drawing.
 *
 * @param state - The NodeManager state
 * @param renderObject - The RenderObject
 * @param frame - The render frame context
 */
export function updateForRender(
    state: NodeManagerState,
    renderObject: RenderObject,
    frame: RenderFrame,
): void {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) return;

    for (const node of nodeState.updateNodes) {
        const updateType = node.updateType;
        if (updateType === 'none') continue;

        const maps = getUpdateMaps(state.updateMap, node);

        if (updateType === 'frame') {
            if (maps.frameId !== state.frameId) {
                const prev = maps.frameId;
                maps.frameId = state.frameId;
                if (node.update(frame) === false) {
                    maps.frameId = prev;
                }
            }
        } else if (updateType === 'render') {
            if (maps.renderId !== state.renderId) {
                const prev = maps.renderId;
                maps.renderId = state.renderId;
                if (node.update(frame) === false) {
                    maps.renderId = prev;
                }
            }
        } else if (updateType === 'object') {
            node.update(frame);
        }
    }
}

/**
 * Run updateAfter for a RenderObject's nodes.
 *
 * updateAfter is called after the draw call for cleanup, readback, etc.
 *
 * @param state - The NodeManager state
 * @param renderObject - The RenderObject
 * @param frame - The render frame context
 */
export function updateAfter(
    state: NodeManagerState,
    renderObject: RenderObject,
    frame: RenderFrame,
): void {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) return;

    for (const node of nodeState.updateAfterNodes) {
        const updateType = node.updateAfterType;
        if (updateType === 'none') continue;

        const maps = getUpdateMaps(state.updateAfterMap, node);

        if (updateType === 'frame') {
            if (maps.frameId !== state.frameId) {
                const prev = maps.frameId;
                maps.frameId = state.frameId;
                if (node.updateAfter(frame) === false) {
                    maps.frameId = prev;
                }
            }
        } else if (updateType === 'render') {
            if (maps.renderId !== state.renderId) {
                const prev = maps.renderId;
                maps.renderId = state.renderId;
                if (node.updateAfter(frame) === false) {
                    maps.renderId = prev;
                }
            }
        } else if (updateType === 'object') {
            node.updateAfter(frame);
        }
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
