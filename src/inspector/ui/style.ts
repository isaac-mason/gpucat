/**
 * style.ts, Injects the inspector CSS into the document once.
 * CSS targets the actual class/id names emitted by profiler.ts, tab.ts,
 * list.ts, item.ts, graph.ts, values.ts and the tab files.
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
   gpucat Inspector, CSS variables (scoped to profiler shell)
   ============================================================ */

#profiler-shell,
.detached-tab-panel {
	--background-color: #1a1a1a;
	--panel-bg: #1e1e1e;
	--header-bg: #252525;
	--border-color: #383838;
	--text-primary: #e0e0e0;
	--text-secondary: #888;
	--text-muted: #555;
	--accent-color: #4a9eff;
	--accent-dim: #1e3d6e;
	--color-fps: rgba(74, 158, 255, 0.7);
	--color-call: rgba(156, 39, 176, 0.7);
	--color-green: #4caf50;
	--color-yellow: #ffc107;
	--color-red: #f44336;
	--color-orange: #ff9800;
	/* shape + density tokens (single source of truth for the reskin) */
	--radius: 0px;          /* roundedness off; bump to 2px to soften */
	--space-1: 2px;
	--space-2: 4px;
	--space-3: 8px;
	--font-size: 11px;
	--font-size-sm: 10px;
	--control-h: 20px;      /* rows, inputs, buttons */
	--header-h: 24px;       /* tab bar / title / toggle pill */
	font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
	font-size: var(--font-size);
	color: var(--text-primary);
	box-sizing: border-box;
}

#profiler-shell *,
.detached-tab-panel * {
	box-sizing: border-box;
}

/* ============================================================
   Toggle button (the FPS pill that floats in the corner)
   ============================================================ */

#profiler-toggle {
	position: fixed;
	bottom: 0;
	left: 0;
	z-index: 1001;
	display: flex;
	align-items: center;
	gap: 6px;
	padding: var(--space-2) var(--space-3);
	background: var(--header-bg);
	border: 1px solid var(--border-color);
	border-bottom: none;
	border-radius: var(--radius);
	color: var(--text-primary);
	cursor: pointer;
	font-family: inherit;
	font-size: var(--font-size);
	line-height: 1;
	user-select: none;
	white-space: nowrap;
	min-height: var(--header-h);
}

#profiler-toggle:hover {
	background: #2a2a2a;
}

#profiler-toggle.position-right {
	bottom: auto;
	top: 0;
	left: auto;
	right: 0;
	border-radius: var(--radius);
	border-bottom: 1px solid var(--border-color);
	border-right: none;
}

#fps-counter {
	font-variant-numeric: tabular-nums;
	font-weight: bold;
	color: var(--accent-color);
	min-width: 2ch;
	text-align: right;
}

.fps-label {
	font-size: var(--font-size-sm);
	color: var(--text-muted);
	text-transform: uppercase;
}

#toggle-icon svg {
	display: block;
	opacity: 0.6;
}

#toggle-text {
	display: flex;
	align-items: center;
	gap: 3px;
}

/* Builtin tabs container inside the toggle button */
#builtin-tabs-container {
	display: flex;
	align-items: center;
	gap: 2px;
}

.builtin-tab-btn {
	background: none;
	border: 1px solid transparent;
	border-radius: var(--radius);
	color: var(--text-secondary);
	cursor: pointer;
	padding: 3px 5px;
	font-size: var(--font-size);
	line-height: 1;
	font-family: inherit;
	display: flex;
	align-items: center;
}

.builtin-tab-btn:hover {
	background: rgba(255,255,255,0.08);
	color: var(--text-primary);
}

.builtin-tab-btn.active {
	border-color: var(--accent-color);
	color: var(--accent-color);
}

/* ============================================================
   Mini panel (builtin tab popover above the toggle button)
   ============================================================ */

#profiler-mini-panel {
	position: fixed;
	bottom: 28px;
	left: 0;
	z-index: 1000;
	background: var(--panel-bg);
	border: 1px solid var(--border-color);
	border-radius: var(--radius);
	min-width: 300px;
	max-width: 420px;
	max-height: 80vh;
	display: none;
	overflow: hidden;
	flex-direction: column;
	box-shadow: 0 -4px 16px rgba(0,0,0,0.4);
}

#profiler-mini-panel.visible {
	display: flex;
}

#profiler-mini-panel.position-right {
	bottom: auto;
	top: 32px;
	left: auto;
	right: 0;
	border-radius: var(--radius);
	box-shadow: 0 4px 16px rgba(0,0,0,0.4);
}

