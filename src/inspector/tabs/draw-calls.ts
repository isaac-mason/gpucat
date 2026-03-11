/**
 * draw-calls.ts — Inspector "Draw Calls" tab.
 *
 * Surfaces renderer-level RenderObject data — one entry per GPU draw call.
 * ROs are grouped under their render pass (via ro.passId).
 *
 * When a RO is selected a detail panel appears with three sub-tabs:
 *   [Shader]   — reuses ShaderPanel (with probe hover/selection support)
 *   [Pipeline] — material / render-context state table
 *   [Bindings] — bind group layout table (uniform groups, textures, samplers, storage)
 *
 * Update strategy (60 fps concern):
 *   update() diffs by ro.id — only adds/removes items on structural changes.
 *   The static detail panel is only rebuilt when _selectedRO changes.
 */

import { Tab } from '../ui/tab';
import { List } from '../ui/list';
import { Item } from '../ui/item';
import { ShaderPanel } from './shader-panel';
import type { Inspector } from '../inspector';
import type { RenderObject } from '../../renderer/render-object';
import type { WebGPURenderer } from '../../renderer/renderer';
import { getIndexFormat } from '../../core/buffer';
import type {
    UniformGroupBlock,
    StorageEntry,
    TextureEntry,
    SamplerEntry,
} from '../../nodes/builder';

// ---------------------------------------------------------------------------
// Internal record — one per live RenderObject
// ---------------------------------------------------------------------------

type RONode = {
    id: number;
    ro: RenderObject;
    item: Item;
    /** passId this RO was last filed under — lets us detect pass changes */
    passId: string;
};

// ---------------------------------------------------------------------------
// Sub-tab type
// ---------------------------------------------------------------------------

type DetailSubTab = 'shader' | 'pipeline' | 'bindings';

// ---------------------------------------------------------------------------
// DrawCalls Tab
// ---------------------------------------------------------------------------

export class DrawCalls extends Tab {

    readonly list: List;

    /** ro.id → RONode for every currently-displayed RenderObject */
    private _roNodes: Map<number, RONode> = new Map();

    /** Pass header items keyed by passId */
    private _passHeaders: Map<string, Item> = new Map();

    /** Currently selected RO */
    private _selectedRO: RenderObject | null = null;

    // --- Detail panel ---
    private _detailPanel: HTMLDivElement;
    private _detailSubBtns: Map<DetailSubTab, HTMLButtonElement> = new Map();
    private _shaderPane: HTMLDivElement;
    private _pipelinePane: HTMLDivElement;
    private _bindingsPane: HTMLDivElement;
    private _shaderPanel: ShaderPanel;
    private _currentSubTab: DetailSubTab = 'shader';

