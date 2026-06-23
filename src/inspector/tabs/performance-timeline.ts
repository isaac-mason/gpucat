import { Tab } from '../ui/tab';
import type { FrameRecord, TimelineEntry, RenderEntry, ComputeEntry } from '../renderer-inspector';
import type { RendererInspector } from '../renderer-inspector';

// Max number of flat entries retained during recording (~3 min at 60fps with ~20 entries/frame)
const MAX_ENTRIES = 200_000;

// Entries narrower than this in CSS pixels are skipped in the detail view, no point drawing sub-pixel bars
const MIN_BAR_PX = 1;

// Layout
const ROW_HEIGHT = 20;
const ROW_GAP = 2;
const TOOLBAR_HEIGHT = 28;
const OVERVIEW_HEIGHT = 40;
const RULER_HEIGHT = 24;
const TRACK_LABEL_WIDTH = 40;
const TRACK_PADDING = 8;
const MIN_CPU_TRACK_HEIGHT = 120;
const MIN_VIEWPORT_WIDTH_PX = 4;

// Colors
const COLORS = {
    marker: '#9c7ce5',
    render: '#64b5f6',
    compute: '#ffb74d',
    gpu: '#81c784',
    bg: '#1a1a1a',
    trackBg: '#222222',
    trackBgAlt: '#252525',
    ruler: '#2d2d2d',
    toolbar: '#2d2d2d',
    text: '#e0e0e0',
    textDim: '#888888',
    grid: '#3a3a3a',
    gridMajor: '#4a4a4a',
    border: '#555555',
    now: '#ff5252',
    viewport: 'rgba(100, 180, 255, 0.25)',
    viewportBorder: 'rgba(100, 180, 255, 0.6)',
    recording: '#f44336',
};

type FlatEntry = {
    name: string;
    kind: 'marker' | 'render' | 'compute';
    depth: number;
    startMs: number;
    durationMs: number;
    /** Reference to original entry for live gpuMs updates (async resolved) */
    sourceEntry: TimelineEntry | null;
};

/** Get gpuMs from a FlatEntry (reads from source for live updates) */
function getGpuMs(entry: FlatEntry): number | null {
    if (!entry.sourceEntry || entry.sourceEntry.kind === 'marker') return null;
    return (entry.sourceEntry as RenderEntry | ComputeEntry).gpuMs;
}

/** Get gpuStartMs for a FlatEntry (CPU end time = GPU start time) */
function getGpuStartMs(entry: FlatEntry): number | null {
    const gpuMs = getGpuMs(entry);
    if (gpuMs === null || gpuMs <= 0) return null;
    return entry.startMs + entry.durationMs;
}

export class PerformanceTimeline extends Tab {
    private _canvas: HTMLCanvasElement;
    private _ctx: CanvasRenderingContext2D;
    private _tooltip: HTMLDivElement;
    private _toolbar: HTMLDivElement;
    private _recordBtn: HTMLButtonElement;
    private _clearBtn: HTMLButtonElement;
    private _statusText: HTMLSpanElement;

    // Recording state
    private _isRecording = false;
    private _entries: FlatEntry[] = [];
    private _recordingStartMs = 0;
    private _recordingEndMs = 0;

    /** Whether the timeline is currently recording. */
    get isRecording(): boolean {
        return this._isRecording;
    }

    // Viewport state (in ms, relative to recording start)
    private _viewportStartMs = 0;
    private _viewportDurationMs = 2000; // Visible window width in ms
    private _followNow = true;

    // Interaction state
    private _isDraggingViewport = false;
    private _dragStartX = 0;
    private _dragStartViewportMs = 0;
    private _isPanningDetail = false;
    private _panStartX = 0;
    private _panStartViewportMs = 0;

    private _maxCpuDepth = 0;
    private _needsRender = false;
    private _rafId = 0;

