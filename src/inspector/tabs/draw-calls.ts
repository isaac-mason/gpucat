/**
 * draw-calls.ts, Inspector "Draw Calls" tab.
 *
 * The frame as it was asked for: every pass in call order, render, compute and transform feedback,
 * each with the calls it recorded and what became of them. A pass recorded while a call resolved (a
 * render texture its material samples) sits under that call.
 *
 * Selecting a draw opens a detail panel on the render object it resolved to:
 *   [Shader], reuses ShaderPanel (with probe hover/selection support)
 *   [Pipeline], material / render-context state table
 *   [Bindings], bind group layout table (uniform groups, textures, samplers, storage)
 *
 * The list is rebuilt only when the frame's shape changes, so a steady frame touches no DOM.
 */

import { getIndexFormat } from '../../core/gpu-buffer';
import type { NodeBuilderState } from '../../renderer/core/node-builder-state';
import type { RenderObject } from '../../renderer/core/render-object';
import type { Inspector } from '../inspector';
import type { FrameRecord, RecordedCall, RecordedPass } from '../renderer-inspector';
import { Item } from '../ui/item';
import { List } from '../ui/list';
import { Tab } from '../ui/tab';
import { ShaderPanel } from './shader-panel';

// Sub-tab type

type DetailSubTab = 'shader' | 'pipeline' | 'bindings';

// DrawCalls Tab

export class DrawCalls extends Tab {
    readonly list: List;

    /** The top-level pass rows of the frame on show. */
    private _passItems: Item[] = [];

    /** Every row that selects a render object, by its id; one object can be drawn in several passes. */
    private _rowsByRenderObject: Map<number, Item[]> = new Map();

    /** The shape of the frame on show, so an unchanged frame keeps its rows. */
    private _shownShape = '';

    /** Currently selected RO */
    private _selectedRO: RenderObject | null = null;

    // Detail panel
    private _detailPanel: HTMLDivElement;
    private _detailSubBtns: Map<DetailSubTab, HTMLButtonElement> = new Map();
    private _shaderPane: HTMLDivElement;
    private _pipelinePane: HTMLDivElement;
    private _bindingsPane: HTMLDivElement;
    private _shaderPanel: ShaderPanel;
    private _currentSubTab: DetailSubTab = 'shader';

    constructor() {
        super('Draw Calls');

        // List (left column)
        const list = new List('Draw Call');
        list.setGridStyle('1fr');

        const scrollWrapper = document.createElement('div');
        scrollWrapper.className = 'list-scroll-wrapper scene-hierarchy-list';
        scrollWrapper.appendChild(list.domElement);

        // Detail panel (right column)
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

        // Root layout (list | detail)
        const layout = document.createElement('div');
        layout.className = 'scene-hierarchy-layout';
        layout.appendChild(scrollWrapper);
        layout.appendChild(detailPanel);

        this.content.appendChild(layout);

        this.list = list;

        // Activate initial sub-tab
        this._showDetailSubTab('shader');
    }

    // Public API

    /** Called by Inspector._processFrame() every frame the panel is open. */
    update(inspector: Inspector, record: FrameRecord): void {
        const shape = passesShape(record.passes);
        if (shape !== this._shownShape) {
            this._shownShape = shape;
            for (const item of this._passItems) this.list.remove(item);
            this._passItems.length = 0;
            this._rowsByRenderObject.clear();
            for (const pass of record.passes) {
                const item = this._passItem(pass, inspector);
                this.list.add(item);
                this._passItems.push(item);
            }
            this._highlight(this._selectedRO);
        }

        if (this._selectedRO) {
            this._shaderPanel.updateFromRO(inspector, this._selectedRO);
        }
    }

    /**
     * Select a RO programmatically (also called on click).
     * Highlights its rows and populates the detail panel.
     */
    selectRO(ro: RenderObject, inspector: Inspector): void {
        this._highlight(null);
        this._selectedRO = ro;
        this._highlight(ro);

        this._detailPanel.style.display = 'flex';
        this._populateDetail(ro, inspector);
    }

    private _highlight(ro: RenderObject | null): void {
        const selected = this._selectedRO === null ? undefined : this._rowsByRenderObject.get(this._selectedRO.id);
        if (ro === null) {
            for (const row of selected ?? []) row.itemRow.classList.remove('hierarchy-selected');
            return;
        }
        for (const row of this._rowsByRenderObject.get(ro.id) ?? []) row.itemRow.classList.add('hierarchy-selected');
    }

    private _passItem(pass: RecordedPass, inspector: Inspector): Item {
        const status = pass.error ?? (pass.skipped === null ? '' : `skipped: ${pass.skipped}`);
        const item = new Item(rowLabel(pass.kind, pass.label, `${pass.calls.length} calls`, status, pass.error !== null));
        for (const call of pass.calls) item.add(this._callItem(call, inspector));
        return item;
    }

