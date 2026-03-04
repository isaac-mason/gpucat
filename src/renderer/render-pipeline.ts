/**
 * render-pipeline.ts — RenderPipeline: holds the output node expression that
 * the WebGPURenderer composites to the swapchain each frame.
 *
 * Usage:
 *   const renderPipeline = new RenderPipeline();
 *   renderPipeline.outputNode = scenePass.getTextureNode();
 *
 *   function frame() {
 *       renderer.render(renderPipeline.outputNode!);
 *       requestAnimationFrame(frame);
 *   }
 */

import type { Node, WgslType } from '../nodes/nodes.js';

/**
 * Container for the top-level output node expression.
 * The renderer reads `outputNode` each frame and composites it to the canvas.
 */
export class RenderPipeline {
    /**
     * The node expression to render to the swapchain.
     * Typically a PassColorTextureNode returned by `pass().getTextureNode()`,
     * or any composed post-processing graph rooted at a Node<'vec4f'>.
     * Null until assigned.
     */
    outputNode: Node<WgslType> | null = null;
}
