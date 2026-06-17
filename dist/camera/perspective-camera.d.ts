import { Camera } from './camera';
export declare class PerspectiveCamera extends Camera {
    readonly isPerspectiveCamera = true;
    fov: number;
    aspect: number;
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    /** Recompute the projection matrix from current fov / aspect / near / far. */
    updateProjectionMatrix(): void;
}