    private _callItem(call: RecordedCall, inspector: Inspector): Item {
        const item = new Item(rowLabel(call.kind, call.name, call.detail, callStatus(call), call.error !== null));
        if (call.kind === 'draw' && call.renderObjects.length === 1) {
            this._selectsRenderObject(item, call.renderObjects[0], inspector);
        } else if (call.kind === 'bundle') {
            for (const ro of call.renderObjects) {
                const drawItem = new Item(rowLabel('draw', _roDisplayName(ro), '', '', false));
                this._selectsRenderObject(drawItem, ro, inspector);
                item.add(drawItem);
            }
        }
        for (const pass of call.passes) item.add(this._passItem(pass, inspector));
        return item;
    }

    private _selectsRenderObject(item: Item, ro: RenderObject, inspector: Inspector): void {
        item.itemRow.classList.add('actionable');
        item.itemRow.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('.item-toggler')) return;
            this.selectRO(ro, inspector);
        });
        let rows = this._rowsByRenderObject.get(ro.id);
        if (rows === undefined) {
            rows = [];
            this._rowsByRenderObject.set(ro.id, rows);
        }
        rows.push(item);
    }

    // Detail panel population

    private _populateDetail(ro: RenderObject, inspector: Inspector): void {
        // Shader pane, delegate to ShaderPanel (reuses probe support)
        this._shaderPanel.updateFromRO(inspector, ro);

        // Pipeline pane
        this._pipelinePane.innerHTML = '';
        this._pipelinePane.appendChild(_buildPipelineTable(ro));

        // Bindings pane
        this._bindingsPane.innerHTML = '';
        if (ro.nodeBuilderState) {
            this._bindingsPane.appendChild(buildBindingsTable(ro.nodeBuilderState));
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

// Helpers

/** Everything a row shows, so two frames with the same shape can keep the same rows. */
function passesShape(passes: RecordedPass[]): string {
    let shape = '';
    for (const pass of passes) {
        shape += `[${pass.kind}|${pass.label}|${pass.skipped}|${pass.error}`;
        for (const call of pass.calls) {
            shape += `(${call.kind}|${call.name}|${call.detail}|${call.emptyDraws}|${call.error}`;
            for (const ro of call.renderObjects) shape += `,${ro.id}`;
            shape += `${passesShape(call.passes)})`;
        }
        shape += ']';
    }
    return shape;
}

function callStatus(call: RecordedCall): string {
    if (call.error !== null) return call.error;
    if (call.kind === 'bundle' && call.emptyDraws > 0) return `${call.emptyDraws} draw nothing`;
    if (call.kind === 'draw' && call.emptyDraws > 0) return 'draws nothing';
    return '';
}

function rowLabel(kind: string, name: string, detail: string, status: string, failed: boolean): HTMLElement {
    const row = document.createElement('span');
    row.className = 'hierarchy-name';

    const badge = document.createElement('span');
    badge.className = `hierarchy-type-badge dc-kind--${kind}`;
    badge.textContent = kind === 'transform-feedback' ? 'tf' : kind;
    row.appendChild(badge);
    row.append(` ${name}`);

    if (detail !== '') {
        const detailEl = document.createElement('span');
        detailEl.className = 'dc-call-detail';
        detailEl.textContent = ` ${detail}`;
        row.appendChild(detailEl);
    }
    if (status !== '') {
        const statusEl = document.createElement('span');
        statusEl.className = failed ? 'dc-call-status dc-call-status--failed' : 'dc-call-status';
        statusEl.textContent = ` ${status}`;
        row.appendChild(statusEl);
    }
    return row;
}

function _roDisplayName(ro: RenderObject): string {
    const meshName = ro.mesh.name || `Mesh #${ro.mesh.objectId}`;
    return meshName;
}

// Pipeline table

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
    rows.push(['drawRange.start', String(geo.drawRange.start)]);
    rows.push(['drawRange.count', String(geo.drawRange.count)]);
    if (geo.index && geo.index.array) {
        rows.push(['indexFormat', getIndexFormat(geo.index.array) ?? 'unknown']);
        rows.push(['indexCount', String(geo.index.array.length)]);
    }
    rows.push(['instanceCount', String(ro.mesh.count)]);

    for (const [k, v] of rows) {
        container.appendChild(kvRow(k, v));
    }

    return container;
}

// Bindings table (exported for reuse by ComputeCalls)

export function buildBindingsTable(state: NodeBuilderState): HTMLDivElement {
    const container = document.createElement('div');

    const { uniformGroups, textures, samplers, storage, vertexBufferGroups, varyings, builtinsUsed } = state;

    // Vertex Buffer Groups
    if (vertexBufferGroups.length > 0) {
        container.appendChild(sectionHeader('Vertex Buffers'));
        const table = document.createElement('div');
        table.className = 'dc-kv-table';
        for (let i = 0; i < vertexBufferGroups.length; i++) {
            const group = vertexBufferGroups[i];
            const source = group.name !== null ? group.name : 'buffer';
            const stepMode = group.instanced ? 'instance' : 'vertex';
            table.appendChild(
                kvRow(
                    `slot ${i} (${source})`,
                    `stride=${group.stride}, ${stepMode}, ${group.attributes.length} attr${group.attributes.length > 1 ? 's' : ''}`,
                ),
            );
            for (const attr of group.attributes) {
                const memberEl = document.createElement('div');
                memberEl.className = 'dc-kv-row';
                memberEl.style.paddingLeft = '16px';
                const k = document.createElement('span');
                k.className = 'dc-kv-key';
                k.textContent = `  @location(${attr.shaderLocation})`;
                const v = document.createElement('span');
                v.className = 'dc-kv-val';
                v.textContent = `${attr.type}, offset=${attr.offset}`;
                memberEl.appendChild(k);
                memberEl.appendChild(v);
                table.appendChild(memberEl);
            }
        }
        container.appendChild(table);
    }

    // Varyings
    if (varyings.length > 0) {
        container.appendChild(sectionHeader('Varyings'));
        const table = document.createElement('div');
        table.className = 'dc-kv-table';
        for (const v of varyings) {
            let interp = '';
            if (v.interpolationType) {
                interp = ` @interpolate(${v.interpolationType}`;
                if (v.interpolationSampling) interp += `, ${v.interpolationSampling}`;
                interp += ')';
            }
            table.appendChild(kvRow(`@location(${v.location}) ${v.name}`, `${v.type}${interp}`));
        }
        container.appendChild(table);
    }

    // Builtins
    if (builtinsUsed.size > 0) {
        container.appendChild(sectionHeader('Builtins'));
        const table = document.createElement('div');
        table.className = 'dc-kv-table';
        for (const b of builtinsUsed) {
            table.appendChild(kvRow(`@builtin(${b})`, ''));
        }
        container.appendChild(table);
    }

    // Uniform groups
    if (uniformGroups.length > 0) {
        container.appendChild(sectionHeader('Uniform Groups'));
        const table = document.createElement('div');
        table.className = 'dc-kv-table';
        for (const ug of uniformGroups) {
            table.appendChild(
                kvRow(`@group(${ug.groupIndex}) ${ug.groupName}`, `${ug.totalBytes} bytes, ${ug.members.length} members`),
            );
            for (const m of ug.members) {
                const memberEl = document.createElement('div');
                memberEl.className = 'dc-kv-row';
                memberEl.style.paddingLeft = '16px';
                const k = document.createElement('span');
                k.className = 'dc-kv-key';
                k.textContent = `  ${m.uniformId}`;
                const v = document.createElement('span');
                v.className = 'dc-kv-val';
                v.textContent = `${m.schema.wgslType} (${m.size}b)`;
                memberEl.appendChild(k);
                memberEl.appendChild(v);
                table.appendChild(memberEl);
            }
        }
        container.appendChild(table);
    }

    // Textures
    if (textures.length > 0) {
        container.appendChild(sectionHeader('Textures'));
        const table = document.createElement('div');
        table.className = 'dc-kv-table';
        for (const t of textures) {
            table.appendChild(kvRow(`@group(${t.group}) @binding(${t.binding})`, `${t.type} (${t.textureId})`));
        }
        container.appendChild(table);
    }

    // Samplers
    if (samplers.length > 0) {
        container.appendChild(sectionHeader('Samplers'));
        const table = document.createElement('div');
        table.className = 'dc-kv-table';
        for (const s of samplers) {
            table.appendChild(kvRow(`@group(${s.group}) @binding(${s.binding})`, s.type));
        }
        container.appendChild(table);
    }

    // Storage
    if (storage.length > 0) {
        container.appendChild(sectionHeader('Storage Buffers'));
        const table = document.createElement('div');
        table.className = 'dc-kv-table';
        for (const st of storage) {
            table.appendChild(kvRow(`@group(${st.group}) @binding(${st.binding}) ${st.name}`, `${st.type} [${st.access}]`));
        }
        container.appendChild(table);
    }

    if (
        vertexBufferGroups.length === 0 &&
        varyings.length === 0 &&
        builtinsUsed.size === 0 &&
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

// DOM helpers (exported for reuse by ComputeCalls)

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
