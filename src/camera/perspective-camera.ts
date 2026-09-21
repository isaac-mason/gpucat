import { mat4 } from 'math';
import { CoordinateSystem } from '../core/coordinate-system';
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

    /** Recompute the projection matrix from current fov / aspect / near / far, for the camera's coordinate system. */
    updateProjectionMatrix(): void {
        // WebGPU clip space is z in [0,1] (ZO); WebGL is z in [-1,1] (NO). Only the depth mapping differs.
        if (this.coordinateSystem === CoordinateSystem.WEBGL) {
            mat4.perspectiveNO(this.projectionMatrix, this.fov, this.aspect, this.near, this.far);
        } else {
            mat4.perspectiveZO(this.projectionMatrix, this.fov, this.aspect, this.near, this.far);
        }
    }
}

/** The factory form, matching `createOrthographicCamera` and the other object constructors. */
export function createPerspectiveCamera(fov?: number, aspect?: number, near?: number, far?: number): PerspectiveCamera {
    return new PerspectiveCamera(fov, aspect, near, far);
}
