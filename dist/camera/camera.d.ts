import { type Vec3 } from 'mathcat';
import { Object3D } from 'gpucat/dist/core/object3d';
export declare class Camera extends Object3D {
    near: number;
    far: number;
    projectionMatrix: import("mathcat").Mat4;
    matrixWorldInverse: import("mathcat").Mat4;
    constructor();
    /** recompute the matrixWorldInverse from the current matrixWorld. */
    updateViewMatrix(): void;
}
/**
 * Unproject a point from NDC (normalized device coordinates) to world space.
 * NDC: x,y in [-1, 1], z in [0, 1] where 0 is near plane, 1 is far plane (WebGPU convention).
 */
export declare function unproject(out: Vec3, ndc: Vec3, camera: Camera): Vec3;
