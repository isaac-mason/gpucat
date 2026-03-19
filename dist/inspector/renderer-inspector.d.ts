/**
 * RendererInspector.ts — Stats-collecting inspector layer.
 *
 * Extends InspectorBase with per-frame stats accumulation, a rolling frame
 * history buffer (512 frames), and optional GPU timestamp-query support.
 *
 * Architecture:
 *   - begin(frameId) resets per-frame counters and records a CPU timestamp.
 *   - finish(frameId) seals the frame record and optionally resolves GPU timestamps.
 *   - beginRender/finishRender track CPU wall-time per render pass.
 *   - beginCompute/finishCompute track CPU wall-time per compute dispatch.
 *   - resolveFrame() returns the most recent fully-resolved FrameRecord.
 *
 * GPU timestamp queries (optional):
 *   If the 'timestamp-query' feature is available, the renderer passes
 *   hasTimestamps=true to init(). We allocate a GPUQuerySet and a resolve
 *   buffer and read them back asynchronously after each submit.
 *   Each pass gets two slots: [begin, end]. Max 64 passes per frame.
 */
import { InspectorBase } from './inspector-base';
import type { InspectorNode, ComputeNode } from '../nodes/nodes';
import type { Object3D } from '../core/object3d';
import { Any } from '../schema/schema';
/** Base fields shared by all timeline entries */
type TimelineEntryBase = {
    /** Entry name (pass ID or marker name) */
    name: string;
    /** Start time relative to frame start (ms) */
    startTime: number;
    /** CPU wall-time duration in ms */
    cpuMs: number;
    /** Nested child entries */
    children: TimelineEntry[];
};
/** Marker entry - pure JS timing marker */
export type MarkerEntry = TimelineEntryBase & {
    kind: 'marker';
};
/** Render pass entry */
export type RenderEntry = TimelineEntryBase & {
    kind: 'render';
    /** GPU duration in ms (null until async timestamp resolves) */
    gpuMs: number | null;
    /** Monotonic query slot index (pair: begin=slot*2, end=slot*2+1) */
    querySlot: number;
};
/** Compute pass entry */
export type ComputeEntry = TimelineEntryBase & {
    kind: 'compute';
    /** GPU duration in ms (null until async timestamp resolves) */
    gpuMs: number | null;
    /** Monotonic query slot index (pair: begin=slot*2, end=slot*2+1) */
    querySlot: number;
};
/** Unified timeline entry - can be a marker, render pass, or compute pass */
export type TimelineEntry = MarkerEntry | RenderEntry | ComputeEntry;
/** @deprecated Use TimelineEntry instead */
export type PassRecord = RenderEntry | ComputeEntry;
/**
 * Snapshot of a single renderScene() call within a frame.
 * Carries the scene reference and the pipeline-key parameters needed to
 * look up compiled WGSL from the pipeline cache.
 */
export type SceneRecord = {
    /** Pass ID that owns this scene render (matches PassRecord.id). */
    passId: string;
    /** The scene/object being rendered (Scene or QuadMesh). */
    scene: Object3D;
    /** MSAA sample count used for pipeline key lookup. */
    samples: number;
    /** Color attachment format used for pipeline key lookup. */
    colorFormat: GPUTextureFormat;
};
export type FrameRecord = {
    frameId: number;
    /** Total CPU time for the entire frame (begin→finish) in ms */
    cpuMs: number;
    /** Sum of all pass GPU times in ms (null until all resolved) */
    gpuMs: number | null;
    /** Hierarchical timeline of all entries (markers, render passes, compute passes) */
    timeline: TimelineEntry[];
    /** Snapshot of buffer/pipeline stats at frame end */
    bufferStats: {
        bufferCount: number;
        rawCount: number;
    };
    pipelineStats: {
        renderCount: number;
        computeCount: number;
        bindGroupLayoutCount: number;
    };
    renderObjectStats: {
        total: number;
    };
    /** Inspectable nodes encountered this frame */
    inspectableNodes: InspectorNode<Any>[];
    /** Scene render calls encountered this frame, one entry per renderScene() call. */
    scenes: SceneRecord[];
};
export declare class RendererInspector extends InspectorBase {
    /** Rolling ring buffer of frame records. */
    readonly frames: (FrameRecord | null)[];
    /** Index of the most recently completed frame in the ring buffer. */
    frameHead: number;
    /** Live registry of compute nodes seen by the inspector. */
    readonly computeNodes: Map<string, ComputeNode>;
    protected hasTimestamps: boolean;
    private _querySet;
    private _resolveBuffer;
    private _readbackBuffer;
    private _lastFinishTime;
    private _deltaTimes;
    get fps(): number;
    private _frameStart;
    private _currentQuerySlot;
    private _pendingInspectables;
    private _pendingScenes;
    private _entryStack;
    private _rootTimeline;
    private _entryRefs;
    init(): void;
    begin(frameId: number): void;
    finish(frameId: number): void;
    beginRender(passId: string, _frameId: number): void;
    finishRender(passId: string, _frameId: number): void;
    getTimestampWrites(passId: string): GPURenderPassTimestampWrites | undefined;
    beginCompute(node: ComputeNode, _frameId: number): void;
    finishCompute(nodeId: string, _frameId: number): void;
    inspect(node: InspectorNode<Any>): void;
    beginRenderScene(passId: string, scene: Object3D, samples: number, colorFormat: GPUTextureFormat, _frameId: number): void;
    /** Public API for adding performance markers from user code */
    readonly perf: {
        /**
         * Start a named performance marker. Can be nested.
         * Any render/compute passes or child markers will be added as children.
         */
        start: (name: string) => void;
        /**
         * End a named performance marker.
         * Calculates duration and closes the marker.
         */
        end: (name: string) => void;
    };
    /** Push an entry onto the stack, nesting it under current parent if any */
    private _pushEntry;
    /** Finish an entry by name - calculates duration and pops from stack */
    private _finishEntry;
    /** Close the current top entry (used for unclosed entries at frame end) */
    private _closeCurrentEntry;
    /** Returns the most recent completed FrameRecord, or null. */
    resolveFrame(): FrameRecord | null;
    /** Returns a slice of the last `count` frame records, oldest first. */
    getRecentFrames(count: number): FrameRecord[];
    /** Collect all GPU entries (render/compute) from timeline tree, mapped by querySlot */
    private _collectGpuEntries;
    /**
     * Resolves GPU timestamps for a frame.
     * Checks buffer.mapState before using, skips if not 'unmapped'.
     */
    private _resolveTimestamps;
}
export {};
