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
import type { NodeBuilderState } from '../../renderer/core/node-builder-state';
import type { RenderObject } from '../../renderer/core/render-object';
import type { Inspector } from '../inspector';
import type { FrameRecord } from '../renderer-inspector';
import { List } from '../ui/list';
import { Tab } from '../ui/tab';
export declare class DrawCalls extends Tab {
    readonly list: List;
    /** The top-level pass rows of the frame on show. */
    private _passItems;
    /** Every row that selects a render object, by its id; one object can be drawn in several passes. */
    private _rowsByRenderObject;
    /** The shape of the frame on show, so an unchanged frame keeps its rows. */
    private _shownShape;
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
    /** Called by Inspector._processFrame() every frame the panel is open. */
    update(inspector: Inspector, record: FrameRecord): void;
    /**
     * Select a RO programmatically (also called on click).
     * Highlights its rows and populates the detail panel.
     */
    selectRO(ro: RenderObject, inspector: Inspector): void;
    private _highlight;
    private _passItem;
    private _callItem;
    private _selectsRenderObject;
    private _populateDetail;
    private _showDetailSubTab;
}
export declare function buildBindingsTable(state: NodeBuilderState): HTMLDivElement;
export declare function kvRow(key: string, value: string): HTMLDivElement;
export declare function sectionHeader(text: string): HTMLDivElement;
