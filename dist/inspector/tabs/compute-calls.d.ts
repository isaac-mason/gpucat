/**
 * compute-calls.ts — Inspector "Compute Calls" tab.
 *
 * Surfaces compute node data — one entry per compute dispatch.
 *
 * When a compute node is selected, a detail panel appears with two sub-tabs:
 *   [Shader]   — displays the compute WGSL using ShaderPanel in compute mode
 *   [Bindings] — bind group layout table (uniform groups, storage buffers)
 *
 * Mirrors the structure of draw-calls.ts.
 */
import { Tab } from '../ui/tab';
import { List } from '../ui/list';
import type { Inspector } from '../inspector';
import type { ComputeNode } from '../../nodes/nodes';
import type { WebGPURenderer } from '../../renderer/renderer';
export declare class ComputeCalls extends Tab {
    readonly list: List;
    /** node.id → ComputeNodeRecord for every currently-displayed ComputeNode */
    private _nodeRecords;
    /** Currently selected ComputeNode */
    private _selectedNode;
    private _detailPanel;
    private _detailSubBtns;
    private _shaderPane;
    private _bindingsPane;
    private _shaderPanel;
    private _metaPane;
    private _currentSubTab;
    constructor();
    /**
     * Called by Inspector._processFrame() every frame when compute passes exist.
     * Diffs by node.id — only adds/removes items on structural changes.
     */
    update(inspector: Inspector, renderer: WebGPURenderer): void;
    /**
     * Select a compute node programmatically (also called on click).
     * Highlights the item and populates the detail panel.
     */
    selectNode(node: ComputeNode, inspector: Inspector, renderer: WebGPURenderer): void;
    private _populateDetail;
    private _refreshShaderPanel;
    private _showDetailSubTab;
}
