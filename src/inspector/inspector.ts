/**
 * Inspector.ts — Full gpucat Inspector UI shell.
 *
 * Extends RendererInspector with:
 *  - A Profiler UI panel housing all tabs
 *  - Display cycle updates (text at 250ms, graph at 20ms)
 *  - Timeline recording via overridden begin/beginRender/finishRender/beginCompute/finishCompute hooks
 *  - Console monkey-patching of console.warn / console.error
 *  - Viewer tab: inspectable node canvases
 */

import { RendererInspector } from './renderer-inspector';
import type { FrameRecord } from './renderer-inspector';
import { Profiler } from './ui/profiler';
import { injectStyle } from './ui/style';
import { setText } from './ui/utils';
import { Parameters } from './tabs/parameters';
import { Performance } from './tabs/performance';
import { Memory } from './tabs/memory';
import { Timeline } from './tabs/timeline';
import { Console } from './tabs/console';
import { Settings } from './tabs/settings';
import { Viewer, makePreviewMaterial, splitCamelCase, splitPath, type CanvasData } from './tabs/viewer';
import { SceneHierarchy } from './tabs/scene-hierarchy';
import { DrawCalls } from './tabs/draw-calls';
import type { Node, WgslType } from '../nodes/nodes';
import type { WebGPURenderer } from '../renderer/renderer';
import { CanvasTarget } from '../renderer/canvas-target';
import { buildProbeWGSL } from './probe-wgsl';
import type { ProbeTarget } from './probe-wgsl';
import type { RenderObject } from '../renderer/render-object';
import { buildVertexBufferLayouts } from '../renderer/render-objects';
import * as buffers from '../renderer/buffers';


type DisplayCycleEntry = { needsUpdate: boolean; duration: number; time: number };

// ---------------------------------------------------------------------------
// ProbeEntry — live shader value inspector canvas
// ---------------------------------------------------------------------------

type ProbeEntry = {
    /** The probed expression. */
    expr: string;
    /** The patched WGSL source. */
    patchedCode: string;
    /** The probe render pipeline (patched shader + same bind group layouts). */
    pipeline: GPURenderPipeline;
    /** 140×140 preview canvas target. */
    canvasTarget: CanvasTarget;
    /** The HTML canvas element. */
    canvas: HTMLCanvasElement;
    /** The source RenderObject whose bind groups and vertex/index buffers are reused. */
    sourceRO: RenderObject;
    /** Depth texture for the probe canvas (recreated if canvas size changes). */
    depthTexture: GPUTexture;
    /** Stable cache key: `${varName}::${anchorKind}::${roId}` */
    cacheKey: string;
};

export class Inspector extends RendererInspector {

    readonly profiler: Profiler;
    readonly performance: Performance;
    readonly memory: Memory;
    readonly console: Console;
    readonly parameters: Parameters;
    readonly viewer: Viewer;
    readonly timeline: Timeline;
    readonly settings: Settings;
    readonly sceneHierarchy: SceneHierarchy;
    readonly drawCalls: DrawCalls;

    private _displayCycle: { text: DisplayCycleEntry; graph: DisplayCycleEntry };
    private _lastUpdateTime = 0;

    /** Cache of CanvasData per inspectable node. */
    private _canvasNodes: Map<Node<WgslType>, CanvasData> = new Map();

    /** Active probe entry, if any. */
    private _activeProbe: ProbeEntry | null = null;

