import { type Mat4, type Box3, type Sphere, type Plane3 } from 'mathcat';
export type Frustum = [Plane3, Plane3, Plane3, Plane3, Plane3, Plane3];
export declare function create(): Frustum;
export declare function clone(f: Frustum): Frustum;
export declare function copy(out: Frustum, f: Frustum): Frustum;
export declare function setFromViewProjectionMatrix(out: Frustum, proj: Mat4, view: Mat4): Frustum;
export declare function intersectsSphere(f: Frustum, s: Sphere): boolean;
export declare function intersectsBox3(f: Frustum, box: Box3): boolean;
