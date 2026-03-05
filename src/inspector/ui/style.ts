/**
 * Style.ts — Injects the inspector CSS into the document once.
 * Mirrors Three's Style.js pattern.
 */

let injected = false;

export function injectStyle(): void {
    if (injected || typeof document === 'undefined') return;
    injected = true;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
}

const CSS = `
/* ============================================================
   gpucat Inspector — base styles
   ============================================================ */

.gpucat-inspector {
    position: fixed;
    z-index: 9999;
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    font-size: 12px;
    color: var(--gc-text-primary, #e0e0e0);
    background: var(--gc-bg, #1a1a1a);
    border: 1px solid var(--gc-border, #333);
    border-radius: 6px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.5);
    min-width: 360px;
    min-height: 200px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    resize: both;
    user-select: none;
}

.gpucat-inspector * {
    box-sizing: border-box;
}

/* ---- CSS variables ---- */
.gpucat-inspector {
    --gc-bg: #1a1a1a;
    --gc-bg-panel: #222;
    --gc-bg-hover: #2a2a2a;
    --gc-bg-active: #333;
    --gc-border: #383838;
    --gc-text-primary: #e0e0e0;
    --gc-text-secondary: #888;
    --gc-text-muted: #555;
    --gc-accent: #4a9eff;
    --gc-accent-dim: #2a5a99;
    --gc-color-green: #4caf50;
    --gc-color-yellow: #ffc107;
    --gc-color-red: #f44336;
    --gc-color-orange: #ff9800;
    --gc-color-purple: #9c27b0;
    --gc-color-cyan: #00bcd4;
}

/* ---- Titlebar / drag handle ---- */
.gc-titlebar {
    display: flex;
    align-items: center;
    padding: 6px 10px;
    background: var(--gc-bg-panel);
    border-bottom: 1px solid var(--gc-border);
    cursor: grab;
    flex-shrink: 0;
    gap: 8px;
}

.gc-titlebar:active { cursor: grabbing; }

.gc-title {
    flex: 1;
    font-weight: bold;
    font-size: 11px;
    color: var(--gc-text-secondary);
    letter-spacing: 0.05em;
    text-transform: uppercase;
}

.gc-titlebar-btn {
    background: none;
    border: 1px solid var(--gc-border);
    border-radius: 3px;
    color: var(--gc-text-secondary);
    cursor: pointer;
    font-size: 11px;
    padding: 2px 6px;
    line-height: 1;
}

.gc-titlebar-btn:hover {
    background: var(--gc-bg-active);
    color: var(--gc-text-primary);
}

/* ---- Tab bar ---- */
.gc-tabs {
    display: flex;
    background: var(--gc-bg-panel);
    border-bottom: 1px solid var(--gc-border);
    overflow-x: auto;
    flex-shrink: 0;
}

.gc-tab {
    padding: 6px 12px;
    cursor: pointer;
    white-space: nowrap;
    color: var(--gc-text-secondary);
    border-bottom: 2px solid transparent;
    font-size: 11px;
    transition: color 0.1s;
}

.gc-tab:hover { color: var(--gc-text-primary); }
.gc-tab.active {
    color: var(--gc-accent);
    border-bottom-color: var(--gc-accent);
}

/* ---- Tab content pane ---- */
.gc-tab-content {
    display: none;
    flex: 1;
    overflow: auto;
    min-height: 0;
}

.gc-tab-content.active { display: flex; flex-direction: column; }

/* ---- List / Item tree ---- */
.gc-list {
    width: 100%;
    padding: 4px 0;
}

.gc-list-header {
    display: grid;
    padding: 4px 8px;
    font-size: 10px;
    color: var(--gc-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--gc-border);
    background: var(--gc-bg-panel);
    position: sticky;
    top: 0;
    z-index: 1;
}

.gc-item {
    padding: 0;
}

.gc-item-row {
    display: grid;
    padding: 3px 8px;
    cursor: pointer;
    align-items: center;
    min-height: 24px;
}

.gc-item-row:hover { background: var(--gc-bg-hover); }
.gc-item-row.selected { background: var(--gc-bg-active); }

.gc-item-label {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--gc-text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.gc-item-toggle {
    width: 12px;
    flex-shrink: 0;
    color: var(--gc-text-muted);
    font-size: 10px;
    text-align: center;
}

.gc-item-children {
    padding-left: 16px;
    display: none;
}

.gc-item.expanded > .gc-item-children { display: block; }

.gc-item-value {
    color: var(--gc-text-secondary);
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
}

.gc-item-value.good  { color: var(--gc-color-green); }
.gc-item-value.warn  { color: var(--gc-color-yellow); }
.gc-item-value.bad   { color: var(--gc-color-red); }

/* ---- Graph (SVG rolling line) ---- */
.gc-graph {
    display: block;
    width: 100%;
    height: 60px;
    background: var(--gc-bg);
    border: 1px solid var(--gc-border);
    border-radius: 3px;
    overflow: hidden;
}

.gc-graph-line { fill: none; stroke-width: 1.5; }
.gc-graph-fill { stroke: none; opacity: 0.15; }

/* ---- Performance tab ---- */
.gc-perf-section {
    padding: 8px;
    border-bottom: 1px solid var(--gc-border);
}

.gc-perf-section-title {
    font-size: 10px;
    color: var(--gc-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
}

.gc-stat-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 2px 0;
    font-size: 11px;
}

.gc-stat-label { color: var(--gc-text-secondary); }
.gc-stat-value {
    color: var(--gc-text-primary);
    font-variant-numeric: tabular-nums;
    font-weight: 500;
}

/* ---- Memory tab ---- */
.gc-memory-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    padding: 8px;
}

.gc-memory-card {
    background: var(--gc-bg-panel);
    border: 1px solid var(--gc-border);
    border-radius: 4px;
    padding: 8px;
}

.gc-memory-card-title {
    font-size: 10px;
    color: var(--gc-text-muted);
    text-transform: uppercase;
    margin-bottom: 6px;
}

.gc-memory-card-value {
    font-size: 18px;
    font-weight: bold;
    color: var(--gc-accent);
    font-variant-numeric: tabular-nums;
}

.gc-memory-card-sub {
    font-size: 10px;
    color: var(--gc-text-secondary);
    margin-top: 2px;
}

/* ---- Timeline tab ---- */
.gc-timeline {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.gc-timeline-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--gc-border);
    background: var(--gc-bg-panel);
    flex-shrink: 0;
}

.gc-timeline-btn {
    background: var(--gc-bg-active);
    border: 1px solid var(--gc-border);
    border-radius: 3px;
    color: var(--gc-text-primary);
    cursor: pointer;
    font-size: 11px;
    padding: 3px 10px;
    font-family: inherit;
}

.gc-timeline-btn:hover { background: var(--gc-accent-dim); border-color: var(--gc-accent); }
.gc-timeline-btn.recording { color: var(--gc-color-red); border-color: var(--gc-color-red); }

.gc-timeline-track {
    flex: 1;
    overflow: auto;
    padding: 8px;
}

.gc-timeline-frame {
    display: flex;
    align-items: stretch;
    min-height: 24px;
    margin-bottom: 2px;
    cursor: pointer;
    border-radius: 3px;
    overflow: hidden;
    border: 1px solid transparent;
}

.gc-timeline-frame:hover { border-color: var(--gc-border); }
.gc-timeline-frame.selected { border-color: var(--gc-accent); }

.gc-timeline-frame-label {
    font-size: 10px;
    color: var(--gc-text-secondary);
    width: 50px;
    padding: 4px 6px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    background: var(--gc-bg-panel);
}

.gc-timeline-bars {
    flex: 1;
    display: flex;
    align-items: stretch;
    gap: 1px;
    background: var(--gc-bg);
    overflow: hidden;
}

.gc-timeline-bar {
    height: 100%;
    min-width: 2px;
    border-radius: 1px;
    opacity: 0.85;
}

.gc-timeline-bar.render  { background: var(--gc-accent); }
.gc-timeline-bar.compute { background: var(--gc-color-purple); }

.gc-timeline-detail {
    padding: 8px;
    border-top: 1px solid var(--gc-border);
    background: var(--gc-bg-panel);
    font-size: 11px;
    max-height: 120px;
    overflow-y: auto;
    flex-shrink: 0;
}

/* ---- Parameters tab ---- */
.gc-params {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.gc-param-group {
    border: 1px solid var(--gc-border);
    border-radius: 4px;
    overflow: hidden;
}

.gc-param-group-title {
    padding: 5px 8px;
    background: var(--gc-bg-panel);
    font-size: 10px;
    color: var(--gc-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.gc-param-group-title:hover { background: var(--gc-bg-active); }

.gc-param-row {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 8px;
    padding: 4px 8px;
    align-items: center;
    border-top: 1px solid var(--gc-border);
}

.gc-param-row:first-child { border-top: none; }

.gc-param-label {
    color: var(--gc-text-secondary);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.gc-param-control { display: flex; align-items: center; gap: 4px; }

.gc-input {
    background: var(--gc-bg);
    border: 1px solid var(--gc-border);
    border-radius: 3px;
    color: var(--gc-text-primary);
    font-family: inherit;
    font-size: 11px;
    padding: 2px 6px;
    width: 100%;
    outline: none;
}

.gc-input:focus { border-color: var(--gc-accent); }

.gc-slider {
    flex: 1;
    accent-color: var(--gc-accent);
    cursor: pointer;
}

.gc-checkbox {
    accent-color: var(--gc-accent);
    cursor: pointer;
    width: 14px;
    height: 14px;
}

.gc-select {
    background: var(--gc-bg);
    border: 1px solid var(--gc-border);
    border-radius: 3px;
    color: var(--gc-text-primary);
    font-family: inherit;
    font-size: 11px;
    padding: 2px 4px;
    cursor: pointer;
    outline: none;
    flex: 1;
}

.gc-color-input {
    width: 30px;
    height: 22px;
    border: 1px solid var(--gc-border);
    border-radius: 3px;
    cursor: pointer;
    padding: 1px;
    background: none;
}

.gc-button {
    background: var(--gc-bg-active);
    border: 1px solid var(--gc-border);
    border-radius: 3px;
    color: var(--gc-text-primary);
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    padding: 3px 10px;
    width: 100%;
}

.gc-button:hover { background: var(--gc-accent-dim); border-color: var(--gc-accent); }

/* ---- Console tab ---- */
.gc-console-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--gc-border);
    background: var(--gc-bg-panel);
    flex-shrink: 0;
}

.gc-console-filter {
    flex: 1;
    background: var(--gc-bg);
    border: 1px solid var(--gc-border);
    border-radius: 3px;
    color: var(--gc-text-primary);
    font-family: inherit;
    font-size: 11px;
    padding: 3px 6px;
    outline: none;
}

.gc-console-filter:focus { border-color: var(--gc-accent); }

.gc-console-body {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
    font-size: 11px;
}

.gc-console-msg {
    padding: 3px 10px;
    border-bottom: 1px solid var(--gc-border);
    word-break: break-all;
    line-height: 1.5;
}

.gc-console-msg.info  { color: var(--gc-text-primary); }
.gc-console-msg.warn  { color: var(--gc-color-yellow); background: rgba(255,193,7,0.05); }
.gc-console-msg.error { color: var(--gc-color-red); background: rgba(244,67,54,0.05); }
.gc-console-msg.hidden { display: none; }

/* ---- Viewer tab ---- */
.gc-viewer {
    padding: 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    overflow-y: auto;
    align-content: flex-start;
}

.gc-viewer-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
}

.gc-viewer-canvas {
    width: 140px;
    height: 140px;
    border: 1px solid var(--gc-border);
    border-radius: 3px;
    display: block;
    background: #000;
}

.gc-viewer-label {
    font-size: 10px;
    color: var(--gc-text-secondary);
    text-align: center;
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* ---- Settings tab ---- */
.gc-settings {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.gc-settings-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 0;
    border-bottom: 1px solid var(--gc-border);
}

.gc-settings-label {
    font-size: 11px;
    color: var(--gc-text-secondary);
}

/* ---- Detached window ---- */
.gpucat-inspector.detached {
    position: fixed;
    top: 40px;
    left: 40px;
}

/* ---- Scrollbars ---- */
.gpucat-inspector ::-webkit-scrollbar { width: 6px; height: 6px; }
.gpucat-inspector ::-webkit-scrollbar-track { background: var(--gc-bg); }
.gpucat-inspector ::-webkit-scrollbar-thumb { background: var(--gc-border); border-radius: 3px; }
.gpucat-inspector ::-webkit-scrollbar-thumb:hover { background: var(--gc-text-muted); }

/* ---- list-scroll-wrapper ---- */
.list-scroll-wrapper {
    flex: 1;
    overflow: auto;
    min-height: 0;
}
`;
