/**
 * camera.ts — Camera with projection + view matrix management.
 *
 * Camera UBO layout (std140, group 0, binding 0):
 *
 *   struct Camera {
 *     projectionMatrix : mat4x4f,
 *     viewMatrix       : mat4x4f,
 *     position         : vec3f,
 *     near             : f32,
 *     far              : f32,
 *     _pad             : vec3f,
 *   }
 *
 * Total: 2×64 + 12 + 4 + 4 + 12 = 160 bytes, padded to 176 (std140).
 *
 * Concrete subclass: PerspectiveCamera(fov, aspect, near, far)
 */

import { mat4, type Mat4 } from 'mathcat';
import { Object3D } from './object3d.js';

export class Camera extends Object3D {
    projectionMatrix: Mat4 = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

    near: number = 0.1;
    far: number = 100;

    /** View matrix = inverse of world matrix. Updated each frame by updateViewMatrix(). */
    _viewMatrix: Mat4 = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

    constructor() {
        super();
        this.name = 'Camera';
    }

    updateViewMatrix(): void {
        if (mat4.invert(this._viewMatrix, this._worldMatrix) === null) {
            mat4.identity(this._viewMatrix);
        }
    }
}

// ---------------------------------------------------------------------------
// PerspectiveCamera
// ---------------------------------------------------------------------------

/**
 * Perspective camera with settable fov / aspect / near / far properties.
 *
 * Call `updateProjectionMatrix()` after changing any property.
 *
 * ```ts
 * const camera = new PerspectiveCamera(Math.PI / 4, canvas.width / canvas.height, 0.1, 100);
 * camera.position[2] = 5;
 *
 * // On resize:
 * camera.aspect = canvas.width / canvas.height;
 * camera.updateProjectionMatrix();
 * ```
 */
export class PerspectiveCamera extends Camera {
    fov: number;
    aspect: number;

    constructor(fov: number, aspect: number, near: number, far: number) {
        super();
        this.name = 'PerspectiveCamera';
        this.fov = fov;
        this.aspect = aspect;
        this.near = near;
        this.far = far;
        this.updateProjectionMatrix();
    }

    /** Recompute the projection matrix from current fov / aspect / near / far. */
    updateProjectionMatrix(): void {
        mat4.perspectiveZO(this.projectionMatrix, this.fov, this.aspect, this.near, this.far);
    }
}
