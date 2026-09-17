import { getRenderObjectsStats } from '../../renderer/core/render-objects';
import type { InspectorBase } from '../inspector-base';
import { Graph } from '../ui/graph';
import { Item } from '../ui/item';
import { List } from '../ui/list';
import { Tab } from '../ui/tab';
import { createValueSpan, setText } from '../ui/utils';

/**
 * Memory tab — resident-resource counts for the attached renderer, read from `renderer.info.memory`.
 *
 * Backend-neutral: the named rows mean the same thing on both backends, so there is no branch here.
 * Counts a backend reports in its own vocabulary arrive in `memory.backend` and are appended as extra
 * rows; the row set is rebuilt when those keys change (they appear as the caches populate). The graph
 * tracks a single total-resource line.
 */
const NEUTRAL_ROWS = ['Buffers', 'Geometries', 'Textures', 'Samplers'];

/** `renderPipelines` -> `Render Pipelines`. Backend bag keys are camelCase by convention. */
function humanizeKey(key: string): string {
    const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export class Memory extends Tab {
    graph: Graph;
    private _memoryList: List;
    private _memoryStats: Item | null = null;
    /** Value spans for the current rows, keyed by row label. */
    private _rows: Map<string, HTMLElement> = new Map();
    /** Signature of the rows currently built, so backend-specific keys appearing later rebuild them. */
    private _builtKey: string | null = null;

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

    /** Neutral rows plus one per backend-specific key. Rebuilt only when that key set changes. */
    private _buildRows(backendKeys: string[]): void {
        const key = backendKeys.join(',');
        if (this._builtKey === key && this._memoryStats) return;

        // Clear any previous rows (the backend bag gained a key, or the renderer changed).
        for (const el of Array.from(this._memoryList.domElement.querySelectorAll('.list-item-wrapper'))) {
            el.remove();
        }
        this._rows.clear();

        const memoryStats = new Item('Renderer Info', '');
        (memoryStats.domElement.firstChild as HTMLElement).classList.add('no-hover');
        this._memoryList.add(memoryStats);

        const labels = [...NEUTRAL_ROWS, 'Render Objects', ...backendKeys.map(humanizeKey)];
        for (const label of labels) {
            const span = createValueSpan();
            memoryStats.add(new Item(label, span));
            this._rows.set(label, span);
        }

        this._memoryStats = memoryStats;
        this._builtKey = key;
    }

    updateGraph(inspector: InspectorBase): void {
        const renderer = inspector.getRenderer();
        if (!renderer) return;
        const m = renderer.info.memory;
        this.graph.addPoint('total', m.buffers + m.geometries + m.textures + m.samplers);
        if (this.graph.limit === 0) this.graph.limit = 1;
        this.graph.update();
    }

    updateText(inspector: InspectorBase): void {
        const renderer = inspector.getRenderer();
        if (!renderer) return;

        const m = renderer.info.memory;
        const backendKeys = Object.keys(m.backend).sort();
        this._buildRows(backendKeys);

        this._set('Buffers', m.buffers.toString());
        this._set('Geometries', m.geometries.toString());
        this._set('Textures', m.textures.toString());
        this._set('Samplers', m.samplers.toString());
        this._set('Render Objects', getRenderObjectsStats(renderer._renderObjects).total.toString());
        for (const k of backendKeys) this._set(humanizeKey(k), String(m.backend[k] ?? 0));
    }

    private _set(label: string, value: string): void {
        const span = this._rows.get(label);
        if (span) setText(span, value);
    }
}