    constructor() {
        super();

        injectStyle();

        const profiler = new Profiler();

        const parameters = new Parameters({
            builtin: true,
            icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M14 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M4 6l8 0" /><path d="M16 6l4 0" /><path d="M8 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M4 12l2 0" /><path d="M10 12l10 0" /><path d="M17 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M4 18l11 0" /><path d="M19 18l1 0" /></svg>'
        });
        parameters.hide();
        profiler.addTab(parameters);

        const viewer = new Viewer();
        viewer.hide();
        profiler.addTab(viewer);

        const sceneHierarchy = new SceneHierarchy();
        sceneHierarchy.hide();
        profiler.addTab(sceneHierarchy);

        const drawCalls = new DrawCalls();
        drawCalls.hide();
        profiler.addTab(drawCalls);

        const performance = new Performance();
        profiler.addTab(performance);

        const memory = new Memory();
        profiler.addTab(memory);

        const timeline = new Timeline();
        profiler.addTab(timeline);

        const consoleTab = new Console();
        profiler.addTab(consoleTab);

        const settings = new Settings();
        profiler.addTab(settings);

        profiler.loadLayout();

        if (!profiler.activeTabId) {
            profiler.setActiveTab(performance.id);
        }

        this.profiler = profiler;
        this.performance = performance;
        this.memory = memory;
        this.console = consoleTab;
        this.parameters = parameters;
        this.viewer = viewer;
        this.timeline = timeline;
        this.settings = settings;
        this.sceneHierarchy = sceneHierarchy;
        this.drawCalls = drawCalls;

        this._displayCycle = {
            text:  { needsUpdate: false, duration: 250, time: 0 },
            graph: { needsUpdate: false, duration: 20,  time: 0 },
        };
    }

