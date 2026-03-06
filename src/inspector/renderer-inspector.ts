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
import type { Node, WgslType } from '../nodes/nodes';

// ---------------------------------------------------------------------------
// Frame data types
// ---------------------------------------------------------------------------

export type PassRecord = {
    /** 'render' or 'compute' */
    kind: 'render' | 'compute';
    /** PassNode.passId or ComputeNode.id */
    id: string;
    /** CPU wall-time duration in ms */
    cpuMs: number;
    /** GPU duration in ms (null until async timestamp resolves) */
    gpuMs: number | null;
    /** Monotonic query slot index (pair: begin=slot*2, end=slot*2+1) */
    querySlot: number;
};

export type FrameRecord = {
    frameId: number;
    /** Total CPU time for the entire frame (begin→finish) in ms */
    cpuMs: number;
    /** Sum of all pass GPU times in ms (null until all resolved) */
    gpuMs: number | null;
    /** Per-pass breakdown */
    passes: PassRecord[];
    /** Snapshot of buffer/pipeline stats at frame end */
    bufferStats: { vertexCount: number; indexCount: number; storageCount: number; rawCount: number };
    pipelineStats: { readyCount: number; pendingCount: number };
    computePipelineStats: { readyCount: number; pendingCount: number };
    /** Inspectable nodes encountered this frame */
    inspectableNodes: Node<WgslType>[];
};

const FRAME_HISTORY = 512;
const MAX_PASSES_PER_FRAME = 64;

// ---------------------------------------------------------------------------
// RendererInspector
// ---------------------------------------------------------------------------

export class RendererInspector extends InspectorBase {
    /** Rolling ring buffer of frame records. */
    readonly frames: (FrameRecord | null)[] = new Array(FRAME_HISTORY).fill(null);

    /** Index of the most recently completed frame in the ring buffer. */
    frameHead = -1;

    // GPU timestamp state
    protected hasTimestamps = false;
    private _querySet: GPUQuerySet | null = null;
    private _resolveBuffer: GPUBuffer | null = null;
    private _readbackBuffer: GPUBuffer | null = null;

    // FPS tracking
    private _lastFinishTime = 0;
    private _deltaTimes: number[] = [];

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
    private _currentPasses: PassRecord[] = [];
    private _passStarts: Map<string, number> = new Map();
    private _currentQuerySlot = 0;
    private _pendingInspectables: Node<WgslType>[] = [];

