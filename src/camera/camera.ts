import { mat4, type Vec3, vec3 } from 'mathcat';
import { Object3D } from '../core/object3d';
import { CoordinateSystem } from '../core/coordinate-system';

const _invViewProj = mat4.create();

export class Camera extends Object3D {
    readonly isCamera = true;
    readonly isOrthographicCamera?: true;
    readonly isPerspectiveCamera?: true;

    near = 0.1;
    far = 100;

    /**
     * Clip-space convention the projection matrix + frustum are built for. Defaults to WebGPU (z in
     * [0,1]); the renderer stamps its own convention on before rendering and rebuilds the projection.
     */
    coordinateSystem: CoordinateSystem = CoordinateSystem.WEBGPU;

    projectionMatrix = mat4.create();
    matrixWorldInverse = mat4.create();

    constructor() {
        super();
        this.name = 'Camera';
    }

    /** Recompute the projection matrix for the current `coordinateSystem`. Overridden by subclasses. */
    updateProjectionMatrix(): void {}

    /** recompute the matrixWorldInverse from the current matrixWorld. */
    updateViewMatrix(): void {
        if (mat4.invert(this.matrixWorldInverse, this.matrixWorld) === null) {
            mat4.identity(this.matrixWorldInverse);
        }
    }
}

/**
 * Unproject a point from NDC (normalized device coordinates) to world space.
 * NDC: x,y in [-1, 1], z in [0, 1] where 0 is near plane, 1 is far plane (WebGPU convention).
 */
export function unproject(out: Vec3, ndc: Vec3, camera: Camera): Vec3 {
    mat4.multiply(_invViewProj, camera.projectionMatrix, camera.matrixWorldInverse);
    mat4.invert(_invViewProj, _invViewProj);
    vec3.transformMat4(out, ndc, _invViewProj);
    return out;
}
