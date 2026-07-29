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
import { getRenderObjectsStats } from '../renderer/core/render-objects';
import { getBufferCacheStats } from '../renderer/webgpu/buffers';
import * as pipelines from '../renderer/webgpu/pipelines';
import type { Any } from '../schema/schema';
import { type InspectableRenderer, InspectorBase } from './inspector-base';

// ---------------------------------------------------------------------------
// Frame data types
// ---------------------------------------------------------------------------

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
    bufferStats: { bufferCount: number; rawCount: number };
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

/**
 * Minimal shape of the `EXT_disjoint_timer_query_webgl2` extension. lib.dom doesn't type it, but the
 * only members we need are the two enums — the query lifecycle (begin/end/getQuery) is WebGL2 core
 * (`gl.beginQuery`/`gl.endQuery`/`gl.getQueryParameter`).
 */
interface EXT_disjoint_timer_query_webgl2 {
    readonly TIME_ELAPSED_EXT: GLenum;
    readonly GPU_DISJOINT_EXT: GLenum;
}

const FRAME_HISTORY = 512;
const MAX_PASSES_PER_FRAME = 64;
// Readback buffers rotate so a frame's timestamps can resolve while prior frames'
// mapAsync reads are still in flight. Sized to cover typical map latency (1-3
// frames) so *every* frame resolves — the Perf Timeline recording needs per-frame
// GPU times, not just a recent one. Buffers are tiny (1 KiB), so err generous.
const READBACK_POOL_SIZE = 6;

// ---------------------------------------------------------------------------
// RendererInspector
// ---------------------------------------------------------------------------

export class RendererInspector extends InspectorBase {
    /** Rolling ring buffer of frame records. */
    readonly frames: (FrameRecord | null)[] = new Array(FRAME_HISTORY).fill(null);

    /** Index of the most recently completed frame in the ring buffer. */
    frameHead = -1;

    /** Live registry of compute nodes seen by the inspector. */
    readonly computeNodes: Map<string, ComputeNode> = new Map();

    // GPU timestamp state
    protected hasTimestamps = false;
    private _gpuInitialized = false;
    private _querySet: GPUQuerySet | null = null;
    private _resolveBuffer: GPUBuffer | null = null;

    // -----------------------------------------------------------------------
    // WebGL GPU-timing state (EXT_disjoint_timer_query_webgl2)
    // -----------------------------------------------------------------------
    /** The WebGL disjoint-timer extension, or null if unavailable. */
    private _glTimerExt: EXT_disjoint_timer_query_webgl2 | null = null;
    /** Free pool of GL timer-query objects to reuse. */
    private _glQueryPool: WebGLQuery[] = [];
    /** Timer queries submitted but not yet read back: {query, entry, frame record}. */
    private _glPendingQueries: { query: WebGLQuery; entry: RenderEntry | ComputeEntry; record: FrameRecord }[] = [];
    /** The GL timer query currently open (between beginRender and finishRender). Only one may be
     *  active at a time — TIME_ELAPSED queries can't nest, so nested passes are left untimed. */
    private _glActiveQuery: { query: WebGLQuery; entry: RenderEntry | ComputeEntry } | null = null;
    /** Per-frame list of entries whose GL query landed in this frame, to compute the frame span. */
    private _glFrameQueries: { query: WebGLQuery; entry: RenderEntry | ComputeEntry }[] = [];
    /** Pool of MAP_READ readback buffers (see READBACK_POOL_SIZE). Each frame
     *  resolves into a free (unmapped) one, so a pending mapAsync from a prior
     *  frame never blocks the next — every frame's gpuMs resolves and back-patches
     *  its record. The resolve buffer isn't pooled: resolveQuerySet + copy run
     *  synchronously at submit, so it's free again before the next frame. */
    private _readbackPool: GPUBuffer[] = [];

    // FPS tracking
    private _lastFinishTime = 0;
    private _deltaTimes: number[] = [];
    // Whether the current frame did any rendering. The FPS counts render frames
    // only, so a separate compute() dispatch in the same animation frame does not
    // inflate the rate.
    private _frameHadRender = false;

    get fps(): number {
        const deltas = this._deltaTimes;
        if (deltas.length === 0) return 0;
        let timeSum = 0;
        let frameSum = 0;
        for (let i = deltas.length - 1; i >= 0; i--) {
            timeSum += deltas[i];
            frameSum++;
            if (timeSum >= 1000) break;
        }
        return (frameSum * 1000) / timeSum;
    }

