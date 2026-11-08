import { type Mat4, mat4, type Vec3, vec3 } from 'math';
import { Object3D } from '../core/object3d';
import type { View } from '../renderer/core/view';
import { CoordinateSystem } from '../core/coordinate-system';

const _invViewProj = mat4.create();
const _ndc = vec3.create();

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

/** World to clip space for `view`, `projectionMatrix * matrixWorldInverse`, written into `out`. */
export function viewProjection(out: Mat4, view: View): Mat4 {
    return mat4.multiply(out, view.projectionMatrix, view.matrixWorldInverse);
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
export function unproject(out: Vec3, ndc: Vec3, camera: Camera): Vec3 {
    mat4.invert(_invViewProj, viewProjection(_invViewProj, camera));
    _ndc[0] = ndc[0];
    _ndc[1] = ndc[1];
    _ndc[2] = camera.coordinateSystem === CoordinateSystem.WEBGL ? ndc[2] * 2 - 1 : ndc[2];
    vec3.transformMat4(out, _ndc, _invViewProj);
    return out;
}
