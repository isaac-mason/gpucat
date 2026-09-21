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
 * So the PRODUCER resets, at the frame boundary: `beginFrame` bumps `frameId`, zeroes the per-frame
 * counters and opens the Inspector's frame. Every pass in that frame, including a RenderTextureNode's, shares
 * it. Nothing has to be called from outside, so nothing can be forgotten, and any number of readers
 * can read the same numbers without disturbing each other.
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
    /** Device buffers resident: vertex, index, uniform and storage. */
    buffers: number;
    /** Geometries holding at least one uploaded buffer. */
    geometries: number;
    /** Textures resident on the device. */
    textures: number;
    /**
     * Estimated bytes those textures occupy. An estimate on purpose (see `core/texture-size.ts`):
     * a budget figure for finding the expensive textures, not an allocator's answer.
     */
    texturesSize: number;
    /**
     * Estimated texture bytes broken down by `GPUTextureFormat`. The format vocabulary is the same on
     * both backends, so this row set is comparable across them, unlike `backend` below.
     */
    texturesByFormat: Record<string, number>;
    /** Samplers resident on the device. */
    samplers: number;
    /**
     * Counts with no cross-backend meaning, keyed in the reporting backend's own vocabulary. Read
     * these as a leak check within one backend, never as a comparison between them: the key set
     * differs by design.
     *
     * Compiled shader variants live here rather than above, and that is not squeamishness. A GL
     * program is keyed on its source alone, because GL applies blend/depth/cull state live; a WebGPU
     * pipeline bakes that state in and is keyed on all of it. The same scene can honestly be 10
     * programs and 40 pipelines with identical workload, so one number would invite a comparison that
     * means nothing.
     */
    backend: Record<string, number>;
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
        buffers: { writeCalls: 0, writeBytes: 0, writes: [], detailedWrites: false, writeCount: 0 },
        memory: {
            buffers: 0,
            geometries: 0,
            textures: 0,
            texturesSize: 0,
            texturesByFormat: {},
            samplers: 0,
            backend: {},
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
    // the records array is POOLED: reset the live count and reuse the entries rather
    // than reallocating a few hundred objects every frame.
    info.buffers.writeCount = 0;
}

/**
 * The single usage a buffer is attributed under, when it declares several. Shared by both backends so
 * a vertex buffer is never filed as 'storage' on one and 'vertex' on the other.
 */
export function primaryBufferUsage(buffer: { usage: Set<string> }): string {
    for (const candidate of ['storage', 'index', 'vertex', 'uniform', 'indirect']) {
        if (buffer.usage.has(candidate)) return candidate;
    }
    return 'other';
}

/**
 * Attribute one `writeBuffer` to a label, updating both the totals and the
 * breakdown. Every write site goes through here so the two can never disagree.
 */
export function recordBufferWrite(
    info: RendererInfo,
    bytes: number,
    usage: string,
    full: boolean,
    label?: string,
    material?: string,
    updateType?: string,
    changedBytes?: number,
): void {
    const buffers = info.buffers;
    buffers.writeBytes += bytes;
    buffers.writeCalls++;
    if (!buffers.detailedWrites) return;

    let entry = buffers.writes[buffers.writeCount];
    if (entry === undefined) {
        entry = {
            bytes: 0,
            usage: '',
            full: false,
            label: undefined,
            material: undefined,
            updateType: undefined,
            changedBytes: undefined,
        };
        buffers.writes[buffers.writeCount] = entry;
    }
    entry.bytes = bytes;
    entry.usage = usage;
    entry.full = full;
    entry.label = label;
    entry.material = material;
    entry.updateType = updateType;
    entry.changedBytes = changedBytes;
    buffers.writeCount++;
}

/**
 * Running texture tally a backend keeps alongside its cache.
 *
 * Incremented at create/replace/destroy rather than read live at the frame boundary like the other
 * memory counters, because both backends key their texture caches by object in a WeakMap and a WeakMap
 * cannot be enumerated. Shared so the two cannot disagree about what counts or how it is bucketed.
 */
export type TextureTally = {
    count: number;
    bytes: number;
    /** bytes per `GPUTextureFormat`. */
    byFormat: Map<string, number>;
};

/**
 * What one cache entry currently contributes to the tally. Held ON the entry so a resize can subtract
 * exactly what it added, rather than recomputing a size the texture no longer has. `format: null`
 * means this entry contributes nothing yet.
 */
export type TextureTallyEntry = { format: string | null; bytes: number };

export function createTextureTally(): TextureTally {
    return { count: 0, bytes: 0, byFormat: new Map() };
}

export function createTextureTallyEntry(): TextureTallyEntry {
    return { format: null, bytes: 0 };
}

function subtract(tally: TextureTally, format: string, bytes: number): void {
    tally.bytes -= bytes;
    const remaining = (tally.byFormat.get(format) ?? 0) - bytes;
    if (remaining > 0) tally.byFormat.set(format, remaining);
    else tally.byFormat.delete(format);
}

/**
 * Set what an entry contributes, replacing whatever it contributed before. First call for an entry
 * counts a new texture; later calls (a resize or format change) move bytes without moving the count.
 */
export function tallySetTexture(tally: TextureTally, entry: TextureTallyEntry, format: string, bytes: number): void {
    if (entry.format === null) tally.count++;
    else subtract(tally, entry.format, entry.bytes);

    entry.format = format;
    entry.bytes = bytes;
    tally.bytes += bytes;
    tally.byFormat.set(format, (tally.byFormat.get(format) ?? 0) + bytes);
}

/** Drop an entry's contribution entirely. Idempotent: clearing an uncounted entry does nothing. */
export function tallyClearTexture(tally: TextureTally, entry: TextureTallyEntry): void {
    if (entry.format === null) return;
    tally.count--;
    subtract(tally, entry.format, entry.bytes);
    entry.format = null;
    entry.bytes = 0;
}

export function resetTextureTally(tally: TextureTally): void {
    tally.count = 0;
    tally.bytes = 0;
    tally.byFormat.clear();
}

/** Copy a backend's tally into the neutral snapshot. Called from the renderer's frame boundary. */
export function readTextureTally(tally: TextureTally, memory: MemoryInfo): void {
    memory.textures = tally.count;
    memory.texturesSize = tally.bytes;
    const byFormat: Record<string, number> = {};
    for (const [format, bytes] of tally.byFormat) byFormat[format] = bytes;
    memory.texturesByFormat = byFormat;
}

/** Full reset, including the cumulative call counts and the memory snapshot. */
export function resetRendererInfo(info: RendererInfo): void {
    beginInfoFrame(info);
    info.render.calls = 0;
    info.compute.calls = 0;
    info.memory.buffers = 0;
    info.memory.geometries = 0;
    info.memory.textures = 0;
    info.memory.texturesSize = 0;
    info.memory.texturesByFormat = {};
    info.memory.samplers = 0;
    info.memory.backend = {};
}
