import { Tab } from '../ui/tab';
import { List } from '../ui/list';
import { Graph } from '../ui/graph';
import { Item } from '../ui/item';
import { createValueSpan, setText } from '../ui/utils';
import type { InspectorBase } from '../inspector-base';
import { getBufferCacheStats } from '../../renderer/buffers';
import * as pipelinesModule from '../../renderer/pipelines';

export class Memory extends Tab {

    graph: Graph;
    memoryStats: Item;
    vertexBuffers: Item;
    indexBuffers: Item;
    storageBuffers: Item;
    rawBuffers: Item;
    renderPipelines: Item;
    computePipelines: Item;

    constructor(options: { name?: string; allowDetach?: boolean } = {}) {
        super('Memory', options);

        // Graph pinned above the list — full width, fixed height
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

        // Stats tree
        const memoryStats = new Item('Renderer Info', '');
        (memoryStats.domElement.firstChild as HTMLElement).classList.add('no-hover');
        memoryList.add(memoryStats);

        const vertexBuffers   = new Item('Vertex Buffers',   createValueSpan());
        const indexBuffers    = new Item('Index Buffers',    createValueSpan());
        const storageBuffers  = new Item('Storage Buffers',  createValueSpan());
        const rawBuffers      = new Item('Raw Buffers',      createValueSpan());
        const renderPipelines = new Item('Render Pipelines', createValueSpan());
        const computePipelines = new Item('Compute Pipelines', createValueSpan());

        memoryStats.add(vertexBuffers);
        memoryStats.add(indexBuffers);
        memoryStats.add(storageBuffers);
        memoryStats.add(rawBuffers);
        memoryStats.add(renderPipelines);
        memoryStats.add(computePipelines);

        this.graph = graph;
        this.memoryStats = memoryStats;
        this.vertexBuffers = vertexBuffers;
        this.indexBuffers = indexBuffers;
        this.storageBuffers = storageBuffers;
        this.rawBuffers = rawBuffers;
        this.renderPipelines = renderPipelines;
        this.computePipelines = computePipelines;
    }

    updateGraph(inspector: InspectorBase): void {
        const renderer = inspector.getRenderer();
        if (!renderer) return;
        const bs = getBufferCacheStats(renderer.buffers);
        const total = bs.vertexCount + bs.indexCount + bs.storageCount + bs.rawCount;
        this.graph.addPoint('total', total);
        if (this.graph.limit === 0) this.graph.limit = 1;
        this.graph.update();
    }

    updateText(inspector: InspectorBase): void {
        const renderer = inspector.getRenderer();
        if (!renderer) return;

        const bs = getBufferCacheStats(renderer.buffers);
        const ps = pipelinesModule.getStats(renderer.pipelines);

        setText(this.vertexBuffers.data[1] as HTMLElement, bs.vertexCount.toString());
        setText(this.indexBuffers.data[1] as HTMLElement, bs.indexCount.toString());
        setText(this.storageBuffers.data[1] as HTMLElement, bs.storageCount.toString());
        setText(this.rawBuffers.data[1] as HTMLElement, bs.rawCount.toString());
        setText(this.renderPipelines.data[1] as HTMLElement, `${ps.renderReadyCount} / ${ps.renderPendingCount} pending`);
        setText(this.computePipelines.data[1] as HTMLElement, `${ps.computeReadyCount} / ${ps.computePendingCount} pending`);
    }
}
