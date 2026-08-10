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

import type { FrameRecord } from './renderer-inspector';
import { RendererInspector } from './renderer-inspector';

export type {
    ComputeEntry,
    FrameRecord,
    MarkerEntry,
    PassRecord,
    RenderEntry,
    SceneRecord,
    TimelineEntry,
} from './renderer-inspector';

import { getIndexFormat } from '../core/gpu-buffer';
import type { ComputeNode, InspectorNode } from '../nodes/nodes';
import { QuadMesh } from '../objects/quad-mesh';
import { CanvasTarget } from '../renderer/core/canvas-target';
import type { RenderObject } from '../renderer/core/render-object';
import * as Bindings from '../renderer/webgpu/bindings';
import * as Buffers from '../renderer/webgpu/buffers';
import { buildVertexBufferLayouts } from '../renderer/webgpu/pipelines';
import * as RenderObjectGpu from '../renderer/webgpu/render-object-gpu';
import type { Any } from '../schema/schema';
import type { InspectableRenderer } from './inspector-base';
import type { GUI } from './gui/GUI';
import { buildProbeGLSL, componentCount, type GlslKind } from './probe-glsl';
import type { ProbeTarget } from './probe-wgsl';
import { buildProbeWGSL } from './probe-wgsl';
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
import { type CanvasData, createPreviewMaterial, splitCamelCase, splitPath, Viewer } from './tabs/viewer';
import { Profiler } from './ui/profiler';
import { injectStyle } from './ui/style';
import { setText } from './ui/utils';

type DisplayCycleEntry = { needsUpdate: boolean; duration: number; time: number };

// ProbeEntry, live shader value inspector canvas

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

// GlProbeEntry, WebGL live shader-value readback (GLSL parallel to ProbeEntry)

type GlProbeEntry = {
    /** The probed expression. */
    expr: string;
    /** The patched fragment GLSL source (fed to renderer.renderProbe each frame). */
    patchedFragment: string;
    /** The inferred GLSL kind of the probed value (drives readback decode). */
    kind: GlslKind;
    /** The source RenderObject whose geometry/UBOs/textures are reused. */
    sourceRO: RenderObject;
    /** The popover element (a color swatch + numeric text) returned to the caller. */
    element: HTMLDivElement;
    /** The swatch subelement (background color = the read-back value). */
    swatch: HTMLDivElement;
    /** The numeric-text subelement. */
    label: HTMLDivElement;
    /** Stable cache key: `${expr}::${anchorKind}::${roId}`. */
    cacheKey: string;
};

export class Inspector extends RendererInspector {
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

    private _displayCycle: { text: DisplayCycleEntry; graph: DisplayCycleEntry };
    private _lastUpdateTime = 0;

    /** Cache of CanvasData per inspectable node. */
    private _canvasNodes: Map<InspectorNode<Any>, CanvasData> = new Map();

    /** Active probe entry, if any. */
    private _activeProbe: ProbeEntry | null = null;

    /** Active WebGL probe entry, if any (mutually exclusive with `_activeProbe`). */
    private _activeGlProbe: GlProbeEntry | null = null;

