import type { CubeRenderTarget } from '../core/cube-render-target';
import { Object3D } from '../core/object3d';
import type { Frame } from '../renderer/core/frame';
import { PerspectiveCamera } from './perspective-camera';
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
    /** Records six passes, one per face, on the caller's frame, so the cube and what samples it share a submit. */
    update(f: Frame, scene: Object3D): void;
}
/** The factory form; pair it with `createCubeRenderTarget` for the target it draws into. */
export declare function createCubeCamera(near: number, far: number, renderTarget: CubeRenderTarget): CubeCamera;
