import { Tab } from '../ui/tab';
import { Graph } from '../ui/graph';
import { Item } from '../ui/item';
import type { InspectorBase } from '../inspector-base';
export declare class Memory extends Tab {
    graph: Graph;
    memoryStats: Item;
    gpuBuffers: Item;
    rawBuffers: Item;
    renderPipelines: Item;
    computePipelines: Item;
    constructor(options?: {
        name?: string;
        allowDetach?: boolean;
    });
    updateGraph(inspector: InspectorBase): void;
    updateText(inspector: InspectorBase): void;
}
