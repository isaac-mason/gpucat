/**
 * render-list.ts - Sorted render item list with object pooling.
 *
 * Aligned with Three.js RenderList:
 * - Object pooling for RenderItems (avoids GC pressure)
 * - Sorted opaque and transparent lists
 * - Cached per scene/camera
 *
 * RenderList collects meshes from a scene graph and sorts them for rendering:
 * - Opaque: sorted by material/pipeline key to minimize state changes
 * - Transparent: sorted back-to-front by view-space Z
 */

import type { Mesh } from '../objects/mesh';
import type { Geometry } from '../geometry/geometry';
import type { Material } from '../material/material';
import type { Scene } from '../scene/scene';
import type { Camera } from '../camera/camera';
import type { GeometryGroup } from './render-object';

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

    /**
     * Optional geometry group for multi-material meshes.
     */
    group: GeometryGroup | null;
};

/**
 * RenderList - Contains sorted lists of render items.
 */
export type RenderList = {
    /** The scene this list was built from. */
    scene: Scene | null;

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** ID counter for RenderItems. */
let renderItemIdCounter = 0;

/**
 * Create a new RenderList.
 */
export function createRenderList(): RenderList {
    return {
        scene: null,
        camera: null,
        renderItems: [],
        renderItemsIndex: 0,
        opaque: [],
        transparent: [],
        occlusionQueryCount: 0,
    };
}

// ---------------------------------------------------------------------------
// List Management
// ---------------------------------------------------------------------------

/**
 * Begin building a render list for a new frame.
 *
 * This resets the pool index but keeps pooled items for reuse.
 */
export function beginRenderList(list: RenderList, scene: Scene, camera: Camera): void {
    list.scene = scene;
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
            group: null,
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
 * @param group - Optional geometry group for multi-material
 */
export function pushRenderItem(
    list: RenderList,
    mesh: Mesh,
    geometry: Geometry,
    material: Material,
    groupOrder: number,
    z: number,
    group: GeometryGroup | null = null,
): void {
    const item = getNextRenderItem(list);

    item.mesh = mesh;
    item.geometry = geometry;
    item.material = material;
    item.groupOrder = groupOrder;
    item.renderOrder = 0; // mesh.renderOrder if we add that
    item.z = z;
    item.group = group;

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
 * Default sort for opaque items (front-to-back, then by renderOrder/groupOrder).
 *
 * "Painter sort stable" - maintains relative order for equal keys.
 */
export function painterSortStable(a: RenderItem, b: RenderItem): number {
    // Sort by groupOrder first (render layers)
    if (a.groupOrder !== b.groupOrder) {
        return a.groupOrder - b.groupOrder;
    }

    // Then by renderOrder
    if (a.renderOrder !== b.renderOrder) {
        return a.renderOrder - b.renderOrder;
    }

    // Then by Z (front-to-back for opaque = smaller Z first)
    if (a.z !== b.z) {
        return a.z - b.z;
    }

    // Finally by ID for stability
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
