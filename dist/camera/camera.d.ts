import { Object3D } from '../core/object3d';
export declare class Camera extends Object3D {
    near: number;
    far: number;
    projectionMatrix: import("mathcat").Mat4;
    matrixWorldInverse: import("mathcat").Mat4;
    constructor();
    /** recompute the matrixWorldInverse from the current matrixWorld. */
    updateViewMatrix(): void;
}