#profiler-mini-panel.panel-open {
	/* keep visible when main panel is open too */
}

.mini-panel-content {
	flex: 1;
	overflow: auto;
	min-height: 0;
}

/* ============================================================
   Main panel
   ============================================================ */

#profiler-panel {
	position: fixed;
	bottom: 0;
	left: 0;
	width: 100%;
	height: 350px;
	z-index: 1000;
	background: var(--panel-bg);
	border-top: 1px solid var(--border-color);
	display: none;
	flex-direction: column;
	overflow: hidden;
	transition: height 0.15s ease, width 0.15s ease;
}

#profiler-panel.visible {
	display: flex;
}

#profiler-panel.position-right {
	bottom: auto;
	top: 0;
	left: auto;
	right: 0;
	width: 450px;
	height: 100%;
	border-top: none;
	border-left: 1px solid var(--border-color);
}

#profiler-panel.position-bottom {
	bottom: 0;
	top: auto;
	left: 0;
	right: auto;
	width: 100%;
	border-top: 1px solid var(--border-color);
	border-left: none;
}

/* Maximized state */
#profiler-panel.maximized {
	transition: none;
}

/* No tabs, shrink panel to header only */
#profiler-panel.no-tabs .profiler-content-wrapper {
	display: none;
}

/* ============================================================
   Panel resizer handle
   ============================================================ */

.panel-resizer {
	position: absolute;
	background: transparent;
	z-index: 10;
}

#profiler-panel.position-bottom .panel-resizer {
	top: 0;
	left: 0;
	right: 0;
	height: 4px;
	cursor: ns-resize;
}

#profiler-panel.position-right .panel-resizer {
	top: 0;
	left: 0;
	bottom: 0;
	width: 4px;
	cursor: ew-resize;
}

.panel-resizer:hover {
	background: rgba(74, 158, 255, 0.3);
}

/* ============================================================
   Panel header (tab bar + controls)
   ============================================================ */

.profiler-header {
	display: flex;
	align-items: stretch;
	background: var(--header-bg);
	border-bottom: 1px solid var(--border-color);
	flex-shrink: 0;
	overflow: hidden;
	min-height: var(--header-h);
}

.profiler-tabs {
	display: flex;
	align-items: stretch;
	overflow-x: auto;
	overflow-y: hidden;
	flex: 1;
	gap: 0;
	scrollbar-width: none;
}

.profiler-tabs::-webkit-scrollbar {
	display: none;
}

.tab-btn {
	padding: 0 var(--space-3);
	background: none;
	border: none;
	border-bottom: 2px solid transparent;
	color: var(--text-secondary);
	cursor: grab;
	font-family: inherit;
	font-size: var(--font-size);
	white-space: nowrap;
	user-select: none;
	flex-shrink: 0;
	display: flex;
	align-items: center;
	transition: color 0.1s;
	min-height: var(--header-h);
}

.tab-btn:hover {
	color: var(--text-primary);
	background: rgba(255,255,255,0.04);
}

.tab-btn.active {
	color: var(--accent-color);
	border-bottom-color: var(--accent-color);
}

.tab-btn.no-detach {
	cursor: default;
}

.profiler-controls {
	display: flex;
	align-items: center;
	gap: 2px;
	padding: 0 6px;
	flex-shrink: 0;
}

.profiler-controls button {
	background: none;
	border: 1px solid transparent;
	border-radius: var(--radius);
	color: var(--text-secondary);
	cursor: pointer;
	padding: 3px 6px;
	font-size: var(--font-size);
	line-height: 1;
	font-family: inherit;
	display: flex;
	align-items: center;
	min-height: var(--control-h);
}

.profiler-controls button:hover {
	background: rgba(255,255,255,0.08);
	color: var(--text-primary);
	border-color: var(--border-color);
}

#floating-btn.active {
	color: var(--accent-color);
}

/* ============================================================
   Content wrapper + tab content panes
   ============================================================ */

.profiler-content-wrapper {
	flex: 1;
	position: relative;
	display: flex;
	flex-direction: column;
	min-height: 0;
}

.profiler-content {
	display: none;
	flex-direction: column;
	width: 100%;
	height: 100%;
	position: absolute;
	top: 0; left: 0; right: 0; bottom: 0;
}

.profiler-content.active {
	display: flex;
}

/* ============================================================
   Detached tab windows
   ============================================================ */

