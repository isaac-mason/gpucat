import { Mesh } from './mesh';
import { Camera } from '../camera/camera';
import type { Material } from '../material/material';
import type { WebGPURenderer } from '../renderer/renderer';
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
export declare class QuadMesh extends Mesh {
    /**
     * The camera used to render the quad mesh.
     */
    readonly camera: Camera;
    /**
     * Type flag for identification.
     */
    readonly isQuadMesh = true;
    /**
     * @param material - The material to render the quad with.
     */
    constructor(material: Material);
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
     */
    render(renderer: WebGPURenderer, encoder?: GPUCommandEncoder): void;
}