    constructor() {
        super();

        injectStyle();

        const profiler = new Profiler();

        const parameters = new Parameters({
            builtin: true,
            icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M14 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M4 6l8 0" /><path d="M16 6l4 0" /><path d="M8 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M4 12l2 0" /><path d="M10 12l10 0" /><path d="M17 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M4 18l11 0" /><path d="M19 18l1 0" /></svg>',
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

        const computeCalls = new ComputeCalls();
        computeCalls.hide();
        profiler.addTab(computeCalls);

        const performance = new Performance();
        profiler.addTab(performance);

        const performanceTimeline = new PerformanceTimeline();
        profiler.addTab(performanceTimeline);

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
        this.performanceTimeline = performanceTimeline;
        this.memory = memory;
        this.console = consoleTab;
        this.parameters = parameters;
        this.viewer = viewer;
        this.timeline = timeline;
        this.settings = settings;
        this.sceneHierarchy = sceneHierarchy;
        this.drawCalls = drawCalls;
        this.computeCalls = computeCalls;

        this._displayCycle = {
            text: { needsUpdate: false, duration: 250, time: 0 },
            graph: { needsUpdate: false, duration: 20, time: 0 },
        };
    }

    get domElement(): HTMLElement {
        return this.profiler.domElement;
    }

    // Lifecycle

    /**
     * Surface log messages in the Console tab AND devtools. Overrides the
     * no-op base. Callers route via `renderer.inspector?.log.warn('...')`.
     */
    override readonly log = {
        info: (msg: string): void => {
            this.console.addMessage('info', msg);
        },
        warn: (msg: string): void => {
            this.console.addMessage('warn', msg);
            console.warn(msg);
        },
        error: (msg: string): void => {
            this.console.addMessage('error', msg);
            console.error(msg);
        },
    };

    override setRenderer(renderer: InspectableRenderer | null): void {
        if (renderer === null) {
            this.dispose();
            super.setRenderer(null);
            return;
        }

        super.setRenderer(renderer);
        this.timeline.setRenderer(renderer);
        this.log.info(
            renderer.backend === 'webgpu'
                ? 'gpucat WebGPU Renderer [ "WebGPU" ]'
                : 'gpucat WebGL Renderer [ "WebGL2" ]',
        );

        // Compute is WebGPU-only; hide the Compute Calls tab on WebGL so it never appears.
        if (renderer.backend === 'webgl') {
            this.computeCalls.hide();
        }

        // Self-attach the panel to the canvas parent, if there is one. Callers
        // that don't mount the WebGPURenderer's implicit canvas (e.g. engines
        // rendering to per-room canvases via render targets) should append
        // `inspector.domElement` to the DOM themselves.
        // The inspector is a DOM tool, so the renderer's canvas here is always a real HTMLCanvasElement
        // (never the OffscreenCanvas of a headless WebGL renderer).
        const rendererCanvas = renderer.domElement as HTMLCanvasElement;
        if (this.domElement.parentElement === null && rendererCanvas.parentElement) {
            rendererCanvas.parentElement.appendChild(this.domElement);
        }
    }

    /**
     * Release everything this Inspector owns: GPU resources (probe + timestamp
     * query state), DOM (panel + any detached tab windows), and window
     * listeners. Safe to call multiple times. After dispose the instance is
     * dead, discard it and `new Inspector()` if you need one again.
     *
     * Normally called automatically via `renderer.setInspector(null)`; expose
     * directly for callers that want explicit teardown.
     */
    async dispose(): Promise<void> {
        const probeDrained = this.clearProbe();
        for (const cd of this._canvasNodes.values()) {
            cd.canvasTarget.dispose();
        }
        this._canvasNodes.clear();
        this.profiler.dispose();
        this.domElement.remove();
        // Await the GPU teardowns (probe depth texture + timestamp query resources)
        // so a caller that `await`s dispose() knows all destroys have landed.
        await Promise.all([probeDrained, this.disposeTimestampGpu()]);
    }

    // Timeline hooks, forward calls to timeline.onCall()

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

    override beginCompute(node: ComputeNode, frameId: number): void {
        super.beginCompute(node, frameId);
        if (this.timeline.isRecording) {
            this.timeline.onCall('beginCompute', node.id);
        }
    }

    override finishCompute(nodeId: string, frameId: number): void {
        super.finishCompute(nodeId, frameId);
        if (this.timeline.isRecording) {
            this.timeline.onCall('finishCompute', nodeId);
        }
    }

    override setPipeline(label: string): void {
        if (this.timeline.isRecording) {
            this.timeline.onCall('setPipeline', label);
        }
    }

    override setBindGroup(index: number, label: string): void {
        if (this.timeline.isRecording) {
            this.timeline.onCall('setBindGroup', `[${index}] ${label}`);
        }
    }

    override setVertexBuffer(slot: number): void {
        if (this.timeline.isRecording) {
            this.timeline.onCall('setVertexBuffer', String(slot));
        }
    }

    override setIndexBuffer(): void {
        if (this.timeline.isRecording) {
            this.timeline.onCall('setIndexBuffer', '');
        }
    }

    override draw(vertexCount: number, instanceCount: number): void {
        if (this.timeline.isRecording) {
            this.timeline.onCall('draw', `${vertexCount}v × ${instanceCount}i`);
        }
    }

    override drawIndexed(indexCount: number, instanceCount: number): void {
        if (this.timeline.isRecording) {
            this.timeline.onCall('drawIndexed', `${indexCount}idx × ${instanceCount}i`);
        }
    }

    override drawIndirect(): void {
        if (this.timeline.isRecording) {
            this.timeline.onCall('drawIndirect', '');
        }
    }

    override drawIndexedIndirect(): void {
        if (this.timeline.isRecording) {
            this.timeline.onCall('drawIndexedIndirect', '');
        }
    }

    override dispatchWorkgroups(x: number, y: number, z: number): void {
        if (this.timeline.isRecording) {
            this.timeline.onCall('dispatchWorkgroups', `${x}×${y}×${z}`);
        }
    }

    override dispatchWorkgroupsIndirect(_buffer: GPUBuffer, offset: number): void {
        if (this.timeline.isRecording) {
            this.timeline.onCall('dispatchWorkgroupsIndirect', `offset=${offset}`);
        }
    }

    override finish(frameId: number): void {
        super.finish(frameId);
        const record = this.resolveFrame();
        if (record) this._processFrame(record);
    }

    // createParameters, expose dat.GUI-style groups via the Parameters tab

    createParameters(name: string): GUI {
        // Activate the mini-panel (top-right floating panel) without showing
        // the Parameters tab inside the main profiler panel.  showBuiltin()
        // moves the list content into the mini-panel overlay and makes it
        // visible, while leaving isVisible=false so the tab button never
        // appears in the docked panel's tab bar.
        this.parameters.showBuiltin();
        return this.parameters.createGroup(name);
    }

    // Probe API, shader value live inspector

    /**
     * Set the active probe to the given variable expression in the given mesh's
     * compiled WGSL.  Builds a new probe pipeline (patched WGSL + same bind
     * group layouts), creates a 140×140 CanvasTarget, and wires it to render
     * every frame in _processFrame.
     *
     * Returns the probe canvas element so the caller can display it, or null
     * if patching / pipeline creation fails.
     */
    setProbe(target: ProbeTarget, sourceRO: RenderObject): HTMLElement | null {
        const renderer = this.getRenderer();
        if (!renderer) return null;

        // WebGL backend: patch the fragment GLSL and read back the value via renderer.renderProbe
        // (never touches `device`). Returns a swatch/text element instead of a live canvas.
        if (renderer.backend === 'webgl') {
            return this._setGlProbe(target, sourceRO);
        }

        // The probe patches WGSL and builds a WebGPU render pipeline — WebGPU-only.
        if (renderer.backend !== 'webgpu') return null;

        const code = sourceRO.nodeBuilderState?.vertexCode;
        if (!code) return null;

        const cacheKey = `${target.expr}::${target.anchorKind}::${sourceRO.id}::gen`;

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
        const bindGroupLayouts = Bindings.getRenderBindGroupLayouts(renderer.bindings, sourceRO);
        if (bindGroupLayouts.length === 0) {
            this.log.warn(
                '[gpucat probe] bind group layouts not yet initialised, try clicking again after the first frame renders',
            );
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
        const vertexBufferLayouts = buildVertexBufferLayouts(sourceRO.geometry, sourceRO.nodeBuilderState!);

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
            this.log.error(`[gpucat probe] Failed to create probe pipeline: ${e}`);
            return null;
        }

        // Create preview canvas + depth texture
        const canvas = document.createElement('canvas');
        canvas.style.display = 'block';
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

    /**
     * WebGL probe: patch the fragment GLSL to output the probed value, build a small popover element
     * (color swatch + numeric readback), and wire it to read back each frame via renderer.renderProbe.
     * Returns the element, or null if patching fails. Never touches `device`.
     */
    private _setGlProbe(target: ProbeTarget, sourceRO: RenderObject): HTMLElement | null {
        const code = sourceRO.nodeBuilderState?.vertexCode;
        if (!code) return null;

        // The combined GLSL separates stages with this marker; the probe patcher wants fragment-only.
        const marker = '// ---- fragment stage ----';
        const idx = code.indexOf(marker);
        if (idx === -1) return null;
        const fragmentSrc = code.slice(idx + marker.length).trimStart();

        const cacheKey = `${target.expr}::${target.anchorKind}::${sourceRO.id}::gl`;
        if (this._activeGlProbe?.cacheKey === cacheKey) {
            return this._activeGlProbe.element;
        }

        this.clearProbe();

        const patched = buildProbeGLSL(fragmentSrc, target);
        if (!patched) return null;

        console.groupCollapsed(`[gpucat probe] patched GLSL for "${target.expr}"`);
        console.log(patched.fragment);
        console.groupEnd();

        // Build the popover content: a color swatch + a numeric-text line.
        const element = document.createElement('div');
        element.style.display = 'flex';
        element.style.flexDirection = 'column';
        element.style.gap = '6px';
        element.style.padding = '4px';

        const swatch = document.createElement('div');
        swatch.style.width = '120px';
        swatch.style.height = '80px';
        swatch.style.borderRadius = '4px';
        swatch.style.border = '1px solid rgba(255,255,255,0.2)';
        swatch.style.background = '#000';

        const label = document.createElement('div');
        label.style.fontFamily = 'monospace';
        label.style.fontSize = '11px';
        label.style.whiteSpace = 'pre';
        label.textContent = '…';

        element.appendChild(swatch);
        element.appendChild(label);

        this._activeGlProbe = {
            expr: target.expr,
            patchedFragment: patched.fragment,
            kind: patched.kind,
            sourceRO,
            element,
            swatch,
            label,
            cacheKey,
        };

        // Read back immediately so the popover isn't blank until the next frame.
        this._renderGlProbe();

        return element;
    }

    /** Remove the active probe (WebGPU and WebGL). Returns a promise that resolves
     *  once the WebGPU probe's GPU resources are actually destroyed (drained first). */
    clearProbe(): Promise<void> {
        let drained: Promise<void> = Promise.resolve();
        if (this._activeProbe) {
            const { canvasTarget, depthTexture } = this._activeProbe;
            this._activeProbe = null;
            // Drain in-flight probe passes before destroying their depth texture; a
            // mid-submit destroy can lose the device (see drainThenDestroy).
            drained = this.drainThenDestroy(() => {
                canvasTarget.dispose();
                depthTexture.destroy();
            });
        }
        if (this._activeGlProbe) {
            this._activeGlProbe = null;
            const renderer = this.getRenderer();
            if (renderer && renderer.backend === 'webgl') renderer.clearProbe();
        }
        return drained;
    }

    // navigateToRO, jump to a RenderObject in the Draw Calls tab

    navigateToRO(ro: RenderObject): void {
        this.profiler.setActiveTab(this.drawCalls.id);
        if (!this.drawCalls.isVisible) this.drawCalls.show();
        this.drawCalls.selectRO(ro, this);
    }

    // Private: per-frame update dispatch

    private _processFrame(record: FrameRecord): void {
        const now = performance.now();
        const deltaMs = now - (this._lastUpdateTime || now);
        this._lastUpdateTime = now;

        // `record` is the just-finished frame — used for recording, the viewer,
        // scene hierarchy and draw/compute calls (all want the current frame).
        // The perf panel's CPU+GPU stats instead read the newest *resolved* frame
        // so GPU times show consistently despite async timestamp readback latency
        // (the current frame's gpuMs is always still pending at this point).
        const displayFrame = this.latestResolvedFrame() ?? record;

        this._tickCycle(this._displayCycle.text, deltaMs);
        this._tickCycle(this._displayCycle.graph, deltaMs);

        // Check if main panel is visible (expanded)
        const panelVisible = this.profiler.panel.classList.contains('visible');

        // Always capture every frame when recording - must not be throttled
        if (this.performanceTimeline.isRecording) {
            this.performanceTimeline.update(this, record);
        }

        if (this._displayCycle.text.needsUpdate) {
            // Always update FPS counter (visible in toggle button)
            setText('fps-counter', this.fps.toFixed());
            // Only update detailed stats when panel is visible
            if (panelVisible) {
                this.performance.updateText(this, displayFrame);
                this.memory.updateText(this);
                if (this.performanceTimeline.isActive && !this.performanceTimeline.isRecording) {
                    this.performanceTimeline.scheduleRender();
                }
            }
            this._displayCycle.text.needsUpdate = false;
        }

        if (this._displayCycle.graph.needsUpdate) {
            // Only update graphs when panel is visible
            if (panelVisible) {
                this.performance.updateGraph(this);
                this.memory.updateGraph(this);
            }
            this._displayCycle.graph.needsUpdate = false;
        }

        // Skip expensive tree traversals when panel is collapsed
        if (!panelVisible) {
            return;
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
        if (renderer && renderer._renderObjects.renderObjects.size > 0) {
            this.drawCalls.show();
            this.drawCalls.update(this, renderer);
        }

        // Update compute calls tab if compute passes were dispatched this frame. Compute is
        // WebGPU-only, so this never fires on WebGL (computeNodes stays empty); the backend check also
        // narrows `renderer` to WebGPURenderer for the WebGPU-typed update().
        if (renderer && renderer.backend === 'webgpu' && this.computeNodes.size > 0) {
            this.computeCalls.show();
            this.computeCalls.update(this, renderer);
        }

        // Render probe canvas (if active) using a fresh command encoder so we
        // don't re-enter the main render pipeline.
        this._renderProbe();
        // WebGL probe: read back the probed value into the swatch/text popover.
        this._renderGlProbe();
    }

    /**
     * Build canvasData for each inspectable node and call viewer.update().
     */
    resolveViewer(nodes: InspectorNode<Any>[]): void {
        const renderer = this.getRenderer();
        if (!renderer) return;

        const canvasDataList = nodes.map((node) => this.getCanvasDataByNode(node));
        this.viewer.update(this, canvasDataList);
    }

    /**
     * Get or create the CanvasData for an inspectable node.
     * Creates a 140×140 CanvasTarget, wraps the node as vec4(vec3(node), 1),
     * and builds a fullscreen Material. Cached per node, never recreated.
     */
    getCanvasDataByNode(node: InspectorNode<Any>): CanvasData {
        let canvasData = this._canvasNodes.get(node);

        if (canvasData === undefined) {
            const canvas = document.createElement('canvas');
            canvas.style.display = 'block';

            const canvasTarget = new CanvasTarget(canvas);
            canvasTarget.setPixelRatio(window.devicePixelRatio);
            canvasTarget.setSize(140, 140);

            const id = node.id;
            const rawName = node.getName();
            const { path, name } = splitPath(splitCamelCase(rawName));

            const material = createPreviewMaterial(node.wrappedNode);
            const quadMesh = new QuadMesh(material);
            quadMesh.name = 'Viewer - ' + name;

            canvasData = {
                id,
                name,
                path,
                node,
                quadMesh,
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
        // Probe pipelines are WebGPU-only; _activeProbe is never set on WebGL (setProbe returns null),
        // so this is belt-and-braces — and it narrows `renderer` to WebGPURenderer for the device access.
        if (renderer.backend !== 'webgpu') return;

        const ro = probe.sourceRO;
        if (ro.mesh.count === 0) return;

        // Bind groups updated this frame by the main render loop (camera at [0]).
        // These live in the WebGPU device side table keyed by RenderObject.
        const bindGroups = RenderObjectGpu.peekRenderObjectGpu(renderer.renderObjectGpu, ro)?.bindGroups;
        if (!bindGroups || bindGroups.length === 0) return;

        // Vertex buffers must be uploaded already (main render loop does this)
        const nodeState = ro.nodeBuilderState;
        if (!nodeState) return;

        const format = navigator.gpu.getPreferredCanvasFormat();
        const ctx = renderer.getContext(probe.canvasTarget, format, 'opaque');
        const targetTexture = ctx.getCurrentTexture();

        const encoder = renderer.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: targetTexture.createView(),
                    clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1 },
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
            depthStencilAttachment: {
                view: probe.depthTexture.createView(),
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        });

        pass.setPipeline(probe.pipeline);

        // Bind groups (camera, object uniforms, textures, same as main draw)
        for (let i = 0; i < bindGroups.length; i++) {
            pass.setBindGroup(i, bindGroups[i]);
        }

        // Vertex buffers, look up uploaded GPU buffers from the geometry
        let slot = 0;
        const geometry = ro.geometry;
        const bufferCache = renderer.buffers;
        for (const group of nodeState.vertexBufferGroups) {
            if (group.name !== null) {
                // Geometry-based group - resolve buffer by name
                const bufAttr = geometry.buffers.get(group.name);
                if (bufAttr) {
                    const gpuBuf = Buffers.ensureUploaded(bufferCache, renderer.device, bufAttr);
                    pass.setVertexBuffer(slot, gpuBuf);
                }
            } else {
                // Direct buffer group
                const gpuBuffer = group.buffer;
                if (!gpuBuffer) {
                    throw new Error(`[gpucat] VertexBufferGroup has no buffer`);
                }
                const arr = gpuBuffer.array;
                if (arr) {
                    const gpuBuf = Buffers.uploadRaw(
                        bufferCache,
                        renderer.device,
                        gpuBuffer,
                        arr,
                        GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                    ).buffer;
                    pass.setVertexBuffer(slot, gpuBuf);
                }
            }
            slot++;
        }

        // Issue draw call, mirrors renderer.ts issueDraws exactly, including
        // indirect draw support.  The indirect GPU buffer was already written by
        // the compute pass this frame; getUploaded() does a non-uploading lookup.
        if (geometry.index) {
            const idxBuf = Buffers.ensureUploaded(bufferCache, renderer.device, geometry.index);
            pass.setIndexBuffer(idxBuf, getIndexFormat(geometry.index.array)!);
            if (geometry.indirect) {
                const indBuf = Buffers.getUploaded(bufferCache, geometry.indirect);
                if (indBuf) {
                    const byteStride = geometry.indirect.itemSize * 4;
                    for (let d = 0; d < geometry.indirect.count; d++) {
                        pass.drawIndexedIndirect(indBuf, d * byteStride);
                    }
                }
            } else {
                pass.drawIndexed(
                    Math.min(geometry.drawRange.count, geometry.index.array!.length),
                    ro.mesh.count,
                    geometry.drawRange.start,
                );
            }
        } else {
            if (geometry.indirect) {
                const indBuf = Buffers.getUploaded(bufferCache, geometry.indirect);
                if (indBuf) {
                    const byteStride = geometry.indirect.itemSize * 4;
                    for (let d = 0; d < geometry.indirect.count; d++) {
                        pass.drawIndirect(indBuf, d * byteStride);
                    }
                }
            } else {
                pass.draw(geometry.drawRange.count, ro.mesh.count, geometry.drawRange.start);
            }
        }

        pass.end();
        renderer.device.queue.submit([encoder.finish()]);
    }

    /**
     * WebGL probe readback: re-render the probed mesh with the patched fragment into a 1×1 FBO via
     * renderer.renderProbe, then decode the pixel per the coerced type and update the swatch + text.
     * Runs each frame while a WebGL probe is active. Never touches `device`.
     */
    private _renderGlProbe(): void {
        const probe = this._activeGlProbe;
        if (!probe) return;

        const renderer = this.getRenderer();
        if (!renderer || renderer.backend !== 'webgl') return;

        let pixel: Uint8Array | null;
        try {
            pixel = renderer.renderProbe(probe.sourceRO, probe.patchedFragment);
        } catch (e) {
            this.log.error(`[gpucat probe] WebGL probe failed: ${e}`);
            this.clearProbe();
            return;
        }
        if (!pixel) return;

        // Decode the RGBA8 pixel. The probe coerced the value to a vec4 written to the location-0
        // color output, so the bytes are the value's components (0..255 → 0..1). Show a color swatch
        // (always the raw RGBA) plus the numeric components that the coerced type carries.
        const [r, g, b, a] = pixel;
        probe.swatch.style.background = `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;

        const n = componentCount(probe.kind);
        const comps = [r, g, b, a].slice(0, n).map((v) => (v / 255).toFixed(3));
        probe.label.textContent = `${probe.kind}\n(${comps.join(', ')})`;
    }
}
