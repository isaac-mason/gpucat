import { Object3D } from '../core/object3d';
import { PerspectiveCamera } from './perspective-camera';
import type { CubeRenderTarget } from '../core/cube-render-target';
import type { WebGPURenderer } from '../renderer/renderer';
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
export declare class CubeCamera extends Object3D {
    /** The cube render target this camera draws into. */
    readonly renderTarget: CubeRenderTarget;
    /** The six per-face perspective cameras (90 degree fov, 1:1 aspect). */
    readonly cameras: PerspectiveCamera[];
    /** Active mip level written by update(). */
    activeMipmapLevel: number;
    constructor(near: number, far: number, renderTarget: CubeRenderTarget);
    /**
     * Render the scene into all six faces of the cube render target from this
     * camera's world position. Restores the renderer's previous render target.
     */
    update(renderer: WebGPURenderer, scene: Object3D): void;
}
