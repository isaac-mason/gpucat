import { Tab } from 'gpucat/dist/inspector/ui/tab';
import { Graph } from 'gpucat/dist/inspector/ui/graph';
import { Item } from 'gpucat/dist/inspector/ui/item';
import type { FrameRecord } from 'gpucat/dist/inspector/renderer-inspector';
import type { RendererInspector } from 'gpucat/dist/inspector/renderer-inspector';
export declare class Performance extends Tab {
    graph: Graph;
    graphStats: Item;
    frameStats: Item;
    private _entryItems;
    private _list;
    constructor(options?: {
        name?: string;
        allowDetach?: boolean;
    });
    updateGraph(inspector: RendererInspector): void;
    updateText(inspector: RendererInspector, frame: FrameRecord): void;
    /** Recursively update/create items for timeline entries */
    private _updateEntries;
}
