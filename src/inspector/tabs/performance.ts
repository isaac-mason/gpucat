import { Tab } from '../ui/tab';
import { List } from '../ui/list';
import { Graph } from '../ui/graph';
import { Item } from '../ui/item';
import { createValueSpan, setText } from '../ui/utils';
import type { FrameRecord, TimelineEntry } from '../renderer-inspector';
import type { RendererInspector } from '../renderer-inspector';

export class Performance extends Tab {

    graph: Graph;
    graphStats: Item;
    frameStats: Item;
    private _entryItems: Map<string, Item> = new Map();
    private _list: List;

    constructor(options: { name?: string; allowDetach?: boolean } = {}) {
        super('Performance', options);

        // Graph pinned above the list — full width, fixed height
        const graphContainer = document.createElement('div');
        graphContainer.className = 'graph-container';

        const graph = new Graph();
        graph.addLine('fps', 'var(--color-fps)');
        graphContainer.appendChild(graph.domElement);
        this.content.appendChild(graphContainer);

        // Scrollable list below the graph
        const perfList = new List('Name', 'CPU (ms)', 'GPU (ms)');
        perfList.setGridStyle('minmax(200px, 2fr) 80px 80px');
        perfList.domElement.style.minWidth = '400px';

        const scrollWrapper = document.createElement('div');
        scrollWrapper.className = 'list-scroll-wrapper';
        scrollWrapper.appendChild(perfList.domElement);
        this.content.appendChild(scrollWrapper);

        // Graph stats row (FPS counter)
        const graphStats = new Item('Graph', createValueSpan(), createValueSpan('graph-fps-counter'));
        perfList.add(graphStats);

        // Frame stats item (totals row)
        const frameStats = new Item('Frame Stats', createValueSpan(), createValueSpan());
        perfList.add(frameStats);

        this.graph = graph;
        this.graphStats = graphStats;
        this.frameStats = frameStats;
        this._list = perfList;
    }

    updateGraph(inspector: RendererInspector): void {
        this.graph.addPoint('fps', inspector.fps);
        this.graph.update();
    }

    updateText(inspector: RendererInspector, frame: FrameRecord): void {
        setText('graph-fps-counter', inspector.fps.toFixed() + ' FPS');

        // Update frame totals
        setText(this.frameStats.data[1] as HTMLElement, frame.cpuMs.toFixed(2));
        setText(this.frameStats.data[2] as HTMLElement, frame.gpuMs !== null ? frame.gpuMs.toFixed(2) : '-');

        // Track which entry names appeared this frame
        const seenNames = new Set<string>();

        // Sort timeline by startTime for chronological display
        const sortedTimeline = [...frame.timeline].sort((a, b) => a.startTime - b.startTime);

        // Process timeline entries recursively
        this._updateEntries(sortedTimeline, this.frameStats, seenNames, '');

        // Remove items for entries no longer in this frame
        for (const [name, item] of this._entryItems) {
            if (!seenNames.has(name)) {
                if (item.parent) (item.parent as Item).remove(item);
                this._entryItems.delete(name);
            }
        }

        void this._list; // suppress unused warning — list is owned by DOM
    }

    /** Recursively update/create items for timeline entries */
    private _updateEntries(
        entries: TimelineEntry[],
        parentItem: Item,
        seenNames: Set<string>,
        pathPrefix: string,
    ): void {
        for (const entry of entries) {
            // Create unique path for nested entries
            const entryPath = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
            seenNames.add(entryPath);

            let item = this._entryItems.get(entryPath);
            if (!item) {
                const nameSpan = createValueSpan();
                // Add kind indicator prefix
                const kindPrefix = entry.kind === 'marker' ? '◆ ' : entry.kind === 'compute' ? '⚙ ' : '▶ ';
                nameSpan.textContent = kindPrefix + entry.name;
                const cpuSpan = createValueSpan();
                const gpuSpan = createValueSpan();
                item = new Item(nameSpan, cpuSpan, gpuSpan);
                parentItem.add(item);
                this._entryItems.set(entryPath, item);
            }

            // Update values
            setText(item.data[1] as HTMLElement, entry.cpuMs.toFixed(2));
            
            // GPU time only for render/compute entries
            if (entry.kind === 'render' || entry.kind === 'compute') {
                setText(item.data[2] as HTMLElement, entry.gpuMs !== null ? entry.gpuMs.toFixed(2) : '-');
            } else {
                setText(item.data[2] as HTMLElement, '-');
            }

            // Process children recursively
            if (entry.children.length > 0) {
                const sortedChildren = [...entry.children].sort((a, b) => a.startTime - b.startTime);
                this._updateEntries(sortedChildren, item, seenNames, entryPath);
            }
        }
    }
}
