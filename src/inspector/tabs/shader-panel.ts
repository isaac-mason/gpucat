/**
 * shader-panel.ts — Inline WGSL shader viewer for the Scene Hierarchy tab.
 *
 * Given a Mesh + SceneRecord, it:
 *  1. Finds the first compiled RenderObject for that mesh in the renderer's
 *     renderObjects set and reads nodeBuilderState.code (combined WGSL).
 *  2. Splits the code into vertex/fragment sections on the fn markers.
 *  3. Applies basic WGSL syntax highlighting.
 *  4. Provides stage-select buttons (Vertex / Fragment) and a Copy button.
 *  5. Shows "Compiling…" when no compiled RenderObject exists yet.
 *  6. Hovering a probeable fragment-stage line shows a floating popover with
 *     a live 140×140 preview canvas next to the cursor.
 */

import type { Inspector } from '../inspector';
import type { SceneRecord } from '../renderer-inspector';
import type { Mesh } from '../../objects/mesh';
import type { RenderObject } from '../../renderer/render-object';
import { extractProbeTarget } from '../probe-wgsl';

// ---------------------------------------------------------------------------
// WGSL Syntax Highlighting
// ---------------------------------------------------------------------------

/** Lightweight regex-based WGSL highlighter. Returns an HTML string. */
function highlightWGSL(code: string): string {
    // Escape HTML first so we can safely inject spans
    const escaped = code
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    return escaped
        // Line comments
        .replace(/(\/\/[^\n]*)/g, '<span class="wgsl-comment">$1</span>')
        // Block comments (non-greedy)
        .replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="wgsl-comment">$1</span>')
        // Attributes  @builtin @location @group @binding @vertex @fragment @compute
        .replace(/(@\w+)/g, '<span class="wgsl-attribute">$1</span>')
        // Keywords
        .replace(
            /\b(fn|let|var|const|struct|return|if|else|for|while|loop|break|continue|switch|case|default|discard|override|enable|alias|import|true|false|null)\b/g,
            '<span class="wgsl-keyword">$1</span>',
        )
        // Built-in types
        .replace(
            /\b(bool|i32|u32|f32|f16|vec2|vec3|vec4|vec2f|vec3f|vec4f|vec2i|vec3i|vec4i|vec2u|vec3u|vec4u|mat2x2|mat3x3|mat4x4|mat2x2f|mat3x3f|mat4x4f|array|atomic|texture_2d|texture_depth_2d|texture_storage_2d|sampler|sampler_comparison|ptr|ref)\b/g,
            '<span class="wgsl-type">$1</span>',
        )
        // Built-in functions
        .replace(
            /\b(abs|acos|asin|atan|atan2|ceil|clamp|cos|cross|degrees|distance|dot|exp|exp2|floor|fma|fract|inverseSqrt|length|log|log2|max|min|mix|modf|normalize|pow|radians|reflect|refract|round|sign|sin|smoothstep|sqrt|step|tan|trunc|bitcast|select|arrayLength|textureLoad|textureSample|textureSampleBias|textureSampleCompare|textureSampleGrad|textureSampleLevel|textureStore|textureDimensions|dpdx|dpdy|fwidth|pack4x8snorm|pack4x8unorm|unpack4x8snorm|unpack4x8unorm)\b/g,
            '<span class="wgsl-builtin">$1</span>',
        )
        // Numeric literals (hex, float, int)
        .replace(/\b(0x[0-9a-fA-F]+|[0-9]*\.[0-9]+(?:[eE][+-]?[0-9]+)?[fh]?|[0-9]+[uif]?)\b/g,
            '<span class="wgsl-number">$1</span>',
        );
}

// ---------------------------------------------------------------------------
// Split WGSL into vertex / fragment sections
// ---------------------------------------------------------------------------

type ShaderStages = {
    vertex: string;
    fragment: string;
    full: string;
};

