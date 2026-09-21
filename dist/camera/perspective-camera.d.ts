import { Camera } from './camera';
export declare class PerspectiveCamera extends Camera {
    readonly isPerspectiveCamera = true;
    fov: number;
    aspect: number;
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    /** Recompute the projection matrix from current fov / aspect / near / far, for the camera's coordinate system. */
    updateProjectionMatrix(): void;
}
/** The factory form, matching `createOrthographicCamera` and the other object constructors. */
export declare function createPerspectiveCamera(fov?: number, aspect?: number, near?: number, far?: number): PerspectiveCamera;
