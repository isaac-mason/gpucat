import { Mesh } from './mesh';
import { createFullscreenTriangleGeometry } from '../geometry/geometry-helpers';
import { Camera } from '../camera/camera';
import type { Material } from '../material/material';
import type { WebGPURenderer } from '../renderer/renderer';

/**
 * Shared fullscreen triangle geometry with position and uv vertex buffers.
 */
const _geometry = /* @__PURE__ */ createFullscreenTriangleGeometry();

/**
 * Shared camera for fullscreen rendering.
 * The vertex shader positions are driven by the geometry buffers directly
 * in clip space, so no projection is applied.
 */
const _camera = /* @__PURE__ */ new Camera();
_camera.name = '__quadCamera__';

/**
 * QuadMesh is a helper for rendering fullscreen effects.
 *
 * It wraps a fullscreen triangle geometry and provides a `render()` method
 * that draws the quad to the renderer's current target (canvas or render target).
 *
 * Usage:
 * ```ts
 * const quad = new QuadMesh(postProcessMaterial);
 * quad.render(renderer);
 * ```
 *
 * The intended usage is to reuse a single quad mesh for rendering
 * subsequent passes by just reassigning the `material` reference.
 */
export class QuadMesh extends Mesh {
    /**
     * The camera used to render the quad mesh.
     */
    readonly camera: Camera = _camera;

    /**
     * Type flag for identification.
     */
    readonly isQuadMesh = true;

    /**
     * @param material - The material to render the quad with.
     */
    constructor(material: Material) {
        super(_geometry, material);
        this.name = '__quadMesh__';
    }

    /**
     * Renders the quad mesh to the renderer's current target.
     *
     * Uses the renderer's current state:
     * - Canvas target (set via `renderer.setCanvasTarget()`)
     * - Render target (set via `renderer.setRenderTarget()`)
     * - Clear color
     * - MSAA samples (only for default canvas target)
     *
     * @param renderer - The WebGPU renderer.
     * @param encoder - Optional command encoder. If not provided, creates and submits one.
     * @param passId - Optional pass label (inspector + GPU tooling). Defaults to the renderer's `'render'`.
     */
    render(renderer: WebGPURenderer, encoder?: GPUCommandEncoder, passId?: string): void {
        renderer.render(this, this.camera, encoder, passId);
    }
}
