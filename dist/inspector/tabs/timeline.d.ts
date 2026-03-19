import { Tab } from '../ui/tab';
import { Graph } from '../ui/graph';
type TimelineFrame = {
    id: string;
    calls: Array<{
        method: string;
    }>;
    fps: number;
};
export declare class Timeline extends Tab {
    isRecording: boolean;
    frames: TimelineFrame[];
    currentFrame: TimelineFrame | null;
    isHierarchicalView: boolean;
    graph: Graph;
    graphSlider: HTMLDivElement;
    hoverIndicator: HTMLDivElement;
    playhead: HTMLDivElement;
    timelineTrack: HTMLDivElement;
    recordButton: HTMLButtonElement;
    recordRefreshButton: HTMLButtonElement;
    viewModeButton: HTMLButtonElement;
    frameInfo: HTMLSpanElement;
    collapsedGroups?: Set<string>;
    selectedFrameIndex: number;
    isTrackingLatest: boolean;
    isManualScrubbing: boolean;
    fixedScreenX: number;
    constructor(options?: {
        name?: string;
        allowDetach?: boolean;
    });
    private _buildHeader;
    private _buildUI;
    /** Called by Inspector.ts to set up auto-start from localStorage. */
    setRenderer(_renderer: unknown): void;
    toggleRecording(): void;
    startRecording(): void;
    stopRecording(): void;
    /**
     * Called by Inspector when a new frame begins or a pass/compute begins/ends.
     * `method` is e.g. 'begin', 'beginRender', 'finishRender', 'beginCompute', 'finishCompute'.
     * `label` is e.g. the frameId string or a passId.
     */
    onCall(method: string, label: string, fps?: number): void;
    clear(): void;
    exportTimeline(): void;
    private _showEmptyHint;
    renderSlider(): void;
    selectFrame(index: number): void;
    renderTimelineTrack(frame: TimelineFrame): void;
    private _getColorForMethod;
}
export {};