    // Per-frame working state
    private _frameStart = 0;
    private _currentQuerySlot = 0;
    private _pendingInspectables: InspectorNode<Any>[] = [];
    private _pendingScenes: SceneRecord[] = [];

    // Timeline entry stack - entries nest inside the current stack top
    // The stack holds "in-progress" entries that haven't been closed yet
    private _entryStack: TimelineEntry[] = [];
    // Root-level timeline entries (completed top-level entries go here)
    private _rootTimeline: TimelineEntry[] = [];
    // Map of name → stack of open entries with that name (handles same-name passes)
    private _entryRefs: Map<string, TimelineEntry[]> = new Map();

    override setRenderer(renderer: InspectableRenderer | null): void {
        if (renderer === null) {
            this._destroyTimestampGpu();
            super.setRenderer(null);
            return;
        }
        super.setRenderer(renderer);
        // GPU setup runs lazily on first begin(), by then renderer is guaranteed
        // to be initialized (the renderer asserts init before render/compute).
    }

    override init(): void {
        if (this._gpuInitialized || !this.renderer) return;

        if (this.renderer.backend === 'webgl') {
            this._initWebGLTimestamps();
            this._gpuInitialized = true;
            return;
        }

        const device = this.renderer.device;

        this.hasTimestamps = device?.features?.has('timestamp-query') ?? false;

        if (this.hasTimestamps && device) {
            this._querySet = device.createQuerySet({
                type: 'timestamp',
                count: MAX_PASSES_PER_FRAME * 2,
            });

            const resolveSize = MAX_PASSES_PER_FRAME * 2 * 8; // 2 timestamps × 8 bytes (BigInt64)
            this._resolveBuffer = device.createBuffer({
                size: resolveSize,
                usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
            });
            this._readbackPool = [];
            for (let i = 0; i < READBACK_POOL_SIZE; i++) {
                this._readbackPool.push(
                    device.createBuffer({
                        size: resolveSize,
                        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
                    }),
                );
            }
        }

        this._gpuInitialized = true;
    }

    private _destroyTimestampGpu(): void {
        // WebGPU query resources.
        this._querySet?.destroy();
        this._querySet = null;
        // GPUBuffers don't always expose destroy on all browsers; guard.
        if (this._resolveBuffer?.destroy) this._resolveBuffer.destroy();
        this._resolveBuffer = null;
        for (const b of this._readbackPool) b.destroy?.();
        this._readbackPool = [];

        // WebGL timer-query resources.
        const gl = this.renderer && this.renderer.backend === 'webgl' ? this.renderer.gl : null;
        if (gl) {
            for (const q of this._glQueryPool) gl.deleteQuery(q);
            for (const p of this._glPendingQueries) gl.deleteQuery(p.query);
            if (this._glActiveQuery) gl.deleteQuery(this._glActiveQuery.query);
        }
        this._glQueryPool = [];
        this._glPendingQueries = [];
        this._glActiveQuery = null;
        this._glFrameQueries = [];
        this._glTimerExt = null;

        this.hasTimestamps = false;
        this._gpuInitialized = false;
    }

    // -----------------------------------------------------------------------
    // WebGL GPU-timing (EXT_disjoint_timer_query_webgl2)
    // -----------------------------------------------------------------------

    /** Acquire the disjoint-timer extension if available; enables per-pass GPU timing on WebGL. */
    private _initWebGLTimestamps(): void {
        const r = this.renderer;
        if (!r || r.backend !== 'webgl' || !r.gl) return;
        // The extension exposes TIME_ELAPSED_EXT + GPU_DISJOINT_EXT; the query objects and
        // begin/end/getQueryParameter are WebGL2 core (gl.beginQuery/endQuery/getQuery).
        this._glTimerExt = r.gl.getExtension(
            'EXT_disjoint_timer_query_webgl2',
        ) as EXT_disjoint_timer_query_webgl2 | null;
        this.hasTimestamps = this._glTimerExt !== null;
    }

    /** Grab a free GL timer query, creating one if the pool is empty. */
    private _glAcquireQuery(gl: WebGL2RenderingContext): WebGLQuery | null {
        const q = this._glQueryPool.pop() ?? gl.createQuery();
        return q;
    }

