import type { InspectorBase } from '../inspector-base';
import { Graph } from '../ui/graph';
import { Tab } from '../ui/tab';
/**
 * Memory tab — device-resource counts for the attached renderer. The stat rows are backend-specific
 * (WebGPU caches buffers/pipelines; WebGL caches programs/UBOs/textures/…), so they're built lazily on
 * the first update once the renderer's backend is known, and reused thereafter. The graph tracks a
 * single "total resource count" line for whichever backend is attached.
 */
export declare class Memory extends Tab {
    graph: Graph;
    private _memoryList;
    private _memoryStats;
    /** Value spans for the current backend's rows, keyed by row label. */
    private _rows;
    /** Backend the current rows were built for; rebuilt if the attached renderer changes backend. */
    private _builtBackend;
    constructor(options?: {
        name?: string;
        allowDetach?: boolean;
    });
    /** (Re)build the stat rows for the given backend. Rows differ per backend. */
    private _buildRows;
    updateGraph(inspector: InspectorBase): void;
    updateText(inspector: InspectorBase): void;
    private _set;
}
