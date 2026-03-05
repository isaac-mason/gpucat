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
import { Viewer } from './tabs/viewer';
import type { WebGPURenderer } from '../renderer/renderer';


type DisplayCycleEntry = { needsUpdate: boolean; duration: number; time: number };

export class Inspector extends RendererInspector {

    readonly profiler: Profiler;
    readonly performance: Performance;
    readonly memory: Memory;
    readonly console: Console;
    readonly parameters: Parameters;
    readonly viewer: Viewer;
    readonly timeline: Timeline;
    readonly settings: Settings;

    private _displayCycle: { text: DisplayCycleEntry; graph: DisplayCycleEntry };
    private _lastUpdateTime = 0;

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
            this.viewer.update(this, record.inspectableNodes);
        }
    }

    private _tickCycle(cycle: DisplayCycleEntry, deltaMs: number): void {
        cycle.time += deltaMs;
        if (cycle.time >= cycle.duration) {
            cycle.needsUpdate = true;
            cycle.time = 0;
        }
    }
}