    /** Begin a GL timer query around a render/compute entry (top-level only — can't nest). */
    private _glBeginQuery(entry: RenderEntry | ComputeEntry): void {
        if (!this.hasTimestamps || !this._glTimerExt) return;
        const r = this.renderer;
        if (!r || r.backend !== 'webgl' || !r.gl) return;
        // TIME_ELAPSED can't nest — if one is already open, this (nested) pass goes untimed.
        if (this._glActiveQuery) return;
        const query = this._glAcquireQuery(r.gl);
        if (!query) return;
        r.gl.beginQuery(this._glTimerExt.TIME_ELAPSED_EXT, query);
        this._glActiveQuery = { query, entry };
    }

    /** End the GL timer query for an entry, stashing it until finish() attaches the frame record. */
    private _glEndQuery(entry: RenderEntry | ComputeEntry): void {
        if (!this._glActiveQuery || this._glActiveQuery.entry !== entry) return;
        const r = this.renderer;
        if (!r || r.backend !== 'webgl' || !r.gl || !this._glTimerExt) return;
        r.gl.endQuery(this._glTimerExt.TIME_ELAPSED_EXT);
        this._glFrameQueries.push({ query: this._glActiveQuery.query, entry });
        this._glActiveQuery = null;
    }

    /**
     * Poll pending GL timer queries: any whose result is available is read (ns → ms) and back-patched
     * onto its entry + frame record, then the query returns to the pool. Disjoint results (GPU state
     * change invalidated the timing) are discarded. Called each frame from finish().
     */
    private _glPollQueries(): void {
        const r = this.renderer;
        if (!r || r.backend !== 'webgl' || !r.gl || !this._glTimerExt) return;
        const gl = r.gl;

        // GPU_DISJOINT_EXT: if the GPU changed state during timing, ALL in-flight results are bogus.
        const disjoint = gl.getParameter(this._glTimerExt.GPU_DISJOINT_EXT) as boolean;

        const stillPending: typeof this._glPendingQueries = [];
        const touchedRecords = new Set<FrameRecord>();

        for (const pending of this._glPendingQueries) {
            const available = gl.getQueryParameter(pending.query, gl.QUERY_RESULT_AVAILABLE) as boolean;
            if (!available) {
                stillPending.push(pending);
                continue;
            }
            if (disjoint) {
                // Discard: timing invalid. Recycle the query.
                this._glQueryPool.push(pending.query);
                continue;
            }
            const ns = gl.getQueryParameter(pending.query, gl.QUERY_RESULT) as number;
            this._glQueryPool.push(pending.query);
            pending.entry.gpuMs = ns / 1_000_000;
            touchedRecords.add(pending.record);
        }
        this._glPendingQueries = stillPending;

        // For each record whose queries have all landed, set the frame GPU time as the sum of its
        // entries' per-pass durations. WebGL timer queries are per-pass elapsed times (not a shared
        // clock), and gpucat's GL passes run sequentially with no overlap, so the frame GPU time is the
        // sum. gpuStartMs stays null (no shared GPU epoch on WebGL) — the timeline falls back to CPU
        // ordering for bar placement. Recomputed from the timeline so partial landings across frames
        // don't double-count.
        for (const record of touchedRecords) {
            if (this._glPendingQueries.some((p) => p.record === record)) continue;
            let sumMs = 0;
            const walk = (entries: TimelineEntry[]): void => {
                for (const e of entries) {
                    if ((e.kind === 'render' || e.kind === 'compute') && e.gpuMs !== null) sumMs += e.gpuMs;
                    if (e.children.length > 0) walk(e.children);
                }
            };
            walk(record.timeline);
            record.gpuMs = sumMs;
        }
    }

    override begin(frameId: number): void {
        // Lazy GPU setup: renderer is guaranteed initialized by the time begin()
        // runs (render/compute assert init), so this is the natural place.
        if (!this._gpuInitialized) this.init();

        this._frameStart = performance.now();
        this._currentQuerySlot = 0;
        this._pendingInspectables = [];
        this._pendingScenes = [];
        this._entryStack = [];
        this._rootTimeline = [];
        this._entryRefs.clear();
        this._frameHadRender = false;
        this._glFrameQueries = [];
        void frameId;
    }