.detached-tab-panel {
	position: fixed;
	width: 400px;
	height: 300px;
	background: var(--panel-bg);
	border: 1px solid var(--border-color);
	border-radius: var(--radius);
	box-shadow: 0 8px 32px rgba(0,0,0,0.5);
	display: flex;
	flex-direction: column;
	overflow: hidden;
	z-index: 1002;
}

.detached-tab-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 6px 8px;
	background: var(--header-bg);
	border-bottom: 1px solid var(--border-color);
	cursor: grab;
	flex-shrink: 0;
	user-select: none;
	font-size: var(--font-size);
	color: var(--text-primary);
	min-height: var(--header-h);
}

.detached-tab-header:active {
	cursor: grabbing;
}

.detached-header-controls {
	display: flex;
	align-items: center;
	gap: 4px;
}

.detached-reattach-btn {
	background: none;
	border: 1px solid var(--border-color);
	border-radius: var(--radius);
	color: var(--text-secondary);
	cursor: pointer;
	padding: 2px 6px;
	font-size: var(--font-size);
	line-height: 1;
}

.detached-reattach-btn:hover {
	background: rgba(255,255,255,0.08);
	color: var(--text-primary);
}

.detached-tab-content {
	flex: 1;
	overflow: hidden;
	display: flex;
	flex-direction: column;
	min-height: 0;
	position: relative;
}

.detached-tab-content .profiler-content {
	position: relative;
	top: auto; left: auto; right: auto; bottom: auto;
	flex: 1;
	min-height: 0;
}

/* Detached resizer handles */
.detached-tab-resizer {
	position: absolute;
	bottom: 0;
	right: 0;
	width: 12px;
	height: 12px;
	cursor: se-resize;
	z-index: 5;
}

.detached-tab-resizer::after {
	content: '';
	position: absolute;
	bottom: 2px;
	right: 2px;
	width: 8px;
	height: 8px;
	border-right: 2px solid var(--border-color);
	border-bottom: 2px solid var(--border-color);
}

.detached-tab-resizer-top    { position:absolute; top:0; left:4px; right:4px; height:4px; cursor:n-resize; z-index:5; }
.detached-tab-resizer-bottom { position:absolute; bottom:0; left:4px; right:4px; height:4px; cursor:s-resize; z-index:5; }
.detached-tab-resizer-left   { position:absolute; left:0; top:4px; bottom:4px; width:4px; cursor:w-resize; z-index:5; }
.detached-tab-resizer-right  { position:absolute; right:0; top:4px; bottom:4px; width:4px; cursor:e-resize; z-index:5; }

.detached-tab-resizer-top:hover,
.detached-tab-resizer-bottom:hover,
.detached-tab-resizer-left:hover,
.detached-tab-resizer-right:hover {
	background: rgba(74, 158, 255, 0.25);
}

/* ============================================================
   List component  (.list-container, .list-header, .list-header-cell)
   ============================================================ */

.list-container {
	width: 100%;
	min-width: 0;
}

.list-header {
	display: grid;
	padding: 5px 8px;
	font-size: var(--font-size-sm);
	color: var(--text-muted);
	text-transform: uppercase;
	letter-spacing: 0.05em;
	border-bottom: 1px solid var(--border-color);
	background: var(--header-bg);
	position: sticky;
	top: 0;
	z-index: 1;
}

