import type { InspectorBase } from '../inspector-base';
import { Graph } from '../ui/graph';
import { Tab } from '../ui/tab';
export declare class Memory extends Tab {
    graph: Graph;
    private _memoryList;
    private _memoryStats;
    /** Value spans for the current rows, keyed by row label. */
    private _rows;
    /** Signature of the rows currently built, so backend-specific keys appearing later rebuild them. */
    private _builtKey;
    constructor(options?: {
        name?: string;
        allowDetach?: boolean;
    });
    /** Neutral rows plus one per backend-specific key. Rebuilt only when that key set changes. */
    private _buildRows;
    updateGraph(inspector: InspectorBase): void;
    updateText(inspector: InspectorBase): void;
    private _set;
}
