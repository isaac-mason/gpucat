/**
 * render-pipeline.ts — outputNode-based render pipeline.
 *
 * Usage:
 *   const scenePass = pass(scene, camera);
 *   const pipeline = new RenderPipeline();
 *   pipeline.outputNode = scenePass.getTextureNode();
 *
 *   // animation loop:
 *   pipeline.render(renderer);
 *
 * The pipeline collects all PassNodes reachable from `outputNode` via BFS,
 * renders each scene into its off-screen render target, then renders the
 * node expression as a fullscreen quad to the swapchain.
 */

import type { Node, WgslType } from '../nodes/nodes.js';
import type { WebGPURenderer } from './renderer.js';

export class RenderPipeline {
    /** The root node expression to render to the swapchain. */
    outputNode: Node<WgslType> | null = null;

    /**
     * Execute the pipeline against the given renderer.
     * Collects all PassNodes, renders their scenes, then renders the output
     * expression as a fullscreen quad to the swapchain.
     */
    render(renderer: WebGPURenderer): void {
        renderer._executePipeline(this);
    }
}
