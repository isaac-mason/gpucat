/**
 * shader-panel.ts — Inline WGSL shader viewer for the Inspector.
 *
 * Given a RenderObject, it:
 *  1. Splits nodeBuilderState.code into vertex/fragment sections.
 *  2. Applies basic WGSL syntax highlighting in a <pre> display layer.
 *  3. Provides stage-select buttons (Vertex / Fragment / Full) and Copy button.
 *  4. Shows "Compiling…" when no compiled RenderObject exists yet.
 *  5. Hovering a probeable fragment-stage line shows a floating popover with
 *     a live 140×140 preview canvas next to the cursor.
 */
import type { Inspector } from '../inspector';
import type { SceneRecord } from '../renderer-inspector';
import type { Mesh } from '../../objects/mesh';
import type { RenderObject } from '../../renderer/render-object';
type Stage = 'vertex' | 'fragment' | 'full' | 'compute';
export type ShaderPanelMode = 'render' | 'compute';
export declare class ShaderPanel {
    readonly domElement: HTMLDivElement;
    private _codeBlock;
    private _stageButtons;
    private _currentStage;
    private _stages;
    /** Raw compute shader code (used in compute mode). */
    private _computeCode;
    /** The raw code string last written to innerHTML — skips re-render if unchanged. */
    private _lastRenderedCode;
    /** The RenderObject found during the last update() call. */
    private _renderObject;
    /** Inspector reference — set on first update() call. */
    private _inspector;
    /** Floating popover element, appended to document.body. */
    private _popover;
    private _popoverLabel;
    private _popoverCanvasSlot;
    /** varName currently shown in the popover (to avoid redundant setProbe calls). */
    private _hoverVarName;
    /** Whether the popover is currently visible. */
    private _popoverVisible;
    /**
     * When true the current probe was triggered by a text selection, not a
     * hover.  Mousemove events will NOT clear it — only a mousedown outside
     * the code block (or a new selection) will.
     */
    private _selectionLocked;
    constructor(mode?: ShaderPanelMode);
    /**
     * Update the panel for the given mesh.
     * Finds the compiled RenderObject in the renderer's renderObjects set.
     */
    update(inspector: Inspector, mesh: Mesh, _sceneRecord: SceneRecord): void;
    /**
     * Update the panel directly from a RenderObject.
     * Used by the DrawCalls tab where we already have the RO.
     */
    updateFromRO(inspector: Inspector, ro: RenderObject): void;
    /**
     * Update the panel with compute shader WGSL code.
     * Used by the ComputeCalls tab.
     */
    updateFromCompute(code: string): void;
    /**
     * The stage currently shown in the panel.
     */
    get currentStage(): Stage;
    private _selectStage;
    private _renderCurrentStage;
    private _onMouseLeave;
    private _onLineHover;
    private _positionPopover;
    private _showPopover;
    private _hidePopover;
    /**
     * Called on `mouseup` inside the code block.  If the user has selected
     * a non-empty text range, treat the selected text as the probe expression.
     */
    private _onSelectionEnd;
    private _setCompiling;
    private _copyCode;
}
export {};
