import { mat4 } from 'mathcat';
import { Camera } from './camera';

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

    /** recompute the projection matrix from current fov / aspect / near / far. */
    updateProjectionMatrix(): void {
        mat4.perspectiveZO(this.projectionMatrix, this.fov, this.aspect, this.near, this.far);
    }
}
