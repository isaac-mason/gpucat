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
import { Item } from '../ui/item';
import { ShaderPanel } from './shader-panel';
import { buildBindingsTable, kvRow } from './draw-calls';
import type { Inspector } from '../inspector';
import type { ComputeNode } from '../../nodes/nodes';
import type { WebGPURenderer } from '../../renderer/renderer';
import * as pipelines from '../../renderer/pipelines';

// ---------------------------------------------------------------------------
// Internal record — one per live ComputeNode
// ---------------------------------------------------------------------------

type ComputeNodeRecord = {
    id: string;
    node: ComputeNode;
    item: Item;
};

// ---------------------------------------------------------------------------
// Sub-tab type
// ---------------------------------------------------------------------------

type DetailSubTab = 'shader' | 'bindings';

// ---------------------------------------------------------------------------
// ComputeCalls Tab
// ---------------------------------------------------------------------------

export class ComputeCalls extends Tab {

    readonly list: List;

    /** node.id → ComputeNodeRecord for every currently-displayed ComputeNode */
    private _nodeRecords: Map<string, ComputeNodeRecord> = new Map();

    /** Currently selected ComputeNode */
    private _selectedNode: ComputeNode | null = null;

    // --- Detail panel ---
    private _detailPanel: HTMLDivElement;
    private _detailSubBtns: Map<DetailSubTab, HTMLButtonElement> = new Map();
    private _shaderPane: HTMLDivElement;
    private _bindingsPane: HTMLDivElement;
    private _shaderPanel: ShaderPanel;
    private _metaPane: HTMLDivElement;
    private _currentSubTab: DetailSubTab = 'shader';

