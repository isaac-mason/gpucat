/**
 * The meshes of a tree a camera sees, frustum culled, opaque apart from transparent, with pooled items cached per
 * (tree, camera). The pass's bins order them (`draw-scene.ts`).
 */

import { type Box3, box3, type Sphere } from 'math/shapes';
import type { Object3D } from '../../core/object3d';
import type { Geometry } from '../../geometry/geometry';
import type { Material } from '../../material/material';
import * as frustum from '../../math/frustum';
import type { Mesh } from '../../objects/mesh';
import type { View } from './view';

// Types

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

    // Object Pool

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

// Factories

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
    };
}

/**
 * Create a new RenderLists state.
 */
export function createRenderListsState(): RenderListsState {
    return {
        lists: new WeakMap(),
    };
}

// RenderList Access

/**
 * Get or create a RenderList for the given object and camera.
 *
 * @param state - The RenderLists state
 * @param object - The object to render (Scene, Mesh, or any Object3D)
 * @param camera - The camera to render from
 */
export function getRenderList(state: RenderListsState, object: Object3D, camera: View): RenderList {
    let cameraMap = state.lists.get(object);
    if (!cameraMap) {
        cameraMap = new WeakMap();
        state.lists.set(object, cameraMap);
    }

    let list = cameraMap.get(camera);
    if (!list) {
        list = createRenderList();
        cameraMap.set(camera, list);
    }

    return list;
}

// List Management

/**
 * Begin building a render list for a new frame.
 *
 * This resets the pool index but keeps pooled items for reuse.
 */
export function beginRenderList(list: RenderList, object: Object3D, camera: View): void {
    list.object = object;
    list.camera = camera;
    list.renderItemsIndex = 0;
    list.opaque.length = 0;
    list.transparent.length = 0;
}

/**
 * Get a RenderItem from the pool (or create a new one).
 */
function getNextRenderItem(list: RenderList): RenderItem {
    const index = list.renderItemsIndex;

    let item = list.renderItems[index];
    if (item === undefined) {
        item = { mesh: null, geometry: null, material: null };
        list.renderItems.push(item);
    }

    list.renderItemsIndex++;
    return item;
}

/** Push a mesh into the render list, with the transparent ones if its material is. */
export function pushRenderItem(list: RenderList, mesh: Mesh, geometry: Geometry, material: Material): void {
    const item = getNextRenderItem(list);

    item.mesh = mesh;
    item.geometry = geometry;
    item.material = material;

    if (material.transparent) {
        list.transparent.push(item);
    } else {
        list.opaque.push(item);
    }
}

// Scene Collection

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
 * @param camera - The camera for frustum culling
 * @returns The populated RenderList
 */
export function collectRenderList(state: RenderListsState, object: Object3D, camera: View): RenderList {
    const list = getRenderList(state, object, camera);

    // Begin new frame
    beginRenderList(list, object, camera);

    // Build frustum from camera matrices
    frustum.setFromViewProjectionMatrix(_frustum, camera.projectionMatrix, camera.matrixWorldInverse, camera.coordinateSystem);

    // Walk object and collect visible meshes
    walkObject(list, object);

    return list;
}

/**
 * Walk the scene graph and collect visible meshes.
 */
function walkObject(list: RenderList, obj: Object3D): void {
    if (!obj.visible) return;

    if (obj.isMesh) {
        const mesh = obj as Mesh;
        if (isMeshVisible(mesh)) pushRenderItem(list, mesh, mesh.geometry, mesh.material);
    }

    // Recurse into children
    for (const child of obj.children) {
        walkObject(list, child);
    }
}

/**
 * Test whether a mesh should be included in the draw list.
 *
 * Uses frustum culling with bounding volumes:
 * 1. boundingSphere, cheapest test (6 dot-products)
 * 2. boundingBox, more precise but slightly more work
 * 3. no bounds, always visible (safe fallback)
 */
function isMeshVisible(mesh: Mesh): boolean {
    const geom = mesh.geometry;
    const wm = mesh.matrixWorld;

    // Skip disposed geometries
    if (geom.disposed) return false;

    if (!mesh.frustumCulled) return true;

    // sphere test (preferred)
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

    // AABB test (fallback)
    if (geom.boundingBox !== undefined) {
        // Transform the local AABB by the world matrix to a world-space AABB.
        box3.transformMat4(_worldBox, geom.boundingBox, wm);
        return frustum.intersectsBox3(_frustum, _worldBox);
    }

    // no bounds, always draw
    return true;
}
