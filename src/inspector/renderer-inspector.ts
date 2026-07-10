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

import { InspectorBase } from './inspector-base';
import type { WebGPURenderer } from '../renderer/renderer';
import type { InspectorNode, ComputeNode } from '../nodes/nodes';
import type { Object3D } from '../core/object3d';
import { getBufferCacheStats } from '../renderer/buffers';
import * as pipelines from '../renderer/pipelines';
import { getRenderObjectsStats } from '../renderer/render-objects';
import { Any } from '../schema/schema';

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
        return frameSum * 1000 / timeSum;
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

    override setRenderer(renderer: WebGPURenderer | null): void {
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
        const device = this.renderer._device;

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
        this._querySet?.destroy();
        this._querySet = null;
        // GPUBuffers don't always expose destroy on all browsers; guard.
        if (this._resolveBuffer?.destroy) this._resolveBuffer.destroy();
        this._resolveBuffer = null;
        for (const b of this._readbackPool) b.destroy?.();
        this._readbackPool = [];
        this.hasTimestamps = false;
        this._gpuInitialized = false;
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

        const record: FrameRecord = {
            frameId,
            cpuMs,
            gpuMs: null,
            timeline: [...this._rootTimeline],
            bufferStats: getBufferCacheStats(this.renderer._buffers),
            pipelineStats: pipelines.getStats(this.renderer._pipelines),
            renderObjectStats: getRenderObjectsStats(this.renderer._renderObjects),
            inspectableNodes: [...this._pendingInspectables],
            scenes: [...this._pendingScenes],
        };

        this.frameHead = (this.frameHead + 1) % FRAME_HISTORY;
        this.frames[this.frameHead] = record;

        // Async GPU timestamp resolution
        if (this.hasTimestamps && this._querySet && this._resolveBuffer && this._readbackPool.length > 0 && this.renderer._device) {
            this._resolveTimestamps(frameId, record);
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
            querySlot: slot,
            children: [],
        };
        this._pushEntry(entry);
    }

    override finishRender(passId: string, _frameId: number): void {
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
        colorFormat: GPUTextureFormat,
        _frameId: number,
    ): void {
        // Deduplicate: if the same passId fires more than once this frame (shouldn't
        // happen, but be safe) just overwrite so we always have the latest.
        const existing = this._pendingScenes.findIndex(s => s.passId === passId);
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
        const device = this.renderer!._device;
        
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
        encoder.copyBufferToBuffer(
            this._resolveBuffer!,
            0,
            rb,
            0,
            slotsToResolve * 2 * 8,
        );
        device.queue.submit([encoder.finish()]);

        rb.mapAsync(GPUMapMode.READ, 0, slotsToResolve * 2 * 8).then(() => {
            const data = new BigUint64Array(rb.getMappedRange(0, slotsToResolve * 2 * 8));
            let totalGpuNs = 0n;
            for (const [slot, entry] of gpuEntries) {
                const beginNs = data[slot * 2];
                const endNs = data[slot * 2 + 1];
                if (endNs <= beginNs) continue; // unwritten or bogus timestamp
                const durationNs = endNs - beginNs;
                entry.gpuMs = Number(durationNs) / 1_000_000;
                totalGpuNs += durationNs;
            }
            // back-patches this frame's record (held by reference in the ring);
            // latestResolvedFrame() picks it up for the display next frame.
            record.gpuMs = Number(totalGpuNs) / 1_000_000;
            rb.unmap();
        }).catch(() => {
            if (rb.mapState === 'mapped') rb.unmap();
            void frameId;
        });
    }

}
