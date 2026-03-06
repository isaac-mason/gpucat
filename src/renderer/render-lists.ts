/**
 * render-lists.ts - RenderList manager with ChainMap caching.
 *
 * Aligned with Three.js RenderLists:
 * - Caches RenderLists per (scene, camera) tuple using ChainMap
 * - Provides frustum culling integration
 * - Walks scene graph and collects visible meshes
 */

import type { Scene } from '../scene/scene';
import type { Camera } from '../camera/camera';
import type { Object3D } from '../objects/object3d';
import type { Box3, Sphere } from 'mathcat';
import { box3 } from 'mathcat';
import { Mesh } from '../objects/mesh';
import * as chainMap from './chain-map';
import {
    createRenderList,
    beginRenderList,
    pushRenderItem,
    finishRenderList,
    sortRenderList,
    type RenderList,
    type RenderItem,
} from './render-list';
import * as frustum from '../math/frustum';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * RenderLists state - manages RenderList caching.
 */
export type RenderListsState = {
    /** ChainMap cache for RenderLists by (scene, camera). */
    lists: chainMap.ChainMap<RenderList>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

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
 * Get or create a RenderList for the given scene and camera.
 *
 * @param state - The RenderLists state
 * @param scene - The scene to render
 * @param camera - The camera to render from
 */
export function getRenderList(
    state: RenderListsState,
    scene: Scene,
    camera: Camera,
): RenderList {
    const keys = [scene, camera];

    let list = chainMap.get(state.lists, keys);
    if (!list) {
        list = createRenderList();
        chainMap.set(state.lists, keys, list);
    }

    return list;
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
 * This walks the scene graph, performs frustum culling, and populates
 * the RenderList with opaque and transparent items.
 *
 * @param state - The RenderLists state
 * @param scene - The scene to collect from
 * @param camera - The camera for frustum culling and Z sorting
 * @returns The populated and sorted RenderList
 */
export function collectRenderList(
    state: RenderListsState,
    scene: Scene,
    camera: Camera,
): RenderList {
    const list = getRenderList(state, scene, camera);

    // Begin new frame
    beginRenderList(list, scene, camera);

    // Build frustum from camera matrices
    frustum.setFromViewProjectionMatrix(
        _frustum,
        camera.projectionMatrix,
        camera.matrixWorldInverse,
    );

    // Walk scene and collect visible meshes
    walkObject(list, scene, camera);

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
): void {
    if (obj instanceof Mesh) {
        if (isMeshVisible(obj)) {
            const z = computeViewZ(obj, camera);
            pushRenderItem(
                list,
                obj,
                obj.geometry,
                obj.material,
                0, // groupOrder - could be mesh.renderOrder or layer
                z,
                null, // group - for multi-material
            );
        }
    }

    // Recurse into children
    for (const child of obj.children) {
        walkObject(list, child, camera);
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
    scene: Scene,
    camera: Camera,
    opaqueSort?: (a: RenderItem, b: RenderItem) => number,
    transparentSort?: (a: RenderItem, b: RenderItem) => number,
): RenderList {
    const list = getRenderList(state, scene, camera);

    beginRenderList(list, scene, camera);

    frustum.setFromViewProjectionMatrix(
        _frustum,
        camera.projectionMatrix,
        camera.matrixWorldInverse,
    );

    walkObject(list, scene, camera);

    finishRenderList(list);
    sortRenderList(list, opaqueSort, transparentSort);

    return list;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

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
