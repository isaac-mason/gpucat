/**
 * render-objects.ts (core) - neutral RenderObject cache with nested WeakMap keying.
 *
 * Owns only the caching structures (per-pass nested WeakMaps + the live set). All device
 * work (compile, pipeline/bindings/geometry upload) lives on the backend; this module never
 * references a device or a concrete graphics API. The backend's device-side per-object
 * init/update helpers take these `RenderObject`s but the cache itself is backend-agnostic,
 * so both current (WebGPU) and future (WebGL2) renderers share one cache.
 *
 * Each passId (e.g., 'render', 'shadow', 'reflection') maps to a chain of WeakMaps keyed by
 * (mesh -> material -> renderContext). Using WeakMaps means the cached RenderObject is
 * released automatically when any of its key objects is garbage collected.
 */

import type { Camera } from '../../camera/camera';
import type { Object3D } from '../../core/object3d';
import type { Material } from '../../material/material';
import type { Mesh } from '../../objects/mesh';
import type { RenderContext } from './pass-context';
import type { RenderObject } from './render-object';
import { computeRenderObjectCacheKey, createRenderObject, disposeRenderObject } from './render-object';

/**
 * Nested WeakMap chain for a single pass:
 * mesh -> material -> renderContext -> RenderObject.
 */
type RenderObjectCache = WeakMap<Mesh, WeakMap<Material, WeakMap<RenderContext, RenderObject>>>;

/**
 * RenderObjects state, owns only the caching structures.
 * All subsystem deps are passed to functions that need them.
 */
export type RenderObjectsState = {
    /**
     * Per-pass nested WeakMap caches for RenderObjects.
     * Each passId (e.g., 'render', 'shadow', 'reflection') gets its own
     * (mesh -> material -> renderContext) WeakMap chain.
     */
    passCaches: Map<string, RenderObjectCache>;

    /** All active RenderObjects (for iteration/disposal). */
    renderObjects: Set<RenderObject>;
};

/**
 * Create a new RenderObjects state.
 */
export function createRenderObjectsState(): RenderObjectsState {
    return {
        passCaches: new Map(),
        renderObjects: new Set(),
    };
}

/**
 * Get or create the nested WeakMap cache for a pass.
 */
function getPassCache(state: RenderObjectsState, passId: string): RenderObjectCache {
    let cache = state.passCaches.get(passId);
    if (!cache) {
        cache = new WeakMap();
        state.passCaches.set(passId, cache);
    }
    return cache;
}

/**
 * Get or create a RenderObject for the given parameters.
 *
 * This is the main entry point for obtaining a RenderObject. It:
 * 1. Looks up existing RenderObject in the nested WeakMap cache
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
    const cache = getPassCache(state, passId);

    // Try to get existing RenderObject: mesh -> material -> renderContext.
    const materialMap = cache.get(mesh);
    const contextMap = materialMap?.get(material);
    let renderObject = contextMap?.get(renderContext);

    if (!renderObject) {
        // Create new RenderObject
        renderObject = createRenderObject(mesh, material, scene, camera, renderContext);

        // Compute and store initial cache key
        renderObject.initialCacheKey = computeRenderObjectCacheKey(material, mesh.geometry, renderContext);

        // Tag with the pass this RO belongs to
        renderObject.passId = passId;

        // Set up disposal callback: walk the nested chain and delete the leaf.
        renderObject.onDispose = () => {
            cache.get(mesh)?.get(material)?.delete(renderContext);
            state.renderObjects.delete(renderObject!);
        };

        // Set up material disposal callback (like geometries.ts does for geometry)
        if (!material._onDispose) {
            material._onDispose = () => {
                disposeRenderObjectsForMaterial(state, material);
            };
        }

        // Cache it: create intermediate WeakMaps as needed.
        let mMap = materialMap;
        if (!mMap) {
            mMap = new WeakMap();
            cache.set(mesh, mMap);
        }
        let cMap = contextMap;
        if (!cMap) {
            cMap = new WeakMap();
            mMap.set(material, cMap);
        }
        cMap.set(renderContext, renderObject);
        state.renderObjects.add(renderObject);
    } else {
        // Update mutable references that may have changed
        renderObject.camera = camera;
        renderObject.scene = scene;
        renderObject.passId = passId;
    }

    return renderObject;
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
    state.passCaches.clear();
}

/** Get statistics about RenderObjects. */
export function getRenderObjectsStats(state: RenderObjectsState): {
    total: number;
    perPass: Record<string, number>;
} {
    const perPass: Record<string, number> = {};

    // count render objects per pass (approximate - we can't enumerate WeakMaps)
    for (const passId of state.passCaches.keys()) {
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