.list-header-cell {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

/* ============================================================
   Item component
   ============================================================ */

.list-item-wrapper {
	width: 100%;
}

.list-item-row {
	display: grid;
	padding: 3px 8px;
	cursor: default;
	align-items: center;
	min-height: var(--control-h);
}

.list-item-row:hover {
	background: rgba(255,255,255,0.04);
}

.list-item-row.collapsible {
	cursor: pointer;
}

.list-item-row.actionable {
	cursor: pointer;
}

.list-item-row.no-hover:hover {
	background: none;
}

.list-item-cell {
	display: flex;
	align-items: center;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	gap: 4px;
	color: var(--text-primary);
	font-size: var(--font-size);
}

.list-item-cell:not(:first-child) {
	color: var(--text-secondary);
	justify-content: flex-end;
}

/* Section separator (first item in list / group header) */
.list-item-wrapper.header-wrapper > .list-item-row {
	background: var(--header-bg);
	color: var(--text-secondary);
	font-size: var(--font-size);
	border-top: 1px solid var(--border-color);
}

.list-item-wrapper.section-start > .list-item-row {
	border-top: 1px solid var(--border-color);
}

/* Collapse toggler arrow */
.item-toggler {
	display: inline-block;
	width: 14px;
	flex-shrink: 0;
	font-size: var(--font-size-sm);
	color: var(--text-muted);
	text-align: center;
}

.item-toggler::before {
	content: '▶';
}

.list-item-row.open .item-toggler::before {
	content: '▼';
}

/* Children container */
.list-children-container {
	overflow: hidden;
}

.list-children-container.closed {
	display: none;
}

/* Children indented slightly */
.list-children-container .list-item-row {
	padding-left: 24px;
}

.list-children-container .list-children-container .list-item-row {
	padding-left: 40px;
}

.list-children-container .list-children-container .list-children-container .list-item-row {
	padding-left: 56px;
}

/* ============================================================
   Scrollable wrapper inside tab content
   ============================================================ */

.list-scroll-wrapper {
	flex: 1;
	overflow: auto;
	min-height: 0;
	min-width: 0;
}

/* ============================================================
   Graph (SVG rolling chart)
   ============================================================ */

.graph-container {
	width: 100%;
	height: 60px;
	min-height: 60px;
	flex-shrink: 0;
	background: var(--background-color);
	border-bottom: 1px solid var(--border-color);
	display: block;
	position: relative;
}

.graph-svg {
	display: block;
	width: 100%;
	height: 100%;
	position: absolute;
	top: 0;
	left: 0;
}

.graph-path {
	fill-opacity: 0.2;
	stroke-width: 1.5;
}

/* ============================================================
   Value widgets (param-control, custom-checkbox, etc.)
   ============================================================ */

.param-control {
	display: flex;
	align-items: center;
	gap: 4px;
	width: 100%;
}

.param-control input[type="number"] {
	background: #111;
	border: 1px solid var(--border-color);
	border-radius: var(--radius);
	color: var(--text-primary);
	font-family: inherit;
	font-size: var(--font-size);
	padding: 2px 4px;
	width: 80px;
	outline: none;
	text-align: right;
}

.param-control input[type="number"]:focus {
	border-color: var(--accent-color);
}

.param-control input[type="range"] {
	flex: 1;
	accent-color: var(--accent-color);
	cursor: pointer;
	min-width: 0;
}

.param-control select {
	background: #111;
	border: 1px solid var(--border-color);
	border-radius: var(--radius);
	color: var(--text-primary);
	font-family: inherit;
	font-size: var(--font-size);
	padding: 2px 4px;
	cursor: pointer;
	outline: none;
	flex: 1;
}

.param-control input[type="color"] {
	width: 30px;
	height: var(--control-h);
	border: 1px solid var(--border-color);
	border-radius: var(--radius);
	cursor: pointer;
	padding: 1px;
	background: none;
}

.param-control button {
	background: rgba(255,255,255,0.07);
	border: 1px solid var(--border-color);
	border-radius: var(--radius);
	color: var(--text-primary);
	cursor: pointer;
	font-family: inherit;
	font-size: var(--font-size);
	padding: var(--space-1) var(--space-3);
	width: 100%;
}

.param-control button:hover {
	background: var(--accent-dim);
	border-color: var(--accent-color);
}

/* Custom checkbox */
.custom-checkbox {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	cursor: pointer;
	user-select: none;
	font-size: var(--font-size);
}

.custom-checkbox input[type="checkbox"] {
	display: none;
}

.checkmark {
	display: inline-block;
	width: 14px;
	height: 14px;
	border: 1px solid var(--border-color);
	border-radius: var(--radius);
	background: #111;
	flex-shrink: 0;
	position: relative;
}

.custom-checkbox input[type="checkbox"]:checked + .checkmark {
	background: var(--accent-color);
	border-color: var(--accent-color);
}

.custom-checkbox input[type="checkbox"]:checked + .checkmark::after {
	content: '';
	position: absolute;
	left: 4px;
	top: 1px;
	width: 4px;
	height: 8px;
	border: 2px solid #fff;
	border-top: none;
	border-left: none;
	transform: rotate(45deg);
}

/* .value span (stat value text) */
.value {
	font-variant-numeric: tabular-nums;
	color: var(--text-secondary);
}

/* ============================================================
   Console tab
   ============================================================ */

.console-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 5px 8px;
	background: var(--header-bg);
	border-bottom: 1px solid var(--border-color);
	flex-shrink: 0;
	gap: 6px;
}

.console-filter-input {
	flex: 1;
	background: #111;
	border: 1px solid var(--border-color);
	border-radius: var(--radius);
	color: var(--text-primary);
	font-family: inherit;
	font-size: var(--font-size);
	padding: 3px 6px;
	outline: none;
}

