/**
 * render-list.ts - Sorted render item list with object pooling and scene collection.
 *
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

import type { Camera } from '../camera/camera';
import type { Object3D } from '../core/object3d';
import type { Box3, Sphere } from 'mathcat';
import { box3 } from 'mathcat';
import { Mesh } from '../objects/mesh';
import * as chainMap from './chain-map';
import * as frustum from '../math/frustum';
import type { Geometry } from '../geometry/geometry';
import type { Material } from '../material/material';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

    // -------------------------------------------------------------------------
    // Object Pool
    // -------------------------------------------------------------------------

    /** Pool of RenderItems (reused across frames). */
    renderItems: RenderItem[];

    /** Current index into the pool (number of active items). */
    renderItemsIndex: number;

    // -------------------------------------------------------------------------
    // Sorted Lists
    // -------------------------------------------------------------------------

    /** Opaque items (sorted by pipeline key). */
    opaque: RenderItem[];

    /** Transparent items (sorted back-to-front by Z). */
    transparent: RenderItem[];

    // -------------------------------------------------------------------------
    // Statistics
    // -------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/** ID counter for RenderItems. */
let renderItemIdCounter = 0;

/**
 * Create a new RenderList.
 */
export function createRenderList(): RenderList {
    return {
        object: null,
        camera: null,
        renderItems: [],
        renderItemsIndex: 0,
        opaque: [],
        transparent: [],
        occlusionQueryCount: 0,
    };
}

/**
 * Create a new RenderLists state.
 */
export function createRenderListsState(): RenderListsState {
    return {
        lists: chainMap.create<RenderList>(),
    };
}

// ---------------------------------------------------------------------------
// RenderList Access
// ---------------------------------------------------------------------------

/**
 * Get or create a RenderList for the given object and camera.
 *
 * @param state - The RenderLists state
 * @param object - The object to render (Scene, Mesh, or any Object3D)
 * @param camera - The camera to render from
 */
export function getRenderList(
    state: RenderListsState,
    object: Object3D,
    camera: Camera,
): RenderList {
    const keys = [object, camera];

    let list = chainMap.get(state.lists, keys);
    if (!list) {
        list = createRenderList();
        chainMap.set(state.lists, keys, list);
    }

    return list;
}

// ---------------------------------------------------------------------------
// List Management
// ---------------------------------------------------------------------------

/**
 * Begin building a render list for a new frame.
 *
 * This resets the pool index but keeps pooled items for reuse.
 */
export function beginRenderList(list: RenderList, object: Object3D, camera: Camera): void {
    list.object = object;
    list.camera = camera;
    list.renderItemsIndex = 0;
    list.opaque.length = 0;
    list.transparent.length = 0;
    list.occlusionQueryCount = 0;
}

/**
 * Get a RenderItem from the pool (or create a new one).
 */
function getNextRenderItem(list: RenderList): RenderItem {
    const index = list.renderItemsIndex;

    let item = list.renderItems[index];
    if (item === undefined) {
        item = {
            id: renderItemIdCounter++,
            mesh: null,
            geometry: null,
            material: null,
            groupOrder: 0,
            renderOrder: 0,
            z: 0,
        };
        list.renderItems.push(item);
    }

    list.renderItemsIndex++;
    return item;
}

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
export function pushRenderItem(
    list: RenderList,
    mesh: Mesh,
    geometry: Geometry,
    material: Material,
    groupOrder: number,
    z: number,
): void {
    const item = getNextRenderItem(list);

    item.mesh = mesh;
    item.geometry = geometry;
    item.material = material;
    item.groupOrder = groupOrder;
    item.renderOrder = mesh.renderOrder;
    item.z = z;

    if (material.transparent) {
        list.transparent.push(item);
    } else {
        list.opaque.push(item);
    }
}

/**
 * Finish building the render list.
 *
 * This doesn't do anything special currently, but could be used
 * for finalization tasks.
 */
