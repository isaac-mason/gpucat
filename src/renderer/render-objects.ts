/**
 * render-objects.ts - RenderObject manager with ChainMap caching.
 *
 * Coordinates initialization of NodeBuilderState, pipeline, bindings.
 * Subsystem dependencies (nodes, geometries, bindings, pipelines, device,
 * bufferCache, textureCache) are passed as function parameters — not stored
 * in state.
 */

import type { Camera } from '../camera/camera';
import type { Material } from '../material/material';
import type { Mesh } from '../objects/mesh';
import type { Object3D } from '../core/object3d';
import type { BindingsState } from './bindings';
import { getRenderBindGroupLayouts, initRenderBindings, updateRenderBindings } from './bindings';
import type { BufferCache } from './buffers';
import * as chainMap from './chain-map';
import type { GeometriesState } from './geometries';
import { updateForRender as updateGeometry } from './geometries';
import type { NodeFrame } from './node-frame';
import type { NodeManagerState } from './node-manager';
import { compileNodeState, needsNodeUpdate } from './node-manager';
import * as pipelines from './pipelines';
import type { RenderContext } from './pass-context';
import type { RenderObject } from './render-object';
import { computeRenderObjectCacheKey, createRenderObject, disposeRenderObject } from './render-object';
import type { TextureCache } from './textures';

/**
 * RenderObjects state — owns only the caching structures.
 * All subsystem deps are passed to functions that need them.
 */
export type RenderObjectsState = {
    /**
     * Per-pass ChainMaps for RenderObject caching.
     * Each passId (e.g., 'default', 'shadow', 'reflection') gets its own ChainMap.
     */
    chainMaps: Map<string, chainMap.ChainMap<RenderObject>>;

    /** All active RenderObjects (for iteration/disposal). */
    renderObjects: Set<RenderObject>;
};

/**
 * Create a new RenderObjects state.
 */
