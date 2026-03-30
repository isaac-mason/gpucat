import { raycast3, vec3, type Vec3 } from 'mathcat';
import { Object3D } from '../core/object3d';
import type { Geometry } from '../geometry/geometry';
import type { Material } from '../material/material';
import {
    type Raycaster,
    type Intersection,
    transformRayToLocalSpace,
    checkTriangleIntersection,
} from '../math/raycaster';

const _worldSphereCenter: Vec3 = [0, 0, 0];

export class Mesh extends Object3D {
    geometry: Geometry;
    material: Material;
    count: number = 1;
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
            if (!raycast3.intersectsBox3(localRay, geometry.boundingBox)) return;
        }
        
        // get optional index buffer and UV buffer
        const indexBuffer = geometry.index;
        const indices = indexBuffer?.array as Uint16Array | Uint32Array | null ?? null;

        const uvBuffer = geometry.getBuffer('uv');
        const uvs = uvBuffer?.array as Float32Array | null ?? null;

        // triangle intersection tests
        if (indices) {
            // indexed geometry
            const count = Math.min(
                indices.length,
                geometry.drawRange.start + (geometry.drawRange.count === Infinity ? indices.length : geometry.drawRange.count)
            );
            for (let i = geometry.drawRange.start; i < count; i += 3) {
                checkTriangleIntersection(
                    this,
                    raycaster,
                    localRay,
                    matrixWorld,
                    i, i + 1, i + 2,
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
                geometry.drawRange.start + (geometry.drawRange.count === Infinity ? vertexCount : geometry.drawRange.count)
            );
            for (let i = geometry.drawRange.start; i < count; i += 3) {
                checkTriangleIntersection(
                    this,
                    raycaster,
                    localRay,
                    matrixWorld,
                    i, i + 1, i + 2,
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