export function finishRenderList(_list: RenderList): void {
    // Future: could reset unused pool items to null references for GC
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * Sort the render list.
 *
 * @param list - The RenderList to sort
 * @param customOpaqueSort - Optional custom sort for opaque items
 * @param customTransparentSort - Optional custom sort for transparent items
 */
export function sortRenderList(
    list: RenderList,
    customOpaqueSort?: (a: RenderItem, b: RenderItem) => number,
    customTransparentSort?: (a: RenderItem, b: RenderItem) => number,
): void {
    if (list.opaque.length > 1) {
        list.opaque.sort(customOpaqueSort ?? painterSortStable);
    }

    if (list.transparent.length > 1) {
        list.transparent.sort(customTransparentSort ?? reversePainterSortStable);
    }
}

/**
 * Default sort for opaque items.
 *
 * Sort priority:
 * 1. groupOrder (render layers)
 * 2. renderOrder (manual ordering)
 * 3. Z (front-to-back for early-z rejection)
 * 4. ID (stability)
 *
 * Note: we do NOT sort by material/pipeline. Pipeline switching is
 * minimized at draw time by tracking the active pipeline in setPipeline().
 */
export function painterSortStable(a: RenderItem, b: RenderItem): number {
    if (a.groupOrder !== b.groupOrder) {
        return a.groupOrder - b.groupOrder;
    }

    if (a.renderOrder !== b.renderOrder) {
        return a.renderOrder - b.renderOrder;
    }

    if (a.z !== b.z) {
        return a.z - b.z;
    }

    return a.id - b.id;
}

/**
 * Default sort for transparent items (back-to-front).
 *
 * "Reverse painter sort stable" - sorts back-to-front for proper alpha blending.
 */
export function reversePainterSortStable(a: RenderItem, b: RenderItem): number {
    // Sort by groupOrder first (render layers)
    if (a.groupOrder !== b.groupOrder) {
        return a.groupOrder - b.groupOrder;
    }

    // Then by renderOrder
    if (a.renderOrder !== b.renderOrder) {
        return a.renderOrder - b.renderOrder;
    }

    // Then by Z (back-to-front for transparent = larger Z first)
    if (a.z !== b.z) {
        return b.z - a.z;
    }

    // Finally by ID for stability
    return a.id - b.id;
}

// ---------------------------------------------------------------------------
// Scene Collection
// ---------------------------------------------------------------------------

/** Frustum used for culling; rebuilt from VP every frame. */
const _frustum = frustum.create();

/** World-space AABB used when transforming a local bounding box. */
const _worldBox: Box3 = [0, 0, 0, 0, 0, 0];

/** World-space sphere used when transforming a local bounding sphere. */
const _worldSphere: Sphere = { center: [0, 0, 0], radius: 0 };

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
export function collectRenderList(
    state: RenderListsState,
    object: Object3D,
    camera: Camera,
    overrideMaterial: Material | null = null,
): RenderList {
    const list = getRenderList(state, object, camera);

    // Begin new frame
    beginRenderList(list, object, camera);

    // Build frustum from camera matrices
    frustum.setFromViewProjectionMatrix(
        _frustum,
        camera.projectionMatrix,
        camera.matrixWorldInverse,
    );

    // Walk object and collect visible meshes
    walkObject(list, object, camera, overrideMaterial);

    // Finish and sort
    finishRenderList(list);
    sortRenderList(list);

    return list;
}

/**
 * Walk the scene graph and collect visible meshes.
 */
function walkObject(
    list: RenderList,
    obj: Object3D,
    camera: Camera,
    overrideMaterial: Material | null,
): void {
    if (!obj.visible) return;

    if (obj instanceof Mesh) {
        if (isMeshVisible(obj)) {
            const material = overrideMaterial ?? obj.material;
            const z = computeViewZ(obj, camera);
            pushRenderItem(
                list,
                obj,
                obj.geometry,
                material,
                0, // groupOrder - could be mesh.renderOrder or layer
                z,
            );
        }
    }

    // Recurse into children
    for (const child of obj.children) {
        walkObject(list, child, camera, overrideMaterial);
    }
}

/**
 * Test whether a mesh should be included in the draw list.
 *
 * Uses frustum culling with bounding volumes:
 * 1. boundingSphere — cheapest test (6 dot-products)
 * 2. boundingBox — more precise but slightly more work
 * 3. no bounds — always visible (safe fallback)
 */
function isMeshVisible(mesh: Mesh): boolean {
    const geom = mesh.geometry;
    const wm = mesh.matrixWorld;

    // Skip disposed geometries
    if (geom.disposed) return false;

    if (!mesh.frustumCulled) return true;

    // --- sphere test (preferred) ------------------------------------------
    if (geom.boundingSphere !== undefined) {
        const ls = geom.boundingSphere;

        // Transform centre: ws_centre = wm * [cx, cy, cz, 1]
        const cx = ls.center[0];
        const cy = ls.center[1];
        const cz = ls.center[2];
        _worldSphere.center[0] = wm[0] * cx + wm[4] * cy + wm[8] * cz + wm[12];
        _worldSphere.center[1] = wm[1] * cx + wm[5] * cy + wm[9] * cz + wm[13];
        _worldSphere.center[2] = wm[2] * cx + wm[6] * cy + wm[10] * cz + wm[14];

        // Scale the radius by the largest axis scale extracted from the world matrix.
        const sx = Math.sqrt(wm[0] * wm[0] + wm[1] * wm[1] + wm[2] * wm[2]);
        const sy = Math.sqrt(wm[4] * wm[4] + wm[5] * wm[5] + wm[6] * wm[6]);
        const sz = Math.sqrt(wm[8] * wm[8] + wm[9] * wm[9] + wm[10] * wm[10]);
        _worldSphere.radius = ls.radius * Math.max(sx, sy, sz);

        return frustum.intersectsSphere(_frustum, _worldSphere);
    }

    // --- AABB test (fallback) -----------------------------------------------
    if (geom.boundingBox !== undefined) {
        // Transform the local AABB by the world matrix to a world-space AABB.
        box3.transformMat4(_worldBox, geom.boundingBox, wm);
        return frustum.intersectsBox3(_frustum, _worldBox);
    }

    // --- no bounds — always draw -------------------------------------------
    return true;
}

/**
 * Compute the view-space Z of a mesh for transparent sorting.
 *
 * Uses the mesh world-position (column 12, 13, 14 of matrixWorld)
 * and the camera view matrix.
 *
 * Returns the view-space Z coordinate (negative = in front of camera in a
 * right-handed system; we sort from largest (furthest) to smallest).
 */
function computeViewZ(mesh: Mesh, camera: Camera): number {
    const wm = mesh.matrixWorld;
    const vm = camera.matrixWorldInverse;

    // World position of mesh origin
    const wx = wm[12];
    const wy = wm[13];
    const wz = wm[14];

    // Transform world position by view matrix (only z row needed)
    return vm[2] * wx + vm[6] * wy + vm[10] * wz + vm[14];
}

// ---------------------------------------------------------------------------
// Custom Sort Support
// ---------------------------------------------------------------------------

/**
 * Collect and sort with custom sort functions.
 */
export function collectRenderListWithSort(
    state: RenderListsState,
    object: Object3D,
    camera: Camera,
    opaqueSort?: (a: RenderItem, b: RenderItem) => number,
    transparentSort?: (a: RenderItem, b: RenderItem) => number,
    overrideMaterial: Material | null = null,
): RenderList {
    const list = getRenderList(state, object, camera);

    beginRenderList(list, object, camera);

    frustum.setFromViewProjectionMatrix(
        _frustum,
        camera.projectionMatrix,
        camera.matrixWorldInverse,
    );

    walkObject(list, object, camera, overrideMaterial);

    finishRenderList(list);
    sortRenderList(list, opaqueSort, transparentSort);

    return list;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Get render list statistics.
 */
export function getRenderListStats(list: RenderList): {
    opaque: number;
    transparent: number;
    total: number;
    poolSize: number;
} {
    return {
        opaque: list.opaque.length,
        transparent: list.transparent.length,
        total: list.opaque.length + list.transparent.length,
        poolSize: list.renderItems.length,
    };
}

/**
 * Get statistics about all cached RenderLists.
 */
export function getRenderListsStats(_state: RenderListsState): {
    cachedLists: number;
} {
    // Note: We can't enumerate ChainMap entries, so we can't count them.
    // This would require tracking lists in a separate Set.
    return {
        cachedLists: -1, // Unknown
    };
}
