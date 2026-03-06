/**
 * style.ts — Injects the inspector CSS into the document once.
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
   gpucat Inspector — CSS variables (scoped to profiler shell)
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
	font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
	font-size: 12px;
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
	padding: 4px 10px 4px 6px;
	background: var(--header-bg);
	border: 1px solid var(--border-color);
	border-bottom: none;
	border-radius: 6px 6px 0 0;
	color: var(--text-primary);
	cursor: pointer;
	font-family: inherit;
	font-size: 12px;
	line-height: 1;
	user-select: none;
	white-space: nowrap;
	min-height: 28px;
}

#profiler-toggle:hover {
	background: #2a2a2a;
}

#profiler-toggle.position-right {
	bottom: auto;
	top: 0;
	left: auto;
	right: 0;
	border-radius: 0 0 0 6px;
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
	font-size: 10px;
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
	border-radius: 4px;
	color: var(--text-secondary);
	cursor: pointer;
	padding: 3px 5px;
	font-size: 11px;
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
	border-radius: 6px 6px 0 0;
	min-width: 240px;
	max-height: 320px;
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
	top: 0;
	left: auto;
	right: 28px;
	border-radius: 0 0 6px 6px;
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

/* No tabs — shrink panel to header only */
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
	min-height: 34px;
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
	padding: 0 14px;
	background: none;
	border: none;
	border-bottom: 2px solid transparent;
	color: var(--text-secondary);
	cursor: grab;
	font-family: inherit;
	font-size: 12px;
	white-space: nowrap;
	user-select: none;
	flex-shrink: 0;
	display: flex;
	align-items: center;
	transition: color 0.1s;
	min-height: 34px;
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
	border-radius: 4px;
	color: var(--text-secondary);
	cursor: pointer;
	padding: 3px 6px;
	font-size: 12px;
	line-height: 1;
	font-family: inherit;
	display: flex;
	align-items: center;
	min-height: 24px;
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
	overflow: hidden;
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
	overflow: hidden;
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
	border-radius: 6px;
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
	font-size: 12px;
	color: var(--text-primary);
	min-height: 30px;
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
	border-radius: 4px;
	color: var(--text-secondary);
	cursor: pointer;
	padding: 2px 6px;
	font-size: 13px;
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
	font-size: 10px;
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
	min-height: 26px;
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
	font-size: 12px;
}

.list-item-cell:not(:first-child) {
	color: var(--text-secondary);
	justify-content: flex-end;
}

/* Section separator (first item in list / group header) */
.list-item-wrapper.header-wrapper > .list-item-row {
	background: var(--header-bg);
	color: var(--text-secondary);
	font-size: 11px;
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
	font-size: 9px;
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
	border-radius: 3px;
	color: var(--text-primary);
	font-family: inherit;
	font-size: 11px;
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
	border-radius: 3px;
	color: var(--text-primary);
	font-family: inherit;
	font-size: 11px;
	padding: 2px 4px;
	cursor: pointer;
	outline: none;
	flex: 1;
}

.param-control input[type="color"] {
	width: 30px;
	height: 22px;
	border: 1px solid var(--border-color);
	border-radius: 3px;
	cursor: pointer;
	padding: 1px;
	background: none;
}

.param-control button {
	background: rgba(255,255,255,0.07);
	border: 1px solid var(--border-color);
	border-radius: 3px;
	color: var(--text-primary);
	cursor: pointer;
	font-family: inherit;
	font-size: 11px;
	padding: 3px 10px;
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
	font-size: 11px;
}

.custom-checkbox input[type="checkbox"] {
	display: none;
}

.checkmark {
	display: inline-block;
	width: 14px;
	height: 14px;
	border: 1px solid var(--border-color);
	border-radius: 3px;
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
	border-radius: 3px;
	color: var(--text-primary);
	font-family: inherit;
	font-size: 11px;
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
	border-radius: 4px;
	color: var(--text-secondary);
	cursor: pointer;
	padding: 3px 6px;
	font-size: 11px;
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
	padding: 4px 10px;
	border-bottom: 1px solid rgba(255,255,255,0.04);
	word-break: break-all;
	line-height: 1.5;
	font-size: 11px;
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
	border-radius: 2px;
	padding: 0 3px;
	font-size: 11px;
}

/* ============================================================
   Parameters tab — .parameters class on list-container
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
	border-radius: 3px;
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
	font-size: 12px;
	text-align: center;
	padding: 16px;
}
`;
