import { mat4 } from 'mathcat';
import { Camera } from './camera';

export class PerspectiveCamera extends Camera {
    readonly isPerspectiveCamera = true;
    fov: number;
    aspect: number;

    constructor(fov = Math.PI / 4, aspect = 1.0, near = 0.1, far = 1000.0) {
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