.console-filter-input:focus {
	border-color: var(--accent-color);
}

.console-buttons-group {
	display: flex;
	align-items: center;
	gap: 4px;
}

.console-copy-button {
	background: rgba(255,255,255,0.06);
	border: 1px solid var(--border-color);
	border-radius: var(--radius);
	color: var(--text-secondary);
	cursor: pointer;
	padding: 3px 6px;
	font-size: var(--font-size);
	font-family: inherit;
	display: flex;
	align-items: center;
	gap: 4px;
}

.console-copy-button:hover {
	background: rgba(255,255,255,0.1);
	color: var(--text-primary);
}

.console-copy-button.copied {
	color: var(--color-green);
	border-color: var(--color-green);
}

#console-log {
	flex: 1;
	overflow-y: auto;
	padding: 4px 0;
}

.log-message {
	padding: var(--space-2) var(--space-3);
	border-bottom: 1px solid rgba(255,255,255,0.04);
	word-break: break-all;
	line-height: 1.5;
	font-size: var(--font-size);
	color: var(--text-primary);
}

.log-message.warn {
	color: var(--color-yellow);
	background: rgba(255,193,7,0.05);
}

.log-message.error {
	color: var(--color-red);
	background: rgba(244,67,54,0.05);
}

.log-message.hidden {
	display: none;
}

.log-prefix {
	font-weight: bold;
	opacity: 0.8;
}

.log-code {
	font-family: inherit;
	background: rgba(255,255,255,0.08);
	border-radius: var(--radius);
	padding: 0 3px;
	font-size: var(--font-size);
}

/* ============================================================
   Parameters tab, .parameters class on list-container
   ============================================================ */

.parameters .list-item-row {
	grid-template-columns: .5fr 1fr;
}

/* ============================================================
   Scrollbars (inside panels)
   ============================================================ */

#profiler-panel ::-webkit-scrollbar,
.detached-tab-panel ::-webkit-scrollbar,
#profiler-mini-panel ::-webkit-scrollbar {
	width: 6px;
	height: 6px;
}

#profiler-panel ::-webkit-scrollbar-track,
.detached-tab-panel ::-webkit-scrollbar-track,
#profiler-mini-panel ::-webkit-scrollbar-track {
	background: transparent;
}

#profiler-panel ::-webkit-scrollbar-thumb,
.detached-tab-panel ::-webkit-scrollbar-thumb,
#profiler-mini-panel ::-webkit-scrollbar-thumb {
	background: var(--border-color);
	border-radius: var(--radius);
}

#profiler-panel ::-webkit-scrollbar-thumb:hover,
.detached-tab-panel ::-webkit-scrollbar-thumb:hover {
	background: var(--text-muted);
}

/* ============================================================
   Timeline tab layout
   ============================================================ */

.timeline-body {
	display: flex;
	flex-direction: column;
	flex: 1;
	min-height: 0;
	width: 100%;
}

.timeline-graph-slider {
	height: 100%;
	width: 100%;
	position: relative;
	cursor: crosshair;
	outline: none;
}

.timeline-hover-indicator {
	position: absolute;
	top: 0;
	bottom: 0;
	width: 1px;
	background: rgba(255,255,255,0.3);
	pointer-events: none;
	display: none;
	z-index: 9;
	transform: translateX(-50%);
}

.timeline-playhead {
	position: absolute;
	top: 0;
	bottom: 0;
	width: 2px;
	background: var(--color-red);
	box-shadow: 0 0 4px rgba(255,0,0,0.5);
	pointer-events: none;
	display: none;
	z-index: 10;
	transform: translateX(-50%);
}

.timeline-playhead-handle {
	position: absolute;
	top: 0;
	left: 50%;
	transform: translate(-50%, 0);
	width: 0;
	height: 0;
	border-left: 6px solid transparent;
	border-right: 6px solid transparent;
	border-top: 8px solid var(--color-red);
}

.timeline-main-area {
	flex: 1;
	display: flex;
	flex-direction: column;
	overflow: hidden;
	min-height: 0;
}

.timeline-track {
	flex: 1;
	overflow-y: auto;
	padding: 6px;
	background: var(--background-color);
}

.timeline-empty-hint {
	display: flex;
	align-items: center;
	justify-content: center;
	height: 100%;
	color: var(--text-muted);
	font-size: var(--font-size);
	text-align: center;
	padding: var(--space-3);
}

