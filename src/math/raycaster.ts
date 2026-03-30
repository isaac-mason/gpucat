import { raycast3, vec3, mat4, type Raycast3, type Vec3, type Mat4 } from 'mathcat';
import type { Object3D } from '../core/object3d';
import { Camera, unproject } from '../camera/camera';

export type Intersection = {
    distance: number;
    point: Vec3;
    object: Object3D;
    faceIndex?: number;
    face?: { a: number; b: number; c: number; normal: Vec3 };
    uv?: [number, number];
    normal?: Vec3;
};

// Reusable temp objects
const _target: Vec3 = [0, 0, 0];
const _direction: Vec3 = [0, 0, 0];

export class Raycaster {
    ray: Raycast3;
    near: number;
    far: number;

    constructor(origin?: Vec3, direction?: Vec3, near: number = 0, far: number = Infinity) {
        this.ray = raycast3.create();
        if (origin) vec3.copy(this.ray.origin, origin);
        if (direction) vec3.copy(this.ray.direction, direction);
        this.ray.length = far;
        this.near = near;
        this.far = far;
    }

    set(origin: Vec3, direction: Vec3): void {
        vec3.copy(this.ray.origin, origin);
        vec3.copy(this.ray.direction, direction);
    }

    setFromCamera(coords: [number, number], camera: Camera): void {
        const isOrthographic = 'isOrthographicCamera' in camera && (camera as any).isOrthographicCamera;

        if (isOrthographic) {
            // Orthographic: origin on near plane, direction is camera's forward
            unproject(this.ray.origin, [coords[0], coords[1], 0], camera);

            // Get camera forward direction from matrixWorld
            const e = camera.matrixWorld;
            vec3.set(_direction, -e[8], -e[9], -e[10]);
            vec3.normalize(this.ray.direction, _direction);
        } else {
            // Perspective: origin at camera position, direction toward unprojected point
            vec3.copy(this.ray.origin, camera.position);

            // Unproject a point on the far plane and compute direction
            unproject(_target, [coords[0], coords[1], 1], camera);
            vec3.subtract(_direction, _target, this.ray.origin);
            vec3.normalize(this.ray.direction, _direction);
        }

        this.ray.length = this.far;
    }

    intersectObject(object: Object3D, recursive: boolean = true, intersects: Intersection[] = []): Intersection[] {
        intersect(object, this, intersects, recursive);
        intersects.sort(ascSort);
        return intersects;
    }

    intersectObjects(objects: Object3D[], recursive: boolean = true, intersects: Intersection[] = []): Intersection[] {
        for (const object of objects) {
            intersect(object, this, intersects, recursive);
        }
        intersects.sort(ascSort);
        return intersects;
    }
}

function ascSort(a: Intersection, b: Intersection): number {
    return a.distance - b.distance;
}

function intersect(object: Object3D, raycaster: Raycaster, intersects: Intersection[], recursive: boolean): void {
    if (object.visible === false) return;

    object.raycast(raycaster, intersects);

    if (recursive) {
        for (const child of object.children) {
            intersect(child, raycaster, intersects, true);
        }
    }
}

// ============================================================================
// Helpers for Mesh.raycast() - exported for use by Mesh
// ============================================================================

const _inverseMatrix: Mat4 = mat4.create();
const _localRay: Raycast3 = raycast3.create();
const _localOrigin: Vec3 = [0, 0, 0];
const _localDir: Vec3 = [0, 0, 0];
const _intersectionResult = raycast3.createIntersectsTriangleResult();
const _intersectionPoint: Vec3 = [0, 0, 0];
const _intersectionPointWorld: Vec3 = [0, 0, 0];
const _vA: Vec3 = [0, 0, 0];
const _vB: Vec3 = [0, 0, 0];
const _vC: Vec3 = [0, 0, 0];
const _edge1: Vec3 = [0, 0, 0];
const _edge2: Vec3 = [0, 0, 0];
const _faceNormal: Vec3 = [0, 0, 0];

/**
 * Transform a ray into the local space of an object.
 * Returns the local ray for intersection testing.
 */