export function createRenderObjectsState(): RenderObjectsState {
    return {
        chainMaps: new Map(),
        renderObjects: new Set(),
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
 */
export function getRenderObject(
    state: RenderObjectsState,
    mesh: Mesh,
    material: Material,
    scene: Object3D,
    camera: Camera,
    renderContext: RenderContext,
    passId: string = 'default',
): RenderObject {
    const map = getChainMap(state, passId);
    const keys = [mesh, material, renderContext];

    // Try to get existing RenderObject
    let renderObject = chainMap.get(map, keys);

    if (!renderObject) {
        // Create new RenderObject
        renderObject = createRenderObject(mesh, material, scene, camera, renderContext);

        // Compute and store initial cache key
        renderObject.initialCacheKey = computeRenderObjectCacheKey(material, mesh.geometry, renderContext);

        // Tag with the pass this RO belongs to
        renderObject.passId = passId;

        // Set up disposal callback
        renderObject.onDispose = () => {
            chainMap.del(map, keys);
            state.renderObjects.delete(renderObject!);
        };

        // Set up material disposal callback (like geometries.ts does for geometry)
        if (!material._onDispose) {
            material._onDispose = () => {
                disposeRenderObjectsForMaterial(state, material);
            };
        }

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
 * @returns true if initialization succeeded
 */
export function initRenderObject(
    nodes: NodeManagerState,
    geometriesState: GeometriesState,
    bindingsState: BindingsState,
    pipelinesState: pipelines.PipelinesState,
    device: GPUDevice,
    bufferCache: BufferCache,
    renderObject: RenderObject,
    colorFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat | null,
): boolean {
    const material = renderObject.material;
    const geometry = renderObject.geometry;
    const renderContext = renderObject.renderContext;

    // Check if we need to (re)compile using fast version comparison
    if (needsNodeUpdate(nodes, renderObject)) {
        // Only compute cache key when we actually need to recompile
        const cacheKey = computeRenderObjectCacheKey(material, geometry, renderContext);
        // Compile node graph
        compileNodeState(nodes, renderObject, cacheKey);
    }

    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) {
        console.warn('[RenderObjects] Failed to compile NodeBuilderState');
        return false;
    }

    // Initialize bindings (creates bind group layouts)
    initRenderBindings(bindingsState, renderObject, device);

    // Get bind group layouts for pipeline creation
    const bindGroupLayouts = getRenderBindGroupLayouts(bindingsState, renderObject);

    // Check if we need to create/update pipeline
    if (!renderObject.pipeline) {
        // Create pipeline using the unified pipelines system (sync)
        const entry = pipelines.getForRender(
            pipelinesState,
            device,
            renderObject,
            bindGroupLayouts,
            colorFormat,
            depthFormat,
            null, // sync
        );
        renderObject.pipeline = entry.pipeline;
    }

    // Update geometry attributes
    updateGeometry(geometriesState, bufferCache, device, renderObject);

    return true;
}

/**
 * Update a RenderObject for rendering.
 *
 * This is called each frame to:
 * - Update uniform buffers
 * - Rebuild bind groups if needed
 */
export function updateRenderObject(
    bindingsState: BindingsState,
    geometriesState: GeometriesState,
    device: GPUDevice,
    bufferCache: BufferCache,
    textureCache: TextureCache,
    renderObject: RenderObject,
    frame: NodeFrame,
): void {
    // Update bindings (uniforms, bind groups)
    updateRenderBindings(bindingsState, renderObject, frame, device, bufferCache, textureCache);

    // Update geometry if needed
    updateGeometry(geometriesState, bufferCache, device, renderObject);
}

/**
 * Initialize a RenderObject for pre-warming with async pipeline compilation.
 *
 * This is similar to initRenderObject but collects pipeline compilation promises
 * for non-blocking compilation. Use this in renderer.compile() to pre-warm all
 * pipelines without blocking the main thread.
 *
 * @returns true if initialization succeeded (pipeline may still be compiling)
 */
export function initRenderObjectWithPromises(
    nodes: NodeManagerState,
    geometriesState: GeometriesState,
    bindingsState: BindingsState,
    pipelinesState: pipelines.PipelinesState,
    device: GPUDevice,
    bufferCache: BufferCache,
    renderObject: RenderObject,
    colorFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat | null,
    promises: Promise<void>[],
): boolean {
    const material = renderObject.material;
    const geometry = renderObject.geometry;
    const renderContext = renderObject.renderContext;

    // Check if we need to (re)compile using fast version comparison
    if (needsNodeUpdate(nodes, renderObject)) {
        // Only compute cache key when we actually need to recompile
        const cacheKey = computeRenderObjectCacheKey(material, geometry, renderContext);
        // Compile node graph (sync - this is fast)
        compileNodeState(nodes, renderObject, cacheKey);
    }

    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) {
        console.warn('[RenderObjects] Failed to compile NodeBuilderState');
        return false;
    }

    // Initialize bindings (creates bind group layouts)
    initRenderBindings(bindingsState, renderObject, device);

    // Get bind group layouts for pipeline creation
    const bindGroupLayouts = getRenderBindGroupLayouts(bindingsState, renderObject);

    // Check if we need to create/update pipeline
    if (!renderObject.pipeline) {
        // Create pipeline asynchronously using the unified pipelines system
        const entry = pipelines.getForRender(
            pipelinesState,
            device,
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
    updateGeometry(geometriesState, bufferCache, device, renderObject);

    return true;
}

/** Dispose all RenderObjects for a specific mesh. */
export function disposeRenderObjectsForMesh(state: RenderObjectsState, mesh: Mesh): void {
    for (const renderObject of state.renderObjects) {
        if (renderObject.mesh === mesh) {
            disposeRenderObject(renderObject);
        }
    }
}

/** Dispose all RenderObjects for a specific material. */
export function disposeRenderObjectsForMaterial(state: RenderObjectsState, material: Material): void {
    for (const renderObject of state.renderObjects) {
        if (renderObject.material === material) {
            disposeRenderObject(renderObject);
        }
    }
}

/** Dispose all RenderObjects. */
export function disposeAllRenderObjects(state: RenderObjectsState): void {
    for (const renderObject of state.renderObjects) {
        disposeRenderObject(renderObject);
    }
    state.renderObjects.clear();
    state.chainMaps.clear();
}

/** Get statistics about RenderObjects. */
export function getRenderObjectsStats(state: RenderObjectsState): {
    total: number;
    perPass: Record<string, number>;
} {
    const perPass: Record<string, number> = {};

    // count render objects per pass (approximate - we can't enumerate ChainMap)
    for (const passId of state.chainMaps.keys()) {
        perPass[passId] = 0;
    }

    // count from the set
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
