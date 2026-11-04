/**
 * The meshes of a tree a camera sees, frustum culled, opaque apart from transparent, with pooled items cached per
 * (tree, camera). The pass's bins order them (`draw-scene.ts`).
 */
import type { Object3D } from '../../core/object3d';
import type { Geometry } from '../../geometry/geometry';
import type { Material } from '../../material/material';
import type { Mesh } from '../../objects/mesh';
import type { View } from './view';
/** A mesh the walk found, pooled and reused across frames. */
export type RenderItem = {
    /** The mesh to render. */
    mesh: Mesh | null;
    /** The geometry (cached from mesh.geometry). */
    geometry: Geometry | null;
    /** The material (cached from mesh.material). */
    material: Material | null;
};
/**
 * RenderList - Contains sorted lists of render items.
 */
export type RenderList = {
    /** The object this list was built from (Scene, Mesh, or any Object3D). */
    object: Object3D | null;
    /** The camera this list was built for. */
    camera: View | null;
    /** Pool of RenderItems (reused across frames). */
    renderItems: RenderItem[];
    /** Current index into the pool (number of active items). */
    renderItemsIndex: number;
    /** Opaque items, in walk order. */
    opaque: RenderItem[];
    /** Transparent items, in walk order. */
    transparent: RenderItem[];
};
/**
 * RenderListsState - manages RenderList caching.
 */
export type RenderListsState = {
    /** Nested WeakMap cache for RenderLists by (object -> camera). */
    lists: WeakMap<Object3D, WeakMap<View, RenderList>>;
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
export declare function getRenderList(state: RenderListsState, object: Object3D, camera: View): RenderList;
/**
 * Begin building a render list for a new frame.
 *
 * This resets the pool index but keeps pooled items for reuse.
 */
export declare function beginRenderList(list: RenderList, object: Object3D, camera: View): void;
/** Push a mesh into the render list, with the transparent ones if its material is. */
export declare function pushRenderItem(list: RenderList, mesh: Mesh, geometry: Geometry, material: Material): void;
/**
 * Collect all visible meshes from a scene into a RenderList.
 *
 * This walks the object graph, performs frustum culling, and populates
 * the RenderList with opaque and transparent items.
 *
 * @param state - The RenderLists state
 * @param object - The object to collect from (Scene, Mesh, or any Object3D)
 * @param camera - The camera for frustum culling
 * @returns The populated RenderList
 */
export declare function collectRenderList(state: RenderListsState, object: Object3D, camera: View): RenderList;
