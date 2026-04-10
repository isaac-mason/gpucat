import { vec3, mat4, type Vec3, type Mat4, type Box3 } from 'mathcat';
import type { Object3D } from '../core/object3d';
import { Camera, unproject } from '../camera/camera';

export type Ray = {
    origin: Vec3;
    direction: Vec3;
};

/**
 * Möller–Trumbore ray-triangle intersection.
 * Returns raw t (distance along ray direction) or null if no hit.
 * Ported from Three.js Ray.intersectTriangle.
 */
export function rayTriangleIntersection(
    origin: Vec3, direction: Vec3,
    a: Vec3, b: Vec3, c: Vec3,
    backfaceCulling: boolean,
): number | null {
    // edge1 = b - a, edge2 = c - a
    const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
    const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];

    // normal = edge1 × edge2
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    let DdN = direction[0] * nx + direction[1] * ny + direction[2] * nz;
    let sign: number;

    if (DdN > 0) {
        if (backfaceCulling) return null;
        sign = 1;
    } else if (DdN < 0) {
        sign = -1;
        DdN = -DdN;
    } else {
        return null;
    }

    const diffx = origin[0] - a[0];
    const diffy = origin[1] - a[1];
    const diffz = origin[2] - a[2];

    // barycentric coord b1
    const DdQxE2 = sign * (
        direction[0] * (diffy * e2z - diffz * e2y) +
        direction[1] * (diffz * e2x - diffx * e2z) +
        direction[2] * (diffx * e2y - diffy * e2x)
    );
    if (DdQxE2 < 0) return null;

    // barycentric coord b2
    const DdE1xQ = sign * (
        direction[0] * (e1y * diffz - e1z * diffy) +
        direction[1] * (e1z * diffx - e1x * diffz) +
        direction[2] * (e1x * diffy - e1y * diffx)
    );
    if (DdE1xQ < 0) return null;

    if (DdQxE2 + DdE1xQ > DdN) return null;

    // t = raw distance along ray direction
    const QdN = -sign * (diffx * nx + diffy * ny + diffz * nz);
    if (QdN < 0) return null;

    return QdN / DdN;
}

/**
 * Slab-based ray-AABB intersection test.
 * Tests intersection within [0, maxT] along the ray.
 */
export function rayIntersectsBox3(origin: Vec3, direction: Vec3, aabb: Box3, maxT: number): boolean {
    let tmin = 0;
    let tmax = maxT;

    for (let i = 0; i < 3; i++) {
        // Pad degenerate slabs to avoid near-miss rejections on thin/flat geometry
        let lo = aabb[i];
        let hi = aabb[i + 3];
        if (hi - lo < 1e-4) {
            const mid = (lo + hi) * 0.5;
            lo = mid - 5e-5;
            hi = mid + 5e-5;
        }

        const d = direction[i];
        if (Math.abs(d) < 1e-10) {
            if (origin[i] < lo || origin[i] > hi) {
                return false;
            }
        } else {
            const invD = 1 / d;
            let t0 = (lo - origin[i]) * invD;
            let t1 = (hi - origin[i]) * invD;
            if (invD < 0) { const tmp = t0; t0 = t1; t1 = tmp; }
            tmin = Math.max(tmin, t0);
            tmax = Math.min(tmax, t1);
            if (tmax < tmin) return false;
        }
    }

    return true;
}

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
    ray: Ray;
    near: number;
    far: number;
    camera: Camera | null = null;

    constructor(origin?: Vec3, direction?: Vec3, near: number = 0, far: number = Infinity) {
        this.ray = { origin: [0, 0, 0], direction: [0, 0, 0] };
        if (origin) vec3.copy(this.ray.origin, origin);
        if (direction) vec3.copy(this.ray.direction, direction);
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
            unproject(this.ray.origin, [coords[0], coords[1], 0], camera);

            const e = camera.matrixWorld;
            vec3.set(_direction, -e[8], -e[9], -e[10]);
            vec3.normalize(this.ray.direction, _direction);
        } else {
            mat4.getTranslation(this.ray.origin, camera.matrixWorld);

            unproject(_target, [coords[0], coords[1], 1], camera);
            vec3.subtract(_direction, _target, this.ray.origin);
            vec3.normalize(this.ray.direction, _direction);
        }

        this.near = camera.near;
        this.far = camera.far;
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
const _localRay: Ray = { origin: [0, 0, 0], direction: [0, 0, 0] };
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
export function transformRayToLocalSpace(raycaster: Raycaster, matrixWorld: Mat4): Ray {
    mat4.invert(_inverseMatrix, matrixWorld);

    vec3.transformMat4(_localRay.origin, raycaster.ray.origin, _inverseMatrix);

    // Transform direction by upper 3x3 of inverse matrix
    const m = _inverseMatrix;
    const dx = raycaster.ray.direction[0];
    const dy = raycaster.ray.direction[1];
    const dz = raycaster.ray.direction[2];
    _localRay.direction[0] = m[0] * dx + m[4] * dy + m[8] * dz;
    _localRay.direction[1] = m[1] * dx + m[5] * dy + m[9] * dz;
    _localRay.direction[2] = m[2] * dx + m[6] * dy + m[10] * dz;
    vec3.normalize(_localRay.direction, _localRay.direction);

    return _localRay;
}

/**
 * Test ray-triangle intersection and add to intersects if hit.
 * Positions are in local space, ray should be in local space.
 */
export function checkTriangleIntersection(
    object: Object3D,
    raycaster: Raycaster,
    localRay: Ray,
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
    const ia = indices ? indices[a] : a;
    const ib = indices ? indices[b] : b;
    const ic = indices ? indices[c] : c;

    vec3.fromBuffer(_vA, positions, ia * 3);
    vec3.fromBuffer(_vB, positions, ib * 3);
    vec3.fromBuffer(_vC, positions, ic * 3);

    const t = rayTriangleIntersection(localRay.origin, localRay.direction, _vA, _vB, _vC, false);
    if (t === null) return;

    // Compute intersection point in local space: origin + direction * t
    vec3.scaleAndAdd(_intersectionPoint, localRay.origin, localRay.direction, t);

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
