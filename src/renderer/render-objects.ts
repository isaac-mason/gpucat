/**
 * render-objects.ts - RenderObject manager with ChainMap caching.
 *
 * Aligned with Three.js RenderObjects class:
 * - Creates and caches RenderObjects per (mesh, material, renderContext, passId) tuple
 * - Uses ChainMap for automatic garbage collection
 * - Coordinates initialization of NodeBuilderState, pipeline, bindings
 *
 * The RenderObjects manager is the central orchestrator that brings together:
 * - NodeManager (compilation)
 * - Geometries (attribute uploads)
 * - Bindings (bind group management)
 * - Pipeline cache (pipeline creation)
 */

import type { Camera } from '../camera/camera';
import type { Material } from '../material/material';
import type { Mesh } from '../objects/mesh';
import type { Scene } from '../scene/scene';
import type { BindingsState } from './bindings';
import { getBindGroupLayouts, initBindings, updateBindings } from './bindings';
import * as chainMap from './chain-map';
import type { GeometriesState } from './geometries';
import { updateForRender as updateGeometry } from './geometries';
import type { NodeFrame } from './node-frame';
import type { NodeManagerState } from './node-manager';
import { compileNodeState, needsNodeUpdate } from './node-manager';
import * as pipelines from './pipelines';
import type { RenderContext } from './render-context';
import type { GeometryGroup, RenderObject } from './render-object';
import { computeRenderObjectCacheKey, createRenderObject, disposeRenderObject } from './render-object';
// [graph-tab] import for graph snapshot callback type
import type { GraphSnapshot } from '../inspector/graph-snapshot';
import { CompileResult } from '../nodes/builder';

/**
 * RenderObjects state - manages RenderObject creation and caching.
 */
export type RenderObjectsState = {
    /** NodeManager for compilation. */
    nodes: NodeManagerState;

    /** Geometries system for attribute management. */
    geometries: GeometriesState;

    /** Bindings system for bind group management. */
    bindings: BindingsState;

    /** Pipeline cache for pipeline creation. */
    pipelines: pipelines.PipelinesState;

    /** GPU device reference. */
    device: GPUDevice;

    /**
     * Per-pass ChainMaps for RenderObject caching.
     * Each passId (e.g., 'default', 'shadow', 'reflection') gets its own ChainMap.
     */
    chainMaps: Map<string, chainMap.ChainMap<RenderObject>>;

    /**
     * All active RenderObjects (for iteration/disposal).
     */
    renderObjects: Set<RenderObject>;

    // [graph-tab] Called after each compile with the compiled node graph.
    onGraphSnapshot: ((s: GraphSnapshot) => void) | null;
};

/**
 * Create a new RenderObjects state.
 */
export function createRenderObjectsState(deps: {
    nodes: NodeManagerState;
    geometries: GeometriesState;
    bindings: BindingsState;
    pipelines: pipelines.PipelinesState;
    device: GPUDevice;
}): RenderObjectsState {
    return {
        nodes: deps.nodes,
        geometries: deps.geometries,
        bindings: deps.bindings,
        pipelines: deps.pipelines,
        device: deps.device,
        chainMaps: new Map(),
        renderObjects: new Set(),
        onGraphSnapshot: null, // [graph-tab] wired in renderer.ts
    };
}

/**
 * Get or create the ChainMap for a pass.
 */
function getChainMap(state: RenderObjectsState, passId: string): chainMap.ChainMap<RenderObject> {
    let map = state.chainMaps.get(passId);
    if (!map) {
        map = chainMap.create<RenderObject>();
        state.chainMaps.set(passId, map);
    }
    return map;
}

/**
 * Get or create a RenderObject for the given parameters.
 *
 * This is the main entry point for obtaining a RenderObject. It:
 * 1. Looks up existing RenderObject in ChainMap cache
 * 2. Creates new RenderObject if not found
 * 3. Initializes NodeBuilderState, pipeline, bindings if needed
 *
 * @param state - The RenderObjects state
 * @param mesh - The mesh to render
 * @param material - The material to use
 * @param scene - The scene containing the mesh
 * @param camera - The camera for rendering
 * @param renderContext - The render context (framebuffer config)
 * @param passId - Pass identifier (e.g., 'default', 'shadow')
 * @param group - Optional geometry group for multi-material meshes
 */
