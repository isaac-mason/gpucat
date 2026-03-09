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
 *
 * Per-draw-call hooks (inside a render pass):
 *   issueDrawsForItems      → inspector.setPipeline(label)
 *                           → inspector.setBindGroup(index, label)
 *                           → inspector.setVertexBuffer(slot)
 *                           → inspector.setIndexBuffer()
 *                           → inspector.draw(vertexCount, instanceCount)
 *                           → inspector.drawIndexed(indexCount, instanceCount)
 *                           → inspector.drawIndirect()
 *                           → inspector.drawIndexedIndirect()
 *
 * Per-dispatch hooks (inside a compute pass):
 *   _dispatchComputeNode    → inspector.dispatchWorkgroups(x, y, z)
 */

import type { WebGPURenderer } from '../renderer/renderer';
import type { InspectorNode, WgslType } from '../nodes/nodes';
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
    inspect(_node: InspectorNode<WgslType>): void {}

    // -----------------------------------------------------------------------
    // Per-draw-call hooks (inside a render pass)
    // -----------------------------------------------------------------------

    /**
     * Called whenever a new pipeline is bound (i.e. renderObject.pipeline changed).
     * `label` is the mesh/material label for the object that triggered the switch.
     */
    setPipeline(_label: string): void {}

    /**
     * Called for each setBindGroup() issued to the GPU pass encoder.
     * `index` is the bind group slot index; `label` is an optional debug label.
     */
    setBindGroup(_index: number, _label: string): void {}

    /**
     * Called for each setVertexBuffer() issued to the GPU pass encoder.
     * `slot` is the vertex buffer slot index.
     */
    setVertexBuffer(_slot: number): void {}

    /**
     * Called whenever setIndexBuffer() is issued for an indexed draw.
     */
    setIndexBuffer(): void {}

    /**
     * Called for each non-indexed draw().
     */
    draw(_vertexCount: number, _instanceCount: number): void {}

    /**
     * Called for each indexed drawIndexed().
     */
    drawIndexed(_indexCount: number, _instanceCount: number): void {}

    /**
     * Called for each drawIndirect() (non-indexed indirect draw).
     */
    drawIndirect(): void {}

    /**
     * Called for each drawIndexedIndirect() (indexed indirect draw).
     */
    drawIndexedIndirect(): void {}

    // -----------------------------------------------------------------------
    // Per-dispatch hooks (inside a compute pass)
    // -----------------------------------------------------------------------

    /**
     * Called for each dispatchWorkgroups() issued in a compute pass.
     */
    dispatchWorkgroups(_x: number, _y: number, _z: number): void {}

    /** Returns the renderer reference (null until setRenderer() is called). */
    getRenderer(): WebGPURenderer | null {
        return this.renderer;
    }
}
