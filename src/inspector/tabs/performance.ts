import { Tab } from '../ui/tab';
import { List } from '../ui/list';
import { Graph } from '../ui/graph';
import { Item } from '../ui/item';
import { createValueSpan, setText } from '../ui/utils';
import type { FrameRecord } from '../renderer-inspector';
import type { RendererInspector } from '../renderer-inspector';

export class Performance extends Tab {

    graph: Graph;
    graphStats: Item;
    frameStats: Item;
    private _passItems: Map<string, Item> = new Map();
    private _list: List;

    constructor(options: { name?: string; allowDetach?: boolean } = {}) {
        super('Performance', options);

        const perfList = new List('Name', 'CPU (ms)', 'GPU (ms)');
        perfList.setGridStyle('minmax(200px, 2fr) 80px 80px');
        perfList.domElement.style.minWidth = '400px';

        const scrollWrapper = document.createElement('div');
        scrollWrapper.className = 'list-scroll-wrapper';
        scrollWrapper.appendChild(perfList.domElement);
        this.content.appendChild(scrollWrapper);

        // Graph container
        const graphContainer = document.createElement('div');
        graphContainer.className = 'graph-container';

        const graph = new Graph();
        graph.addLine('fps', 'var(--color-fps)');
        graphContainer.append(graph.domElement);

        // Graph stats item (with fps counter span)
        const graphStats = new Item('Graph Stats', createValueSpan(), createValueSpan('graph-fps-counter'));
        perfList.add(graphStats);

        const graphItem = new Item(graphContainer);
        (graphItem.itemRow.childNodes[0] as HTMLElement).style.gridColumn = '1 / -1';
        graphStats.add(graphItem);

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

        // Track which pass ids appeared this frame
        const seenIds = new Set<string>();

        for (const pass of frame.passes) {
            seenIds.add(pass.id);
            let item = this._passItems.get(pass.id);
            if (!item) {
                const nameSpan = createValueSpan();
                nameSpan.textContent = pass.id;
                const cpuSpan = createValueSpan();
                const gpuSpan = createValueSpan();
                item = new Item(nameSpan, cpuSpan, gpuSpan);
                this.frameStats.add(item);
                this._passItems.set(pass.id, item);
            }
            setText(item.data[1] as HTMLElement, pass.cpuMs.toFixed(2));
            setText(item.data[2] as HTMLElement, pass.gpuMs !== null ? pass.gpuMs.toFixed(2) : '-');
        }

        // Remove items for passes no longer in this frame
        for (const [id, item] of this._passItems) {
            if (!seenIds.has(id)) {
                if (item.parent) (item.parent as Item).remove(item);
                this._passItems.delete(id);
            }
        }

        void this._list; // suppress unused warning — list is owned by DOM
    }
}