export function transformRayToLocalSpace(raycaster: Raycaster, matrixWorld: Mat4): Raycast3 {
    mat4.invert(_inverseMatrix, matrixWorld);

    // Transform origin (point)
    vec3.transformMat4(_localOrigin, raycaster.ray.origin, _inverseMatrix);

    // Transform direction (vector, not point) - use mat3 of inverse matrix
    // For direction vectors we need to transform by the inverse-transpose,
    // but for orthonormal transforms (no non-uniform scale), inverse works.
    // We extract upper 3x3 and transform.
    const m = _inverseMatrix;
    const dx = raycaster.ray.direction[0];
    const dy = raycaster.ray.direction[1];
    const dz = raycaster.ray.direction[2];
    _localDir[0] = m[0] * dx + m[4] * dy + m[8] * dz;
    _localDir[1] = m[1] * dx + m[5] * dy + m[9] * dz;
    _localDir[2] = m[2] * dx + m[6] * dy + m[10] * dz;
    vec3.normalize(_localDir, _localDir);

    raycast3.set(_localRay, _localOrigin, _localDir, raycaster.far);
    return _localRay;
}

/**
 * Test ray-triangle intersection and add to intersects if hit.
 * Positions are in local space, ray should be in local space.
 */
export function checkTriangleIntersection(
    object: Object3D,
    raycaster: Raycaster,
    localRay: Raycast3,
    matrixWorld: Mat4,
    a: number,
    b: number,
    c: number,
    positions: Float32Array,
    indices: Uint16Array | Uint32Array | null,
    uvs: Float32Array | null,
    intersects: Intersection[],
    faceIndex: number,
): void {
    // Get vertex positions
    const ia = indices ? indices[a] : a;
    const ib = indices ? indices[b] : b;
    const ic = indices ? indices[c] : c;

    vec3.fromBuffer(_vA, positions, ia * 3);
    vec3.fromBuffer(_vB, positions, ib * 3);
    vec3.fromBuffer(_vC, positions, ic * 3);

    // Test intersection (double-sided, no backface culling)
    raycast3.intersectsTriangle(_intersectionResult, localRay, _vA, _vB, _vC, false);

    if (!_intersectionResult.hit) return;

    // Compute intersection point in local space
    const t = _intersectionResult.fraction;
    vec3.scaleAndAdd(_intersectionPoint, localRay.origin, localRay.direction, t * localRay.length);

    // Transform to world space
    vec3.transformMat4(_intersectionPointWorld, _intersectionPoint, matrixWorld);

    // Check distance against near/far
    const distance = vec3.distance(raycaster.ray.origin, _intersectionPointWorld);
    if (distance < raycaster.near || distance > raycaster.far) return;

    // Compute face normal
    vec3.subtract(_edge1, _vB, _vA);
    vec3.subtract(_edge2, _vC, _vA);
    vec3.cross(_faceNormal, _edge1, _edge2);
    vec3.normalize(_faceNormal, _faceNormal);

    // Build intersection result
    const intersection: Intersection = {
        distance,
        point: vec3.clone(_intersectionPointWorld),
        object,
        faceIndex,
        face: {
            a: ia,
            b: ib,
            c: ic,
            normal: vec3.clone(_faceNormal),
        },
    };

    // Compute UV if available (barycentric interpolation)
    if (uvs) {
        const uv = computeBarycentricUV(_intersectionPoint, _vA, _vB, _vC, ia, ib, ic, uvs);
        if (uv) intersection.uv = uv;
    }

    intersects.push(intersection);
}

/**
 * Compute UV coordinates at intersection point using barycentric interpolation.
 */
function computeBarycentricUV(
    point: Vec3,
    vA: Vec3,
    vB: Vec3,
    vC: Vec3,
    ia: number,
    ib: number,
    ic: number,
    uvs: Float32Array,
): [number, number] | null {
    // Compute barycentric coordinates
    const v0: Vec3 = [0, 0, 0];
    const v1: Vec3 = [0, 0, 0];
    const v2: Vec3 = [0, 0, 0];

    vec3.subtract(v0, vC, vA);
    vec3.subtract(v1, vB, vA);
    vec3.subtract(v2, point, vA);

    const dot00 = vec3.dot(v0, v0);
    const dot01 = vec3.dot(v0, v1);
    const dot02 = vec3.dot(v0, v2);
    const dot11 = vec3.dot(v1, v1);
    const dot12 = vec3.dot(v1, v2);

    const denom = dot00 * dot11 - dot01 * dot01;
    if (Math.abs(denom) < 1e-10) return null;

    const invDenom = 1 / denom;
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
    const w = 1 - u - v;

    // Interpolate UVs
    const uvA_u = uvs[ia * 2];
    const uvA_v = uvs[ia * 2 + 1];
    const uvB_u = uvs[ib * 2];
    const uvB_v = uvs[ib * 2 + 1];
    const uvC_u = uvs[ic * 2];
    const uvC_v = uvs[ic * 2 + 1];

    return [
        w * uvA_u + v * uvB_u + u * uvC_u,
        w * uvA_v + v * uvB_v + u * uvC_v,
    ];
}
