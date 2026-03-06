/**
 * collect.ts — Walk the scene graph and collect draw calls.
 *
 * Returns two lists:
 *   opaque      — sorted by pipelineKey (minimise pipeline switches)
 *   transparent — sorted back-to-front by view-space Z
 *
 * Meshes whose geometry carries a boundingSphere or boundingBox are tested
 * against the camera frustum in world space; meshes that fall entirely outside
 * are discarded before a DrawCall is created.
 */

import type { Object3D } from '../objects/object3d';
import type { Scene } from '../scene/scene';
import type { Camera } from '../camera/camera';
import type { Box3, Sphere } from 'mathcat';
import { box3 } from 'mathcat';
import { Mesh } from '../objects/mesh';
import { makeRenderPipelineKey } from './pipelines';
import * as frustum from '../math/frustum';

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

/** frustum; rebuilt from VP every frame. */
const _frustum = frustum.create();

/** world-space AABB used when transforming a local bounding box. */
const _worldBox: Box3 = [0, 0, 0, 0, 0, 0];

/** world-space sphere used when transforming a local bounding sphere. */
const _worldSphere: Sphere = { center: [0, 0, 0], radius: 0 };

/**
 * Walk `scene`, collect all `Mesh` nodes, and split into opaque / transparent lists.
 *
 * Meshes with geometry bounding volumes are frustum-culled in world space.
 * Meshes without any bounding volume are always drawn (safe default).
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

    // rebuild frustum planes from the current view-projection matrix.
    frustum.setFromViewProjectionMatrix(_frustum, camera.projectionMatrix, camera.matrixWorldInverse);

    walkObject(scene, camera, samples, format, opaque, transparent);

    // sort opaque by pipeline key — minimises GPU pipeline switches
    opaque.sort((a, b) => (a.pipelineKey < b.pipelineKey ? -1 : a.pipelineKey > b.pipelineKey ? 1 : 0));

    // sort transparent back-to-front (largest viewZ = furthest away = draw first)
    transparent.sort((a, b) => b.viewZ - a.viewZ);

    return { opaque, transparent };
}

function walkObject(
    obj: Object3D,
    camera: Camera,
    samples: number,
    format: GPUTextureFormat,
    opaque: DrawCall[],
    transparent: DrawCall[],
): void {
    if (obj instanceof Mesh) {
        if (!isMeshVisible(obj)) {
            // skip this mesh, but still recurse into children
        } else {
            const pipelineKey = makeRenderPipelineKey(obj.material, samples, format);
            const viewZ = computeViewZ(obj, camera);
            const call: DrawCall = { mesh: obj, pipelineKey, viewZ };

            if (obj.material.transparent) {
                transparent.push(call);
            } else {
                opaque.push(call);
            }
        }
    }

    for (const child of obj.children) {
        walkObject(child, camera, samples, format, opaque, transparent);
    }
}

/**
 * Test whether a mesh should be included in the draw list.
 *
 * Preference order:
 *   1. boundingSphere — cheapest test (6 dot-products)
 *   2. boundingBox    — more precise but slightly more work
 *   3. no bounds      — always visible (safe fallback)
 *
 * Bounding volumes are stored in local (geometry) space and must be
 * transformed to world space before testing.
 */
function isMeshVisible(mesh: Mesh): boolean {
    const geom = mesh.geometry;
    const wm = mesh.matrixWorld;

    // --- sphere test (preferred) ------------------------------------------
    if (geom.boundingSphere !== undefined) {
        const ls = geom.boundingSphere;

        // transform centre: ws_centre = wm * [cx, cy, cz, 1]
        const cx = ls.center[0];
        const cy = ls.center[1];
        const cz = ls.center[2];
        _worldSphere.center[0] = wm[0]*cx + wm[4]*cy + wm[8]*cz  + wm[12];
        _worldSphere.center[1] = wm[1]*cx + wm[5]*cy + wm[9]*cz  + wm[13];
        _worldSphere.center[2] = wm[2]*cx + wm[6]*cy + wm[10]*cz + wm[14];

        // Scale the radius by the largest axis scale extracted from the world matrix.
        // The scale of each axis is the length of the corresponding basis column.
        const sx = Math.sqrt(wm[0]*wm[0] + wm[1]*wm[1] + wm[2]*wm[2]);
        const sy = Math.sqrt(wm[4]*wm[4] + wm[5]*wm[5] + wm[6]*wm[6]);
        const sz = Math.sqrt(wm[8]*wm[8] + wm[9]*wm[9] + wm[10]*wm[10]);
        _worldSphere.radius = ls.radius * Math.max(sx, sy, sz);

        return frustum.intersectsSphere(_frustum, _worldSphere);
    }

    // --- AABB test (fallback) -----------------------------------------------
    if (geom.boundingBox !== undefined) {
        // Transform the local AABB by the world matrix to a world-space AABB.
        // box3.transformMat4 handles this correctly (worst-case 8-corner expansion).
        box3.transformMat4(_worldBox, geom.boundingBox, wm);
        return frustum.intersectsBox3(_frustum, _worldBox);
    }

    // --- no bounds — always draw -------------------------------------------
    return true;
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
    const wm = mesh.matrixWorld;
    const vm = camera.matrixWorldInverse;

    // world position of mesh origin
    const wx = wm[12];
    const wy = wm[13];
    const wz = wm[14];

    // transform world position by view matrix (only z row needed)
    // view[2], view[6], view[10], view[14] are the z-row of the view matrix
    return vm[2] * wx + vm[6] * wy + vm[10] * wz + vm[14];
}
