import { mat4, type Vec3 } from 'math';
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
 * NDC: x,y in [-1, 1], z in the CANONICAL [0, 1] near→far convention (WebGPU) — backend-agnostic.
 *
 * The camera's projection may use the WebGL NDC-z range [-1, 1] (perspectiveNO/orthoNO), so the
 * canonical z is mapped into the camera's actual range before applying the inverse view-projection.
 * This keeps callers (and the frustum-corner helpers in examples) backend-agnostic: pass z=0 for the
 * near plane and z=1 for the far plane regardless of backend.
 */
export declare function unproject(out: Vec3, ndc: Vec3, camera: Camera): Vec3;
