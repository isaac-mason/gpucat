import { type Raycast3, type Vec3, type Mat4 } from 'mathcat';
import type { Object3D } from '../core/object3d';
import { Camera } from '../camera/camera';
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
    ray: Raycast3;
    near: number;
    far: number;
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
export declare function transformRayToLocalSpace(raycaster: Raycaster, matrixWorld: Mat4): Raycast3;
/**
 * Test ray-triangle intersection and add to intersects if hit.
 * Positions are in local space, ray should be in local space.
 */
export declare function checkTriangleIntersection(object: Object3D, raycaster: Raycaster, localRay: Raycast3, matrixWorld: Mat4, a: number, b: number, c: number, positions: Float32Array, indices: Uint16Array | Uint32Array | null, uvs: Float32Array | null, intersects: Intersection[], faceIndex: number): void;