/**
 * Split combined WGSL (as emitted by compile.ts) into vertex / fragment
 * sections. The combined code has `@vertex\nfn vs_main` and
 * `@fragment\nfn fs_main` entry-point markers.
 */
function splitStages(code: string): ShaderStages {
    const vertexMatch = code.match(/@vertex\s*\nfn\s+vs_main/);
    const fragmentMatch = code.match(/@fragment\s*\nfn\s+fs_main/);

    if (!vertexMatch || !fragmentMatch) {
        return { vertex: code, fragment: code, full: code };
    }

    const vsStart = code.indexOf(vertexMatch[0]);
    const fsStart = code.indexOf(fragmentMatch[0]);

    const vertexSection = code.slice(vsStart, fsStart).trimEnd();
    const fragmentSection = code.slice(fsStart).trimEnd();

    return {
        vertex: vertexSection,
        fragment: fragmentSection,
        full: code,
    };
}

// ---------------------------------------------------------------------------
// ShaderPanel
// ---------------------------------------------------------------------------

type Stage = 'vertex' | 'fragment' | 'full';

export class ShaderPanel {

    readonly domElement: HTMLDivElement;

    private _codeBlock: HTMLPreElement;
    private _stageButtons: Map<Stage, HTMLButtonElement> = new Map();

    private _currentStage: Stage = 'vertex';
    private _stages: ShaderStages | null = null;

    /** The raw code string last written to innerHTML — skips re-render if unchanged. */
    private _lastRenderedCode: string | null = null;

    /** The RenderObject found during the last update() call. */
    private _renderObject: RenderObject | null = null;

    /** Inspector reference — set on first update() call. */
    private _inspector: Inspector | null = null;

    // -----------------------------------------------------------------------
    // Probe popover — floats next to the cursor while hovering a probeable line
    // -----------------------------------------------------------------------

    /** Floating popover element, appended to document.body. */
    private _popover: HTMLDivElement;
    private _popoverLabel: HTMLSpanElement;
    private _popoverCanvasSlot: HTMLDivElement;

    /** varName currently shown in the popover (to avoid redundant setProbe calls). */
    private _hoverVarName: string | null = null;

    /** Whether the popover is currently visible. */
    private _popoverVisible = false;

    /**
     * When true the current probe was triggered by a text selection, not a
     * hover.  Mousemove events will NOT clear it — only a mousedown outside
     * the code block (or a new selection) will.
     */
    private _selectionLocked = false;

