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
 */

import type { Inspector } from '../inspector';
import type { SceneRecord } from '../renderer-inspector';
import type { Mesh } from '../../objects/mesh';

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
 *
 * We return the full code for each stage by finding the second @vertex /
 * @fragment attribute and everything following it to the next top-level entry.
 * If the markers are absent we fall back to the full code for both.
 */
function splitStages(code: string): ShaderStages {
    // Find positions of the entry-point attribute lines
    // (the ones immediately preceding fn vs_main / fn fs_main)
    const vertexMatch = code.match(/@vertex\s*\nfn\s+vs_main/);
    const fragmentMatch = code.match(/@fragment\s*\nfn\s+fs_main/);

    if (!vertexMatch || !fragmentMatch) {
        return { vertex: code, fragment: code, full: code };
    }

    const vsStart = code.indexOf(vertexMatch[0]);
    const fsStart = code.indexOf(fragmentMatch[0]);

    // Vertex section: from @vertex … up to (but not including) @fragment
    const vertexSection = code.slice(vsStart, fsStart).trimEnd();
    // Fragment section: from @fragment to end
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

        // --- Code block ---
        const codeBlock = document.createElement('pre');
        codeBlock.className = 'shader-code';
        codeBlock.innerHTML = '<span class="wgsl-comment">// Compiling…</span>';

        container.appendChild(toolbar);
        container.appendChild(codeBlock);

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
        const renderer = inspector.getRenderer();
        if (!renderer) {
            this._setCompiling();
            return;
        }

        // Search the live RenderObjects set for a matching mesh
        let code: string | null = null;
        for (const ro of renderer.renderObjects.renderObjects) {
            if (ro.mesh === mesh && ro.nodeBuilderState) {
                code = ro.nodeBuilderState.code;
                break;
            }
        }

        if (code === null) {
            this._setCompiling();
            return;
        }

        this._stages = splitStages(code);
        this._renderCurrentStage();
    }

    // -----------------------------------------------------------------------
    // Private
    // -----------------------------------------------------------------------

    private _selectStage(stage: Stage): void {
        this._currentStage = stage;

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
        this._codeBlock.innerHTML = highlightWGSL(code);
    }

    private _setCompiling(): void {
        this._stages = null;
        this._codeBlock.innerHTML = '<span class="wgsl-comment">// Compiling…</span>';
    }

    private _copyCode(btn: HTMLButtonElement): void {
        if (!this._stages) return;
        const text = this._stages[this._currentStage];
        navigator.clipboard.writeText(text);
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 350);
    }
}