    override finish(frameId: number): void {
        if (!this.renderer) return;

        const now = performance.now();
        const cpuMs = now - this._frameStart;

        // FPS tracking: only count frames that rendered, so a separate compute()
        // dispatch in the same animation frame does not inflate the rate. Deltas
        // span render-to-render.
        if (this._frameHadRender) {
            if (this._lastFinishTime > 0) {
                this._deltaTimes.push(now - this._lastFinishTime);
                if (this._deltaTimes.length > 60) this._deltaTimes.shift();
            }
            this._lastFinishTime = now;
        }

        // Close any unclosed entries (shouldn't happen, but be safe)
        while (this._entryStack.length > 0) {
            this._closeCurrentEntry(now);
        }

        const renderer = this.renderer;
        // Buffer/pipeline caches are WebGPU-specific; the Memory tab reads GL caches directly on WebGL,
        // so these frame-record stats are zeroed there (nothing else consumes them).
        const record: FrameRecord = {
            frameId,
            cpuMs,
            gpuMs: null,
            timeline: [...this._rootTimeline],
            bufferStats:
                renderer.backend === 'webgpu' ? getBufferCacheStats(renderer.buffers) : { bufferCount: 0, rawCount: 0 },
            pipelineStats:
                renderer.backend === 'webgpu'
                    ? pipelines.getStats(renderer.pipelines)
                    : { renderCount: 0, computeCount: 0, bindGroupLayoutCount: 0 },
            renderObjectStats: getRenderObjectsStats(renderer._renderObjects),
            inspectableNodes: [...this._pendingInspectables],
            scenes: [...this._pendingScenes],
        };

        this.frameHead = (this.frameHead + 1) % FRAME_HISTORY;
        this.frames[this.frameHead] = record;

        if (renderer.backend === 'webgpu') {
            // Async GPU timestamp resolution (WebGPU query set).
            if (
                this.hasTimestamps &&
                this._querySet &&
                this._resolveBuffer &&
                this._readbackPool.length > 0 &&
                renderer.device
            ) {
                this._resolveTimestamps(frameId, record);
            }
        } else if (this.hasTimestamps) {
            // WebGL: attach this frame's ended timer queries to the record, then poll all pending
            // queries (this + prior frames) — results land a frame or two later, back-patching gpuMs.
            for (const q of this._glFrameQueries) {
                this._glPendingQueries.push({ query: q.query, entry: q.entry, record });
            }
            this._glFrameQueries = [];
            this._glPollQueries();
        }
    }

    override beginRender(passId: string, _frameId: number): void {
        this._frameHadRender = true;
        const now = performance.now();
        const slot = this._currentQuerySlot++;
        const entry: RenderEntry = {
            kind: 'render',
            name: passId,
            startTime: now - this._frameStart,
            cpuMs: 0,
            gpuMs: null,
            gpuStartMs: null,
            querySlot: slot,
            children: [],
        };
        this._pushEntry(entry);
        if (this.renderer?.backend === 'webgl') this._glBeginQuery(entry);
    }

    override finishRender(passId: string, _frameId: number): void {
        if (this.renderer?.backend === 'webgl') {
            const stack = this._entryRefs.get(passId);
            const entry = stack?.[stack.length - 1];
            if (entry && entry.kind !== 'marker') this._glEndQuery(entry);
        }
        this._finishEntry(passId);
    }

    override getTimestampWrites(passId: string): GPURenderPassTimestampWrites | undefined {
        if (!this.hasTimestamps || !this._querySet) return undefined;

        // Find the most recently opened entry with this name
        const stack = this._entryRefs.get(passId);
        const entry = stack?.[stack.length - 1];
        if (!entry || entry.kind === 'marker') return undefined;

        const slot = (entry as RenderEntry | ComputeEntry).querySlot;
        return {
            querySet: this._querySet,
            beginningOfPassWriteIndex: slot * 2,
            endOfPassWriteIndex: slot * 2 + 1,
        };
    }

    override beginCompute(node: ComputeNode, _frameId: number): void {
        const nodeId = node.id;
        this.computeNodes.set(nodeId, node);
        const now = performance.now();
        const slot = this._currentQuerySlot++;
        const entry: ComputeEntry = {
            kind: 'compute',
            // friendly `ComputeNode.name` (from `.compute({ name })`) if set, else the
            // auto id — so labelled dispatches read as e.g. "voxel-cull" in the timeline.
            name: node.name ?? nodeId,
            startTime: now - this._frameStart,
            cpuMs: 0,
            gpuMs: null,
            gpuStartMs: null,
            querySlot: slot,
            children: [],
        };
        this._pushEntry(entry);
    }

