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
export declare function createRenderObjectsState(): RenderObjectsState;
/**
 * Get or create a RenderObject for the given parameters.
 *
 * This is the main entry point for obtaining a RenderObject. It:
 * 1. Looks up existing RenderObject in the nested WeakMap cache
 * 2. Creates new RenderObject if not found
 */
export declare function getRenderObject(state: RenderObjectsState, mesh: Mesh, material: Material, scene: Object3D, camera: Camera, renderContext: RenderContext, passId?: string): RenderObject;
/** Dispose all RenderObjects for a specific mesh. */
export declare function disposeRenderObjectsForMesh(state: RenderObjectsState, mesh: Mesh): void;
/** Dispose all RenderObjects for a specific material. */
export declare function disposeRenderObjectsForMaterial(state: RenderObjectsState, material: Material): void;
/** Dispose all RenderObjects. */
export declare function disposeAllRenderObjects(state: RenderObjectsState): void;
/** Get statistics about RenderObjects. */
export declare function getRenderObjectsStats(state: RenderObjectsState): {
    total: number;
    perPass: Record<string, number>;
};
export {};