    constructor(options: { name?: string; allowDetach?: boolean } = {}) {
        super('Perf Timeline', options);

        // Note: don't set display here - it's controlled by .profiler-content.active class
        this.content.style.position = 'relative';
        this.content.style.flexDirection = 'column';
        this.content.style.height = '100%';
        this.content.style.background = COLORS.bg;
        this.content.style.overflow = 'hidden';
        this.content.style.userSelect = 'none';

        // Toolbar
        this._toolbar = document.createElement('div');
        this._toolbar.style.cssText = `
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 8px;
            background: ${COLORS.toolbar};
            border-bottom: 1px solid ${COLORS.border};
            height: ${TOOLBAR_HEIGHT}px;
            box-sizing: border-box;
        `;

        this._recordBtn = document.createElement('button');
        this._recordBtn.innerHTML = '&#9679; Record';
        this._recordBtn.style.cssText = this._buttonStyle();
        this._recordBtn.addEventListener('click', () => this._toggleRecording());

        this._clearBtn = document.createElement('button');
        this._clearBtn.textContent = 'Clear';
        this._clearBtn.style.cssText = this._buttonStyle();
        this._clearBtn.addEventListener('click', () => this._clear());

        this._statusText = document.createElement('span');
        this._statusText.style.cssText = `
            font: 11px monospace;
            color: ${COLORS.textDim};
            margin-left: auto;
        `;
        this._updateStatus();

        this._toolbar.appendChild(this._recordBtn);
        this._toolbar.appendChild(this._clearBtn);
        this._toolbar.appendChild(this._statusText);
        this.content.appendChild(this._toolbar);

        // Canvas
        this._canvas = document.createElement('canvas');
        this._canvas.style.cssText = 'width: 100%; flex: 1; display: block;';
        this.content.appendChild(this._canvas);
        this._ctx = this._canvas.getContext('2d')!;

        // Tooltip
        this._tooltip = document.createElement('div');
        this._tooltip.style.cssText = `
            position: absolute;
            background: #333;
            color: ${COLORS.text};
            padding: 8px 10px;
            border-radius: var(--radius);
            font: 11px/1.4 monospace;
            pointer-events: none;
            z-index: 1000;
            display: none;
            border: 1px solid ${COLORS.border};
            box-shadow: 0 2px 8px rgba(0,0,0,0.4);
            white-space: nowrap;
        `;
        this.content.appendChild(this._tooltip);

        // Event listeners
        this._canvas.addEventListener('mousedown', this._onMouseDown.bind(this));
        this._canvas.addEventListener('mousemove', this._onMouseMove.bind(this));
        this._canvas.addEventListener('mouseup', this._onMouseUp.bind(this));
        this._canvas.addEventListener('mouseleave', this._onMouseLeave.bind(this));
        this._canvas.addEventListener('wheel', this._onWheel.bind(this), { passive: false });

        const ro = new ResizeObserver(() => this._scheduleRender());
        ro.observe(this.content);
    }

    private _buttonStyle(): string {
        return `
            padding: 3px 10px;
            font: 11px monospace;
            background: #404040;
            color: ${COLORS.text};
            border: 1px solid ${COLORS.border};
            border-radius: var(--radius);
            cursor: pointer;
        `;
    }

    private _toggleRecording(): void {
        this._isRecording = !this._isRecording;
        if (this._isRecording) {
            this._entries = [];
            this._recordingStartMs = performance.now();
            this._recordingEndMs = this._recordingStartMs;
            this._viewportStartMs = 0;
            this._followNow = true;
            this._recordBtn.innerHTML = '&#9632; Stop';
            this._recordBtn.style.color = COLORS.recording;
        } else {
            this._recordBtn.innerHTML = '&#9679; Record';
            this._recordBtn.style.color = COLORS.text;
            this._followNow = false;
            this._scheduleRender();
        }
        this._updateStatus();
    }

    private _clear(): void {
        this._entries = [];
        this._recordingStartMs = performance.now();
        this._recordingEndMs = this._recordingStartMs;
        this._viewportStartMs = 0;
        this._maxCpuDepth = 0;
        this._followNow = true;
        this._updateStatus();
        this._scheduleRender();
    }