/* ============================================================
   Scene Hierarchy tab, type badges + selection highlight
   ============================================================ */

.hierarchy-type-badge {
	display: inline-block;
	font-size: var(--font-size-sm);
	font-weight: 600;
	letter-spacing: 0.04em;
	padding: 1px 5px;
	border-radius: var(--radius);
	white-space: nowrap;
	text-transform: uppercase;
	background: rgba(255,255,255,0.07);
	color: var(--text-muted);
}

.hierarchy-type-badge--mesh {
	background: rgba(74,158,255,0.15);
	color: var(--accent-color);
}

.hierarchy-type-badge--scene {
	background: rgba(76,175,80,0.15);
	color: var(--color-green);
}

.hierarchy-type-badge--object3d {
	background: rgba(255,152,0,0.12);
	color: var(--color-orange);
}

.list-item-row.hierarchy-selected {
	background: rgba(74,158,255,0.12);
}

.list-item-row.hierarchy-selected:hover {
	background: rgba(74,158,255,0.18);
}

/* ============================================================
   Scene hierarchy, row layout
   ============================================================ */

.scene-hierarchy-layout {
	display: flex;
	flex-direction: row;
	width: 100%;
	height: 100%;
	min-height: 0;
	overflow: hidden;
}

.scene-hierarchy-list {
	flex-shrink: 0;
	width: 220px;
	min-width: 160px;
	border-right: 1px solid var(--border-color);
	overflow-y: auto;
	overflow-x: hidden;
}

/* ============================================================
   Shader panel, right-side WGSL viewer
   ============================================================ */

.shader-container {
	flex: 1;
	display: flex;
	flex-direction: column;
	border-left: none;
	min-width: 0;
	overflow: hidden;
}

.mesh-detail-panel {
	overflow-y: auto;
}

.shader-panel {
	display: flex;
	flex-direction: column;
	height: 100%;
	min-height: 0;
	background: var(--background-color);
}

.shader-toolbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 4px 8px;
	background: var(--header-bg);
	border-bottom: 1px solid var(--border-color);
	flex-shrink: 0;
	gap: 6px;
}

.shader-stage-group {
	display: flex;
	align-items: center;
	gap: 2px;
}

.shader-stage-btn {
	background: none;
	border: 1px solid transparent;
	border-radius: var(--radius);
	color: var(--text-secondary);
	cursor: pointer;
	font-family: inherit;
	font-size: var(--font-size);
	padding: 3px 8px;
	line-height: 1;
	transition: color 0.1s;
}

.shader-stage-btn:hover {
	background: rgba(255,255,255,0.06);
	color: var(--text-primary);
}

.shader-stage-btn.active {
	border-color: var(--accent-color);
	color: var(--accent-color);
}

.shader-copy-btn {
	margin-left: auto;
}

.shader-code-scroll {
	flex: 1;
	overflow: auto;
	min-height: 0;
	min-width: 0;
}

pre.shader-code {
	margin: 0;
	padding: var(--space-2) var(--space-3);
	font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
	font-size: var(--font-size);
	line-height: 1.55;
	white-space: pre;
	color: var(--text-primary);
	background: var(--background-color);
	tab-size: 4;
	/* NOT overflow:auto here, scroll is on the wrapper so Chrome doesn't
	   intercept click-drag as a scroll gesture, blocking text selection */
	overflow: visible;
	user-select: text;
	-webkit-user-select: text;
	cursor: text;
}