    constructor() {
        const container = document.createElement('div');
        container.className = 'shader-panel';

        // --- Toolbar ---
        const toolbar = document.createElement('div');
        toolbar.className = 'shader-toolbar';

        const stageGroup = document.createElement('div');
        stageGroup.className = 'shader-stage-group';

        const stages: Stage[] = ['vertex', 'fragment', 'full'];
        for (const stage of stages) {
            const btn = document.createElement('button');
            btn.className = 'shader-stage-btn';
            btn.textContent = stage.charAt(0).toUpperCase() + stage.slice(1);
            btn.addEventListener('click', () => this._selectStage(stage));
            stageGroup.appendChild(btn);
            this._stageButtons.set(stage, btn);
        }

        const copyBtn = document.createElement('button');
        copyBtn.className = 'console-copy-button shader-copy-btn';
        copyBtn.title = 'Copy shader';
        copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
        copyBtn.addEventListener('click', () => this._copyCode(copyBtn));

        toolbar.appendChild(stageGroup);
        toolbar.appendChild(copyBtn);

        // --- Code block (pre inside a scroll wrapper) ---
        // The pre must NOT be a scroll container — Chrome intercepts click-drag
        // on scrollable elements as scroll gestures, blocking text selection.
        // Scrolling is handled by the wrapper div instead.
        const codeScroll = document.createElement('div');
        codeScroll.className = 'shader-code-scroll';

        const codeBlock = document.createElement('pre');
        codeBlock.className = 'shader-code';
        codeBlock.innerHTML = '<span class="wgsl-comment">// Compiling…</span>';
        // Belt-and-suspenders: inline style beats any inherited user-select:none
        codeBlock.style.userSelect = 'text';
        (codeBlock.style as CSSStyleDeclaration & { webkitUserSelect: string }).webkitUserSelect = 'text';

        codeScroll.addEventListener('mousemove', (e) => this._onLineHover(e));
        codeScroll.addEventListener('mouseleave', () => this._onMouseLeave());
        codeBlock.addEventListener('mouseup', () => this._onSelectionEnd());

        // Clicking outside the code block dismisses a selection-locked probe
        document.addEventListener('mousedown', (e) => {
            if (this._selectionLocked && !this._codeBlock.contains(e.target as Node)) {
                this._hidePopover();
            }
        });

        codeScroll.appendChild(codeBlock);

        container.appendChild(toolbar);
        container.appendChild(codeScroll);

        // --- Floating probe popover (appended to body, shared across all instances) ---
        const popover = document.createElement('div');
        popover.className = 'probe-popover';
        popover.style.display = 'none';

        const popoverLabel = document.createElement('span');
        popoverLabel.className = 'probe-popover-label';

        const popoverCanvasSlot = document.createElement('div');
        popoverCanvasSlot.className = 'probe-popover-canvas';

        popover.appendChild(popoverLabel);
        popover.appendChild(popoverCanvasSlot);
        document.body.appendChild(popover);

        this._popover = popover;
        this._popoverLabel = popoverLabel;
        this._popoverCanvasSlot = popoverCanvasSlot;

        this.domElement = container;
        this._codeBlock = codeBlock;

        // Select initial stage
        this._selectStage('vertex');
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Update the panel for the given mesh.
     * Finds the compiled RenderObject in the renderer's renderObjects set.
     */
    update(inspector: Inspector, mesh: Mesh, _sceneRecord: SceneRecord): void {
        this._inspector = inspector;

        const renderer = inspector.getRenderer();
        if (!renderer) {
            this._setCompiling();
            return;
        }

        // Search the live RenderObjects set for a matching mesh
        let ro: RenderObject | null = null;
        for (const candidate of renderer.renderObjects.renderObjects) {
            if (candidate.mesh === mesh && candidate.nodeBuilderState) {
                ro = candidate;
                break;
            }
        }

        if (ro === null) {
            this._setCompiling();
            return;
        }

        this._renderObject = ro;
        this._stages = splitStages(ro.nodeBuilderState!.code);
        this._renderCurrentStage();
    }

    /**
     * Update the panel directly from a RenderObject.
     * Used by the DrawCalls tab where we already have the RO.
     */
    updateFromRO(inspector: Inspector, ro: RenderObject): void {
        this._inspector = inspector;

        if (!ro.nodeBuilderState) {
            this._setCompiling();
            return;
        }

        // Skip expensive re-render if the RO and code haven't changed
        if (this._renderObject === ro) return;

        this._renderObject = ro;
        this._stages = splitStages(ro.nodeBuilderState.code);
        this._renderCurrentStage();
    }

    // -----------------------------------------------------------------------
    // Private
    // -----------------------------------------------------------------------

    private _selectStage(stage: Stage): void {
        this._currentStage = stage;
        this._lastRenderedCode = null;
        this._selectionLocked = false;
        this._hidePopover();
        this._hoverVarName = null;

        for (const [s, btn] of this._stageButtons) {
            btn.classList.toggle('active', s === stage);
        }

        if (this._stages) {
            this._renderCurrentStage();
        }
    }

    private _renderCurrentStage(): void {
        if (!this._stages) return;
        const code = this._stages[this._currentStage];

        // Don't rebuild the DOM (and wipe any text selection) if the code hasn't changed
        if (code === this._lastRenderedCode) return;
        this._lastRenderedCode = code;

        const lines = code.split('\n');

        const html = lines
            .map((line, i) => {
                const highlighted = highlightWGSL(line);
                return `<span class="shader-line" data-line="${i}">${highlighted}</span>`;
            })
            .join('');

        this._codeBlock.innerHTML = html;
    }

    private _onMouseLeave(): void {
        // Don't dismiss a selection-locked probe when the cursor leaves
        if (!this._selectionLocked) {
            this._hidePopover();
        }
    }

    private _onLineHover(e: MouseEvent): void {
        // If a selection is locked, just reposition the popover as cursor moves
        if (this._selectionLocked) {
            if (this._popoverVisible) this._positionPopover(e.clientX, e.clientY);
            return;
        }

        // Probing only works for the fragment stage — vertex variables don't
        // exist in fs_main, so attempts on other stages produce a broken canvas.
        if (this._currentStage !== 'fragment') {
            this._hidePopover();
            return;
        }

        // Walk up from the hovered element to find the nearest .shader-line span
        let target: HTMLElement | null = e.target as HTMLElement;
        while (target && target !== this._codeBlock) {
            if (target.classList.contains('shader-line')) break;
            target = target.parentElement;
        }

        if (!target || target === this._codeBlock) {
            this._hidePopover();
            return;
        }

        const lineIndexStr = target.dataset['line'];
        if (lineIndexStr === undefined) {
            this._hidePopover();
            return;
        }
        const lineIndex = parseInt(lineIndexStr, 10);

        if (!this._stages) {
            this._hidePopover();
            return;
        }

        const code = this._stages[this._currentStage];
        const lines = code.split('\n');
        const lineText = lines[lineIndex] ?? '';
        const probeTarget = extractProbeTarget(lineText);

        if (!probeTarget) {
            this._hidePopover();
            return;
        }

        // Position the popover near the cursor, keeping it on-screen
        this._positionPopover(e.clientX, e.clientY);

        // Only rebuild the probe canvas when the hovered expression changes
        if (probeTarget.expr === this._hoverVarName && this._popoverVisible) return;

        this._hoverVarName = probeTarget.expr;

        const ro = this._renderObject;
        if (!ro || !this._inspector) {
            this._hidePopover();
            return;
        }

        const probeCanvas = this._inspector.setProbe(probeTarget, ro);
        if (!probeCanvas) {
            this._hidePopover();
            return;
        }

        // Update popover content
        this._popoverLabel.textContent = probeTarget.expr;
        this._popoverCanvasSlot.innerHTML = '';
        this._popoverCanvasSlot.appendChild(probeCanvas);
        this._showPopover();
    }

    private _positionPopover(cursorX: number, cursorY: number): void {
        const pop = this._popover;
        const offset = 16;
        const vpW = window.innerWidth;
        const vpH = window.innerHeight;

        // Temporarily show to get natural dimensions
        const wasHidden = pop.style.display === 'none';
        if (wasHidden) {
            pop.style.visibility = 'hidden';
            pop.style.display = 'flex';
        }

        const pw = pop.offsetWidth || 180;
        const ph = pop.offsetHeight || 200;

        if (wasHidden) {
            pop.style.display = 'none';
            pop.style.visibility = '';
        }

        let left = cursorX + offset;
        let top = cursorY + offset;

        // Flip left if it would overflow right edge
        if (left + pw > vpW - 8) left = cursorX - pw - offset;
        // Clamp top
        if (top + ph > vpH - 8) top = vpH - ph - 8;
        if (top < 8) top = 8;

        pop.style.left = `${left}px`;
        pop.style.top = `${top}px`;
    }

    private _showPopover(): void {
        this._popover.style.display = 'flex';
        this._popoverVisible = true;
    }

    private _hidePopover(): void {
        this._popover.style.display = 'none';
        this._popoverVisible = false;
        this._hoverVarName = null;
        this._selectionLocked = false;
        this._inspector?.clearProbe();
    }

    /**
     * Called on `mouseup` inside the code block.  If the user has selected
     * a non-empty text range, treat the selected text as the probe expression.
     *
     * The anchor line (for body truncation) is determined by walking up from
     * the selection's anchor node to the nearest `.shader-line[data-line]` span.
     *
     * The probe is "locked" — it won't be dismissed by subsequent mousemove
     * events; only a mousedown outside the code block clears it.
     */
    private _onSelectionEnd(): void {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) {
            // No real selection — fall back to hover behaviour
            this._selectionLocked = false;
            return;
        }

        // Probing only works for the fragment stage
        if (this._currentStage !== 'fragment') {
            this._selectionLocked = false;
            return;
        }

        const selectedText = sel.toString().trim();
        if (!selectedText) {
            this._selectionLocked = false;
            return;
        }

        // Walk up from anchorNode to find the .shader-line span
        let node: Node | null = sel.anchorNode;
        let lineSpan: HTMLElement | null = null;
        while (node && node !== this._codeBlock) {
            if (node instanceof HTMLElement && node.classList.contains('shader-line')) {
                lineSpan = node;
                break;
            }
            node = node.parentElement;
        }

        if (!lineSpan || !this._stages) {
            this._selectionLocked = false;
            return;
        }

        const lineIndexStr = lineSpan.dataset['line'];
        if (lineIndexStr === undefined) {
            this._selectionLocked = false;
            return;
        }
        const lineIndex = parseInt(lineIndexStr, 10);

        const code = this._stages[this._currentStage];
        const lines = code.split('\n');
        const anchorLineText = lines[lineIndex] ?? '';

        // Build a ProbeTarget from the selection:
        // - expr = the selected text (raw WGSL sub-expression)
        // - anchor = the full trimmed anchor line, so the body walker stops there
        // - anchorKind = 'assignment' to stop after that line is included
        //
        // Special case: if the anchor line is a `let _vN = ...` line, use
        // `let_var` kind with the identifier as anchor for cleaner truncation.
        const trimmedAnchor = anchorLineText.trim();
        let probeTarget: import('../probe-wgsl').ProbeTarget;

        const letAnchorMatch = trimmedAnchor.match(/^let\s+(\w+)\s*(?::\s*[\w<>, ]+\s*)?=/);
        if (letAnchorMatch) {
            probeTarget = {
                expr: selectedText,
                anchor: letAnchorMatch[1],
                anchorKind: 'let_var',
            };
        } else if (trimmedAnchor.startsWith('return')) {
            probeTarget = {
                expr: selectedText,
                anchor: '__return__',
                anchorKind: 'return',
            };
        } else {
            probeTarget = {
                expr: selectedText,
                anchor: trimmedAnchor,
                anchorKind: 'assignment',
            };
        }

        const ro = this._renderObject;
        if (!ro || !this._inspector) return;

        // Avoid rebuilding if same selection
        const selKey = selectedText;
        if (selKey === this._hoverVarName && this._selectionLocked && this._popoverVisible) return;

        const probeCanvas = this._inspector.setProbe(probeTarget, ro);
        if (!probeCanvas) return;

        this._selectionLocked = true;
        this._hoverVarName = selKey;

        // Position near the selection (use caret coords as approximation)
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        this._positionPopover(rect.right, rect.bottom);

        this._popoverLabel.textContent = selectedText;
        this._popoverCanvasSlot.innerHTML = '';
        this._popoverCanvasSlot.appendChild(probeCanvas);
        this._showPopover();
    }

    private _setCompiling(): void {
        this._stages = null;
        this._renderObject = null;
        this._lastRenderedCode = null;
        this._codeBlock.innerHTML = '<span class="wgsl-comment">// Compiling…</span>';
        this._hidePopover();
    }

    private _copyCode(btn: HTMLButtonElement): void {
        if (!this._stages) return;
        const text = this._stages[this._currentStage];
        navigator.clipboard.writeText(text);
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 350);
    }
}