    private _updateStatus(): void {
        const duration = (this._recordingEndMs - this._recordingStartMs) / 1000;
        const entries = this._entries.length;
        if (this._isRecording) {
            this._statusText.innerHTML = `<span style="color:${COLORS.recording}">&#9679;</span> Recording: ${duration.toFixed(1)}s | ${entries} entries`;
        } else if (entries > 0) {
            this._statusText.textContent = `Recorded: ${duration.toFixed(1)}s | ${entries} entries`;
        } else {
            this._statusText.textContent = 'Click Record to start';
        }
    }

    update(_inspector: RendererInspector, frame: FrameRecord): void {
        if (!this._isRecording) return;

        const now = performance.now();
        const frameStartMs = now - frame.cpuMs;

        this._flattenFrame(frame.timeline, frameStartMs);
        this._recordingEndMs = now;

        // Evict oldest entries if we've exceeded the cap, sliding the recording window forward
        if (this._entries.length > MAX_ENTRIES) {
            const drop = this._entries.length - MAX_ENTRIES;
            const shiftMs = this._entries[drop].startMs;
            this._entries = this._entries.slice(drop);
            for (const e of this._entries) e.startMs -= shiftMs;
            this._recordingStartMs += shiftMs;
            this._viewportStartMs = Math.max(0, this._viewportStartMs - shiftMs);
        }

        // Auto-follow "now" if enabled
        if (this._followNow) {
            const recordingDuration = this._recordingEndMs - this._recordingStartMs;
            this._viewportStartMs = Math.max(0, recordingDuration - this._viewportDurationMs);
        }

        this._updateStatus();
        // Don't render while recording, render once when recording stops
    }

    private _flattenFrame(entries: TimelineEntry[], frameStartMs: number, depth = 0): void {
        for (const entry of entries) {
            const absStartMs = frameStartMs + entry.startTime;
            const relStartMs = absStartMs - this._recordingStartMs;

            this._entries.push({
                name: entry.name,
                kind: entry.kind as 'marker' | 'render' | 'compute',
                depth,
                startMs: relStartMs,
                durationMs: entry.cpuMs,
                sourceEntry: entry.kind !== 'marker' ? entry : null,
            });

            if (depth > this._maxCpuDepth) this._maxCpuDepth = depth;

            if (entry.children.length > 0) {
                this._flattenFrame(entry.children, frameStartMs, depth + 1);
            }
        }
    }

    scheduleRender(): void {
        this._scheduleRender();
    }

    private _scheduleRender(): void {
        if (this._needsRender) return;
        this._needsRender = true;

        if (this._rafId) cancelAnimationFrame(this._rafId);
        this._rafId = requestAnimationFrame(() => {
            this._needsRender = false;
            this._render();
        });
    }

    private _render(): void {
        const canvas = this._canvas;
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        const w = rect.width;
        const h = rect.height;

        if (w === 0 || h === 0) return;

        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
            canvas.width = w * dpr;
            canvas.height = h * dpr;
        }

        const ctx = this._ctx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Clear
        ctx.fillStyle = COLORS.bg;
        ctx.fillRect(0, 0, w, h);

        const recordingDuration = this._recordingEndMs - this._recordingStartMs;
        if (recordingDuration <= 0 || this._entries.length === 0) {
            ctx.fillStyle = COLORS.textDim;
            ctx.font = '12px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(this._isRecording ? 'Recording...' : 'No data recorded', w / 2, h / 2);
            ctx.textAlign = 'left';
            return;
        }

        // Layout
        const rulerY = OVERVIEW_HEIGHT;
        const detailY = OVERVIEW_HEIGHT + RULER_HEIGHT;
        const detailH = h - detailY;
        const chartWidth = w - TRACK_LABEL_WIDTH;

        // Draw overview
        this._drawOverview(ctx, w, OVERVIEW_HEIGHT, recordingDuration, chartWidth);