    constructor() {
        super('Draw Calls');

        // --- List (left column) ---
        const list = new List('Draw Call');
        list.setGridStyle('1fr');

        const scrollWrapper = document.createElement('div');
        scrollWrapper.className = 'list-scroll-wrapper scene-hierarchy-list';
        scrollWrapper.appendChild(list.domElement);

        // --- Detail panel (right column) ---
        const detailPanel = document.createElement('div');
        detailPanel.className = 'dc-detail-panel';
        detailPanel.style.display = 'none';

        // Sub-tab toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'dc-detail-toolbar';

        const subTabGroup = document.createElement('div');
        subTabGroup.className = 'shader-stage-group';

        const subTabs: DetailSubTab[] = ['shader', 'pipeline', 'bindings'];
        for (const st of subTabs) {
            const btn = document.createElement('button');
            btn.className = 'shader-stage-btn';
            btn.textContent = st.charAt(0).toUpperCase() + st.slice(1);
            btn.addEventListener('click', () => this._showDetailSubTab(st));
            subTabGroup.appendChild(btn);
            this._detailSubBtns.set(st, btn);
        }

        toolbar.appendChild(subTabGroup);
        detailPanel.appendChild(toolbar);

        // Shader pane
        this._shaderPanel = new ShaderPanel();
        const shaderPane = document.createElement('div');
        shaderPane.className = 'dc-detail-pane';
        shaderPane.appendChild(this._shaderPanel.domElement);
        this._shaderPane = shaderPane;

        // Pipeline pane
        const pipelinePane = document.createElement('div');
        pipelinePane.className = 'dc-detail-pane';
        this._pipelinePane = pipelinePane;

        // Bindings pane
        const bindingsPane = document.createElement('div');
        bindingsPane.className = 'dc-detail-pane';
        this._bindingsPane = bindingsPane;

        detailPanel.appendChild(shaderPane);
        detailPanel.appendChild(pipelinePane);
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
     * Called by Inspector._processFrame() every frame.
     * Only diffs by ro.id — does NOT repaint the detail panel unless the
     * selected RO changed.
     *
     * Structure: pass header items are top-level in the List; RO items are
     * children of their respective pass header (Item.add).  This gives proper
     * indent and uses the existing header-wrapper styling automatically.
     */
    update(inspector: Inspector, renderer: WebGPURenderer): void {
        const liveROs = renderer._renderObjects.renderObjects;

        // ------------------------------------------------------------------
        // 1. Build a snapshot: passId → RO[] (skip internal meshes)
        // ------------------------------------------------------------------
        const passBuckets = new Map<string, RenderObject[]>();
        for (const ro of liveROs) {
            if (_isInternalMesh(ro)) continue;
            const passId = ro.passId || 'default';
            let bucket = passBuckets.get(passId);
            if (!bucket) { bucket = []; passBuckets.set(passId, bucket); }
            bucket.push(ro);
        }

        // ------------------------------------------------------------------
        // 2. Remove stale pass headers (and their children are auto-removed)
        // ------------------------------------------------------------------
        for (const [passId, headerItem] of this._passHeaders) {
            if (!passBuckets.has(passId)) {
                this.list.remove(headerItem);
                this._passHeaders.delete(passId);
                // Clean up tracked RO nodes that belonged to this pass
                for (const [id, node] of this._roNodes) {
                    if (node.passId === passId) {
                        this._roNodes.delete(id);
                        if (this._selectedRO?.id === id) {
                            this._selectedRO = null;
                            this._detailPanel.style.display = 'none';
                        }
                    }
                }
            }
        }

        // ------------------------------------------------------------------
        // 3. Remove stale RO items that disappeared from their pass
        // ------------------------------------------------------------------
        const liveIds = new Set<number>();
        for (const bucket of passBuckets.values()) {
            for (const ro of bucket) liveIds.add(ro.id);
        }
        for (const [id, node] of this._roNodes) {
            if (!liveIds.has(id)) {
                // Remove from parent header item
                const headerItem = this._passHeaders.get(node.passId);
                headerItem?.remove(node.item);
                this._roNodes.delete(id);
                if (this._selectedRO?.id === id) {
                    this._selectedRO = null;
                    this._detailPanel.style.display = 'none';
                }
            }
        }

        // ------------------------------------------------------------------
        // 4. Ensure pass header items exist and add new RO children
        // ------------------------------------------------------------------
        for (const [passId, ros] of passBuckets) {
            // Ensure pass header exists in the List
            if (!this._passHeaders.has(passId)) {
                const nameEl = document.createElement('span');
                nameEl.className = 'hierarchy-name';
                nameEl.textContent = passId;
                const headerItem = new Item(nameEl);
                // Keep it open by default (header shows its children)
                this.list.add(headerItem);
                this._passHeaders.set(passId, headerItem);
            }

            const headerItem = this._passHeaders.get(passId)!;

            for (const ro of ros) {
                if (this._roNodes.has(ro.id)) continue;

                const nameEl = document.createElement('span');
                nameEl.className = 'hierarchy-name';
                nameEl.textContent = _roDisplayName(ro);

                const item = new Item(nameEl);
                item.itemRow.classList.add('actionable');

                const capturedRO = ro;
                item.itemRow.addEventListener('click', (e) => {
                    if ((e.target as HTMLElement).closest('.item-toggler')) return;
                    this.selectRO(capturedRO, inspector);
                });

                // Nest under the pass header
                headerItem.add(item);

                this._roNodes.set(ro.id, {
                    id: ro.id,
                    ro,
                    item,
                    passId,
                });
            }
        }

        // ------------------------------------------------------------------
        // 5. Refresh shader panel if a RO is currently selected
        // ------------------------------------------------------------------
        if (this._selectedRO) {
            this._shaderPanel.updateFromRO(inspector, this._selectedRO);
        }
    }

    /**
     * Select a RO programmatically (also called on click).
     * Highlights the item and populates the detail panel.
     */
    selectRO(ro: RenderObject, inspector: Inspector): void {
        // Clear previous highlight
        if (this._selectedRO) {
            const prev = this._roNodes.get(this._selectedRO.id);
            prev?.item.itemRow.classList.remove('hierarchy-selected');
        }

        this._selectedRO = ro;
        const node = this._roNodes.get(ro.id);
        if (node) node.item.itemRow.classList.add('hierarchy-selected');

        // Show and populate detail panel
        this._detailPanel.style.display = 'flex';
        this._populateDetail(ro, inspector);
    }

    // -----------------------------------------------------------------------
    // Detail panel population
    // -----------------------------------------------------------------------

    private _populateDetail(ro: RenderObject, inspector: Inspector): void {
        // Shader pane — delegate to ShaderPanel (reuses probe support)
        this._shaderPanel.updateFromRO(inspector, ro);

        // Pipeline pane
        this._pipelinePane.innerHTML = '';
        this._pipelinePane.appendChild(_buildPipelineTable(ro));

        // Bindings pane
        this._bindingsPane.innerHTML = '';
        if (ro.nodeBuilderState) {
            this._bindingsPane.appendChild(
                buildBindingsTable(
                    ro.nodeBuilderState.uniformGroups,
                    ro.nodeBuilderState.textures,
                    ro.nodeBuilderState.samplers,
                    ro.nodeBuilderState.storage,
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

    private _showDetailSubTab(tab: DetailSubTab): void {
        this._currentSubTab = tab;

        for (const [st, btn] of this._detailSubBtns) {
            btn.classList.toggle('active', st === tab);
        }

        const panes: Record<DetailSubTab, HTMLDivElement> = {
            shader: this._shaderPane,
            pipeline: this._pipelinePane,
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

function _isInternalMesh(ro: RenderObject): boolean {
    // Skip gpucat-internal meshes (e.g. fullscreen quad used by post-processing)
    const name = ro.mesh.name ?? '';
    return name.startsWith('__') && name.endsWith('__');
}

function _roDisplayName(ro: RenderObject): string {
    const meshName = ro.mesh.name || `Mesh #${ro.mesh.objectId}`;
    return meshName;
}

// ---------------------------------------------------------------------------
// Pipeline table
// ---------------------------------------------------------------------------

function _buildPipelineTable(ro: RenderObject): HTMLDivElement {
    const container = document.createElement('div');
    container.className = 'dc-kv-table';

    const m = ro.material;
    const rc = ro.renderContext;

    const rows: [string, string][] = [
        ['transparent', String(m.transparent)],
        ['depthTest', String(m.depthTest)],
        ['depthWrite', String(m.depthWrite)],
        ['depthCompare', m.depthCompare],
        ['cullMode', m.cullMode],
        ['alphaToCoverage', String(m.alphaToCoverage)],
        ['blend', m.blend ? JSON.stringify(m.blend) : 'none'],
        ['sampleCount', String(rc.sampleCount)],
        ['depth', String(rc.depth)],
        ['stencil', String(rc.stencil)],
    ];

    // Geometry / draw params
    const geo = ro.geometry;
    rows.push(['vertexCount', String(geo.vertexCount)]);
    if (geo.index && geo.index.array) {
        rows.push(['indexFormat', getIndexFormat(geo.index.array) ?? 'unknown']);
        rows.push(['indexCount', String(geo.index.array.length)]);
    }
    if (ro.drawParams) {
        rows.push(['instanceCount', String(ro.drawParams.instanceCount)]);
    }

    for (const [k, v] of rows) {
        container.appendChild(kvRow(k, v));
    }

    return container;
}

// ---------------------------------------------------------------------------
// Bindings table (exported for reuse by ComputeCalls)
// ---------------------------------------------------------------------------

export function buildBindingsTable(
    uniformGroups: UniformGroupBlock[],
    textures: TextureEntry[],
    samplers: SamplerEntry[],
    storage: StorageEntry[],
): HTMLDivElement {
    const container = document.createElement('div');

    // --- Uniform groups ---
    if (uniformGroups.length > 0) {
        container.appendChild(sectionHeader('Uniform Groups'));
        const table = document.createElement('div');
        table.className = 'dc-kv-table';
        for (const ug of uniformGroups) {
            table.appendChild(kvRow(
                `@group(${ug.groupIndex}) ${ug.groupName}`,
                `${ug.totalBytes} bytes, ${ug.members.length} members`,
            ));
            for (const m of ug.members) {
                const memberEl = document.createElement('div');
                memberEl.className = 'dc-kv-row';
                memberEl.style.paddingLeft = '16px';
                const k = document.createElement('span');
                k.className = 'dc-kv-key';
                k.textContent = `  ${m.uniformId}`;
                const v = document.createElement('span');
                v.className = 'dc-kv-val';
                v.textContent = `${m.type} (${m.size}b)`;
                memberEl.appendChild(k);
                memberEl.appendChild(v);
                table.appendChild(memberEl);
            }
        }
        container.appendChild(table);
    }

    // --- Textures ---
    if (textures.length > 0) {
        container.appendChild(sectionHeader('Textures'));
        const table = document.createElement('div');
        table.className = 'dc-kv-table';
        for (const t of textures) {
            table.appendChild(kvRow(
                `@group(${t.group}) @binding(${t.binding})`,
                `${t.type} (${t.textureId})`,
            ));
        }
        container.appendChild(table);
    }

    // --- Samplers ---
    if (samplers.length > 0) {
        container.appendChild(sectionHeader('Samplers'));
        const table = document.createElement('div');
        table.className = 'dc-kv-table';
        for (const s of samplers) {
            table.appendChild(kvRow(
                `@group(${s.group}) @binding(${s.binding})`,
                s.type,
            ));
        }
        container.appendChild(table);
    }

    // --- Storage ---
    if (storage.length > 0) {
        container.appendChild(sectionHeader('Storage Buffers'));
        const table = document.createElement('div');
        table.className = 'dc-kv-table';
        for (const st of storage) {
            table.appendChild(kvRow(
                `@group(${st.group}) @binding(${st.binding}) ${st.name}`,
                `${st.type} [${st.access}]`,
            ));
        }
        container.appendChild(table);
    }

    if (
        uniformGroups.length === 0 &&
        textures.length === 0 &&
        samplers.length === 0 &&
        storage.length === 0
    ) {
        const hint = document.createElement('div');
        hint.className = 'dc-section-header';
        hint.textContent = 'No bindings';
        container.appendChild(hint);
    }

    return container;
}

// ---------------------------------------------------------------------------
// DOM helpers (exported for reuse by ComputeCalls)
// ---------------------------------------------------------------------------

export function kvRow(key: string, value: string): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'dc-kv-row';
    const k = document.createElement('span');
    k.className = 'dc-kv-key';
    k.textContent = key;
    const v = document.createElement('span');
    v.className = 'dc-kv-val';
    v.textContent = value;
    row.appendChild(k);
    row.appendChild(v);
    return row;
}

export function sectionHeader(text: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'dc-section-header';
    el.textContent = text;
    return el;
}
