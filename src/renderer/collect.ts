/**
 * collect.ts — Walk the scene graph and collect draw calls.
 *
 * Returns two lists:
 *   opaque      — sorted by pipelineKey (minimise pipeline switches)
 *   transparent — sorted back-to-front by view-space Z
 */

import type { Object3D } from '../scene/object3d.js';
import type { Scene } from '../scene/scene.js';
import type { Camera } from '../scene/camera.js';
import { Mesh } from '../scene/mesh.js';
import { makePipelineKey } from './pipeline.js';

// ---------------------------------------------------------------------------
// DrawCall
// ---------------------------------------------------------------------------

export type DrawCall = {
    mesh: Mesh;
    /** Pipeline cache key. Used to group opaque draws. */
    pipelineKey: string;
    /**
     * View-space Z (negative = in front of camera).
     * Used for back-to-front sorting of transparent draws.
     */
    viewZ: number;
};

// ---------------------------------------------------------------------------
// collectDraws
// ---------------------------------------------------------------------------

/**
 * Walk `scene`, collect all `Mesh` nodes, and split into opaque / transparent lists.
 *
 * Opaque draws are sorted by pipelineKey to minimise GPU pipeline switches.
 * Transparent draws are sorted back-to-front by viewZ.
 *
 * @param scene   The root scene (after updateWorldMatrices() has been called)
 * @param camera  The active camera (after updateViewMatrix() has been called)
 * @param samples MSAA sample count — used when computing pipeline keys
 * @param format  Color attachment format — used when computing pipeline keys
 */
export function collectDraws(
    scene: Scene,
    camera: Camera,
    samples: number,
    format: GPUTextureFormat,
): { opaque: DrawCall[]; transparent: DrawCall[] } {
    const opaque: DrawCall[] = [];
    const transparent: DrawCall[] = [];

    walkObject(scene, camera, samples, format, opaque, transparent);

    // Sort opaque by pipeline key — minimises GPU pipeline switches
    opaque.sort((a, b) => (a.pipelineKey < b.pipelineKey ? -1 : a.pipelineKey > b.pipelineKey ? 1 : 0));

    // Sort transparent back-to-front (largest viewZ = furthest away = draw first)
    transparent.sort((a, b) => b.viewZ - a.viewZ);

    return { opaque, transparent };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function walkObject(
    obj: Object3D,
    camera: Camera,
    samples: number,
    format: GPUTextureFormat,
    opaque: DrawCall[],
    transparent: DrawCall[],
): void {
    if (obj instanceof Mesh) {
        const pipelineKey = makePipelineKey(obj.material, samples, format);
        const viewZ = computeViewZ(obj, camera);
        const call: DrawCall = { mesh: obj, pipelineKey, viewZ };

        if (obj.material.transparent) {
            transparent.push(call);
        } else {
            opaque.push(call);
        }
    }

    for (const child of obj.children) {
        walkObject(child, camera, samples, format, opaque, transparent);
    }
}

/**
 * Compute the view-space Z of a mesh for transparent sorting.
 * Uses the mesh world-position (column 12, 13, 14 of _worldMatrix)
 * and the camera view matrix.
 *
 * Returns the view-space Z coordinate (negative = in front of camera in a
 * right-handed system; we sort from largest (furthest) to smallest).
 */
function computeViewZ(mesh: Mesh, camera: Camera): number {
    const wm = mesh._worldMatrix;
    const vm = camera._viewMatrix;

    // World position of mesh origin
    const wx = wm[12];
    const wy = wm[13];
    const wz = wm[14];

    // Transform world position by view matrix (only z row needed)
    // view[2], view[6], view[10], view[14] are the z-row of the view matrix
    return vm[2] * wx + vm[6] * wy + vm[10] * wz + vm[14];
}
