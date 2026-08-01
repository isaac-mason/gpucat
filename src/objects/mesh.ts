import { type Vec3, vec3 } from 'mathcat';
import { Object3D } from '../core/object3d';
import type { Geometry } from '../geometry/geometry';
import type { Material } from '../material/material';
import {
    checkTriangleIntersection,
    type Intersection,
    type Raycaster,
    rayIntersectsBox3,
    transformRayToLocalSpace,
} from '../math/raycaster';

const _worldSphereCenter: Vec3 = [0, 0, 0];

/**
 * One sub-draw of a batched mesh: a plain instanced draw command over the mesh's (typically
 * merged) geometry, field-for-field a WebGPU indirect-draw arg struct. The mesh's geometry selects
 * the variant: indexed geometry uses {@link IndexedMeshDraw} (`GPUDrawIndexedIndirect`),
 * non-indexed uses {@link NonIndexedMeshDraw} (`GPUDrawIndirect`).
 *
 * When a `Mesh` has `draws` set, the renderer loops these instead of the single `drawRange` +
 * `count` draw. Per-instance data is expected to live in data textures indexed by `instanceIndex`
 * (base-inclusive: `firstInstance + gl_InstanceID` on WebGL, native `instance_index` on WebGPU).
 */
export type IndexedMeshDraw = {
    /** Indices to draw from the (merged) index buffer. */
    indexCount: number;
    /** Instances for this sub-draw (may differ per entry). `<= 0` skips the entry. */
    instanceCount: number;
    /** Offset into the index buffer, in ELEMENTS (converted to bytes at the WebGL call). */
    firstIndex: number;
    /** Base into the instance-index space; `instanceIndex` reads back `firstInstance + local`. */
    firstInstance: number;
    /** Added to each index before vertex fetch. WebGPU-only; ignored on WebGL2 (defaults 0). */
    baseVertex?: number;
};

/** Non-indexed batched sub-draw: the `GPUDrawIndirect` arg struct, used when the mesh's geometry has no index buffer. */
export type NonIndexedMeshDraw = {
    /** Vertices to draw from the (merged) vertex buffer(s). */
    vertexCount: number;
    /** Instances for this sub-draw (may differ per entry). `<= 0` skips the entry. */
    instanceCount: number;
    /** Offset of the first vertex. */
    firstVertex: number;
    /** Base into the instance-index space; `instanceIndex` reads back `firstInstance + local`. */
    firstInstance: number;
};

/** One batched sub-draw; the variant matches the mesh's geometry (indexed vs non-indexed). */
export type MeshDraw = IndexedMeshDraw | NonIndexedMeshDraw;

export class Mesh extends Object3D {
    readonly isMesh = true;
    geometry: Geometry;
    material: Material;
    count: number = 1;
    /**
     * Optional batched draw list. When set, the renderer issues one instanced draw per entry
     * (a CPU loop) instead of the single `drawRange` + `count` draw, and `count`/`drawRange`
     * are ignored. All entries share this mesh's `geometry` + `material` (one pipeline). An
     * empty array draws nothing. Entries must match the mesh's geometry (indexed vs non-indexed).
     */
    draws?: MeshDraw[];
    frustumCulled: boolean = true;

    constructor(geometry: Geometry, material: Material) {
        super();
        this.geometry = geometry;
        this.material = material;
    }

    override raycast(raycaster: Raycaster, intersects: Intersection[]): void {
        const geometry = this.geometry;
        const matrixWorld = this.matrixWorld;

        // get position buffer - required for raycasting
        const positionBuffer = geometry.getBuffer('position');
        if (!positionBuffer?.array) return;
        const positions = positionBuffer.array as Float32Array;

        // early-out: bounding sphere test in world space
        if (geometry.boundingSphere) {
            const sphere = geometry.boundingSphere;

            // transform sphere center to world space
            vec3.transformMat4(_worldSphereCenter, sphere.center, matrixWorld);

            // get world scale to transform radius (approximate for non-uniform scale)
            const sx = Math.hypot(matrixWorld[0], matrixWorld[1], matrixWorld[2]);
            const sy = Math.hypot(matrixWorld[4], matrixWorld[5], matrixWorld[6]);
            const sz = Math.hypot(matrixWorld[8], matrixWorld[9], matrixWorld[10]);
            const worldRadius = sphere.radius * Math.max(sx, sy, sz);

            // quick sphere-ray distance test
            const rayToCenter: Vec3 = [0, 0, 0];
            vec3.subtract(rayToCenter, _worldSphereCenter, raycaster.ray.origin);
            const tca = vec3.dot(rayToCenter, raycaster.ray.direction);
            const d2 = vec3.dot(rayToCenter, rayToCenter) - tca * tca;

            if (d2 > worldRadius * worldRadius) return;
        }

        // transform ray to local space
        const localRay = transformRayToLocalSpace(raycaster, matrixWorld);

        // early-out: bounding box test in local space
        if (geometry.boundingBox) {
            if (!rayIntersectsBox3(localRay.origin, localRay.direction, geometry.boundingBox, raycaster.far)) return;
        }

        // get optional index buffer and UV buffer
        const indexBuffer = geometry.index;
        const indices = (indexBuffer?.array as Uint16Array | Uint32Array | null) ?? null;

        const uvBuffer = geometry.getBuffer('uv');
        const uvs = (uvBuffer?.array as Float32Array | null) ?? null;

        // triangle intersection tests
        if (indices) {
            // indexed geometry
            const count = Math.min(
                indices.length,
                geometry.drawRange.start + (geometry.drawRange.count === Infinity ? indices.length : geometry.drawRange.count),
            );
            for (let i = geometry.drawRange.start; i < count; i += 3) {
                checkTriangleIntersection(
                    this,
                    raycaster,
                    localRay,
                    matrixWorld,
                    i,
                    i + 1,
                    i + 2,
                    positions,
                    indices,
                    uvs,
                    intersects,
                    Math.floor(i / 3),
                );
            }
        } else {
            // non-indexed geometry
            const vertexCount = positions.length / 3;
            const count = Math.min(
                vertexCount,
                geometry.drawRange.start + (geometry.drawRange.count === Infinity ? vertexCount : geometry.drawRange.count),
            );
            for (let i = geometry.drawRange.start; i < count; i += 3) {
                checkTriangleIntersection(
                    this,
                    raycaster,
                    localRay,
                    matrixWorld,
                    i,
                    i + 1,
                    i + 2,
                    positions,
                    null,
                    uvs,
                    intersects,
                    Math.floor(i / 3),
                );
            }
        }
    }
}