        // Draw ruler
        this._drawRuler(ctx, w, rulerY, chartWidth);

        // Draw detail tracks
        this._drawDetail(ctx, w, detailY, detailH, chartWidth);

        // Draw "now" line if recording and following
        if (this._isRecording && this._followNow) {
            ctx.strokeStyle = COLORS.now;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(w - 1, rulerY);
            ctx.lineTo(w - 1, h);
            ctx.stroke();
        }
    }

    private _drawOverview(ctx: CanvasRenderingContext2D, w: number, h: number, recordingDuration: number, chartWidth: number): void {
        // Background
        ctx.fillStyle = COLORS.ruler;
        ctx.fillRect(0, 0, w, h);

        // Mini bars - simplified view
        const pxPerMs = chartWidth / recordingDuration;
        const barHeight = 4;

        for (const entry of this._entries) {
            if (entry.kind === 'marker') continue; // Skip markers in overview for clarity
            const x = TRACK_LABEL_WIDTH + entry.startMs * pxPerMs;
            const barW = Math.max(entry.durationMs * pxPerMs, 1);
            const y = h / 2 - barHeight / 2 + (entry.depth * 2);

            ctx.fillStyle = COLORS[entry.kind];
            ctx.fillRect(x, y, barW, barHeight);
        }

        // Viewport indicator
        const viewportX = TRACK_LABEL_WIDTH + (this._viewportStartMs / recordingDuration) * chartWidth;
        const viewportW = Math.max((this._viewportDurationMs / recordingDuration) * chartWidth, MIN_VIEWPORT_WIDTH_PX);

        ctx.fillStyle = COLORS.viewport;
        ctx.fillRect(viewportX, 0, viewportW, h);

        ctx.strokeStyle = COLORS.viewportBorder;
        ctx.lineWidth = 1;
        ctx.strokeRect(viewportX, 0, viewportW, h);

        // Resize handles
        ctx.fillStyle = COLORS.viewportBorder;
        ctx.fillRect(viewportX, 0, 3, h);
        ctx.fillRect(viewportX + viewportW - 3, 0, 3, h);

        // Label
        ctx.fillStyle = COLORS.textDim;
        ctx.font = '9px monospace';
        ctx.fillText('Overview', 4, 12);
    }

    private _drawRuler(ctx: CanvasRenderingContext2D, w: number, y: number, chartWidth: number): void {
        ctx.fillStyle = COLORS.ruler;
        ctx.fillRect(0, y, w, RULER_HEIGHT);

        ctx.strokeStyle = COLORS.grid;
        ctx.fillStyle = COLORS.textDim;
        ctx.font = '10px monospace';
        ctx.lineWidth = 1;

        const pxPerMs = chartWidth / this._viewportDurationMs;
        const gridInterval = this._calculateGridInterval(this._viewportDurationMs, chartWidth);
        const viewportEndMs = this._viewportStartMs + this._viewportDurationMs;
        const recordingDuration = this._recordingEndMs - this._recordingStartMs;

        // Offset for when recording is shorter than viewport (entries should appear near right edge)
        let drawOffsetPx = 0;
        if (this._isRecording && this._followNow && recordingDuration < this._viewportDurationMs) {
            drawOffsetPx = (this._viewportDurationMs - recordingDuration) * pxPerMs;
        }

        const firstGrid = Math.ceil(this._viewportStartMs / gridInterval) * gridInterval;

        for (let ms = firstGrid; ms <= viewportEndMs; ms += gridInterval) {
            const x = TRACK_LABEL_WIDTH + (ms - this._viewportStartMs) * pxPerMs + drawOffsetPx;
            if (x < TRACK_LABEL_WIDTH || x > w) continue;

            ctx.beginPath();
            ctx.moveTo(x, y + RULER_HEIGHT - 6);
            ctx.lineTo(x, y + RULER_HEIGHT);
            ctx.stroke();

            // Format label based on zoom level and whether we're following live
            const label = this._formatTimeLabel(ms, recordingDuration, gridInterval);
            ctx.fillText(label, x + 2, y + RULER_HEIGHT - 9);
        }
    }

    private _formatTimeLabel(ms: number, recordingDuration: number, gridInterval: number): string {
        // When following live, show time relative to "now"
        if (this._isRecording && this._followNow) {
            const relativeMs = ms - recordingDuration;
            if (Math.abs(relativeMs) < 1) {
                return 'now';
            }
            return this._formatMs(relativeMs, gridInterval);
        }
        // Otherwise show absolute time from recording start
        return this._formatMs(ms, gridInterval);
    }

    private _formatMs(ms: number, gridInterval: number): string {
        const absMs = Math.abs(ms);
        const sign = ms < 0 ? '-' : '';
        
        // Show decimal precision based on grid interval
        if (gridInterval < 0.1) {
            // Sub-0.1ms (microsecond range): show 3 decimal places
            if (absMs < 1000) {
                return `${sign}${absMs.toFixed(3)}ms`;
            }
            return `${sign}${(absMs / 1000).toFixed(4)}s`;
        } else if (gridInterval < 1) {
            // Sub-1ms intervals: show 2 decimal places
            if (absMs < 1000) {
                return `${sign}${absMs.toFixed(2)}ms`;
            }
            return `${sign}${(absMs / 1000).toFixed(3)}s`;
        } else if (gridInterval < 10) {
            // Sub-10ms intervals: show 2 decimal places
            if (absMs < 1000) {
                return `${sign}${absMs.toFixed(2)}ms`;
            }
            return `${sign}${(absMs / 1000).toFixed(3)}s`;
        } else if (gridInterval < 100) {
            // 10-100ms intervals: show 1 decimal place
            if (absMs < 1000) {
                return `${sign}${absMs.toFixed(1)}ms`;
            }
            return `${sign}${(absMs / 1000).toFixed(2)}s`;
        } else {
            // Coarser intervals: integer ms or 1 decimal second
            if (absMs < 1000) {
                return `${sign}${Math.round(absMs)}ms`;
            }
            return `${sign}${(absMs / 1000).toFixed(1)}s`;
        }
    }

    private _calculateGridInterval(durationMs: number, widthPx: number): number {
        const targetPx = 80; // Target pixels between grid lines
        const msPerPx = durationMs / widthPx;
        const targetMs = msPerPx * targetPx;

        // Intervals from microseconds to seconds for extreme zoom levels
        const intervals = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
        for (const interval of intervals) {
            if (interval >= targetMs) return interval;
        }
        return 10000;
    }

    private _drawDetail(ctx: CanvasRenderingContext2D, w: number, y: number, h: number, chartWidth: number): void {
        // Track backgrounds
        const cpuTrackH = Math.max((this._maxCpuDepth + 1) * (ROW_HEIGHT + ROW_GAP) + TRACK_PADDING * 2, MIN_CPU_TRACK_HEIGHT);
        const gpuTrackY = y + cpuTrackH;
        const gpuTrackH = ROW_HEIGHT + TRACK_PADDING * 2;

        ctx.fillStyle = COLORS.trackBg;
        ctx.fillRect(0, y, w, cpuTrackH);
        ctx.fillStyle = COLORS.trackBgAlt;
        ctx.fillRect(0, gpuTrackY, w, gpuTrackH);

        // Track labels
        ctx.fillStyle = COLORS.textDim;
        ctx.font = 'bold 10px monospace';
        ctx.fillText('CPU', 6, y + 14);
        ctx.fillText('GPU', 6, gpuTrackY + 14);

        // Separator
        ctx.strokeStyle = COLORS.gridMajor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, gpuTrackY);
        ctx.lineTo(w, gpuTrackY);
        ctx.stroke();

        // Grid lines
        this._drawGridLines(ctx, w, y, h, chartWidth);

        // When following "now", we want entries positioned so "now" (recordingDuration) is at the right edge
        // viewportStartMs may be 0 when recording is short, but we still want entries near the right
        const recordingDuration = this._recordingEndMs - this._recordingStartMs;
        const pxPerMs = chartWidth / this._viewportDurationMs;
        
        // Offset to apply: when following and recording < viewport, shift entries right
        let drawOffsetPx = 0;
        if (this._isRecording && this._followNow && recordingDuration < this._viewportDurationMs) {
            // "now" should be at right edge, so offset = (viewportDuration - recordingDuration) worth of pixels
            drawOffsetPx = (this._viewportDurationMs - recordingDuration) * pxPerMs;
        }

        const viewportEndMs = this._viewportStartMs + this._viewportDurationMs;

        for (const entry of this._entries) {
            const entryEndMs = entry.startMs + entry.durationMs;
            if (entryEndMs < this._viewportStartMs || entry.startMs > viewportEndMs) continue;

            const barW = entry.durationMs * pxPerMs;
            if (barW < MIN_BAR_PX) continue;

            // CPU bar
            const x = TRACK_LABEL_WIDTH + (entry.startMs - this._viewportStartMs) * pxPerMs + drawOffsetPx;
            const barY = y + TRACK_PADDING + entry.depth * (ROW_HEIGHT + ROW_GAP);

            this._drawBar(ctx, x, barY, Math.max(barW, 2), ROW_HEIGHT, entry.kind, entry.name);

            // GPU bar (read from source entry for live async updates)
            const gpuMs = getGpuMs(entry);
            const gpuStartMs = getGpuStartMs(entry);
            if (gpuMs !== null && gpuMs > 0 && gpuStartMs !== null) {
                const gpuBarW = gpuMs * pxPerMs;
                if (gpuBarW >= MIN_BAR_PX) {
                    const gpuX = TRACK_LABEL_WIDTH + (gpuStartMs - this._viewportStartMs) * pxPerMs + drawOffsetPx;
                    const gpuY = gpuTrackY + TRACK_PADDING;
                    this._drawBar(ctx, gpuX, gpuY, Math.max(gpuBarW, 2), ROW_HEIGHT, 'gpu', entry.name);
                }
            }
        }
    }

    private _drawGridLines(ctx: CanvasRenderingContext2D, w: number, startY: number, h: number, chartWidth: number): void {
        ctx.strokeStyle = COLORS.grid;
        ctx.lineWidth = 0.5;
        ctx.setLineDash([2, 4]);

        const pxPerMs = chartWidth / this._viewportDurationMs;
        const gridInterval = this._calculateGridInterval(this._viewportDurationMs, chartWidth);
        const firstGrid = Math.ceil(this._viewportStartMs / gridInterval) * gridInterval;
        const viewportEndMs = this._viewportStartMs + this._viewportDurationMs;

        // Offset for when recording is shorter than viewport
        const recordingDuration = this._recordingEndMs - this._recordingStartMs;
        let drawOffsetPx = 0;
        if (this._isRecording && this._followNow && recordingDuration < this._viewportDurationMs) {
            drawOffsetPx = (this._viewportDurationMs - recordingDuration) * pxPerMs;
        }

        for (let ms = firstGrid; ms <= viewportEndMs; ms += gridInterval) {
            const x = TRACK_LABEL_WIDTH + (ms - this._viewportStartMs) * pxPerMs + drawOffsetPx;
            if (x < TRACK_LABEL_WIDTH || x > w) continue;

            ctx.beginPath();
            ctx.moveTo(x, startY);
            ctx.lineTo(x, startY + h);
            ctx.stroke();
        }
        ctx.setLineDash([]);
    }

    private _drawBar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, kind: string, label: string): void {
        const color = COLORS[kind as keyof typeof COLORS] || COLORS.marker;

        const r = 2;
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, r);
        ctx.fillStyle = color;
        ctx.fill();

        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = 1;
        ctx.stroke();

        if (w > 30) {
            ctx.fillStyle = 'rgba(0,0,0,0.8)';
            ctx.font = '10px monospace';
            const maxChars = Math.floor((w - 6) / 6);
            const text = label.length > maxChars ? label.slice(0, maxChars - 1) + '…' : label;
            ctx.fillText(text, x + 3, y + h - 5);
        }
    }

    // --- Interaction ---

    private _onMouseDown(e: MouseEvent): void {
        const rect = this._canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Check if clicking in overview (viewport drag)
        if (y < OVERVIEW_HEIGHT) {
            this._isDraggingViewport = true;
            this._dragStartX = x;
            this._dragStartViewportMs = this._viewportStartMs;
            this._followNow = false;
            e.preventDefault();
            return;
        }

        // Pan the detail view (anywhere below overview)
        this._isPanningDetail = true;
        this._panStartX = x;
        this._panStartViewportMs = this._viewportStartMs;
        this._followNow = false;
        e.preventDefault();
    }

    private _onMouseMove(e: MouseEvent): void {
        const rect = this._canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const w = rect.width;
        const chartWidth = w - TRACK_LABEL_WIDTH;
        const recordingDuration = this._recordingEndMs - this._recordingStartMs;
        const maxStart = Math.max(0, recordingDuration - this._viewportDurationMs);

        if (this._isDraggingViewport && recordingDuration > 0) {
            const dx = x - this._dragStartX;
            const msPerPx = recordingDuration / chartWidth;
            const newStart = this._dragStartViewportMs + dx * msPerPx;
            this._viewportStartMs = Math.max(0, Math.min(newStart, maxStart));
            this._scheduleRender();
            return;
        }

        if (this._isPanningDetail && recordingDuration > 0) {
            const dx = this._panStartX - x; // Inverted for natural panning
            const msPerPx = this._viewportDurationMs / chartWidth;
            const newStart = this._panStartViewportMs + dx * msPerPx;
            this._viewportStartMs = Math.max(0, Math.min(newStart, maxStart));
            this._scheduleRender();
            return;
        }

        // Tooltip
        this._updateTooltip(e, x, y, w);
    }

    private _onMouseUp(): void {
        this._isDraggingViewport = false;
        this._isPanningDetail = false;
    }

    private _onMouseLeave(): void {
        this._isDraggingViewport = false;
        this._isPanningDetail = false;
        this._tooltip.style.display = 'none';
    }

    private _onWheel(e: WheelEvent): void {
        e.preventDefault();

        const rect = this._canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const w = rect.width;
        const chartWidth = w - TRACK_LABEL_WIDTH;
        const recordingDuration = this._recordingEndMs - this._recordingStartMs;

        if (recordingDuration <= 0) return;

        const maxStart = Math.max(0, recordingDuration - this._viewportDurationMs);

        // Shift + scroll = pan, otherwise zoom
        if (e.shiftKey) {
            // Pan horizontally
            const panMs = e.deltaY * (this._viewportDurationMs / chartWidth) * 2;
            this._viewportStartMs = Math.max(0, Math.min(this._viewportStartMs + panMs, maxStart));
            this._followNow = false;
        } else {
            // Zoom centered on mouse position
            const zoomFactor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
            const mouseRelX = (x - TRACK_LABEL_WIDTH) / chartWidth;
            const mouseMs = this._viewportStartMs + mouseRelX * this._viewportDurationMs;

            // Allow zooming down to 0.1ms viewport (absurdly detailed) and up to 2x recording length
            const newDuration = Math.max(0.1, Math.min(recordingDuration * 2, this._viewportDurationMs * zoomFactor));
            
            // Keep mouse position fixed during zoom
            const newStart = mouseMs - mouseRelX * newDuration;
            const newMaxStart = Math.max(0, recordingDuration - newDuration);
            
            this._viewportDurationMs = newDuration;
            this._viewportStartMs = Math.max(0, Math.min(newStart, newMaxStart));
            this._followNow = false;
        }

        this._scheduleRender();
    }

    private _updateTooltip(e: MouseEvent, x: number, y: number, w: number): void {
        if (y < OVERVIEW_HEIGHT + RULER_HEIGHT) {
            this._tooltip.style.display = 'none';
            return;
        }

        const chartWidth = w - TRACK_LABEL_WIDTH;
        const pxPerMs = chartWidth / this._viewportDurationMs;
        const viewportEndMs = this._viewportStartMs + this._viewportDurationMs;

        const detailY = OVERVIEW_HEIGHT + RULER_HEIGHT;
        const cpuTrackH = Math.max((this._maxCpuDepth + 1) * (ROW_HEIGHT + ROW_GAP) + TRACK_PADDING * 2, MIN_CPU_TRACK_HEIGHT);
        const gpuTrackY = detailY + cpuTrackH;

        for (let i = this._entries.length - 1; i >= 0; i--) {
            const entry = this._entries[i];
            const entryEndMs = entry.startMs + entry.durationMs;
            if (entryEndMs < this._viewportStartMs || entry.startMs > viewportEndMs) continue;

            const ex = TRACK_LABEL_WIDTH + (entry.startMs - this._viewportStartMs) * pxPerMs;
            const ew = Math.max(entry.durationMs * pxPerMs, 2);
            const ey = detailY + TRACK_PADDING + entry.depth * (ROW_HEIGHT + ROW_GAP);

            if (x >= ex && x <= ex + ew && y >= ey && y <= ey + ROW_HEIGHT) {
                this._showTooltip(e, entry, false);
                return;
            }

            const gpuMs = getGpuMs(entry);
            const gpuStartMs = getGpuStartMs(entry);
            if (gpuMs !== null && gpuMs > 0 && gpuStartMs !== null) {
                const gx = TRACK_LABEL_WIDTH + (gpuStartMs - this._viewportStartMs) * pxPerMs;
                const gw = Math.max(gpuMs * pxPerMs, 2);
                const gy = gpuTrackY + TRACK_PADDING;
                if (x >= gx && x <= gx + gw && y >= gy && y <= gy + ROW_HEIGHT) {
                    this._showTooltip(e, entry, true);
                    return;
                }
            }
        }

        this._tooltip.style.display = 'none';
    }

    private _showTooltip(e: MouseEvent, entry: FlatEntry, isGpu: boolean): void {
        const kindLabel = entry.kind.charAt(0).toUpperCase() + entry.kind.slice(1);
        let html = `<div style="font-weight:bold;margin-bottom:4px">${entry.name}</div>`;
        html += `<div style="color:${COLORS.textDim}">Type: ${kindLabel}</div>`;

        const gpuMs = getGpuMs(entry);
        if (isGpu) {
            html += `<div>GPU: <span style="color:${COLORS.gpu}">${gpuMs?.toFixed(2)}ms</span></div>`;
        } else {
            html += `<div>CPU: <span style="color:${COLORS[entry.kind]}">${entry.durationMs.toFixed(2)}ms</span></div>`;
            if (gpuMs !== null) {
                html += `<div>GPU: <span style="color:${COLORS.gpu}">${gpuMs.toFixed(2)}ms</span></div>`;
            }
        }

        this._tooltip.innerHTML = html;
        this._tooltip.style.display = 'block';

        const contentRect = this.content.getBoundingClientRect();
        let tooltipX = e.clientX - contentRect.left + 12;
        let tooltipY = e.clientY - contentRect.top + 12;

        const tooltipW = this._tooltip.offsetWidth;
        const tooltipH = this._tooltip.offsetHeight;
        if (tooltipX + tooltipW > contentRect.width - 10) {
            tooltipX = e.clientX - contentRect.left - tooltipW - 12;
        }
        if (tooltipY + tooltipH > contentRect.height - 10) {
            tooltipY = e.clientY - contentRect.top - tooltipH - 12;
        }

        this._tooltip.style.left = `${tooltipX}px`;
        this._tooltip.style.top = `${tooltipY}px`;
    }
}
