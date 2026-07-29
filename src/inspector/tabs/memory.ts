import { getRenderObjectsStats } from '../../renderer/core/render-objects';
import { getBufferCacheStats } from '../../renderer/webgpu/buffers';
import * as pipelinesModule from '../../renderer/webgpu/pipelines';
import type { InspectorBase } from '../inspector-base';
import { Graph } from '../ui/graph';
import { Item } from '../ui/item';
import { List } from '../ui/list';
import { Tab } from '../ui/tab';
import { createValueSpan, setText } from '../ui/utils';

/**
 * Memory tab — device-resource counts for the attached renderer. The stat rows are backend-specific
 * (WebGPU caches buffers/pipelines; WebGL caches programs/UBOs/textures/…), so they're built lazily on
 * the first update once the renderer's backend is known, and reused thereafter. The graph tracks a
 * single "total resource count" line for whichever backend is attached.
 */
export class Memory extends Tab {
    graph: Graph;
    private _memoryList: List;
    private _memoryStats: Item | null = null;
    /** Value spans for the current backend's rows, keyed by row label. */
    private _rows: Map<string, HTMLElement> = new Map();
    /** Backend the current rows were built for; rebuilt if the attached renderer changes backend. */
    private _builtBackend: 'webgpu' | 'webgl' | null = null;

    constructor(options: { name?: string; allowDetach?: boolean } = {}) {
        super('Memory', options);

        // Graph pinned above the list, full width, fixed height
        const graphContainer = document.createElement('div');
        graphContainer.className = 'graph-container';

        const graph = new Graph();
        graph.addLine('total', 'var(--color-yellow)');
        graphContainer.appendChild(graph.domElement);
        this.content.appendChild(graphContainer);

        // Scrollable list below the graph
        const memoryList = new List('Name', 'Count');
        memoryList.setGridStyle('minmax(200px, 2fr) 80px');
        memoryList.domElement.style.minWidth = '300px';

        const scrollWrapper = document.createElement('div');
        scrollWrapper.className = 'list-scroll-wrapper';
        scrollWrapper.appendChild(memoryList.domElement);
        this.content.appendChild(scrollWrapper);

        this.graph = graph;
        this._memoryList = memoryList;
    }

    /** (Re)build the stat rows for the given backend. Rows differ per backend. */
    private _buildRows(backend: 'webgpu' | 'webgl'): void {
        if (this._builtBackend === backend && this._memoryStats) return;

        // Clear any previous rows (backend switch on the same tab instance).
        this._memoryList.domElement
            .querySelectorAll('.list-item-wrapper')
            .forEach((el) => el.remove());
        this._rows.clear();

        const memoryStats = new Item('Renderer Info', '');
        (memoryStats.domElement.firstChild as HTMLElement).classList.add('no-hover');
        this._memoryList.add(memoryStats);

        const labels =
            backend === 'webgpu'
                ? ['GPU Buffers', 'Raw Buffers', 'Render Pipelines', 'Compute Pipelines']
                : ['Programs', 'Uniform Buffers', 'Textures', 'Samplers', 'Framebuffers', 'Render Objects'];

        for (const label of labels) {
            const span = createValueSpan();
            memoryStats.add(new Item(label, span));
            this._rows.set(label, span);
        }

        this._memoryStats = memoryStats;
        this._builtBackend = backend;
    }

    updateGraph(inspector: InspectorBase): void {
        const renderer = inspector.getRenderer();
        if (!renderer) return;
        let total: number;
        if (renderer.backend === 'webgpu') {
            const bs = getBufferCacheStats(renderer.buffers);
            total = bs.bufferCount + bs.rawCount;
        } else {
            const s = renderer.getMemoryStats();
            total = s.programCount + s.uboCount + s.textureCount + s.samplerCount + s.fboCount;
        }
        this.graph.addPoint('total', total);
        if (this.graph.limit === 0) this.graph.limit = 1;
        this.graph.update();
    }

    updateText(inspector: InspectorBase): void {
        const renderer = inspector.getRenderer();
        if (!renderer) return;

        this._buildRows(renderer.backend);

        if (renderer.backend === 'webgpu') {
            const bs = getBufferCacheStats(renderer.buffers);
            const ps = pipelinesModule.getStats(renderer.pipelines);
            const ros = getRenderObjectsStats(renderer._renderObjects);
            this._set('GPU Buffers', bs.bufferCount.toString());
            this._set('Raw Buffers', bs.rawCount.toString());
            this._set('Render Pipelines', `${ps.renderCount} render, ${ros.total} objects`);
            this._set('Compute Pipelines', `${ps.computeCount} compute`);
        } else {
            const s = renderer.getMemoryStats();
            const ros = getRenderObjectsStats(renderer._renderObjects);
            this._set('Programs', s.programCount.toString());
            this._set('Uniform Buffers', s.uboCount.toString());
            this._set('Textures', s.textureCount.toString());
            this._set('Samplers', s.samplerCount.toString());
            this._set(
                'Framebuffers',
                s.renderbufferCount > 0 ? `${s.fboCount} (+${s.renderbufferCount} rb)` : s.fboCount.toString(),
            );
            this._set('Render Objects', ros.total.toString());
        }
    }

    private _set(label: string, value: string): void {
        const span = this._rows.get(label);
        if (span) setText(span, value);
    }
}
