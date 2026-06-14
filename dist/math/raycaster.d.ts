import { type Vec3, type Mat4, type Box3 } from 'mathcat';
import type { Object3D } from '../core/object3d';
import { Camera } from '../camera/camera';
export type Ray = {
    origin: Vec3;
    direction: Vec3;
};
/**
 * Möller-Trumbore ray-triangle intersection.
 * Returns raw t (distance along ray direction) or null if no hit.
 */
export declare function rayTriangleIntersection(origin: Vec3, direction: Vec3, a: Vec3, b: Vec3, c: Vec3, backfaceCulling: boolean): number | null;
/**
 * Slab-based ray-AABB intersection test.
 * Tests intersection within [0, maxT] along the ray.
 */
export declare function rayIntersectsBox3(origin: Vec3, direction: Vec3, aabb: Box3, maxT: number): boolean;
export type Intersection = {
    distance: number;
    point: Vec3;
    object: Object3D;
    faceIndex?: number;
    face?: {
        a: number;
        b: number;
        c: number;
        normal: Vec3;
    };
    uv?: [number, number];
    normal?: Vec3;
};
export declare class Raycaster {
    ray: Ray;
    near: number;
    far: number;
    camera: Camera | null;
    constructor(origin?: Vec3, direction?: Vec3, near?: number, far?: number);
    set(origin: Vec3, direction: Vec3): void;
    setFromCamera(coords: [number, number], camera: Camera): void;
    intersectObject(object: Object3D, recursive?: boolean, intersects?: Intersection[]): Intersection[];
    intersectObjects(objects: Object3D[], recursive?: boolean, intersects?: Intersection[]): Intersection[];
}
/**
 * Transform a ray into the local space of an object.
 * Returns the local ray for intersection testing.
 */
export declare function transformRayToLocalSpace(raycaster: Raycaster, matrixWorld: Mat4): Ray;
/**
 * Test ray-triangle intersection and add to intersects if hit.
 * Positions are in local space, ray should be in local space.
 */
export declare function checkTriangleIntersection(object: Object3D, raycaster: Raycaster, localRay: Ray, matrixWorld: Mat4, a: number, b: number, c: number, positions: Float32Array, indices: Uint16Array | Uint32Array | null, uvs: Float32Array | null, intersects: Intersection[], faceIndex: number): void;
