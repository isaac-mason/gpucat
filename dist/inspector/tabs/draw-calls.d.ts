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
import type { Inspector } from '../inspector';
import type { RenderObject } from '../../renderer/render-object';
import type { WebGPURenderer } from '../../renderer/renderer';
import type { NodeBuilderState } from '../../renderer/node-builder-state';
export declare class DrawCalls extends Tab {
    readonly list: List;
    /** ro.id → RONode for every currently-displayed RenderObject */
    private _roNodes;
    /** Pass header items keyed by passId */
    private _passHeaders;
    /** Currently selected RO */
    private _selectedRO;
    private _detailPanel;
    private _detailSubBtns;
    private _shaderPane;
    private _pipelinePane;
    private _bindingsPane;
    private _shaderPanel;
    private _currentSubTab;
    constructor();
    /**
     * Called by Inspector._processFrame() every frame.
     * Only diffs by ro.id — does NOT repaint the detail panel unless the
     * selected RO changed.
     *
     * Structure: pass header items are top-level in the List; RO items are
     * children of their respective pass header (Item.add).  This gives proper
     * indent and uses the existing header-wrapper styling automatically.
     */
    update(inspector: Inspector, renderer: WebGPURenderer): void;
    /**
     * Select a RO programmatically (also called on click).
     * Highlights the item and populates the detail panel.
     */
    selectRO(ro: RenderObject, inspector: Inspector): void;
    private _populateDetail;
    private _showDetailSubTab;
}
export declare function buildBindingsTable(state: NodeBuilderState): HTMLDivElement;
export declare function kvRow(key: string, value: string): HTMLDivElement;
export declare function sectionHeader(text: string): HTMLDivElement;
