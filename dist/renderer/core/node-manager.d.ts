import type { CompileResult, CompileSlots } from '../../nodes/builder';
import { type ComputeNode } from '../../nodes/nodes';
import type { MemoryLayout } from '../../schema/pack';
import type { DeviceBackend } from './device-backend';
import type { BindingContext, NodeBuilderState } from './node-builder-state';
import { type NodeFrame } from './node-frame';
import type { RenderObject } from './render-object';
import { type SharedBlocks, type SharedPlacement } from './shared-blocks';
/** A compiled render shader and how many RenderObjects hold it. */
type RenderStateEntry = {
    nodeState: NodeBuilderState;
    users: number;
};
/** node compilation and updates state */
export type NodeManagerState = {
    /**
     * Compiled render shaders, keyed by what the compile reads (see `renderStateKey`), so every
     * RenderObject drawing the same nodes into the same context shares one. Evicted when the last
     * RenderObject holding an entry lets go of it.
     */
    renderStates: Map<string, RenderStateEntry>;
    /**
     * Per-ComputeNode NodeBuilderState.
     * Keyed by ComputeNode id string.
     */
    computeStates: Map<string, NodeBuilderState>;
    /** the NodeFrame instance for this manager */
    nodeFrame: NodeFrame;
    /** One block per shared uniform group, which every shader reading the group binds; see `shared-blocks.ts`. */
    sharedBlocks: SharedBlocks;
    /** What compiles place shared members with: set by the backend once its device's uniform block limit is known. */
    shared: SharedPlacement | null;
    /** Frees the uniform blocks of the bind groups a RenderObject copies from its compiled shader, and what the backend
     *  holds for a RenderObject being disposed. */
    backend: Pick<DeviceBackend, 'releaseUniformBlock' | 'releaseBindGroup' | 'releaseRenderObject'>;
};
/** create a new NodeManager state */
export declare function createNodeManagerState(backend: Pick<DeviceBackend, 'releaseUniformBlock' | 'releaseBindGroup' | 'releaseRenderObject'>, layout: MemoryLayout): NodeManagerState;
/** Lets compiles place shared members, now that the device's uniform block limit is known. */
export declare function setSharedPlacement(state: NodeManagerState, maxBytes: number): void;
/**
 * Get the NodeFrame for rendering a specific RenderObject.
 * Sets the frame's context properties from the RenderObject.
 */
export declare function getNodeFrameForRender(state: NodeManagerState, renderObject: RenderObject): NodeFrame;
/**
 * Give a RenderObject the compiled shader for its material and context, compiling only when no other
 * RenderObject already holds one under the same key.
 *
 * The render-shader emitter is injected via `compile` so the backend chooses the target language
 * (WGSL for WebGPU, GLSL for WebGL2). Neutral core code never references a concrete emitter here.
 */
export declare function compileNodeState(state: NodeManagerState, renderObject: RenderObject, compile: (slots: CompileSlots, shared: SharedPlacement | null) => CompileResult): NodeBuilderState;
/**
 * Drop a RenderObject's hold on its compiled shader, evicting the shader once nothing holds it. The
 * RenderObject's bind groups were copied from that shader, so they go with it: its own groups' uniform
 * blocks are freed, and the shared groups are left to the shader's other users.
 */
export declare function releaseNodeState(state: NodeManagerState, renderObject: RenderObject): void;
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
export {};
