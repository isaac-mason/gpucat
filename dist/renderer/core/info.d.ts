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
     * Per-write records for this frame, when `detailedWrites` is on. Raw and
     * ungrouped ON PURPOSE: which axis is useful - material, usage, update scope -
     * is a presentation question, and baking one in here means every new question
     * costs a renderer change. Consumers group as they see fit.
     *
     * Off by default; collecting these allocates nothing while disabled, and the
     * array is pooled so enabling it does not churn either.
     */
    writes: BufferWrite[];
    /** collect `writes`. Leave off outside a profiler / debug view. */
    detailedWrites: boolean;
    /** live length of `writes`; the array is pooled, so entries past this are stale. */
    writeCount: number;
};
/**
 * One `writeBuffer`, with whatever identity the call site genuinely has.
 *
 * The optional fields are NOT laziness: identity is asymmetric at this layer. A
 * uniform block belongs to a material, and sometimes to one object. A vertex buffer
 * belongs to a GEOMETRY and is shared by every draw using it, so "which material
 * wrote it" has no single answer - and inventing one would mislead exactly for the
 * shared buffers you would most want to attribute.
 */
export type BufferWrite = {
    bytes: number;
    /** 'vertex' | 'index' | 'uniform' | 'storage' | ... */
    usage: string;
    /** the whole allocation went up, not a queued range. */
    full: boolean;
    /** explicit `GpuBuffer.label`, when the caller set one. */
    label: string | undefined;
    /** uniform blocks only: the material whose block this is. */
    material: string | undefined;
    /**
     * uniform blocks only: how often this block is re-evaluated - 'frame', 'render'
     * or 'object'. An 'object'-scoped block writes once PER MESH, which is usually
     * the explanation for a write count that tracks scene population.
     */
    updateType: string | undefined;
    /**
     * uniform blocks only: bytes that actually differed from last frame. A 64 kB
     * block where four bytes moved is a completely different problem from one where
     * half of it did - the first is a small per-frame value dragging a large static
     * payload up with it, and splitting the block fixes it.
     */
    changedBytes: number | undefined;
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
export declare function createRendererInfo(): RendererInfo;
/**
 * Zero the per-frame counters. Called by the renderer at its top-level frame boundary, never by
 * the host — see the module header. Cumulative `calls` and the `memory` snapshot survive.
 */
export declare function beginInfoFrame(info: RendererInfo): void;
/**
 * Attribute one `writeBuffer` to a label, updating both the totals and the
 * breakdown. Every write site goes through here so the two can never disagree.
 */
export declare function recordBufferWrite(info: RendererInfo, bytes: number, usage: string, full: boolean, label?: string, material?: string, updateType?: string, changedBytes?: number): void;
/** Full reset, including the cumulative call counts and the memory snapshot. */
export declare function resetRendererInfo(info: RendererInfo): void;
