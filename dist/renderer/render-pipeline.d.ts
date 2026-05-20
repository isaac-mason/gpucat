import type { Node } from '../nodes/nodes';
import type { Any } from '../schema/schema';
import type { WebGPURenderer } from './renderer';
/**
 * RenderPipeline - manages the rendering pipeline for fullscreen effects.
 *
 * Usage:
 * ```ts
 * const renderPipeline = new RenderPipeline(renderer);
 *
 * const scenePass = pass(scene, camera);
 * renderPipeline.outputNode = scenePass;
 *
 * function frame() {
 *     renderPipeline.render();
 *     requestAnimationFrame(frame);
 * }
 *
 * // cleanup
 * renderPipeline.dispose();
 * ```
 */
export declare class RenderPipeline {
    /** reference to the renderer */
    readonly renderer: WebGPURenderer;
    /** the output node to render */
    outputNode: Node<Any>;
    /** set to `true` to rebuild the material, e.g. when the outputNode changes */
    needsUpdate: boolean;
    /** material used for rendering the fullscreen quad */
    private _material;
    /** the QuadMesh used for fullscreen rendering */
    private _quadMesh;
    /**
     * @param renderer the renderer.
     * @param outputNode output node. Defaults to solid blue.
     */
    constructor(renderer: WebGPURenderer, outputNode?: Node<Any>);
    /**
     * Renders the output node to the renderer's current target.
     *
     * Call `renderer.beginFrame()` before and `renderer.endFrame()` after all
     * compute and render work for the frame. Example:
     * ```ts
     * renderer.beginFrame();
     * renderer.compute(myCompute, { dispatch: [n, 1, 1] });
     * renderPipeline.render();
     * renderer.endFrame();
     * ```
     */
    render(): void;
    /**
     * Dispose of resources owned by this pipeline.
     */
    dispose(): void;
    /**
     * Updates the material if outputNode has changed.
     * @internal
     */
    private _update;
    /**
     * Creates a fullscreen material for the given output node.
     * @internal
     */
    private _createMaterial;
}