    get domElement(): HTMLElement {
        return this.profiler.domElement;
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    override setRenderer(renderer: WebGPURenderer): void {
        super.setRenderer(renderer);

        if (renderer !== null) {
            // Forward console warnings / errors into the console tab
            const origWarn  = console.warn.bind(console);
            const origError = console.error.bind(console);
            const self = this;

            console.warn = (...args: unknown[]) => {
                const msg = args.map(String).join(' ');
                self.console.addMessage('warn', msg);
                origWarn(...args);
            };
            console.error = (...args: unknown[]) => {
                const msg = args.map(String).join(' ');
                self.console.addMessage('error', msg);
                origError(...args);
            };

            this.timeline.setRenderer(renderer);
        }
    }

    override init(): void {
        super.init();

        this.console.addMessage('info', 'gpucat WebGPU Renderer [ "WebGPU" ]');

        const renderer = this.getRenderer();
        if (this.domElement.parentElement === null && renderer?.domElement.parentElement !== null) {
            renderer!.domElement.parentElement!.appendChild(this.domElement);
        }
    }

    // -----------------------------------------------------------------------
    // Timeline hooks — forward calls to timeline.onCall()
    // -----------------------------------------------------------------------

    override begin(frameId: number): void {
        super.begin(frameId);
        if (this.timeline.isRecording) {
            this.timeline.onCall('begin', String(frameId), this.fps);
        }
    }

    override beginRender(passId: string, frameId: number): void {
        super.beginRender(passId, frameId);
        if (this.timeline.isRecording) {
            this.timeline.onCall('beginRender', passId);
        }
    }

    override finishRender(passId: string, frameId: number): void {
        super.finishRender(passId, frameId);
        if (this.timeline.isRecording) {
            this.timeline.onCall('finishRender', passId);
        }
    }

    override beginCompute(nodeId: string, frameId: number): void {
        super.beginCompute(nodeId, frameId);
        if (this.timeline.isRecording) {
            this.timeline.onCall('beginCompute', nodeId);
        }
    }

    override finishCompute(nodeId: string, frameId: number): void {
        super.finishCompute(nodeId, frameId);
        if (this.timeline.isRecording) {
            this.timeline.onCall('finishCompute', nodeId);
        }
    }

    override finish(frameId: number): void {
        super.finish(frameId);
        const record = this.resolveFrame();
        if (record) this._processFrame(record);
    }

    // -----------------------------------------------------------------------
    // createParameters — expose dat.GUI-style groups via the Parameters tab
    // -----------------------------------------------------------------------

    createParameters(name: string): ReturnType<Parameters['createGroup']> {
        if (!this.parameters.isVisible) {
            this.parameters.show();
        }
        return this.parameters.createGroup(name);
    }

    // -----------------------------------------------------------------------
    // Probe API — shader value live inspector
    // -----------------------------------------------------------------------

    /**
     * Set the active probe to the given variable expression in the given mesh's
     * compiled WGSL.  Builds a new probe pipeline (patched WGSL + same bind
     * group layouts), creates a 140×140 CanvasTarget, and wires it to render
     * every frame in _processFrame.
     *
     * Returns the probe canvas element so the caller can display it, or null
     * if patching / pipeline creation fails.
     */
    setProbe(target: ProbeTarget, sourceRO: RenderObject): HTMLCanvasElement | null {
        const renderer = this.getRenderer();
        if (!renderer) return null;

        const code = sourceRO.nodeBuilderState?.code;
        if (!code) return null;

        const cacheKey = `${target.expr}::${target.anchorKind}::${sourceRO.id}`;

        // Return existing probe canvas if already built for same key
        if (this._activeProbe?.cacheKey === cacheKey) {
            return this._activeProbe.canvas;
        }

        // Discard previous probe
        this.clearProbe();

        // Patch WGSL
        const patchedCode = buildProbeWGSL(code, target);
        if (!patchedCode) return null;

        console.groupCollapsed(`[gpucat probe] patched WGSL for "${target.expr}"`);
        console.log(patchedCode);
        console.groupEnd();

        // Build probe pipeline: same bind group layouts, patched shader
        const bindGroupLayouts = renderer.getBindGroupLayouts(sourceRO);
        if (bindGroupLayouts.length === 0) {
            console.warn('[gpucat probe] bind group layouts not yet initialised — try clicking again after the first frame renders');
            return null;
        }

        const pipelineLayout = renderer.device.createPipelineLayout({ bindGroupLayouts });
        const shaderModule = renderer.device.createShaderModule({ code: patchedCode });

        // Log WGSL compilation errors asynchronously (same pattern as render-objects.ts)
        shaderModule.getCompilationInfo().then((info) => {
            for (const msg of info.messages) {
                const log = msg.type === 'error' ? console.error : console.warn;
                log(`[gpucat probe shader ${msg.type}] line ${msg.lineNum}: ${msg.message}`);
            }
        });

        const format = navigator.gpu.getPreferredCanvasFormat();
        const depthFormat: GPUTextureFormat = 'depth24plus';

        // Real vertex buffer layouts so the pipeline accepts the actual mesh geometry.
        const vertexBufferLayouts = buildVertexBufferLayouts(
            sourceRO.geometry,
            sourceRO.nodeBuilderState!,
        );

        let pipeline: GPURenderPipeline;
        try {
            pipeline = renderer.device.createRenderPipeline({
                layout: pipelineLayout,
                vertex: {
                    module: shaderModule,
                    entryPoint: 'vs_main',
                    buffers: vertexBufferLayouts,
                },
                fragment: {
                    module: shaderModule,
                    entryPoint: 'fs_main',
                    targets: [{ format }],
                },
                primitive: { topology: 'triangle-list', cullMode: 'none' },
                depthStencil: {
                    format: depthFormat,
                    depthWriteEnabled: true,
                    depthCompare: 'less',
                },
            });
        } catch (e) {
            console.error('[gpucat probe] Failed to create probe pipeline:', e);
            return null;
        }

        // Create preview canvas + depth texture
        const canvas = document.createElement('canvas');
        canvas.style.display = 'block';
        canvas.style.borderRadius = '4px';
        const canvasTarget = new CanvasTarget(canvas);
        canvasTarget.setSize(140, 140);

        const depthTexture = renderer.device.createTexture({
            size: [140, 140, 1],
            format: depthFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });

        this._activeProbe = {
            expr: target.expr,
            patchedCode,
            pipeline,
            canvasTarget,
            canvas,
            sourceRO,
            depthTexture,
            cacheKey,
        };

        return canvas;
    }

    /** Remove the active probe. */
    clearProbe(): void {
        if (this._activeProbe) {
            this._activeProbe.canvasTarget.dispose();
            this._activeProbe.depthTexture.destroy();
            this._activeProbe = null;
        }
    }

    // -----------------------------------------------------------------------
    // navigateToRO — jump to a RenderObject in the Draw Calls tab
    // -----------------------------------------------------------------------

    navigateToRO(ro: RenderObject): void {
        this.profiler.setActiveTab(this.drawCalls.id);
        if (!this.drawCalls.isVisible) this.drawCalls.show();
        this.drawCalls.selectRO(ro, this);
    }

    // -----------------------------------------------------------------------
    // Private: per-frame update dispatch
    // -----------------------------------------------------------------------

    private _processFrame(record: FrameRecord): void {
        const now = performance.now();
        const deltaMs = now - (this._lastUpdateTime || now);
        this._lastUpdateTime = now;

        this._tickCycle(this._displayCycle.text, deltaMs);
        this._tickCycle(this._displayCycle.graph, deltaMs);

        if (this._displayCycle.text.needsUpdate) {
            setText('fps-counter', this.fps.toFixed());
            this.performance.updateText(this, record);
            this.memory.updateText(this);
            this._displayCycle.text.needsUpdate = false;
        }

        if (this._displayCycle.graph.needsUpdate) {
            this.performance.updateGraph(this);
            this.memory.updateGraph(this);
            this._displayCycle.graph.needsUpdate = false;
        }

        if (record.inspectableNodes.length > 0) {
            this.viewer.show();
            this.resolveViewer(record.inspectableNodes);
        }

        if (record.scenes.length > 0) {
            this.sceneHierarchy.show();
            this.sceneHierarchy.update(this, record.scenes);
        }

        const renderer = this.getRenderer();
        if (renderer && renderer.renderObjects.renderObjects.size > 0) {
            this.drawCalls.show();
            this.drawCalls.update(this, renderer);
        }

        // Render probe canvas (if active) using a fresh command encoder so we
        // don't re-enter the main render pipeline.
        this._renderProbe();
    }

    /**
     * Build canvasData for each inspectable node and call viewer.update().
     */
    resolveViewer(nodes: Node<WgslType>[]): void {
        const renderer = this.getRenderer();
        if (!renderer) return;

        const canvasDataList = nodes.map(node => this.getCanvasDataByNode(node));
        this.viewer.update(this, canvasDataList);
    }

    /**
     * Get or create the CanvasData for an inspectable node.
     * Creates a 140×140 CanvasTarget, wraps the node as vec4(vec3(node), 1),
     * and builds a fullscreen Material. Cached per node — never recreated.
     *
     * Three.js aligned: mirrors Inspector.getCanvasDataByNode().
     * - setPixelRatio(window.devicePixelRatio) on the canvas target
     * - splitCamelCase + splitPath to derive { path, name } from the node label
     */
    getCanvasDataByNode(node: Node<WgslType>): CanvasData {
        let canvasData = this._canvasNodes.get(node);

        if (canvasData === undefined) {
            const canvas = document.createElement('canvas');
            canvas.style.display = 'block';
            canvas.style.borderRadius = '4px';

            const canvasTarget = new CanvasTarget(canvas);
            // Three.js aligned: set pixel ratio for crisp preview thumbnails
            canvasTarget.setPixelRatio(window.devicePixelRatio);
            canvasTarget.setSize(140, 140);

            const id = node.id;

            // Three.js aligned: splitPath(splitCamelCase(node.getName()))
            // to derive folder path and leaf name from the inspector label.
            const rawName = node._inspectorName ?? id;
            const { path, name } = splitPath(splitCamelCase(rawName));

            const format = navigator.gpu.getPreferredCanvasFormat();
            const { wrappedNode, material } = makePreviewMaterial(node, format);

            canvasData = {
                id,
                name,
                path,
                node,
                wrappedNode,
                material,
                canvasTarget,
            };

            this._canvasNodes.set(node, canvasData);
        }

        return canvasData;
    }

    private _tickCycle(cycle: DisplayCycleEntry, deltaMs: number): void {
        cycle.time += deltaMs;
        if (cycle.time >= cycle.duration) {
            cycle.needsUpdate = true;
            cycle.time = 0;
        }
    }

    /**
     * Encode and submit a single render pass for the active probe.
     * Uses the real mesh vertex/index buffers and bind groups (which include
     * camera uniforms updated this frame) so the probe renders the mesh from
     * the camera's point of view with the chosen expression as the color output.
     */
    private _renderProbe(): void {
        const probe = this._activeProbe;
        if (!probe) return;

        const renderer = this.getRenderer();
        if (!renderer) return;

        const ro = probe.sourceRO;

        // Bind groups updated this frame by the main render loop (camera at [0])
        const bindGroups = ro.bindGroups;
        if (!bindGroups || bindGroups.length === 0) return;

        // Vertex buffers must be uploaded already (main render loop does this)
        const nodeState = ro.nodeBuilderState;
        if (!nodeState) return;

        const format = navigator.gpu.getPreferredCanvasFormat();
        const ctx = probe.canvasTarget.getContext(renderer.device, format, 'opaque');
        const targetTexture = ctx.getCurrentTexture();

        const encoder = renderer.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: targetTexture.createView(),
                clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: probe.depthTexture.createView(),
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        });

