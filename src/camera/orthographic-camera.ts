import { mat4 } from 'mathcat';
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
 * Three.js aligned: mirrors THREE.OrthographicCamera.
 * Uses WebGPU depth range (0→1) via orthoZO, matching PerspectiveCamera's perspectiveZO.
 *
 * ```ts
 * const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
 * ```
 */
export class OrthographicCamera extends Camera {
    readonly isOrthographicCamera = true;

    left: number;
    right: number;
    top: number;
    bottom: number;

    zoom: number = 1;

    view: ViewOffset | null = null;

    /**
     * @param left   - Left plane of the frustum.
     * @param right  - Right plane of the frustum.
     * @param top    - Top plane of the frustum.
     * @param bottom - Bottom plane of the frustum.
     * @param near   - Near plane. Unlike perspective cameras, 0 is valid here.
     * @param far    - Far plane.
     */
    constructor(
        left: number = -1,
        right: number = 1,
        top: number = 1,
        bottom: number = -1,
        near: number = 0.1,
        far: number = 2000,
    ) {
        super();
        this.name = 'OrthographicCamera';
        this.left = left;
        this.right = right;
        this.top = top;
        this.bottom = bottom;
        this.near = near;
        this.far = far;
        this.updateProjectionMatrix();
    }

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
    setViewOffset(
        fullWidth: number,
        fullHeight: number,
        x: number,
        y: number,
        width: number,
        height: number,
    ): void {
        if (this.view === null) {
            this.view = {
                enabled: true,
                fullWidth: 1,
                fullHeight: 1,
                offsetX: 0,
                offsetY: 0,
                width: 1,
                height: 1,
            };
        }

        this.view.enabled = true;
        this.view.fullWidth = fullWidth;
        this.view.fullHeight = fullHeight;
        this.view.offsetX = x;
        this.view.offsetY = y;
        this.view.width = width;
        this.view.height = height;

        this.updateProjectionMatrix();
    }

    /** Removes any view offset and recomputes the projection matrix. */
    clearViewOffset(): void {
        if (this.view !== null) {
            this.view.enabled = false;
        }
        this.updateProjectionMatrix();
    }

    /** Recompute the projection matrix from current frustum planes, zoom, and view offset. */
    updateProjectionMatrix(): void {
        const dx = (this.right - this.left) / (2 * this.zoom);
        const dy = (this.top - this.bottom) / (2 * this.zoom);
        const cx = (this.right + this.left) / 2;
        const cy = (this.top + this.bottom) / 2;

        let left = cx - dx;
        let right = cx + dx;
        let top = cy + dy;
        let bottom = cy - dy;

        if (this.view !== null && this.view.enabled) {
            const scaleW = (this.right - this.left) / this.view.fullWidth / this.zoom;
            const scaleH = (this.top - this.bottom) / this.view.fullHeight / this.zoom;

            left += scaleW * this.view.offsetX;
            right = left + scaleW * this.view.width;
            top -= scaleH * this.view.offsetY;
            bottom = top - scaleH * this.view.height;
        }

        // WebGPU depth range is 0→1, so use orthoZO (zero-to-one) to match perspectiveZO.
        mat4.orthoZO(this.projectionMatrix, left, right, bottom, top, this.near, this.far);
    }
}
