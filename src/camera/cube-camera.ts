import { vec3, type Vec3 } from 'mathcat';
import { Object3D } from '../core/object3d';
import { PerspectiveCamera } from './perspective-camera';
import type { CubeRenderTarget } from '../core/cube-render-target';
import type { WebGPURenderer } from '../renderer/renderer';
import { finalizeCubeRenderTargetCapture } from '../renderer/textures';

/*
 * Per-face look directions and up vectors, copied verbatim from three.js
 * CubeCamera (WebGPU coordinate system). Cube layer order 0..5 = +X, -X, +Y, -Y, +Z, -Z.
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
            // three.js renders cube faces with a negative fov (-90 degrees), which
            // makes perspectiveZO negate the X and Y scale of the projection.
            this.cameras.push(new PerspectiveCamera(-Math.PI / 2, 1, near, far));
        }
    }

    /**
     * Render the scene into all six faces of the cube render target from this
     * camera's world position. Restores the renderer's previous render target.
     */
    update(renderer: WebGPURenderer, scene: Object3D): void {
        if (this.parent === null) this.updateWorldMatrix();
        this.getWorldPosition(_worldPos);

        const previous = renderer.renderTarget;
        const previousFace = this.renderTarget.activeFace;
        const previousMip = this.renderTarget.activeMipmapLevel;
        const generateMipmaps = this.renderTarget.texture.generateMipmaps;

        this.renderTarget.activeMipmapLevel = this.activeMipmapLevel;
        this.renderTarget.texture.generateMipmaps = false;
        renderer.renderTarget = this.renderTarget;

        for (let face = 0; face < 6; face++) {
            const camera = this.cameras[face];
            vec3.copy(camera.position, _worldPos);
            vec3.add(_target, _worldPos, DIRS[face]);
            camera.lookAt(_target, UPS[face]);
            camera.updateWorldMatrix();
            camera.updateViewMatrix();

            this.renderTarget.activeFace = face;
            renderer.render(scene, camera);
        }

        this.renderTarget.texture.generateMipmaps = generateMipmaps;
        finalizeCubeRenderTargetCapture(renderer._textures, renderer._device, this.renderTarget, this.activeMipmapLevel);

        renderer.renderTarget = previous;
        this.renderTarget.activeFace = previousFace;
        this.renderTarget.activeMipmapLevel = previousMip;
    }
}
