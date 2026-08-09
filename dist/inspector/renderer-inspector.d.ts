/**
 * RendererInspector.ts, Stats-collecting inspector layer.
 *
 * Extends InspectorBase with per-frame stats accumulation, a rolling frame
 * history buffer (512 frames), and optional GPU timestamp-query support.
 *
 * Architecture:
 *   - begin(frameId) resets per-frame counters and records a CPU timestamp.
 *   - finish(frameId) seals the frame record and optionally resolves GPU timestamps.
 *   - beginRender/finishRender track CPU wall-time per render pass.
 *   - beginCompute/finishCompute track CPU wall-time per compute dispatch.
 *   - resolveFrame() returns the just-completed frame (fresh CPU/stats).
 *   - latestResolvedFrame() returns the newest frame whose async GPU
 *     timestamps have landed — what the live GPU-time display reads.
 *
 * GPU timestamp queries (optional):
 *   If the 'timestamp-query' feature is available, the renderer passes
 *   hasTimestamps=true to init(). We allocate a GPUQuerySet and a resolve
 *   buffer and read them back asynchronously after each submit.
 *   Each pass gets two slots: [begin, end]. Max 64 passes per frame.
 *   Readback is a frame or two behind (mapAsync latency), so a frame's gpuMs
 *   back-patches its record after finish(). Readback buffers rotate (a small
 *   pool) so every frame resolves even while prior reads are in flight — the Perf
 *   Timeline recording reads per-frame gpuMs live off the entry refs. The live
 *   panel instead reads the newest *resolved* frame (latestResolvedFrame) rather
 *   than the just-finished one, whose gpuMs is always still pending.
 */
