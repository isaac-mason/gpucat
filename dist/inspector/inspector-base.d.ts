/**
 * InspectorBase.ts — Abstract inspector interface.
 *
 * The renderer's `inspector` field is `InspectorBase | null` — null means no
 * inspector is attached (zero hot-path cost). Install one with
 * `renderer.setInspector(new Inspector())` and remove with
 * `renderer.setInspector(null)`.
 *
 * Lifecycle (driven by the renderer's setInspector):
 *   attach   → inspector.setRenderer(renderer)
 *              (subclass runs setup lazily; defers GPU work until renderer is initialized)
 *   detach   → inspector.setRenderer(null)
 *              (subclass releases GPU resources, removes DOM, drops listeners)
 *
 * Hook call sites in WebGPURenderer (all guarded by `if (inspector)`):
 *   render() start         → inspector.begin(frameId)
 *   render() end           → inspector.finish(frameId)
 *   _renderPassNode start  → inspector.beginRender(passId, frameId)
 *   _renderPassNode end    → inspector.finishRender(passId, frameId)
 *   _dispatchComputeNode   → inspector.beginCompute(node, frameId) / finishCompute
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
import type { InspectorNode, ComputeNode } from '../nodes/nodes';
import type { Object3D } from '../core/object3d';
import { Any } from '../schema/schema';
export declare class InspectorBase {
    /** Back-reference to the renderer. Set by renderer after init(). */
    renderer: WebGPURenderer | null;
    /** Performance marker API - no-op in base class, implemented in RendererInspector */
    perf: {
        start: (_name: string) => void;
        end: (_name: string) => void;
    };
    /**
     * Diagnostic log API — call sites that want their message surfaced in the
     * Inspector's Console tab go through here, e.g.
     *   `renderer.inspector?.log.warn('shader compile failed')`.
     *
     * Base implementation routes warn/error to `console.warn`/`console.error`
     * so devtools still sees them when no full Inspector is attached. The full
     * `Inspector` subclass also pushes into the Console tab. Random gpucat
     * `console.warn` sites that don't care about tab routing can keep using
     * the global `console` directly.
     */
    log: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
    };
    /**
     * Attach (renderer non-null) or detach (renderer null).
     * Subclasses override to perform setup on attach and teardown on detach.
     * Setup may be deferred (e.g. until renderer._initialized is true) — see
     * subclasses for the specific lazy strategy.
     */
    setRenderer(renderer: WebGPURenderer | null): void;
    /**
     * Subclasses run one-time GPU resource setup here. Called by subclasses
     * themselves from setRenderer() once the renderer is initialized — the
     * top-level renderer does NOT call this.
     */
    init(): void;
    /** Called at the very start of WebGPURenderer.render(), before any work. */
    begin(_frameId: number): void;
    /** Called at the very end of WebGPURenderer.render(), after queue.submit(). */
    finish(_frameId: number): void;
    /** Called before a PassNode scene render pass begins. */
    beginRender(_passId: string, _frameId: number): void;
    /** Called after a PassNode scene render pass ends. */
    finishRender(_passId: string, _frameId: number): void;
    /**
     * Returns timestampWrites configuration for a render/compute pass, or undefined if not available.
     * Called by the renderer when creating a pass to inject GPU timing queries.
     */
    getTimestampWrites(_passId: string): GPURenderPassTimestampWrites | undefined;
    /** Called before a compute dispatch. */
    beginCompute(_node: ComputeNode, _frameId: number): void;
    /** Called after a compute dispatch. */
    finishCompute(_nodeId: string, _frameId: number): void;
    /**
     * Called at the start of renderScene(), before the GPU pass begins.
     * Gives the inspector a reference to the scene being rendered, along with
     * the pipeline key parameters needed to retrieve compiled WGSL later.
     */
    beginRenderScene(_passId: string, _scene: Object3D, _samples: number, _colorFormat: GPUTextureFormat, _frameId: number): void;
    /**
     * Called when a node marked with .inspect() is encountered during rendering.
     * Subclasses override this to register the node for Viewer tab preview.
     */
    inspect(_node: InspectorNode<Any>): void;
    /**
     * Called whenever a new pipeline is bound (i.e. renderObject.pipeline changed).
     * `label` is the mesh/material label for the object that triggered the switch.
     */
    setPipeline(_label: string): void;
    /**
     * Called for each setBindGroup() issued to the GPU pass encoder.
     * `index` is the bind group slot index; `label` is an optional debug label.
     */
    setBindGroup(_index: number, _label: string): void;
    /**
     * Called for each setVertexBuffer() issued to the GPU pass encoder.
     * `slot` is the vertex buffer slot index.
     */
    setVertexBuffer(_slot: number): void;
    /**
     * Called whenever setIndexBuffer() is issued for an indexed draw.
     */
    setIndexBuffer(): void;
    /**
     * Called for each non-indexed draw().
     */
    draw(_vertexCount: number, _instanceCount: number): void;
    /**
     * Called for each indexed drawIndexed().
     */
    drawIndexed(_indexCount: number, _instanceCount: number): void;
    /**
     * Called for each drawIndirect() (non-indexed indirect draw).
     */
    drawIndirect(): void;
    /**
     * Called for each drawIndexedIndirect() (indexed indirect draw).
     */
    drawIndexedIndirect(): void;
    /**
     * Called for each dispatchWorkgroups() issued in a compute pass.
     */
    dispatchWorkgroups(_x: number, _y: number, _z: number): void;
    /**
     * Called for each dispatchWorkgroupsIndirect() issued in a compute pass.
     */
    dispatchWorkgroupsIndirect(_buffer: GPUBuffer, _offset: number): void;
    /** Returns the renderer reference (null until setRenderer() is called). */
    getRenderer(): WebGPURenderer | null;
}
