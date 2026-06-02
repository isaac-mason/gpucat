import { Tab } from 'gpucat/dist/inspector/ui/tab';
import { Graph } from 'gpucat/dist/inspector/ui/graph';
import { Item } from 'gpucat/dist/inspector/ui/item';
import type { InspectorBase } from 'gpucat/dist/inspector/inspector-base';
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
