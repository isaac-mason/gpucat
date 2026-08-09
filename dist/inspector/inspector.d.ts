/**
 * Inspector.ts, Full gpucat Inspector UI shell.
 *
 * Extends RendererInspector with:
 *  - A Profiler UI panel housing all tabs
 *  - Display cycle updates (text at 250ms, graph at 20ms)
 *  - Timeline recording via overridden begin/beginRender/finishRender/beginCompute/finishCompute hooks
 *  - Console monkey-patching of console.warn / console.error
 *  - Viewer tab: inspectable node canvases
 */
import { RendererInspector } from './renderer-inspector';
export type { ComputeEntry, FrameRecord, MarkerEntry, PassRecord, RenderEntry, SceneRecord, TimelineEntry, } from './renderer-inspector';
import type { ComputeNode, InspectorNode } from '../nodes/nodes';
import type { RenderObject } from '../renderer/core/render-object';
import type { Any } from '../schema/schema';
import type { InspectableRenderer } from './inspector-base';
import type { GUI } from './gui/GUI';
import type { ProbeTarget } from './probe-wgsl';
import { ComputeCalls } from './tabs/compute-calls';
import { Console } from './tabs/console';
import { DrawCalls } from './tabs/draw-calls';
import { Memory } from './tabs/memory';
import { Parameters } from './tabs/parameters';
import { Performance } from './tabs/performance';
import { PerformanceTimeline } from './tabs/performance-timeline';
import { SceneHierarchy } from './tabs/scene-hierarchy';
import { Settings } from './tabs/settings';
import { Timeline } from './tabs/timeline';
import { type CanvasData, Viewer } from './tabs/viewer';
import { Profiler } from './ui/profiler';
export declare class Inspector extends RendererInspector {
    readonly profiler: Profiler;
    readonly performance: Performance;
    readonly performanceTimeline: PerformanceTimeline;
    readonly memory: Memory;
    readonly console: Console;
    readonly parameters: Parameters;
    readonly viewer: Viewer;
    readonly timeline: Timeline;
    readonly settings: Settings;
    readonly sceneHierarchy: SceneHierarchy;
    readonly drawCalls: DrawCalls;
    readonly computeCalls: ComputeCalls;
    private _displayCycle;
    private _lastUpdateTime;
    /** Cache of CanvasData per inspectable node. */
    private _canvasNodes;
    /** Active probe entry, if any. */
    private _activeProbe;
    /** Active WebGL probe entry, if any (mutually exclusive with `_activeProbe`). */
    private _activeGlProbe;
    constructor();
    get domElement(): HTMLElement;
    /**
     * Surface log messages in the Console tab AND devtools. Overrides the
     * no-op base. Callers route via `renderer.inspector?.log.warn('...')`.
     */
    readonly log: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
    };
    setRenderer(renderer: InspectableRenderer | null): void;
    /**
     * Release everything this Inspector owns: GPU resources (probe + timestamp
     * query state), DOM (panel + any detached tab windows), and window
     * listeners. Safe to call multiple times. After dispose the instance is
     * dead, discard it and `new Inspector()` if you need one again.
     *
     * Normally called automatically via `renderer.setInspector(null)`; expose
     * directly for callers that want explicit teardown.
     */
    dispose(): Promise<void>;
    begin(frameId: number): void;
    beginRender(passId: string, frameId: number): void;
    finishRender(passId: string, frameId: number): void;
    beginCompute(node: ComputeNode, frameId: number): void;
    finishCompute(nodeId: string, frameId: number): void;
    setPipeline(label: string): void;
    setBindGroup(index: number, label: string): void;
    setVertexBuffer(slot: number): void;
    setIndexBuffer(): void;
    draw(vertexCount: number, instanceCount: number): void;
    drawIndexed(indexCount: number, instanceCount: number): void;
    drawIndirect(): void;
    drawIndexedIndirect(): void;
    dispatchWorkgroups(x: number, y: number, z: number): void;
    dispatchWorkgroupsIndirect(_buffer: GPUBuffer, offset: number): void;
    finish(frameId: number): void;
    createParameters(name: string): GUI;
    /**
     * Set the active probe to the given variable expression in the given mesh's
     * compiled WGSL.  Builds a new probe pipeline (patched WGSL + same bind
     * group layouts), creates a 140×140 CanvasTarget, and wires it to render
     * every frame in _processFrame.
     *
     * Returns the probe canvas element so the caller can display it, or null
     * if patching / pipeline creation fails.
     */
    setProbe(target: ProbeTarget, sourceRO: RenderObject): HTMLElement | null;
    /**
     * WebGL probe: patch the fragment GLSL to output the probed value, build a small popover element
     * (color swatch + numeric readback), and wire it to read back each frame via renderer.renderProbe.
     * Returns the element, or null if patching fails. Never touches `device`.
     */
    private _setGlProbe;
    /** Remove the active probe (WebGPU and WebGL). Returns a promise that resolves
     *  once the WebGPU probe's GPU resources are actually destroyed (drained first). */
    clearProbe(): Promise<void>;
    navigateToRO(ro: RenderObject): void;
    private _processFrame;
    /**
     * Build canvasData for each inspectable node and call viewer.update().
     */
    resolveViewer(nodes: InspectorNode<Any>[]): void;
    /**
     * Get or create the CanvasData for an inspectable node.
     * Creates a 140×140 CanvasTarget, wraps the node as vec4(vec3(node), 1),
     * and builds a fullscreen Material. Cached per node, never recreated.
     */
    getCanvasDataByNode(node: InspectorNode<Any>): CanvasData;
    private _tickCycle;
    /**
     * Encode and submit a single render pass for the active probe.
     * Uses the real mesh vertex/index buffers and bind groups (which include
     * camera uniforms updated this frame) so the probe renders the mesh from
     * the camera's point of view with the chosen expression as the color output.
     */
    private _renderProbe;
    /**
     * WebGL probe readback: re-render the probed mesh with the patched fragment into a 1×1 FBO via
     * renderer.renderProbe, then decode the pixel per the coerced type and update the swatch + text.
     * Runs each frame while a WebGL probe is active. Never touches `device`.
     */
    private _renderGlProbe;
}