    override finishCompute(nodeId: string, _frameId: number): void {
        this._finishEntry(nodeId);
    }

    override inspect(node: InspectorNode<Any>): void {
        this._pendingInspectables.push(node);
    }

    override beginRenderScene(
        passId: string,
        scene: Object3D,
        samples: number,
        colorFormat: string,
        _frameId: number,
    ): void {
        // Deduplicate: if the same passId fires more than once this frame (shouldn't
        // happen, but be safe) just overwrite so we always have the latest.
        const existing = this._pendingScenes.findIndex((s) => s.passId === passId);
        const record: SceneRecord = { passId, scene, samples, colorFormat };
        if (existing >= 0) {
            this._pendingScenes[existing] = record;
        } else {
            this._pendingScenes.push(record);
        }
    }

    // -----------------------------------------------------------------------
    // Public perf API - for user code to add markers
    // -----------------------------------------------------------------------

    /** Public API for adding performance markers from user code */
    readonly perf = {
        /**
         * Start a named performance marker. Can be nested.
         * Any render/compute passes or child markers will be added as children.
         */
        start: (name: string): void => {
            const now = performance.now();
            const entry: MarkerEntry = {
                kind: 'marker',
                name,
                startTime: now - this._frameStart,
                cpuMs: 0,
                children: [],
            };
            this._pushEntry(entry);
        },

        /**
         * End a named performance marker.
         * Calculates duration and closes the marker.
         */
        end: (name: string): void => {
            this._finishEntry(name);
        },
    };

    // -----------------------------------------------------------------------
    // Timeline entry management
    // -----------------------------------------------------------------------

    /** Push an entry onto the stack, nesting it under current parent if any */
    private _pushEntry(entry: TimelineEntry): void {
        const parent = this._entryStack[this._entryStack.length - 1];
        if (parent) {
            parent.children.push(entry);
        } else {
            this._rootTimeline.push(entry);
        }
        this._entryStack.push(entry);
        const stack = this._entryRefs.get(entry.name);
        if (stack) {
            stack.push(entry);
        } else {
            this._entryRefs.set(entry.name, [entry]);
        }
    }

    /** Finish an entry by name - calculates duration and pops from stack */
    private _finishEntry(name: string): void {
        const stack = this._entryRefs.get(name);
        if (!stack || stack.length === 0) return;
        const entry = stack.pop()!;
        if (stack.length === 0) this._entryRefs.delete(name);

        const now = performance.now();
        entry.cpuMs = now - this._frameStart - entry.startTime;

        const idx = this._entryStack.lastIndexOf(entry);
        if (idx >= 0) {
            this._entryStack.splice(idx, 1);
        }
    }

    /** Close the current top entry (used for unclosed entries at frame end) */
    private _closeCurrentEntry(now: number): void {
        const entry = this._entryStack.pop();
        if (!entry) return;
        entry.cpuMs = now - this._frameStart - entry.startTime;
        const stack = this._entryRefs.get(entry.name);
        if (stack) {
            const idx = stack.lastIndexOf(entry);
            if (idx >= 0) stack.splice(idx, 1);
            if (stack.length === 0) this._entryRefs.delete(entry.name);
        }
    }

    // -----------------------------------------------------------------------
    // Public query API
    // -----------------------------------------------------------------------

    /** Returns the most recent completed FrameRecord, or null. Fresh CPU + stats,
     *  but its `gpuMs` is still null (async readback lands a frame or two later). */
    resolveFrame(): FrameRecord | null {
        if (this.frameHead < 0) return null;
        return this.frames[this.frameHead];
    }

    /** Returns the newest frame whose GPU timestamps have resolved (`gpuMs !==
     *  null`), or null if none have yet. The live GPU-time display reads this so
     *  it shows a real value consistently despite readback latency, instead of
     *  the just-finished frame whose gpuMs is always still pending. */
    latestResolvedFrame(): FrameRecord | null {
        if (this.frameHead < 0) return null;
        for (let i = 0; i < FRAME_HISTORY; i++) {
            const f = this.frames[(this.frameHead - i + FRAME_HISTORY) % FRAME_HISTORY];
            if (f === null) break; // reached the unpopulated tail of the ring
            if (f.gpuMs !== null) return f;
        }
        return null;
    }