        pass.setPipeline(probe.pipeline);

        // Bind groups (camera, object uniforms, textures — same as main draw)
        for (let i = 0; i < bindGroups.length; i++) {
            pass.setBindGroup(i, bindGroups[i]);
        }

        // Vertex buffers — look up uploaded GPU buffers from the geometry
        let slot = 0;
        const geometry = ro.geometry;
        const bufferCache = renderer.buffers;
        for (const attrEntry of nodeState.attributes) {
            if (attrEntry.kind === 'geometry') {
                const bufAttr = geometry.attributes.get(attrEntry.name);
                if (bufAttr) {
                    const gpuBuf = buffers.uploadVertex(bufferCache, bufAttr);
                    pass.setVertexBuffer(slot, gpuBuf);
                }
            } else {
                const node = attrEntry.node;
                const arr = node.attribute.array;
                if (arr) {
                    const gpuBuf = buffers.uploadRaw(
                        bufferCache,
                        node,
                        arr,
                        GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                    );
                    pass.setVertexBuffer(slot, gpuBuf);
                }
            }
            slot++;
        }

        // Issue draw call — mirrors renderer.ts issueDraws exactly, including
        // indirect draw support.  The indirect GPU buffer was already written by
        // the compute pass this frame; getIndirect() does a non-uploading lookup.
        if (geometry.index) {
            const idxBuf = buffers.uploadIndex(bufferCache, geometry.index);
            pass.setIndexBuffer(idxBuf, geometry.index.format);
            if (geometry.indirect) {
                const indBuf = buffers.getIndirect(bufferCache, geometry.indirect);
                if (indBuf) {
                    const byteStride = geometry.indirect.indirectStride * 4;
                    for (let d = 0; d < geometry.indirect.drawCount; d++) {
                        pass.drawIndexedIndirect(indBuf, d * byteStride);
                    }
                }
            } else {
                pass.drawIndexed(geometry.index.array.length, ro.mesh.count);
            }
        } else {
            if (geometry.indirect) {
                const indBuf = buffers.getIndirect(bufferCache, geometry.indirect);
                if (indBuf) {
                    const byteStride = geometry.indirect.indirectStride * 4;
                    for (let d = 0; d < geometry.indirect.drawCount; d++) {
                        pass.drawIndirect(indBuf, d * byteStride);
                    }
                }
            } else {
                pass.draw(geometry.vertexCount, ro.mesh.count);
            }
        }

        pass.end();
        renderer.device.queue.submit([encoder.finish()]);
    }
}