export function getRenderObject(
    state: RenderObjectsState,
    mesh: Mesh,
    material: Material,
    scene: Scene,
    camera: Camera,
    renderContext: RenderContext,
    passId: string = 'default',
    group: GeometryGroup | null = null,
): RenderObject {
    const map = getChainMap(state, passId);
    const keys = [mesh, material, renderContext];

    // Try to get existing RenderObject
    let renderObject = chainMap.get(map, keys);

    if (!renderObject) {
        // Create new RenderObject
        renderObject = createRenderObject(mesh, material, scene, camera, renderContext, group);

        // Compute and store initial cache key
        renderObject.initialCacheKey = computeRenderObjectCacheKey(material, mesh.geometry, renderContext);

        // Tag with the pass this RO belongs to
        renderObject.passId = passId;

        // Set up disposal callback
        renderObject.onDispose = () => {
            chainMap.del(map, keys);
            state.renderObjects.delete(renderObject!);
        };

        // Cache it
        chainMap.set(map, keys, renderObject);
        state.renderObjects.add(renderObject);
    } else {
        // Update mutable references that may have changed
        renderObject.camera = camera;
        renderObject.scene = scene;
        renderObject.passId = passId;
    }

    return renderObject;
}

/**
 * Initialize a RenderObject for rendering.
 *
 * This ensures the RenderObject has:
 * - NodeBuilderState (compiled shader)
 * - Pipeline
 * - Bindings
 * - Geometry attributes uploaded
 *
 * Call this before rendering with a RenderObject.
 *
 * @param state - The RenderObjects state
 * @param renderObject - The RenderObject to initialize
 * @param colorFormat - The color texture format for pipeline creation
 * @param depthFormat - The depth texture format for pipeline creation
 * @returns true if initialization succeeded
 */
export function initRenderObject(
    state: RenderObjectsState,
    renderObject: RenderObject,
    colorFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat | null,
): boolean {
    const material = renderObject.material;
    const geometry = renderObject.geometry;
    const renderContext = renderObject.renderContext;

    // Compute current cache key
    const cacheKey = computeRenderObjectCacheKey(material, geometry, renderContext);

    // Check if we need to (re)compile
    if (needsNodeUpdate(state.nodes, renderObject, cacheKey)) {
        // Compile node graph
        const { compileResult } = compileNodeState(state.nodes, renderObject, cacheKey);
        // [graph-tab] fire snapshot callback after compile
        if (state.onGraphSnapshot) {
            state.onGraphSnapshot(_buildGraphSnapshot(cacheKey, compileResult));
        }
    }

    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) {
        console.warn('[RenderObjects] Failed to compile NodeBuilderState');
        return false;
    }

    // Initialize bindings (creates bind group layouts)
    initBindings(state.bindings, renderObject);

    // Get bind group layouts for pipeline creation
    const bindGroupLayouts = getBindGroupLayouts(state.bindings, renderObject);

    // Check if we need to create/update pipeline
    if (!renderObject.pipeline) {
        // Create pipeline using the unified pipelines system (sync)
        const entry = pipelines.getForRender(
            state.pipelines,
            renderObject,
            bindGroupLayouts,
            colorFormat,
            depthFormat,
            null, // sync
        );
        renderObject.pipeline = entry.pipeline;
    }

    // Update geometry attributes
    updateGeometry(state.geometries, renderObject);

    return true;
}

/**
 * Update a RenderObject for rendering.
 *
 * This is called each frame to:
 * - Update uniform buffers
 * - Rebuild bind groups if needed
 *
 * @param state - The RenderObjects state
 * @param renderObject - The RenderObject to update
 * @param camera - Current camera
 * @param elapsed - Elapsed time
 * @param delta - Delta time
 * @param width - Render width
 * @param height - Render height
 */
export function updateRenderObject(state: RenderObjectsState, renderObject: RenderObject, frame: NodeFrame): void {
    // Update bindings (uniforms, bind groups)
    updateBindings(state.bindings, renderObject, frame);

    // Update geometry if needed
    updateGeometry(state.geometries, renderObject);
}

/**
 * Initialize a RenderObject for pre-warming with async pipeline compilation.
 *
 * This is similar to initRenderObject but collects pipeline compilation promises
 * for non-blocking compilation. Use this in renderer.compile() to pre-warm all
 * pipelines without blocking the main thread.
 *
 * @param state - The RenderObjects state
 * @param renderObject - The RenderObject to initialize
 * @param colorFormat - The color texture format for pipeline creation
 * @param depthFormat - The depth texture format for pipeline creation
 * @param promises - Array to collect async compilation promises
 * @returns true if initialization succeeded (pipeline may still be compiling)
 */