    /** Returns a slice of the last `count` frame records, oldest first. */
    getRecentFrames(count: number): FrameRecord[] {
        const result: FrameRecord[] = [];
        for (let i = 0; i < Math.min(count, FRAME_HISTORY); i++) {
            const idx = (this.frameHead - i + FRAME_HISTORY) % FRAME_HISTORY;
            const f = this.frames[idx];
            if (f) result.unshift(f);
        }
        return result;
    }

    // -----------------------------------------------------------------------
    // GPU timestamp resolution
    // -----------------------------------------------------------------------

    /** Collect all GPU entries (render/compute) from timeline tree, mapped by querySlot */
    private _collectGpuEntries(entries: TimelineEntry[], out: Map<number, RenderEntry | ComputeEntry>): void {
        for (const entry of entries) {
            if (entry.kind === 'render' || entry.kind === 'compute') {
                out.set(entry.querySlot, entry);
            }
            if (entry.children.length > 0) {
                this._collectGpuEntries(entry.children, out);
            }
        }
    }

    /**
     * Resolves GPU timestamps for a frame.
     * Checks buffer.mapState before using, skips if not 'unmapped'.
     */
    private _resolveTimestamps(frameId: number, record: FrameRecord): void {
        // Only reached on the WebGPU path (finish() guards on backend); narrow for device access.
        const renderer = this.renderer;
        if (!renderer || renderer.backend !== 'webgpu') return;
        const device = renderer.device;

        // Collect GPU entries from timeline
        const gpuEntries = new Map<number, RenderEntry | ComputeEntry>();
        this._collectGpuEntries(record.timeline, gpuEntries);

        const slotCount = Math.min(gpuEntries.size, MAX_PASSES_PER_FRAME);
        if (slotCount === 0) return;

        // Grab a free readback buffer from the pool. Only skip if the whole pool is
        // still in flight (map latency spiked past READBACK_POOL_SIZE frames) —
        // rare, and recording resumes the very next frame.
        const rb = this._readbackPool.find((b) => b.mapState === 'unmapped');
        if (!rb) return;

        // Find the max slot used to know how many to resolve
        let maxSlot = 0;
        for (const slot of gpuEntries.keys()) {
            if (slot > maxSlot) maxSlot = slot;
        }
        const slotsToResolve = maxSlot + 1;

        const encoder = device.createCommandEncoder();
        encoder.resolveQuerySet(this._querySet!, 0, slotsToResolve * 2, this._resolveBuffer!, 0);
        encoder.copyBufferToBuffer(this._resolveBuffer!, 0, rb, 0, slotsToResolve * 2 * 8);
        device.queue.submit([encoder.finish()]);

        rb.mapAsync(GPUMapMode.READ, 0, slotsToResolve * 2 * 8)
            .then(() => {
                const data = new BigUint64Array(rb.getMappedRange(0, slotsToResolve * 2 * 8));

                // Frame GPU epoch + end: earliest begin and latest end across the
                // frame's passes. GPU timestamps are on their own clock (unrelated to
                // performance.now), so each pass's begin is stored *relative* to this
                // epoch. Passes pipeline — their [begin,end] intervals overlap — so the
                // frame's real GPU time is the SPAN (maxEnd − epoch), NOT the sum of
                // per-pass durations, which double-counts the overlap.
                let epochNs: bigint | null = null;
                let maxEndNs = 0n;
                for (const [slot] of gpuEntries) {
                    const beginNs = data[slot * 2];
                    const endNs = data[slot * 2 + 1];
                    if (endNs <= beginNs) continue; // unwritten or bogus timestamp
                    if (epochNs === null || beginNs < epochNs) epochNs = beginNs;
                    if (endNs > maxEndNs) maxEndNs = endNs;
                }

                for (const [slot, entry] of gpuEntries) {
                    const beginNs = data[slot * 2];
                    const endNs = data[slot * 2 + 1];
                    if (endNs <= beginNs) continue; // unwritten or bogus timestamp
                    entry.gpuMs = Number(endNs - beginNs) / 1_000_000;
                    entry.gpuStartMs = epochNs === null ? 0 : Number(beginNs - epochNs) / 1_000_000;
                }

                // back-patches this frame's record (held by reference in the ring);
                // latestResolvedFrame() picks it up for the display next frame.
                if (epochNs !== null) record.gpuMs = Number(maxEndNs - epochNs) / 1_000_000;
                rb.unmap();
            })
            .catch(() => {
                if (rb.mapState === 'mapped') rb.unmap();
                void frameId;
            });
    }
}
