import { Camera } from './camera';
type ViewOffset = {
    enabled: boolean;
    fullWidth: number;
    fullHeight: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
};
/**
 * Camera that uses orthographic projection.
 *
 * In this projection mode, an object's size in the rendered image stays constant
 * regardless of its distance from the camera. Useful for 2D scenes, UI, and
 * post-processing passes.
 *
 * Uses WebGPU depth range (0→1) via orthoZO, matching PerspectiveCamera's perspectiveZO.
 *
 * ```ts
 * const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
 * ```
 */
export declare class OrthographicCamera extends Camera {
    readonly isOrthographicCamera = true;
    left: number;
    right: number;
    top: number;
    bottom: number;
    zoom: number;
    view: ViewOffset | null;
    /**
     * @param left   - Left plane of the frustum.
     * @param right  - Right plane of the frustum.
     * @param top    - Top plane of the frustum.
     * @param bottom - Bottom plane of the frustum.
     * @param near   - Near plane. Unlike perspective cameras, 0 is valid here.
     * @param far    - Far plane.
     */
    constructor(left?: number, right?: number, top?: number, bottom?: number, near?: number, far?: number);
    /**
     * Sets an offset into a larger frustum for multi-window / multi-monitor setups.
     *
     * @param fullWidth  - Full width of the multiview setup.
     * @param fullHeight - Full height of the multiview setup.
     * @param x          - Horizontal offset of the subcamera.
     * @param y          - Vertical offset of the subcamera.
     * @param width      - Width of the subcamera.
     * @param height     - Height of the subcamera.
     */
    setViewOffset(fullWidth: number, fullHeight: number, x: number, y: number, width: number, height: number): void;
    /** Removes any view offset and recomputes the projection matrix. */
    clearViewOffset(): void;
    /** Recompute the projection matrix from current frustum planes, zoom, and view offset. */
    updateProjectionMatrix(): void;
}
export {};
