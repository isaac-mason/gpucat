/**
 * render-objects.ts (core) - neutral RenderObject cache with nested WeakMap keying.
 *
 * Owns the cache and the live set. Device work (compile, pipeline/bindings/geometry upload) lives on
 * the backend, which takes these `RenderObject`s; this module never references a device or a concrete
 * graphics API, so both backends share one cache.
 *
 * WeakMaps mean a cached RenderObject is released when any of its key objects is collected.
 */

import type { Material } from '../../material/material';
import type { Mesh } from '../../objects/mesh';
import type { RenderContext } from './pass-context';
import type { RenderObject } from './render-object';
import { createRenderObject, disposeRenderObject } from './render-object';
import type { View } from './view';

/** mesh -> material -> renderContext -> RenderObject. */
type RenderObjectCache = WeakMap<Mesh, WeakMap<Material, WeakMap<RenderContext, RenderObject>>>;

/**
 * RenderObjects state, owns only the caching structures.
 * All subsystem deps are passed to functions that need them.
 */
export type RenderObjectsState = {
    /** One (mesh -> material -> renderContext) chain: a pass's label is not part of the identity. */
    cache: RenderObjectCache;

    /** All active RenderObjects (for iteration/disposal). */
    renderObjects: Set<RenderObject>;
};

export function createRenderObjectsState(): RenderObjectsState {
    return {
        cache: new WeakMap(),
        renderObjects: new Set(),
    };
}

export function getRenderObject(
    state: RenderObjectsState,
    mesh: Mesh,
    material: Material,
    camera: View,
    renderContext: RenderContext,
): RenderObject {
    const { cache } = state;

    // Try to get existing RenderObject: mesh -> material -> renderContext.
    const materialMap = cache.get(mesh);
    const contextMap = materialMap?.get(material);
    let renderObject = contextMap?.get(renderContext);

    if (!renderObject) {
        // Create new RenderObject
        renderObject = createRenderObject(mesh, material, camera, renderContext);

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
        renderObject.camera = camera;
        if (renderObject.geometry !== mesh.geometry) {
            // Both caches version the geometry they were built from, so neither can see a swap: a fresh
            // Geometry can carry the same version the stale entry was built at. Invalidated by hand.
            renderObject.geometry = mesh.geometry;
            renderObject.geometryVersion = -1;
            renderObject._cachedPipelineKey = null;
        }
    }

    return renderObject;
}

/** Dispose all RenderObjects for a specific material. */
export function disposeRenderObjectsForMaterial(state: RenderObjectsState, material: Material): void {
    for (const renderObject of state.renderObjects) {
        if (renderObject.material === material) {
            disposeRenderObject(renderObject);
        }
    }
}

/** Get statistics about RenderObjects. */
export function getRenderObjectsStats(state: RenderObjectsState): { total: number } {
    return { total: state.renderObjects.size };
}
