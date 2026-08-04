import { mat4, type Vec3 } from 'mathcat';
import { Object3D } from '../core/object3d';
import { CoordinateSystem } from '../core/coordinate-system';
export declare class Camera extends Object3D {
    readonly isCamera = true;
    readonly isOrthographicCamera?: true;
    readonly isPerspectiveCamera?: true;
    near: number;
    far: number;
    /**
     * Clip-space convention the projection matrix + frustum are built for. Defaults to WebGPU (z in
     * [0,1]); the renderer stamps its own convention on before rendering and rebuilds the projection.
     */
    coordinateSystem: CoordinateSystem;
    projectionMatrix: mat4.Mat4;
    matrixWorldInverse: mat4.Mat4;
    constructor();
    /** Recompute the projection matrix for the current `coordinateSystem`. Overridden by subclasses. */
    updateProjectionMatrix(): void;
    /** recompute the matrixWorldInverse from the current matrixWorld. */
    updateViewMatrix(): void;
}
/**
 * Unproject a point from NDC (normalized device coordinates) to world space.
 * NDC: x,y in [-1, 1], z in [0, 1] where 0 is near plane, 1 is far plane (WebGPU convention).
 */
export declare function unproject(out: Vec3, ndc: Vec3, camera: Camera): Vec3;
