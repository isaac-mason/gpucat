/**
 * InspectorBase.ts — Abstract no-op inspector interface.
 *
 * Mirrors Three's InspectorBase.js. The renderer holds a reference to one
 * of these (defaulting to a bare InspectorBase instance whose methods are all
 * no-ops). Swap it for a RendererInspector / Inspector instance to enable
 * profiling and the full Inspector UI.
 *
 * Hook call sites in WebGPURenderer:
 *   init()                 → inspector.setRenderer(renderer); inspector.init()
 *   render() start         → inspector.begin(frameId)
 *   render() end           → inspector.finish(frameId)
 *   _renderPassNode start  → inspector.beginRender(passId, frameId)
 *   _renderPassNode end    → inspector.finishRender(passId, frameId)
 *   _dispatchComputeNode   → inspector.beginCompute(nodeId, frameId) / finishCompute
 *   Node.inspect()         → inspector.inspect(node)
 *   renderScene() start    → inspector.beginRenderScene(passId, scene, samples, colorFormat, frameId)
 */

import type { WebGPURenderer } from '../renderer/renderer';
import type { Node, WgslType } from '../nodes/nodes';
import type { Scene } from '../scene/scene';

export class InspectorBase {
    /** Back-reference to the renderer. Set by renderer after init(). */
    protected renderer: WebGPURenderer | null = null;

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    /** Called once after the renderer's GPUDevice is ready. */
    setRenderer(renderer: WebGPURenderer): void {
        this.renderer = renderer;
    }

    /** Called after setRenderer() — subclasses perform one-time GPU resource setup here. */
    init(): void {}

    // -----------------------------------------------------------------------
    // Frame hooks
    // -----------------------------------------------------------------------

    /** Called at the very start of WebGPURenderer.render(), before any work. */
    begin(_frameId: number): void {}

    /** Called at the very end of WebGPURenderer.render(), after queue.submit(). */
    finish(_frameId: number): void {}

    // -----------------------------------------------------------------------
    // Render pass hooks
    // -----------------------------------------------------------------------

    /** Called before a PassNode scene render pass begins. */
    beginRender(_passId: string, _frameId: number): void {}

    /** Called after a PassNode scene render pass ends. */
    finishRender(_passId: string, _frameId: number): void {}

    // -----------------------------------------------------------------------
    // Compute pass hooks
    // -----------------------------------------------------------------------

    /** Called before a compute dispatch. */
    beginCompute(_nodeId: string, _frameId: number): void {}

    /** Called after a compute dispatch. */
    finishCompute(_nodeId: string, _frameId: number): void {}

    // -----------------------------------------------------------------------
    // Scene hooks
    // -----------------------------------------------------------------------

    /**
     * Called at the start of renderScene(), before the GPU pass begins.
     * Gives the inspector a reference to the scene being rendered, along with
     * the pipeline key parameters needed to retrieve compiled WGSL later.
     */
    beginRenderScene(
        _passId: string,
        _scene: Scene,
        _samples: number,
        _colorFormat: GPUTextureFormat,
        _frameId: number,
    ): void {}

    // -----------------------------------------------------------------------
    // Node inspection
    // -----------------------------------------------------------------------

    /**
     * Called when a node marked with .inspect() is encountered during rendering.
     * Subclasses override this to register the node for Viewer tab preview.
     */
    inspect(_node: Node<WgslType>): void {}

    /** Returns the renderer reference (null until setRenderer() is called). */
    getRenderer(): WebGPURenderer | null {
        return this.renderer;
    }
}