/* WGSL syntax highlight spans */
.wgsl-keyword  { color: #c792ea; }
.wgsl-type     { color: #82aaff; }
.wgsl-builtin  { color: #89ddff; }
.wgsl-comment  { color: #546e7a; font-style: italic; }
.wgsl-number   { color: #f78c6c; }
.wgsl-attribute { color: #c3e88d; }

/* ============================================================
   Shader probe, hoverable lines + floating popover
   ============================================================ */

.shader-line {
    display: block;
    white-space: pre;
    user-select: text;
    -webkit-user-select: text;
    cursor: text;
}

.shader-line:hover {
    background: rgba(255,255,255,0.05);
}

.probe-popover {
    position: fixed;
    z-index: 99999;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: var(--space-2) var(--space-3);
    background: var(--panel-bg, #1e1e1e);
    border: 1px solid var(--border-color, #383838);
    border-radius: var(--radius);
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    pointer-events: none;
    min-width: 160px;
    max-width: 180px;
}

.probe-popover-label {
    font-size: var(--font-size-sm);
    color: var(--text-muted, #666);
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.probe-popover-canvas canvas {
    border-radius: var(--radius);
    display: block;
}

/* ============================================================
   Draw Calls tab, detail panel, kv tables, nav link
   ============================================================ */

.dc-detail-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
}

.dc-detail-toolbar {
    display: flex;
    align-items: center;
    padding: 4px 8px;
    background: var(--header-bg);
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
    gap: 6px;
}

/* Sub-tab panes: hidden by default, flex-column when active */
.dc-detail-pane {
    display: none;
    flex: 1;
    flex-direction: column;
    overflow: auto;
    min-height: 0;
}

.dc-detail-pane.active {
    display: flex;
}

/* The ShaderPanel inside the Shader pane needs to fill height */
.dc-detail-pane .shader-panel {
    flex: 1;
    min-height: 0;
}

.dc-kv-table {
    width: 100%;
    padding: 8px;
    flex-shrink: 0;
}

.dc-kv-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    padding: 3px 0;
    border-bottom: 1px solid var(--border-color);
}

.dc-kv-key {
    color: var(--text-muted);
    font-size: var(--font-size);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.dc-kv-val {
    color: var(--text-primary);
    font-size: var(--font-size);
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.dc-section-header {
    padding: 6px 8px;
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: .05em;
    background: var(--header-bg);
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
}

.dc-nav-link {
    font-size: var(--font-size-sm);
    color: var(--accent-color);
    cursor: pointer;
    padding: 2px 6px;
    border: 1px solid var(--accent-dim);
    border-radius: var(--radius);
    background: none;
    font-family: inherit;
    flex-shrink: 0;
    margin-left: 6px;
    line-height: 1;
}

.dc-nav-link:hover {
    background: var(--accent-dim);
}

/* ============================================================
   GUI controller system (.gui-*, .gui-controller, etc.)
   ============================================================ */

.gui-parameters-container {
	padding: 4px 0;
}

.gui {
	font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
	font-size: var(--font-size);
	color: var(--text-primary);
	user-select: none;
	-webkit-user-select: none;
}

.gui-root {
	/* Root GUI when used standalone, no extra styles needed in inspector context */
}

.gui-title {
	display: flex;
	align-items: center;
	width: 100%;
	padding: 5px 8px;
	background: var(--header-bg);
	border: none;
	border-top: 1px solid var(--border-color);
	border-bottom: 1px solid var(--border-color);
	color: var(--text-secondary);
	cursor: pointer;
	font-family: inherit;
	font-size: var(--font-size);
	font-weight: normal;
	text-align: left;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	line-height: 1;
	min-height: var(--control-h);
}

.gui-title:hover {
	color: var(--text-primary);
	background: #2a2a2a;
}

/* Arrow indicator using aria-expanded */
.gui-title::before {
	content: '▶';
	display: inline-block;
	font-size: var(--font-size-sm);
	margin-right: 6px;
	color: var(--text-muted);
	transition: transform 0.15s ease;
}

.gui-title[aria-expanded="true"]::before {
	transform: rotate(90deg);
}

.gui-children {
	overflow: hidden;
}

/* Animated open/close */
.gui-transition .gui-children {
	transition: height 0.15s ease;
}

.gui-closed .gui-children {
	display: none;
}

.gui-transition.gui-closed .gui-children {
	display: block; /* keep block during animation so height transition works */
}

/* ── Controller rows ────────────────────────────────────── */

.gui-controller {
	display: grid;
	grid-template-columns: 0.5fr 1fr;
	align-items: center;
	padding: 3px 8px;
	min-height: var(--control-h);
	border-bottom: 1px solid rgba(56, 56, 56, 0.4);
}

.gui-controller:hover {
	background: rgba(255, 255, 255, 0.04);
}

.gui-controller.gui-disabled {
	opacity: 0.45;
	pointer-events: none;
}

/* BooleanController uses <label> as root, full row is clickable */
label.gui-controller {
	cursor: pointer;
}

.gui-name {
	color: var(--text-primary);
	font-size: var(--font-size);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	padding-right: 6px;
}

.gui-widget {
	display: flex;
	align-items: center;
	min-width: 0;
}

/* ── Number ─────────────────────────────────────────────── */

/* $input is type="text" (type="number" only on coarse pointer devices) */
.gui-number .gui-widget input {
	background: #111;
	border: 1px solid var(--border-color);
	border-radius: var(--radius);
	color: var(--text-primary);
	font-family: inherit;
	font-size: var(--font-size);
	padding: 2px 4px;
	width: 100%;
	outline: none;
	text-align: right;
}

.gui-number .gui-widget input:focus {
	border-color: var(--accent-color);
}

/* Slider layout: fill bar + number input side by side */
.gui-has-slider .gui-widget {
	gap: 6px;
}

.gui-slider {
	position: relative;
	flex: 1;
	height: var(--control-h);
	background: #111;
	border: 1px solid var(--border-color);
	border-radius: var(--radius);
	cursor: ew-resize;
	overflow: hidden;
}

.gui-fill {
	position: absolute;
	top: 0;
	left: 0;
	height: 100%;
	background: var(--accent-dim);
	pointer-events: none;
}

.gui-slider:hover .gui-fill {
	background: rgba(74, 158, 255, 0.35);
}

/* .gui-active is toggled on $slider during drag (not .gui-dragging) */
.gui-slider.gui-active {
	border-color: var(--accent-color);
}

.gui-has-slider .gui-widget input {
	flex-shrink: 0;
	width: 54px;
}

/* ── Boolean ────────────────────────────────────────────── */

.gui-boolean input[type="checkbox"] {
	display: none;
}

.gui-boolean .gui-checkmark {
	display: inline-block;
	width: 14px;
	height: 14px;
	border: 1px solid var(--border-color);
	border-radius: var(--radius);
	background: #111;
	flex-shrink: 0;
	position: relative;
}

.gui-boolean input[type="checkbox"]:checked + .gui-checkmark {
	background: var(--accent-color);
	border-color: var(--accent-color);
}

.gui-boolean input[type="checkbox"]:checked + .gui-checkmark::after {
	content: '';
	position: absolute;
	left: 4px;
	top: 1px;
	width: 4px;
	height: 8px;
	border: 2px solid #fff;
	border-top: none;
	border-left: none;
	transform: rotate(45deg);
}

/* ── String ─────────────────────────────────────────────── */

.gui-string input[type="text"] {
	background: #111;
	border: 1px solid var(--border-color);
	border-radius: var(--radius);
	color: var(--text-primary);
	font-family: inherit;
	font-size: var(--font-size);
	padding: 2px 4px;
	width: 100%;
	outline: none;
}

.gui-string input[type="text"]:focus {
	border-color: var(--accent-color);
}

/* ── Color ──────────────────────────────────────────────── */

.gui-color .gui-widget {
	gap: 5px;
}

.gui-color-display {
	width: 22px;
	height: 18px;
	border: 1px solid var(--border-color);
	border-radius: var(--radius);
	cursor: pointer;
	flex-shrink: 0;
	position: relative;
	overflow: hidden;
}

.gui-color-display input[type="color"] {
	position: absolute;
	top: -4px;
	left: -4px;
	width: calc(100% + 8px);
	height: calc(100% + 8px);
	border: none;
	padding: 0;
	cursor: pointer;
	opacity: 0;
}

.gui-color input[type="text"] {
	background: #111;
	border: 1px solid var(--border-color);
	border-radius: var(--radius);
	color: var(--text-primary);
	font-family: inherit;
	font-size: var(--font-size);
	padding: 2px 4px;
	flex: 1;
	min-width: 0;
	outline: none;
}

.gui-color input[type="text"]:focus {
	border-color: var(--accent-color);
}

/* ── Option / Select ────────────────────────────────────── */

.gui-option select {
	background: #111;
	border: 1px solid var(--border-color);
	border-radius: var(--radius);
	color: var(--text-primary);
	font-family: inherit;
	font-size: var(--font-size);
	padding: 2px 4px;
	cursor: pointer;
	outline: none;
	width: 100%;
}

/* ── Function / Button ──────────────────────────────────── */

.gui-function {
	grid-template-columns: 1fr;
}

.gui-function button {
	background: rgba(255, 255, 255, 0.07);
	border: 1px solid var(--border-color);
	border-radius: var(--radius);
	color: var(--text-primary);
	cursor: pointer;
	font-family: inherit;
	font-size: var(--font-size);
	padding: var(--space-2) var(--space-3);
	width: 100%;
	text-align: left;
}

.gui-function button:hover {
	background: var(--accent-dim);
	border-color: var(--accent-color);
}

/* Nested GUI folder inside another GUI */
.gui-children .gui {
	border-top: 1px solid var(--border-color);
}

.gui-children .gui .gui-title {
	padding-left: 16px;
	font-size: var(--font-size-sm);
}
`;


