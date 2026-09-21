import { type Vec3, vec3 } from 'math';
import type { CubeRenderTarget } from '../core/cube-render-target';
import { Object3D } from '../core/object3d';
import type { Frame } from '../renderer/core/frame';
import { PerspectiveCamera } from './perspective-camera';

/*
 * Per-face look directions and up vectors (WebGPU coordinate system).
 * Cube layer order 0..5 = +X, -X, +Y, -Y, +Z, -Z.
 */
const DIRS: Vec3[] = [
    [-1, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
];
const UPS: Vec3[] = [
    [0, -1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
    [0, -1, 0],
    [0, -1, 0],
];

const _target: Vec3 = [0, 0, 0];
const _worldPos: Vec3 = [0, 0, 0];

/**
 * A camera that renders its surroundings into the six faces of a
 * {@link CubeRenderTarget}, for realtime environment maps and reflections.
 *
 * Position the cube camera where the reflective object sits, then call
 * `update(renderer, scene)` to capture the scene into the target. Sample the
 * result with `cubeTexture(cubeCamera.renderTarget.texture)`.
 *
 * Like the rest of gpucat, this does no automatic per-frame work: you call
 * `update()` when you want to refresh the environment map (often after hiding
 * the reflective object so it does not capture itself).
 */
export class CubeCamera extends Object3D {
    /** The cube render target this camera draws into. */
    readonly renderTarget: CubeRenderTarget;

    /** The six per-face perspective cameras (90 degree fov, 1:1 aspect). */
    readonly cameras: PerspectiveCamera[] = [];

    /** Active mip level written by update(). */
    activeMipmapLevel = 0;

    constructor(near: number, far: number, renderTarget: CubeRenderTarget) {
        super();
        this.name = 'CubeCamera';
        this.renderTarget = renderTarget;
        for (let i = 0; i < 6; i++) {
            // A negative fov (-90°) makes the zero-to-one-depth perspective projection negate
            // the X and Y scale — the orientation the six faces are stored with.
            this.cameras.push(new PerspectiveCamera(-Math.PI / 2, 1, near, far));
        }
    }

    /** Records six passes, one per face, on the caller's frame, so the cube and what samples it share a submit. */
    update(f: Frame, scene: Object3D): void {
        if (this.parent === null) this.updateWorldMatrix();
        this.getWorldPosition(_worldPos);

        const generateMipmaps = this.renderTarget.texture.generateMipmaps;

        // Mips fill once, on the face that completes the cube: earlier faces are not defined yet,
        // and regenerating per face would be 6x redundant.
        this.renderTarget.texture.generateMipmaps = false;

        for (let face = 0; face < 6; face++) {
            if (face === 5) this.renderTarget.texture.generateMipmaps = generateMipmaps;

            const camera = this.cameras[face];
            vec3.copy(camera.position, _worldPos);
            vec3.add(_target, _worldPos, DIRS[face]);
            camera.lookAt(_target, UPS[face]);
            camera.updateWorldMatrix();
            camera.updateViewMatrix();

            const pass = f.pass({
                target: this.renderTarget,
                camera,
                layer: face,
                mipLevel: this.activeMipmapLevel,
                label: 'cube-camera',
            });
            pass.scene(scene, camera);
            pass.end();
        }
    }
}

/** The factory form; pair it with `createCubeRenderTarget` for the target it draws into. */
export function createCubeCamera(near: number, far: number, renderTarget: CubeRenderTarget): CubeCamera {
    return new CubeCamera(near, far, renderTarget);
}
