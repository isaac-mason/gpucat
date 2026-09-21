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
export declare function createRenderObjectsState(): RenderObjectsState;
export declare function getRenderObject(state: RenderObjectsState, mesh: Mesh, material: Material, camera: View, renderContext: RenderContext): RenderObject;
/** Dispose all RenderObjects for a specific mesh. */
export declare function disposeRenderObjectsForMesh(state: RenderObjectsState, mesh: Mesh): void;
/** Dispose all RenderObjects for a specific material. */
export declare function disposeRenderObjectsForMaterial(state: RenderObjectsState, material: Material): void;
/** Dispose all RenderObjects. */
export declare function disposeAllRenderObjects(state: RenderObjectsState): void;
/** Get statistics about RenderObjects. */
export declare function getRenderObjectsStats(state: RenderObjectsState): {
    total: number;
};
export {};
