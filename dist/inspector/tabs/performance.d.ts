import { Tab } from '../ui/tab';
import { Graph } from '../ui/graph';
import { Item } from '../ui/item';
import type { FrameRecord } from '../renderer-inspector';
import type { RendererInspector } from '../renderer-inspector';
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
