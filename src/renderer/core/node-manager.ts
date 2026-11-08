import type { CompileResult, CompileSlots, UpdateNode } from '../../nodes/builder';
import { compileComputeWgsl } from '../../nodes/builder';
import type { MRTNode } from '../../nodes/lib/mrt';
import { type ComputeNode, NodeKind } from '../../nodes/nodes';
import type { MemoryLayout } from '../../schema/pack';
import type { DeviceBackend } from './device-backend';
import type { BindingContext, NodeBuilderState } from './node-builder-state';
import { createNodeBuilderState, createNodeBuilderStateForCompute, releaseNodeBuilderState } from './node-builder-state';
import { createNodeFrame, type NodeFrame } from './node-frame';
import type { RenderObject } from './render-object';
import { createSharedBlocks, type SharedBlocks, type SharedPlacement } from './shared-blocks';

/** A compiled render shader and how many RenderObjects hold it. */
type RenderStateEntry = { nodeState: NodeBuilderState; users: number };

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
export function createNodeManagerState(
    backend: Pick<DeviceBackend, 'releaseUniformBlock' | 'releaseBindGroup' | 'releaseRenderObject'>,
    layout: MemoryLayout,
): NodeManagerState {
    return {
        renderStates: new Map(),
        computeStates: new Map(),
        nodeFrame: createNodeFrame(),
        sharedBlocks: createSharedBlocks(layout),
        shared: null,
        backend,
    };
}

/** Lets compiles place shared members, now that the device's uniform block limit is known. */
export function setSharedPlacement(state: NodeManagerState, maxBytes: number): void {
    state.shared = { blocks: state.sharedBlocks, maxBytes };
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
    // renderer, encoder, width, height are set by the renderer before calling
    return frame;
}

/**
 * Everything a render compile reads. The emitter sees only the material's node slots, named here by
 * node identity, so materials holding the same nodes share a compile whatever their render state (which
 * only the pipeline reads). The context is what the shared bind groups and the MRT outputs resolve
 * against, and the material version keeps `needsUpdate` a recompile. The emitter and its options are
 * not in it: a NodeManager belongs to one renderer, which has one backend.
 */
function renderStateKey(renderObject: RenderObject): string {
    const { material, renderContext } = renderObject;
    return `${renderContext.id}|${material.vertex.id}|${material.fragment?.id ?? ''}|${material.depth?.id ?? ''}|${material.version}`;
}

/**
 * Give a RenderObject the compiled shader for its material and context, compiling only when no other
 * RenderObject already holds one under the same key.
 *
 * The render-shader emitter is injected via `compile` so the backend chooses the target language
 * (WGSL for WebGPU, GLSL for WebGL2). Neutral core code never references a concrete emitter here.
 */
export function compileNodeState(
    state: NodeManagerState,
    renderObject: RenderObject,
    compile: (slots: CompileSlots, shared: SharedPlacement | null) => CompileResult,
): NodeBuilderState {
    const material = renderObject.material;

    // RESOLVE THIS MATERIAL'S MRT BEFORE CODEGEN. An MRTNode names its outputs, but
    // the @location index each one lands at is a property of the render target it is
    // drawn into, so it cannot be known until here. `resolveOutputs` turns the name
    // dictionary into the ordered `members` array the emitter reads, and drops any
    // name the target has no attachment for - which is what lets one material be
    // written once and still compile down to a single output when the pass it lands
    // in declares no extra attachments.
    //
    // The renderer also resolves the PASS-level MRT node, but that is a different
    // object whenever a material brings its own outputs, and only the node actually
    // being compiled has its `members` read. It runs even when the compile is shared:
    // the pipeline built next reads `members` for its target count, and the node may
    // last have been resolved against another context's target.
    const fragmentNode = material.fragment;
    if (fragmentNode !== undefined && fragmentNode.kind === NodeKind.MRT) {
        const context = renderObject.renderContext;
        if (context.colorFormats !== null) {
            const names = context.colorNames;
            (fragmentNode as MRTNode).resolveOutputs((name: string) => names.indexOf(name), names);
        }
    }

    const key = renderStateKey(renderObject);
    let entry = state.renderStates.get(key);
    if (entry === undefined) {
        const compileResult = compile(
            {
                vertex: material.vertex,
                fragment: material.fragment,
                depth: material.depth,
            },
            state.shared,
        );
        // the context is what the template's shared bind groups are cached against
        entry = { nodeState: createNodeBuilderState(compileResult, key, renderObject.renderContext), users: 0 };
        state.renderStates.set(key, entry);
    }

    if (renderObject.nodeBuilderState !== entry.nodeState) {
        releaseNodeState(state, renderObject);
        entry.users++;
        renderObject.nodeBuilderState = entry.nodeState;
    }

    // record versions at compilation time for change detection
    renderObject.materialVersion = material.version;
    renderObject.geometryVersion = renderObject.geometry.version;

    return entry.nodeState;
}

/**
 * Drop a RenderObject's hold on its compiled shader, evicting the shader once nothing holds it. The
 * RenderObject's bind groups were copied from that shader, so they go with it: its own groups' uniform
 * blocks are freed, and the shared groups are left to the shader's other users.
 */
export function releaseNodeState(state: NodeManagerState, renderObject: RenderObject): void {
    const bindings = renderObject._bindings;
    if (bindings !== null) {
        renderObject._bindings = null;
        for (const group of bindings) {
            if (group.shared) continue;
            for (const binding of group.bindings) {
                if (binding.kind === 'uniform' && binding.bufferKey !== null)
                    state.backend.releaseUniformBlock(binding.bufferKey);
            }
            state.backend.releaseBindGroup(group);
        }
    }

    const nodeState = renderObject.nodeBuilderState;
    if (nodeState === null) return;
    renderObject.nodeBuilderState = null;

    const entry = state.renderStates.get(nodeState.cacheKey);
    if (entry === undefined || entry.nodeState !== nodeState) return;
    entry.users--;
    if (entry.users > 0) return;
    state.renderStates.delete(nodeState.cacheKey);
    releaseNodeBuilderState(
        nodeState,
        state.sharedBlocks,
        (key) => state.backend.releaseUniformBlock(key),
        (group) => state.backend.releaseBindGroup(group),
    );
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
    const compileResult = compileComputeWgsl(computeNode, { shared: state.shared ?? undefined });

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
    const nodeState = state.computeStates.get(computeNode.id);
    if (nodeState === undefined) return;
    state.computeStates.delete(computeNode.id);
    // a dispatch binds its compiled groups directly, so its own groups' blocks are its, as the shared ones are
    for (const group of nodeState.bindings) {
        if (group.shared) continue;
        for (const binding of group.bindings) {
            if (binding.kind === 'uniform' && binding.bufferKey !== null) state.backend.releaseUniformBlock(binding.bufferKey);
        }
        state.backend.releaseBindGroup(group);
    }
    releaseNodeBuilderState(
        nodeState,
        state.sharedBlocks,
        (key) => state.backend.releaseUniformBlock(key),
        (group) => state.backend.releaseBindGroup(group),
    );
}