import type { Object3D } from '../core/object3d';
import type { ComputeNode, InspectorNode } from '../nodes/nodes';
import type { Any } from '../schema/schema';
import { type InspectableRenderer, InspectorBase } from './inspector-base';
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
    /** GPU-begin offset within the frame (ms, relative to the frame's earliest
     *  GPU timestamp). Null until async timestamps resolve. The timeline positions
     *  the GPU bar by this real offset, not by the CPU record-end. */
    gpuStartMs: number | null;
    /** Monotonic query slot index (pair: begin=slot*2, end=slot*2+1) */
    querySlot: number;
};
/** Compute pass entry */
export type ComputeEntry = TimelineEntryBase & {
    kind: 'compute';
    /** GPU duration in ms (null until async timestamp resolves) */
    gpuMs: number | null;
    /** GPU-begin offset within the frame (ms, relative to the frame's earliest
     *  GPU timestamp). Null until async timestamps resolve. The timeline positions
     *  the GPU bar by this real offset, not by the CPU record-end. */
    gpuStartMs: number | null;
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
    colorFormat: string;
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
    private _gpuInitialized;
    private _querySet;
    private _resolveBuffer;
    /** In-flight readback map promises, so teardown can await them before it
     *  destroys the buffers they read (see `drainThenDestroy`). Each settles once
     *  its buffer is unmapped. */
    private _pendingMaps;
    /** Bumped on every GPU teardown. A readback captures this at submit and bails
     *  after its `await` if it no longer matches — the gpucat analog of three.js's
     *  `isDisposed` re-check, but re-attach-safe (a fresh attach runs a new
     *  generation rather than staying permanently dead). */
    private _generation;
    /** Set once we hit the readback cap and drop a frame, so the warning fires once
     *  per attach instead of every frame while saturated. Reset in init(). */
    private _readbackSaturatedLogged;
    /** The WebGL disjoint-timer extension, or null if unavailable. */
    private _glTimerExt;
    /** Free pool of GL timer-query objects to reuse. */
    private _glQueryPool;
    /** Timer queries submitted but not yet read back: {query, entry, frame record}. */
    private _glPendingQueries;
    /** The GL timer query currently open (between beginRender and finishRender). Only one may be
     *  active at a time — TIME_ELAPSED queries can't nest, so nested passes are left untimed. */
    private _glActiveQuery;
    /** Per-frame list of entries whose GL query landed in this frame, to compute the frame span. */
    private _glFrameQueries;
    /** Pool of MAP_READ readback buffers, grown on demand up to READBACK_POOL_CAP
     *  (see _acquireReadback). Each frame resolves into a free (unmapped) one, so a
     *  pending mapAsync from a prior frame never blocks the next — every frame's
     *  gpuMs resolves and back-patches its record. The resolve buffer isn't pooled:
     *  resolveQuerySet + copy run synchronously at submit, so it's free again before
     *  the next frame. */
    private _readbackPool;
    private _lastFinishTime;
    private _deltaTimes;
    private _frameHadRender;
    get fps(): number;
    private _frameStart;
    private _currentQuerySlot;
    private _pendingInspectables;
    private _pendingScenes;
    private _entryStack;
    private _rootTimeline;
    private _entryRefs;
    setRenderer(renderer: InspectableRenderer | null): void;
    init(): void;
    /**
     * Destroy GPU resources only after in-flight GPU work drains: any submitted
     * command buffer that references them (timestamp resolve/copy, probe passes)
     * and any pending readback map. Destroying a resource while it's still
     * referenced by in-flight work can lose the whole device in Dawn ("A valid
     * external Instance reference no longer exists"), taking the host app's
     * renderer down with it. Falls back to an immediate destroy when there's no
     * WebGPU device (WebGL, or the renderer is already gone). The returned promise
     * resolves once the resources are actually destroyed, so a caller can `await`
     * full teardown (mirrors three.js's async `TimestampQueryPool.dispose()`).
     */
    protected drainThenDestroy(destroy: () => void): Promise<void>;
    /**
     * Release the GPU timestamp resources. Awaitable: WebGPU query/buffer destroys
     * are deferred behind `drainThenDestroy` so in-flight resolve/copy work and
     * pending readback maps finish first (a synchronous destroy mid-submit can lose
     * the whole device). WebGL timer-query cleanup is synchronous. Idempotent — a
     * second call finds the fields already nulled and no-ops.
     */
    protected disposeTimestampGpu(): Promise<void>;
    /** Acquire the disjoint-timer extension if available; enables per-pass GPU timing on WebGL. */
    private _initWebGLTimestamps;
    /** Grab a free GL timer query, creating one if the pool is empty. */
    private _glAcquireQuery;
    /** Begin a GL timer query around a render/compute entry (top-level only — can't nest). */
    private _glBeginQuery;
    /** End the GL timer query for an entry, stashing it until finish() attaches the frame record. */
    private _glEndQuery;
    /**
     * Poll pending GL timer queries: any whose result is available is read (ns → ms) and back-patched
     * onto its entry + frame record, then the query returns to the pool. Disjoint results (GPU state
     * change invalidated the timing) are discarded. Called each frame from finish().
     */
    private _glPollQueries;
    begin(frameId: number): void;
    finish(frameId: number): void;
    beginRender(passId: string, _frameId: number): void;
    finishRender(passId: string, _frameId: number): void;
    getTimestampWrites(passId: string): GPURenderPassTimestampWrites | undefined;
    beginCompute(node: ComputeNode, _frameId: number): void;
    finishCompute(nodeId: string, _frameId: number): void;
    inspect(node: InspectorNode<Any>): void;
    beginRenderScene(passId: string, scene: Object3D, samples: number, colorFormat: string, _frameId: number): void;
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
    /** Returns the most recent completed FrameRecord, or null. Fresh CPU + stats,
     *  but its `gpuMs` is still null (async readback lands a frame or two later). */
    resolveFrame(): FrameRecord | null;
    /** Returns the newest frame whose GPU timestamps have resolved (`gpuMs !==
     *  null`), or null if none have yet. The live GPU-time display reads this so
     *  it shows a real value consistently despite readback latency, instead of
     *  the just-finished frame whose gpuMs is always still pending. */
    latestResolvedFrame(): FrameRecord | null;
    /** Returns a slice of the last `count` frame records, oldest first. */
    getRecentFrames(count: number): FrameRecord[];
    /** Collect all GPU entries (render/compute) from timeline tree, mapped by querySlot */
    private _collectGpuEntries;
    /**
     * A free (unmapped) readback buffer for this frame's timestamps. Reuses a
     * pooled buffer if one is idle, else allocates a new one while under the cap so
     * the pool self-sizes to the real map latency. Returns null (logging once) at
     * the cap, so a stalled readback drops a frame instead of growing without bound.
     */
    private _acquireReadback;
    /**
     * Resolves GPU timestamps for a frame.
     * Checks buffer.mapState before using, skips if not 'unmapped'.
     */
    private _resolveTimestamps;
}
export {};
