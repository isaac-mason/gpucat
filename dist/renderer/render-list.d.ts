/**
 * render-list.ts - Sorted render item list with object pooling and scene collection.
 *
 * Aligned with Three.js RenderList + RenderLists:
 * - Object pooling for RenderItems (avoids GC pressure)
 * - Sorted opaque and transparent lists
 * - Cached per scene/camera using ChainMap
 * - Frustum culling integration
 * - Scene graph traversal
 *
 * RenderList collects meshes from a scene graph and sorts them for rendering:
 * - Opaque: sorted by material/pipeline key to minimize state changes
 * - Transparent: sorted back-to-front by view-space Z
 */
import type { Camera } from 'gpucat/dist/camera/camera';
import type { Object3D } from 'gpucat/dist/core/object3d';
import { Mesh } from 'gpucat/dist/objects/mesh';
import * as chainMap from 'gpucat/dist/renderer/chain-map';
import type { Geometry } from 'gpucat/dist/geometry/geometry';
import type { Material } from 'gpucat/dist/material/material';
/**
 * RenderItem - A single item in the render list.
 *
 * Pooled and reused across frames to avoid GC pressure.
 */
export type RenderItem = {
    /** Unique ID for this item (stable across frames). */
    id: number;
    /** The mesh to render. */
    mesh: Mesh | null;
    /** The geometry (cached from mesh.geometry). */
    geometry: Geometry | null;
    /** The material (cached from mesh.material). */
    material: Material | null;
    /** Group order for render order sorting (layer-based). */
    groupOrder: number;
    /** Render order for manual sorting. */
    renderOrder: number;
    /**
     * View-space Z coordinate.
     * Used for transparent sorting (back-to-front).
     */
    z: number;
};
/**
 * RenderList - Contains sorted lists of render items.
 */
export type RenderList = {
    /** The object this list was built from (Scene, Mesh, or any Object3D). */
    object: Object3D | null;
    /** The camera this list was built for. */
    camera: Camera | null;
    /** Pool of RenderItems (reused across frames). */
    renderItems: RenderItem[];
    /** Current index into the pool (number of active items). */
    renderItemsIndex: number;
    /** Opaque items (sorted by pipeline key). */
    opaque: RenderItem[];
    /** Transparent items (sorted back-to-front by Z). */
    transparent: RenderItem[];
    /** Number of items performing occlusion queries (future use). */
    occlusionQueryCount: number;
};
/**
 * RenderListsState - manages RenderList caching.
 */
export type RenderListsState = {
    /** ChainMap cache for RenderLists by (scene, camera). */
    lists: chainMap.ChainMap<RenderList>;
};
/**
 * Create a new RenderList.
 */
export declare function createRenderList(): RenderList;
/**
 * Create a new RenderLists state.
 */
export declare function createRenderListsState(): RenderListsState;
/**
 * Get or create a RenderList for the given object and camera.
 *
 * @param state - The RenderLists state
 * @param object - The object to render (Scene, Mesh, or any Object3D)
 * @param camera - The camera to render from
 */
export declare function getRenderList(state: RenderListsState, object: Object3D, camera: Camera): RenderList;
/**
 * Begin building a render list for a new frame.
 *
 * This resets the pool index but keeps pooled items for reuse.
 */
export declare function beginRenderList(list: RenderList, object: Object3D, camera: Camera): void;
/**
 * Push a mesh into the render list.
 *
 * @param list - The RenderList
 * @param mesh - The mesh to add
 * @param geometry - The mesh's geometry
 * @param material - The mesh's material
 * @param groupOrder - Group order for layer-based sorting
 * @param z - View-space Z for transparent sorting
 */
export declare function pushRenderItem(list: RenderList, mesh: Mesh, geometry: Geometry, material: Material, groupOrder: number, z: number): void;
/**
 * Finish building the render list.
 *
 * This doesn't do anything special currently, but could be used
 * for finalization tasks.
 */
export declare function finishRenderList(_list: RenderList): void;
/**
 * Sort the render list.
 *
 * @param list - The RenderList to sort
 * @param customOpaqueSort - Optional custom sort for opaque items
 * @param customTransparentSort - Optional custom sort for transparent items
 */
export declare function sortRenderList(list: RenderList, customOpaqueSort?: (a: RenderItem, b: RenderItem) => number, customTransparentSort?: (a: RenderItem, b: RenderItem) => number): void;
/**
 * Default sort for opaque items.
 *
 * Sort priority (matches Three.js painterSortStable):
 * 1. groupOrder (render layers)
 * 2. renderOrder (manual ordering)
 * 3. Z (front-to-back for early-z rejection)
 * 4. ID (stability)
 *
 * Note: Three.js does NOT sort by material/pipeline. Pipeline switching is
 * minimized at draw time by tracking the active pipeline in setPipeline().
 */
export declare function painterSortStable(a: RenderItem, b: RenderItem): number;
/**
 * Default sort for transparent items (back-to-front).
 *
 * "Reverse painter sort stable" - sorts back-to-front for proper alpha blending.
 */
export declare function reversePainterSortStable(a: RenderItem, b: RenderItem): number;
/**
 * Collect all visible meshes from a scene into a RenderList.
 *
 * This walks the object graph, performs frustum culling, and populates
 * the RenderList with opaque and transparent items.
 *
 * @param state - The RenderLists state
 * @param object - The object to collect from (Scene, Mesh, or any Object3D)
 * @param camera - The camera for frustum culling and Z sorting
 * @param overrideMaterial - When set, all meshes use this material instead of their own
 * @returns The populated and sorted RenderList
 */
export declare function collectRenderList(state: RenderListsState, object: Object3D, camera: Camera, overrideMaterial?: Material | null): RenderList;
/**
 * Collect and sort with custom sort functions.
 */
export declare function collectRenderListWithSort(state: RenderListsState, object: Object3D, camera: Camera, opaqueSort?: (a: RenderItem, b: RenderItem) => number, transparentSort?: (a: RenderItem, b: RenderItem) => number, overrideMaterial?: Material | null): RenderList;
/**
 * Get render list statistics.
 */
export declare function getRenderListStats(list: RenderList): {
    opaque: number;
    transparent: number;
    total: number;
    poolSize: number;
};
/**
 * Get statistics about all cached RenderLists.
 */
export declare function getRenderListsStats(_state: RenderListsState): {
    cachedLists: number;
};
