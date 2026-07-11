import { Tab } from '../ui/tab';
import type { FrameRecord } from '../renderer-inspector';
import type { RendererInspector } from '../renderer-inspector';
export declare class PerformanceTimeline extends Tab {
    private _canvas;
    private _ctx;
    private _tooltip;
    private _toolbar;
    private _recordBtn;
    private _clearBtn;
    private _statusText;
    private _isRecording;
    private _entries;
    private _recordingStartMs;
    private _recordingEndMs;
    /** Whether the timeline is currently recording. */
    get isRecording(): boolean;
    private _viewportStartMs;
    private _viewportDurationMs;
    private _followNow;
    private _isDraggingViewport;
    private _dragStartX;
    private _dragStartViewportMs;
    private _isPanningDetail;
    private _panStartX;
    private _panStartViewportMs;
    private _maxCpuDepth;
    private _needsRender;
    private _rafId;
    constructor(options?: {
        name?: string;
        allowDetach?: boolean;
    });
    private _buttonStyle;
    private _toggleRecording;
    private _clear;
    private _updateStatus;
    update(_inspector: RendererInspector, frame: FrameRecord): void;
    private _flattenFrame;
    scheduleRender(): void;
    private _scheduleRender;
    private _render;
    private _drawOverview;
    private _drawRuler;
    private _formatTimeLabel;
    private _formatMs;
    private _calculateGridInterval;
    /**
     * Assign each entry's GPU span to a lane via greedy interval partitioning.
     * GPU passes pipeline — their [start, start+gpuMs] intervals overlap — so we
     * stack overlapping spans onto separate rows instead of drawing them on top
     * of one another. Shared by the draw and hit-test paths so both agree.
     */
    private _computeGpuLanes;
    private _drawDetail;
    private _drawGridLines;
    private _drawBar;
    private _onMouseDown;
    private _onMouseMove;
    private _onMouseUp;
    private _onMouseLeave;
    private _onWheel;
    private _updateTooltip;
    private _showTooltip;
}