    override init(): void {
        if (!this.renderer) return;
        const device = this.renderer.device;
        const adapter = this.renderer.adapter;

        this.hasTimestamps = adapter?.features?.has('timestamp-query') ?? false;

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
            this._readbackBuffer = device.createBuffer({
                size: resolveSize,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
        }
    }

    override begin(frameId: number): void {
        this._frameStart = performance.now();
        this._currentPasses = [];
        this._passStarts.clear();
        this._currentQuerySlot = 0;
        this._pendingInspectables = [];
        void frameId;
    }

    override finish(frameId: number): void {
        if (!this.renderer) return;

        const now = performance.now();
        const cpuMs = now - this._frameStart;

        // FPS tracking
        if (this._lastFinishTime > 0) {
            this._deltaTimes.push(now - this._lastFinishTime);
            if (this._deltaTimes.length > 60) this._deltaTimes.shift();
        }
        this._lastFinishTime = now;


        const record: FrameRecord = {
            frameId,
            cpuMs,
            gpuMs: null,
            passes: [...this._currentPasses],
            bufferStats: this.renderer.buffers.getStats(),
            pipelineStats: this.renderer.pipelines.getStats(),
            computePipelineStats: this.renderer.computePipelines.getStats(),
            inspectableNodes: [...this._pendingInspectables],
        };

        this.frameHead = (this.frameHead + 1) % FRAME_HISTORY;
        this.frames[this.frameHead] = record;

        // Async GPU timestamp resolution
        if (this.hasTimestamps && this._querySet && this._resolveBuffer && this._readbackBuffer && this.renderer.device) {
            this._resolveTimestamps(frameId, record);
        }
    }

    override beginRender(passId: string, _frameId: number): void {
        const slot = this._currentQuerySlot++;
        this._passStarts.set(passId, performance.now());
        const pass: PassRecord = { kind: 'render', id: passId, cpuMs: 0, gpuMs: null, querySlot: slot };
        this._currentPasses.push(pass);
        // Store a reference so finishRender can update the same object
        this._passStarts.set(`__pass_${passId}`, slot as unknown as number);
        this._storePassRef(passId, pass);
    }

    override finishRender(passId: string, _frameId: number): void {
        const start = this._passStarts.get(passId);
        if (start === undefined) return;
        const pass = this._getPassRef(passId);
        if (pass) pass.cpuMs = performance.now() - start;
        this._passStarts.delete(passId);
        this._clearPassRef(passId);
    }

    override beginCompute(nodeId: string, _frameId: number): void {
        const slot = this._currentQuerySlot++;
        this._passStarts.set(nodeId, performance.now());
        const pass: PassRecord = { kind: 'compute', id: nodeId, cpuMs: 0, gpuMs: null, querySlot: slot };
        this._currentPasses.push(pass);
        this._storePassRef(nodeId, pass);
    }

    override finishCompute(nodeId: string, _frameId: number): void {
        const start = this._passStarts.get(nodeId);
        if (start === undefined) return;
        const pass = this._getPassRef(nodeId);
        if (pass) pass.cpuMs = performance.now() - start;
        this._passStarts.delete(nodeId);
        this._clearPassRef(nodeId);
    }

    override inspect(node: Node<WgslType>): void {
        this._pendingInspectables.push(node);
    }

    // -----------------------------------------------------------------------
    // Public query API
    // -----------------------------------------------------------------------

    /** Returns the most recent completed FrameRecord, or null. */
    resolveFrame(): FrameRecord | null {
        if (this.frameHead < 0) return null;
        return this.frames[this.frameHead];
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

    /**
     * Resolves GPU timestamps for a frame.
     * Checks buffer.mapState before using, skips if not 'unmapped'.
     */
    private _resolveTimestamps(frameId: number, record: FrameRecord): void {
        const device = this.renderer!.device;
        const slotCount = Math.min(record.passes.length, MAX_PASSES_PER_FRAME);
        if (slotCount === 0) return;

        const rb = this._readbackBuffer!;

        // Check mapState before using buffer
        if (rb.mapState !== 'unmapped') return;

        const encoder = device.createCommandEncoder();
        encoder.resolveQuerySet(this._querySet!, 0, slotCount * 2, this._resolveBuffer!, 0);
        encoder.copyBufferToBuffer(
            this._resolveBuffer!,
            0,
            rb,
            0,
            slotCount * 2 * 8,
        );
        device.queue.submit([encoder.finish()]);

        // Check mapState again after submit
        if (rb.mapState !== 'unmapped') return;

        rb.mapAsync(GPUMapMode.READ, 0, slotCount * 2 * 8).then(() => {
            const data = new BigInt64Array(rb.getMappedRange(0, slotCount * 2 * 8));
            let totalGpuNs = 0n;
            for (let i = 0; i < slotCount; i++) {
                const beginNs = data[i * 2];
                const endNs = data[i * 2 + 1];
                const durationNs = endNs - beginNs;
                const gpuMs = Number(durationNs) / 1_000_000;
                const pass = record.passes[i];
                if (pass) pass.gpuMs = gpuMs;
                totalGpuNs += durationNs;
            }
            record.gpuMs = Number(totalGpuNs) / 1_000_000;
            rb.unmap();
        }).catch(() => {
            // Timestamp readback failed — GPU may not support it in this context
            if (rb.mapState === 'mapped') {
                rb.unmap();
            }
            void frameId;
        });
    }

    // -----------------------------------------------------------------------
    // Pass reference tracking (maps passId → PassRecord for in-flight updates)
    // -----------------------------------------------------------------------

    private readonly _passRefs: Map<string, PassRecord> = new Map();

    private _storePassRef(id: string, pass: PassRecord): void {
        this._passRefs.set(id, pass);
    }

    private _getPassRef(id: string): PassRecord | undefined {
        return this._passRefs.get(id);
    }

    private _clearPassRef(id: string): void {
        this._passRefs.delete(id);
    }
}