    constructor() {
        super('Compute');

        // --- List (left column) ---
        const list = new List('Compute Node');
        list.setGridStyle('1fr');

        const scrollWrapper = document.createElement('div');
        scrollWrapper.className = 'list-scroll-wrapper scene-hierarchy-list';
        scrollWrapper.appendChild(list.domElement);

        // --- Detail panel (right column) ---
        const detailPanel = document.createElement('div');
        detailPanel.className = 'dc-detail-panel';
        detailPanel.style.display = 'none';

        // Metadata row (workgroup size)
        const metaPane = document.createElement('div');
        metaPane.className = 'dc-meta-pane';
        this._metaPane = metaPane;

        // Sub-tab toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'dc-detail-toolbar';

        const subTabGroup = document.createElement('div');
        subTabGroup.className = 'shader-stage-group';

        const subTabs: DetailSubTab[] = ['shader', 'bindings'];
        for (const st of subTabs) {
            const btn = document.createElement('button');
            btn.className = 'shader-stage-btn';
            btn.textContent = st.charAt(0).toUpperCase() + st.slice(1);
            btn.addEventListener('click', () => this._showDetailSubTab(st));
            subTabGroup.appendChild(btn);
            this._detailSubBtns.set(st, btn);
        }

        toolbar.appendChild(subTabGroup);
        detailPanel.appendChild(metaPane);
        detailPanel.appendChild(toolbar);

        // Shader pane (using ShaderPanel in compute mode)
        this._shaderPanel = new ShaderPanel('compute');
        const shaderPane = document.createElement('div');
        shaderPane.className = 'dc-detail-pane';
        shaderPane.appendChild(this._shaderPanel.domElement);
        this._shaderPane = shaderPane;

        // Bindings pane
        const bindingsPane = document.createElement('div');
        bindingsPane.className = 'dc-detail-pane';
        this._bindingsPane = bindingsPane;

        detailPanel.appendChild(shaderPane);
        detailPanel.appendChild(bindingsPane);

        this._detailPanel = detailPanel;

        // --- Root layout (list | detail) ---
        const layout = document.createElement('div');
        layout.className = 'scene-hierarchy-layout';
        layout.appendChild(scrollWrapper);
        layout.appendChild(detailPanel);

        this.content.appendChild(layout);

        this.list = list;

        // Activate initial sub-tab
        this._showDetailSubTab('shader');
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Called by Inspector._processFrame() every frame when compute passes exist.
     * Diffs by node.id — only adds/removes items on structural changes.
     */
    update(inspector: Inspector, renderer: WebGPURenderer): void {
        const liveNodes = inspector.computeNodes;

        // ------------------------------------------------------------------
        // 1. Remove stale node items
        // ------------------------------------------------------------------
        for (const [id, record] of this._nodeRecords) {
            if (!liveNodes.has(id)) {
                this.list.remove(record.item);
                this._nodeRecords.delete(id);
                if (this._selectedNode?.id === id) {
                    this._selectedNode = null;
                    this._detailPanel.style.display = 'none';
                }
            }
        }

        // ------------------------------------------------------------------
        // 2. Add new node items
        // ------------------------------------------------------------------
        for (const [id, node] of liveNodes) {
            if (this._nodeRecords.has(id)) continue;

            const nameEl = document.createElement('span');
            nameEl.className = 'hierarchy-name';
            nameEl.textContent = _nodeDisplayName(node);

            const item = new Item(nameEl);
            item.itemRow.classList.add('actionable');

            const capturedNode = node;
            item.itemRow.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).closest('.item-toggler')) return;
                this.selectNode(capturedNode, inspector, renderer);
            });

            this.list.add(item);

            this._nodeRecords.set(id, {
                id,
                node,
                item,
            });
        }

        // ------------------------------------------------------------------
        // 3. Refresh detail panel if a node is currently selected
        // ------------------------------------------------------------------
        if (this._selectedNode && liveNodes.has(this._selectedNode.id)) {
            this._refreshShaderPanel(renderer);
        }
    }

    /**
     * Select a compute node programmatically (also called on click).
     * Highlights the item and populates the detail panel.
     */
    selectNode(node: ComputeNode, inspector: Inspector, renderer: WebGPURenderer): void {
        // Clear previous highlight
        if (this._selectedNode) {
            const prev = this._nodeRecords.get(this._selectedNode.id);
            prev?.item.itemRow.classList.remove('hierarchy-selected');
        }

        this._selectedNode = node;
        const record = this._nodeRecords.get(node.id);
        if (record) record.item.itemRow.classList.add('hierarchy-selected');

        // Show and populate detail panel
        this._detailPanel.style.display = 'flex';
        this._populateDetail(node, inspector, renderer);
    }

    // -----------------------------------------------------------------------
    // Detail panel population
    // -----------------------------------------------------------------------

    private _populateDetail(node: ComputeNode, _inspector: Inspector, renderer: WebGPURenderer): void {
        // Metadata pane — workgroup size
        this._metaPane.innerHTML = '';
        const ws = node.workgroupSize;
        const metaTable = document.createElement('div');
        metaTable.className = 'dc-kv-table';
        metaTable.appendChild(kvRow('Workgroup Size', `[${ws[0]}, ${ws[1]}, ${ws[2]}]`));
        this._metaPane.appendChild(metaTable);

        // Shader pane — delegate to ShaderPanel (compute mode)
        this._refreshShaderPanel(renderer);

        // Bindings pane
        this._bindingsPane.innerHTML = '';
        const entry = pipelines.lookupCompute(renderer.pipelines, node);
        if (entry) {
            const nbs = entry.nodeBuilderState;
            this._bindingsPane.appendChild(
                buildBindingsTable(
                    nbs.uniformGroups,
                    [], // textures - compute doesn't use textures via this path
                    [], // samplers - compute doesn't use samplers via this path
                    nbs.storage,
                ),
            );
        } else {
            const hint = document.createElement('div');
            hint.className = 'dc-section-header';
            hint.textContent = 'Not yet compiled';
            this._bindingsPane.appendChild(hint);
        }

        // Keep active sub-tab visible
        this._showDetailSubTab(this._currentSubTab);
    }

    private _refreshShaderPanel(renderer: WebGPURenderer): void {
        if (!this._selectedNode) return;

        const entry = pipelines.lookupCompute(renderer.pipelines, this._selectedNode);
        if (entry) {
            this._shaderPanel.updateFromCompute(entry.nodeBuilderState.computeCode!);
        }
    }

    private _showDetailSubTab(tab: DetailSubTab): void {
        this._currentSubTab = tab;

        for (const [st, btn] of this._detailSubBtns) {
            btn.classList.toggle('active', st === tab);
        }

        const panes: Record<DetailSubTab, HTMLDivElement> = {
            shader: this._shaderPane,
            bindings: this._bindingsPane,
        };

        for (const [st, pane] of Object.entries(panes) as [DetailSubTab, HTMLDivElement][]) {
            pane.classList.toggle('active', st === tab);
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _nodeDisplayName(node: ComputeNode): string {
    if (node.name) return node.name;
    const id = node.id;
    if (id.length > 32) {
        return id.slice(0, 29) + '...';
    }
    return id;
}
