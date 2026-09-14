/**
 * info.ts (renderer core) — per-frame render statistics, the backend-neutral counterpart to
 * three.js `renderer.info`.
 *
 * WHO RESETS. three.js resets from its own rAF loop (`Animation.js`, gated on `info.autoReset`);
 * PlayCanvas has no reset at all and instead DRAINS each counter as it is read
 * (`framework/stats.js`: `stats.drawCalls.total = device._drawCallsPerFrame; device._drawCallsPerFrame = 0`).
 * Neither ports here. gpucat owns no loop to reset from, and drain-on-read only works with exactly
 * one reader — we have two independent ones, the host's debug panel and gpucat's own Inspector, and
 * whichever read first would zero the other's numbers.
 *
 * So the PRODUCER resets, at the frame boundary the renderer already keeps: the depth-guarded
 * `_renderCallDepth === 0` block that bumps `frameId` and opens the Inspector's frame. Nested
 * renders (PassNode) and render-to-target passes run at depth > 0 and share the frame, exactly as
 * they already share a `frameId`. Nothing has to be called from outside, so nothing can be
 * forgotten, and any number of readers can read the same numbers without disturbing each other.
 *
 * Counters are therefore LAST COMPLETE FRAME while a frame is in flight, which is what a panel
 * wants anyway. `calls` is the one cumulative figure (session totals, free to keep); everything
 * else is per-frame. `memory` is a snapshot refreshed at the same boundary.
 */

/** Per-frame draw statistics. */
export type RenderInfo = {
    /** Top-level `render()` calls since renderer creation. Never reset. */
    calls: number;
    /** Top-level `render()` calls this frame (> 1 when rendering to targets). */
    frameCalls: number;
    /** Draw commands issued this frame, indirect ones included. */
    drawCalls: number;
    /**
     * Triangles this frame, from CPU-known vertex/index counts. Indirect draws contribute their
     * draw call but NOT their triangles: the counts live in a GPU buffer the CPU never reads, so
     * the honest figure is a floor, not a guess.
     */
    triangles: number;
};

/** Per-frame compute statistics. */
export type ComputeInfo = {
    /** Top-level `compute()` calls since renderer creation. Never reset. */
    calls: number;
    /** Top-level `compute()` calls this frame. */
    frameCalls: number;
};

/** Per-frame buffer upload volume — the CPU cost of feeding the GPU. */
export type BufferInfo = {
    /** `queue.writeBuffer` calls this frame. */
    writeCalls: number;
    /**
     * Bytes handed to `queue.writeBuffer` this frame. Read WITH `writeCalls`: the pair separates a
     * batch re-uploading its whole capacity when one slot changed (bytes spike, calls flat) from a
     * caller queueing many tiny ranges (calls spike, bytes flat).
     */
    writeBytes: number;
    /**
     * Per-buffer breakdown of this frame's writes, keyed by `GpuBuffer.label`.
     *
     * `writeBytes` alone says how much went up but not what sent it, which is the
     * only question worth asking once the number looks wrong. `full` is the field
     * that earns its place: a buffer marked `needsUpdate` with NO queued range
     * re-uploads its entire allocation, and a big buffer doing that every frame is
     * indistinguishable from legitimate range writes in the totals.
     *
     * Entries persist across frames and are zeroed rather than deleted, so a label
     * that stops uploading reads 0 instead of vanishing from the listing - and the
     * map does not churn on the hot path.
     */
    byLabel: Map<string, BufferWriteInfo>;
};

/** one label's share of a frame's buffer writes. */
export type BufferWriteInfo = {
    bytes: number;
    calls: number;
    /** writes that re-sent the WHOLE buffer rather than a queued range. */
    full: number;
};

/**
 * Resident GPU objects — a snapshot, not a rate, refreshed at the frame boundary. These should sit
 * flat once a scene settles; a count that climbs frame over frame is a leak rather than a workload.
 */
export type MemoryInfo = {
    buffers: number;
    rawBuffers: number;
    renderPipelines: number;
    computePipelines: number;
    bindGroupLayouts: number;
};

export type RendererInfo = {
    render: RenderInfo;
    compute: ComputeInfo;
    buffers: BufferInfo;
    memory: MemoryInfo;
};

export function createRendererInfo(): RendererInfo {
    return {
        render: { calls: 0, frameCalls: 0, drawCalls: 0, triangles: 0 },
        compute: { calls: 0, frameCalls: 0 },
        buffers: { writeCalls: 0, writeBytes: 0, byLabel: new Map() },
        memory: {
            buffers: 0,
            rawBuffers: 0,
            renderPipelines: 0,
            computePipelines: 0,
            bindGroupLayouts: 0,
        },
    };
}

/**
 * Zero the per-frame counters. Called by the renderer at its top-level frame boundary, never by
 * the host — see the module header. Cumulative `calls` and the `memory` snapshot survive.
 */
export function beginInfoFrame(info: RendererInfo): void {
    info.render.frameCalls = 0;
    info.render.drawCalls = 0;
    info.render.triangles = 0;
    info.compute.frameCalls = 0;
    info.buffers.writeCalls = 0;
    info.buffers.writeBytes = 0;
    // zero in place; see `byLabel` on why entries are kept rather than cleared.
    for (const entry of info.buffers.byLabel.values()) {
        entry.bytes = 0;
        entry.calls = 0;
        entry.full = 0;
    }
}

/**
 * Attribute one `writeBuffer` to a label, updating both the totals and the
 * breakdown. Every write site goes through here so the two can never disagree.
 */
export function recordBufferWrite(info: RendererInfo, label: string, bytes: number, full: boolean): void {
    info.buffers.writeBytes += bytes;
    info.buffers.writeCalls++;
    let entry = info.buffers.byLabel.get(label);
    if (entry === undefined) {
        entry = { bytes: 0, calls: 0, full: 0 };
        info.buffers.byLabel.set(label, entry);
    }
    entry.bytes += bytes;
    entry.calls++;
    if (full) entry.full++;
}

/** Full reset, including the cumulative call counts and the memory snapshot. */
export function resetRendererInfo(info: RendererInfo): void {
    beginInfoFrame(info);
    info.render.calls = 0;
    info.compute.calls = 0;
    info.memory.buffers = 0;
    info.memory.rawBuffers = 0;
    info.memory.renderPipelines = 0;
    info.memory.computePipelines = 0;
    info.memory.bindGroupLayouts = 0;
}