export function initRenderObjectWithPromises(
    state: RenderObjectsState,
    renderObject: RenderObject,
    colorFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat | null,
    promises: Promise<void>[],
): boolean {
    const material = renderObject.material;
    const geometry = renderObject.geometry;
    const renderContext = renderObject.renderContext;

    // Compute current cache key
    const cacheKey = computeRenderObjectCacheKey(material, geometry, renderContext);

    // Check if we need to (re)compile
    if (needsNodeUpdate(state.nodes, renderObject, cacheKey)) {
        // Compile node graph (sync - this is fast)
        const { compileResult } = compileNodeState(state.nodes, renderObject, cacheKey);
        // [graph-tab] fire snapshot callback after compile
        if (state.onGraphSnapshot) {
            state.onGraphSnapshot(_buildGraphSnapshot(cacheKey, compileResult));
        }
    }

    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) {
        console.warn('[RenderObjects] Failed to compile NodeBuilderState');
        return false;
    }

    // Initialize bindings (creates bind group layouts)
    initBindings(state.bindings, renderObject);

    // Get bind group layouts for pipeline creation
    const bindGroupLayouts = getBindGroupLayouts(state.bindings, renderObject);

    // Check if we need to create/update pipeline
    if (!renderObject.pipeline) {
        // Create pipeline asynchronously using the unified pipelines system
        const entry = pipelines.getForRender(
            state.pipelines,
            renderObject,
            bindGroupLayouts,
            colorFormat,
            depthFormat,
            promises, // async - will push promise to array
        );
        // Pipeline will be set when promise resolves, but we track the entry
        // The actual pipeline assignment happens after promises resolve
        promises.push(
            Promise.resolve().then(() => {
                if (entry.pipeline) {
                    renderObject.pipeline = entry.pipeline;
                }
            }),
        );
    }

    // Update geometry attributes
    updateGeometry(state.geometries, renderObject);

    return true;
}

// [graph-tab] Build a GraphSnapshot from a CompileResult + cacheKey.
// This is the only place in render-objects.ts that touches graph-tab types.
function _buildGraphSnapshot(label: string, compileResult: CompileResult): GraphSnapshot {
    const inspectableIds = new Set<string>();
    for (const [id, node] of compileResult.graphNodes) {
        if (node.kind === 'inspector') inspectableIds.add(id);
    }
    return {
        label,
        allNodes: compileResult.graphNodes,
        edges: compileResult.graphEdges,
        info: compileResult.graphInfo,
        inspectableIds,
    };
}

// Re-export buildVertexBufferLayouts from pipelines.ts for backwards compatibility
export { buildVertexBufferLayouts } from './pipelines';

/**
 * Dispose a specific RenderObject.
 */
export function disposeRenderObjectFromState(_state: RenderObjectsState, renderObject: RenderObject): void {
    disposeRenderObject(renderObject);
}

/**
 * Dispose all RenderObjects for a specific mesh.
 */
export function disposeRenderObjectsForMesh(state: RenderObjectsState, mesh: Mesh): void {
    for (const renderObject of state.renderObjects) {
        if (renderObject.mesh === mesh) {
            disposeRenderObject(renderObject);
        }
    }
}

/**
 * Dispose all RenderObjects for a specific material.
 */
export function disposeRenderObjectsForMaterial(state: RenderObjectsState, material: Material): void {
    for (const renderObject of state.renderObjects) {
        if (renderObject.material === material) {
            disposeRenderObject(renderObject);
        }
    }
}

/**
 * Dispose all RenderObjects.
 */
export function disposeAllRenderObjects(state: RenderObjectsState): void {
    for (const renderObject of state.renderObjects) {
        disposeRenderObject(renderObject);
    }
    state.renderObjects.clear();
    state.chainMaps.clear();
}

/**
 * Get statistics about RenderObjects.
 */
export function getRenderObjectsStats(state: RenderObjectsState): {
    total: number;
    perPass: Record<string, number>;
} {
    const perPass: Record<string, number> = {};

    // Count render objects per pass (approximate - we can't enumerate ChainMap)
    for (const passId of state.chainMaps.keys()) {
        perPass[passId] = 0;
    }

    // Count from the set
    for (const ro of state.renderObjects) {
        const p = ro.passId || 'default';
        if (p in perPass) perPass[p]++;
        else perPass[p] = 1;
    }

    return {
        total: state.renderObjects.size,
        perPass,
    };
}
