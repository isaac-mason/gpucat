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
     * Uniform uses this frame that took a dynamic allocation, because an earlier pass or dispatch had
     * already read their block's own buffer with different bytes. Zero while each block is used once a
     * frame; a count that tracks pass or draw count points at a value changing between passes.
     */
    dynamicAllocations: number;
    /** Bytes those allocations packed. */
    dynamicAllocationBytes: number;
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
 *
 * Bytes are what gpucat asked the device for: exact for buffers, an estimate for textures (format x
 * dimensions x mips x layers x samples, see `core/texture-size.ts`), since neither API reports what a driver
 * actually allocates. The canvas's own swapchain is the browser's and is not counted.
 */
export type MemoryInfo = {
    /** Device buffers resident: vertex, index, uniform, storage, indirect, and the uniform ring. */
    buffers: number;
    buffersSize: number;
    /** Textures resident on the device, render targets and renderbuffers included. */
    textures: number;
    texturesSize: number;
    /** `buffersSize + texturesSize`. */
    totalSize: number;
    /**
     * Bytes by `kind/category`: `buffer/vertex`, `buffer/storage`, `texture/sampled`, `texture/msaa`, ... See
     * `AllocationCategory`. On WebGL a storage buffer that shaders read is lowered to a texture, and shows as
     * `texture/storage-backing` under the buffer's label.
     */
    byCategory: Record<string, number>;
    /**
     * Texture bytes by `GPUTextureFormat`. The format vocabulary is the same on both backends, so this row
     * set is comparable across them, unlike `backend` below.
     */
    texturesByFormat: Record<string, number>;
    /** Geometries holding at least one uploaded buffer. */
    geometries: number;
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
        buffers: {
            writeCalls: 0,
            writeBytes: 0,
            dynamicAllocations: 0,
            dynamicAllocationBytes: 0,
            writes: [],
            detailedWrites: false,
            writeCount: 0,
        },
        memory: {
            buffers: 0,
            buffersSize: 0,
            textures: 0,
            texturesSize: 0,
            totalSize: 0,
            byCategory: {},
            texturesByFormat: {},
            geometries: 0,
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
    info.buffers.dynamicAllocations = 0;
    info.buffers.dynamicAllocationBytes = 0;
    // the records array is POOLED: reset the live count and reuse the entries rather
    // than reallocating a few hundred objects every frame.
    info.buffers.writeCount = 0;
}

/**
 * The single usage a buffer is attributed under, when it declares several. Shared by both backends so
 * a vertex buffer is never filed as 'storage' on one and 'vertex' on the other.
 */
export function primaryBufferUsage(buffer: { usage: Set<string> }): BufferUsageCategory {
    for (const candidate of BUFFER_USAGE_PRIORITY) {
        if (buffer.usage.has(candidate)) return candidate;
    }
    return 'other';
}

type BufferUsageCategory = 'storage' | 'index' | 'vertex' | 'uniform' | 'indirect' | 'other';
const BUFFER_USAGE_PRIORITY = ['storage', 'index', 'vertex', 'uniform', 'indirect'] as const;

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

export type AllocationKind = 'buffer' | 'texture';

/**
 * What an allocation is for. Buffers take their primary usage, or `uniform-ring` for the dynamic uniform
 * pool. Textures: `sampled` (a `GpuTexture`), `render-target` and `depth` (a target's attachments), `msaa`
 * (a multisampled attachment), `storage-backing` (WebGL's texture lowering of a storage buffer).
 */
export type AllocationCategory =
    | 'vertex'
    | 'index'
    | 'storage'
    | 'indirect'
    | 'uniform'
    | 'uniform-ring'
    | 'other'
    | 'sampled'
    | 'render-target'
    | 'depth'
    | 'msaa'
    | 'storage-backing';

/**
 * One GPU allocation's contribution to the tally, held on the cache entry that owns the GPU object so a
 * resize moves exactly the bytes it added, rather than recomputing a size the object no longer has.
 */
export type Allocation = {
    kind: AllocationKind;
    category: AllocationCategory;
    /** `kind/category`, the `byCategory` key, built when the category changes rather than per read. */
    categoryKey: string;
    /** textures: the `GPUTextureFormat` (or GL's equivalent name); buffers: ''. */
    format: string;
    /** the resource's label, else the name its upload site gave, else 'unlabelled'. */
    label: string;
    bytes: number;
    /** counted in the tally; false until the first `setAllocation` and after `clearAllocation`. */
    live: boolean;
};

/**
 * Running totals of everything a backend holds on the GPU, the PlayCanvas `device._vram` and Godot
 * `buffer_memory`/`texture_memory` model: every allocation site adjusts it at create, resize and destroy, so
 * reading it costs nothing. One per backend, shared by its buffer, texture and render-target caches.
 *
 * `live` exists for the on-demand report: the caches key by object in WeakMaps, which cannot be walked.
 */
export type MemoryTally = {
    live: Set<Allocation>;
    buffers: number;
    buffersSize: number;
    textures: number;
    texturesSize: number;
    byCategory: Map<string, number>;
    texturesByFormat: Map<string, number>;
    /** bumped on every change, so a frame where nothing was allocated skips copying the breakdowns */
    version: number;
    /** the version and the records the breakdowns were last copied into */
    copiedVersion: number;
    copiedInto: Record<string, number> | null;
};

export function createMemoryTally(): MemoryTally {
    return {
        live: new Set(),
        buffers: 0,
        buffersSize: 0,
        textures: 0,
        texturesSize: 0,
        byCategory: new Map(),
        texturesByFormat: new Map(),
        version: 0,
        copiedVersion: -1,
        copiedInto: null,
    };
}

/**
 * What a texture's allocation is labelled: its own label, under its render target's when the target has one
 * (`shadows/depth`). The texture's label alone is its attachment name, which `mrt()` keys on, so the target
 * adds identity without renaming it.
 */
export function textureAllocationLabel(texture: {
    label: string | undefined;
    renderTarget: { label: string | undefined } | null;
}): string {
    const own = texture.label ?? 'unlabelled';
    const target = texture.renderTarget?.label;
    return target ? `${target}/${own}` : own;
}

export function createAllocation(kind: AllocationKind, category: AllocationCategory, label: string): Allocation {
    return { kind, category, categoryKey: `${kind}/${category}`, format: '', label, bytes: 0, live: false };
}

function addTo(map: Map<string, number>, key: string, bytes: number): void {
    const total = (map.get(key) ?? 0) + bytes;
    if (total > 0) map.set(key, total);
    else map.delete(key);
}

function contribute(tally: MemoryTally, allocation: Allocation, sign: 1 | -1): void {
    tally.version++;
    const bytes = sign * allocation.bytes;
    if (allocation.kind === 'buffer') {
        tally.buffers += sign;
        tally.buffersSize += bytes;
    } else {
        tally.textures += sign;
        tally.texturesSize += bytes;
        addTo(tally.texturesByFormat, allocation.format, bytes);
    }
    addTo(tally.byCategory, allocation.categoryKey, bytes);
}

/**
 * Set what an allocation contributes, replacing whatever it contributed before: the first call counts it,
 * a later one (a resize, a format change) moves its bytes without moving the count.
 */
export function setAllocation(
    tally: MemoryTally,
    allocation: Allocation,
    bytes: number,
    category: AllocationCategory = allocation.category,
    format: string = allocation.format,
): void {
    if (allocation.live) contribute(tally, allocation, -1);
    else {
        allocation.live = true;
        tally.live.add(allocation);
    }
    if (category !== allocation.category) {
        allocation.category = category;
        allocation.categoryKey = `${allocation.kind}/${category}`;
    }
    allocation.format = format;
    allocation.bytes = bytes;
    contribute(tally, allocation, 1);
}

/** Drop an allocation's contribution entirely. Idempotent: clearing one that is not live does nothing. */
export function clearAllocation(tally: MemoryTally, allocation: Allocation): void {
    if (!allocation.live) return;
    contribute(tally, allocation, -1);
    allocation.live = false;
    allocation.bytes = 0;
    tally.live.delete(allocation);
}

/** Forget everything, for a cache teardown that releases its GPU objects wholesale. */
export function resetMemoryTally(tally: MemoryTally): void {
    for (const allocation of tally.live) {
        allocation.live = false;
        allocation.bytes = 0;
    }
    tally.live.clear();
    tally.buffers = 0;
    tally.buffersSize = 0;
    tally.textures = 0;
    tally.texturesSize = 0;
    tally.byCategory.clear();
    tally.texturesByFormat.clear();
    tally.version++;
}

/** Copy a map into a record kept across frames, so a settled scene allocates nothing here. */
function copyInto(record: Record<string, number>, map: Map<string, number>): void {
    for (const key in record) if (!map.has(key)) delete record[key];
    for (const [key, bytes] of map) record[key] = bytes;
}

/** Copy the tally into the neutral snapshot. Called from the renderer's frame boundary. */
export function readMemoryTally(tally: MemoryTally, memory: MemoryInfo): void {
    memory.buffers = tally.buffers;
    memory.buffersSize = tally.buffersSize;
    memory.textures = tally.textures;
    memory.texturesSize = tally.texturesSize;
    memory.totalSize = tally.buffersSize + tally.texturesSize;
    // `resetRendererInfo` swaps in fresh records, which need filling even when nothing changed
    if (tally.copiedVersion === tally.version && tally.copiedInto === memory.byCategory) return;
    copyInto(memory.byCategory, tally.byCategory);
    copyInto(memory.texturesByFormat, tally.texturesByFormat);
    tally.copiedVersion = tally.version;
    tally.copiedInto = memory.byCategory;
}

/** One row of `memoryReport`: a copy, the caller's to keep, sort and group. */
export type AllocationReport = {
    kind: AllocationKind;
    category: AllocationCategory;
    format: string;
    label: string;
    bytes: number;
};

/** Every live allocation, largest first; `memoryReport` is the public entry. */
export function reportAllocations(tally: MemoryTally): AllocationReport[] {
    const rows: AllocationReport[] = [];
    for (const allocation of tally.live) {
        rows.push({
            kind: allocation.kind,
            category: allocation.category,
            format: allocation.format,
            label: allocation.label,
            bytes: allocation.bytes,
        });
    }
    rows.sort((a, b) => b.bytes - a.bytes);
    return rows;
}

/** Full reset, including the cumulative call counts and the memory snapshot. */
export function resetRendererInfo(info: RendererInfo): void {
    beginInfoFrame(info);
    info.render.calls = 0;
    info.compute.calls = 0;
    info.memory.buffers = 0;
    info.memory.buffersSize = 0;
    info.memory.textures = 0;
    info.memory.texturesSize = 0;
    info.memory.totalSize = 0;
    info.memory.byCategory = {};
    info.memory.texturesByFormat = {};
    info.memory.geometries = 0;
    info.memory.samplers = 0;
    info.memory.backend = {};
}
