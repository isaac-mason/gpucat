import type { GpuBuffer } from '../../core/gpu-buffer';
import type { Geometry } from '../../geometry/geometry';
import type { StorageNode } from '../../nodes/nodes';
import type { Any } from '../../schema/schema';
/** the one usage worth reporting, most specific first. A buffer often carries several
 *  flags (`storage` + `vertex`), and the specific one is what identifies it. */
import { BufferUpload, planBufferUpload } from '../core/buffer-upload';
import type { RendererInfo } from '../core/info';
import { primaryBufferUsage, recordBufferWrite } from '../core/info';

type CacheEntry = { buf: GPUBuffer; version: number };

export type BufferCache = {
    /** All GpuBuffer -> GPUBuffer mappings, regardless of usage. */
    bufferMap: WeakMap<GpuBuffer, CacheEntry>;

    /** Plain-object-keyed buffers (instance matrices, material UBOs, camera, time). */
    rawMap: WeakMap<object, GPUBuffer>;

    /** Mutable stats counters (approximate, tracks allocations, not deallocations) */
    bufferCount: number;
    rawCount: number;

    /** Where upload volume is tallied. Held by reference rather than counted locally so the
     *  frame boundary that zeroes it stays in ONE place (the renderer), and so every reader
     *  sees the same numbers — see `renderer/core/info.ts`. */
    info: RendererInfo;

    /** Allocations for uniform uses that cannot read their block's own buffer. See `allocDynamicUniform`. */
    dynamicUniforms: DynamicUniformBuffers;
};

/**
 * PlayCanvas's `DynamicBuffers`. A uniform block used again in a frame with different bytes cannot rewrite
 * its own buffer (the earlier use would read the write, since every write lands before the frame's
 * submit), so that use takes an aligned allocation here, written into a mapped staging buffer and bound
 * with a dynamic offset. At submit the staging buffers are copied into their GPU buffers by a command
 * buffer placed ahead of the frame's, then remapped for reuse. No allocation is written twice in a frame.
 */
export type DynamicUniformBuffers = {
    /** Free GPU buffers. One returns here as soon as its copy is scheduled: the copy runs before any later pass. */
    gpuBuffers: DynamicGpuBuffer[];
    /** Staging buffers mapped for writing. */
    stagingBuffers: StagingBuffer[];
    /** CPU copies, free again as soon as their submit has written them. */
    cpuStagingBuffers: StagingBuffer[];
    /** Filled, waiting for the submit that copies them. */
    usedBuffers: UsedBuffer[];
    active: UsedBuffer | null;
    /** Submitted, waiting for `mapAsync` before they take allocations again. */
    pendingStagingBuffers: StagingBuffer[];
    /** Mapped staging buffers alive, capped by `MAX_MAPPED_STAGING_BUFFERS`. */
    mappedStagingCount: number;
    /** CPU copies created. */
    cpuStagingCount: number;
    nextBufferId: number;
    destroyed: boolean;
};

/** `id` is what a binding records, so neutral code never holds a GPU type. */
type DynamicGpuBuffer = { buffer: GPUBuffer; id: number };
/** `buffer` is null for a CPU copy, which the submit uploads with a queue write instead of a copy. */
type StagingBuffer = { buffer: GPUBuffer | null; view: DataView<ArrayBuffer> };
type UsedBuffer = { gpuBuffer: DynamicGpuBuffer; staging: StagingBuffer; size: number };

/** PlayCanvas's WebGPU device size for these buffers. */
const DYNAMIC_BUFFER_BYTES = 100 * 1024;

/**
 * A mapped staging buffer only returns once `mapAsync` resolves, which needs the event loop to turn, so
 * frames submitted back to back within one task would otherwise create one per frame without bound.
 * Past this many, a dynamic buffer is filled through a CPU copy instead.
 */
const MAX_MAPPED_STAGING_BUFFERS = 8;

function createDynamicUniformBuffers(): DynamicUniformBuffers {
    return {
        gpuBuffers: [],
        stagingBuffers: [],
        cpuStagingBuffers: [],
        usedBuffers: [],
        active: null,
        pendingStagingBuffers: [],
        mappedStagingCount: 0,
        cpuStagingCount: 0,
        nextBufferId: 0,
        destroyed: false,
    };
}

export type BufferCacheStats = {
    bufferCount: number;
    rawCount: number;
};

export function createBufferCache(info: RendererInfo): BufferCache {
    return {
        bufferMap: new WeakMap(),
        rawMap: new WeakMap(),
        bufferCount: 0,
        rawCount: 0,
        info,
        dynamicUniforms: createDynamicUniformBuffers(),
    };
}

/**
 * Chained, not assigned: another module may already hang a callback on this buffer's dispose, and
 * whichever registers second must not drop the first. Mirrors `webgl/buffers.ts`.
 */
function setupDispose(cache: BufferCache, buffer: GpuBuffer): void {
    const previous = buffer._onDispose;
    buffer._onDispose = () => {
        previous?.();
        const entry = cache.bufferMap.get(buffer);
        if (!entry) return;
        entry.buf.destroy();
        cache.bufferCount--;
        cache.bufferMap.delete(buffer);
    };
}

/**
 * Derive GPUBufferUsage flags from a GpuBuffer's usage set.
 */
function deriveGPUUsage(buffer: GpuBuffer): GPUBufferUsageFlags {
    let flags = GPUBufferUsage.COPY_DST;

    if (buffer.usage.has('vertex')) flags |= GPUBufferUsage.VERTEX;
    if (buffer.usage.has('index')) flags |= GPUBufferUsage.INDEX;
    if (buffer.usage.has('storage')) flags |= GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
    if (buffer.usage.has('indirect')) flags |= GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE;
    if (buffer.usage.has('uniform')) flags |= GPUBufferUsage.UNIFORM;

    return flags;
}

/**
 * Ensure a GpuBuffer is uploaded to the GPU, creating the GPUBuffer on first
 * use and re-uploading when the version advances or updateRanges are pending.
 *
 * This is the single upload function for all GpuBuffer types (vertex, index,
 * storage, indirect). GPU usage flags are derived from `buffer.usage`.
 */
/** `name` identifies the buffer in the per-frame upload breakdown. Required, not optional: every
 *  call site knows what it is binding, and a name is call-site knowledge - the same buffer can be
 *  bound under different attribute names, so it cannot live on the buffer. */
export function ensureUploaded(cache: BufferCache, device: GPUDevice, buffer: GpuBuffer, name: string): GPUBuffer {
    const entry = cache.bufferMap.get(buffer);
    const plan = planBufferUpload(buffer, entry !== undefined, entry?.buf.size ?? 0, entry?.version ?? -1);

    if (plan === BufferUpload.Skip) {
        if (!entry) {
            throw new Error('[gpucat] ensureUploaded: buffer.array is null but GPU buffer was never created');
        }
        return entry.buf;
    }

    // non-null past the plan: Skip is the only outcome for a released array.
    const arr = buffer.array!;
    const usage = primaryBufferUsage(buffer);
    const label = buffer.label ?? name;

    if (plan === BufferUpload.Allocate) {
        entry?.buf.destroy();
        // 4-byte alignment is a device requirement, so the size is decided here, not in the plan.
        const buf = device.createBuffer({ size: alignTo4(arr.byteLength), usage: deriveGPUUsage(buffer) });
        // Both under the same guard: a reallocation must not count twice, nor hook dispose twice.
        if (!entry) {
            cache.bufferCount++;
            setupDispose(cache, buffer);
        }

        device.queue.writeBuffer(buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        recordBufferWrite(cache.info, arr.byteLength, usage, true, label);
        cache.bufferMap.set(buffer, { buf, version: buffer.version });

        // the allocate path wrote everything, so pending ranges are already covered; dropping them
        // stops the next frame replaying them as a redundant partial write.
        buffer.clearUpdateRanges();
        buffer.onUpload?.();
        return buf;
    }

    const { buf } = entry!;

    if (plan === BufferUpload.Partial) {
        // Ranges are flat component indices and arrive already merged.
        const bytesPerComponent = arr.BYTES_PER_ELEMENT;
        for (let i = 0; i < buffer.updateRangeCount; i++) {
            const { start, count } = buffer.updateRanges[i]!;
            const byteOffset = start * bytesPerComponent;
            const byteCount = count * bytesPerComponent;
            device.queue.writeBuffer(buf, byteOffset, arr.buffer as ArrayBuffer, arr.byteOffset + byteOffset, byteCount);
            recordBufferWrite(cache.info, byteCount, usage, false, label);
        }
        buffer.clearUpdateRanges();
    } else {
        device.queue.writeBuffer(buf, 0, arr.buffer as ArrayBuffer, arr.byteOffset, arr.byteLength);
        recordBufferWrite(cache.info, arr.byteLength, usage, true, label);
    }
    entry!.version = buffer.version;
    return buf;
}

/**
 * Return the GPUBuffer for an already-uploaded GpuBuffer, or undefined
 * if it has not been uploaded yet.
 *
 * This is a pure lookup, no data transfer occurs.
 */
export function getUploaded(cache: BufferCache, buffer: GpuBuffer): GPUBuffer | undefined {
    return cache.bufferMap.get(buffer)?.buf;
}

/**
 * Resolve a GpuBuffer from a StorageNode.
 *
 * For named references, lookup order is: `buffers` (per-call override) → `geometry.buffers`.
 * For value references, the buffer is taken from node.value.
 */
export function resolveStorageBuffer(
    node: StorageNode<Any>,
    geometry: Geometry | null,
    buffers: Record<string, GpuBuffer<Any>> | null,
): GpuBuffer {
    if (node.isNamedReference) {
        const name = node.bufferName!;
        const buffer = buffers?.[name] ?? geometry?.buffers.get(name);

        if (!buffer) {
            throw new Error(
                `[gpucat] resolveStorageBuffer: buffer '${name}' not found in compute buffers map or geometry.buffers`,
            );
        }

        return buffer;
    } else {
        const buffer = node.value;
        if (!buffer) {
            throw new Error('[gpucat] resolveStorageBuffer: node.value is null');
        }
        return buffer;
    }
}

// Raw buffers (object-keyed, for UBOs and BufferAttributeNodes)

/**
 * Result of uploadRaw - includes buffer and whether it was newly created.
 */
export type UploadRawResult = {
    buffer: GPUBuffer;
    /** True if the buffer was newly created (requires bind group rebuild) */
    created: boolean;
};

/**
 * Get or create a uniform/storage GPUBuffer identified by a JS object key.
 * Always writes `data` to the buffer (caller decides when to call this).
 * Returns both the buffer and whether it was newly created/resized.
 */
/** identity for a raw write, supplied by callers that have it (uniform blocks do). */
export type RawWriteDetail = {
    material?: string;
    updateType?: string;
    changedBytes?: number;
};

/**
 * Upload one packed uniform block, identified by an arbitrary key.
 *
 * The one case with no `GpuBuffer` to gate on: a block is a byte blob packed from many uniform nodes
 * through a compile-time layout, double-buffered so the binding can diff it, with no version of its
 * own. Change detection is the caller's (`packAndCompare`), so this writes unconditionally.
 *
 * `ArrayBuffer`, not a typed array, so anything carrying a version cannot be passed here - those go
 * through `ensureUploaded`.
 */
export function uploadUniformBlock(
    cache: BufferCache,
    device: GPUDevice,
    key: object,
    data: ArrayBuffer,
    detail?: RawWriteDetail,
): UploadRawResult {
    let buf = cache.rawMap.get(key);
    const byteLength = alignTo4(data.byteLength);
    const isNew = !buf;
    let created = false;

    if (!buf || buf.size < byteLength) {
        buf?.destroy();
        buf = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        cache.rawMap.set(key, buf);
        created = true;
        if (isNew) {
            cache.rawCount++;
        }
    }

    // raw path: no GpuBuffer, so no label. `full` is FALSE on purpose - this path has
    // no concept of ranges, so it always writes everything, and flagging it would make
    // the "full re-upload" signal tautological exactly where it matters most. Identity
    // comes from `detail`, which the uniform-binding caller fills in.
    device.queue.writeBuffer(buf, 0, data, 0, data.byteLength);
    recordBufferWrite(
        cache.info,
        data.byteLength,
        'uniform',
        false,
        undefined,
        detail?.material,
        detail?.updateType,
        detail?.changedBytes,
    );
    return { buffer: buf, created };
}

/**
 * Get a previously created raw buffer, or undefined.
 * Does NOT upload, use uploadRaw for that.
 */
export function getRaw(cache: BufferCache, key: object): GPUBuffer | undefined {
    return cache.rawMap.get(key);
}

/**
 * Tear down the cache (called on renderer dispose).
 *
 * `device.destroy()` releases the GPU buffers, so this resets JS state: the maps are REPLACED rather
 * than emptied so a `GpuBuffer` outliving its renderer cannot find a stale entry and destroy through a
 * dead device. The WebGL sibling does the same.
 */
export function disposeBufferCache(cache: BufferCache): void {
    cache.bufferMap = new WeakMap();
    cache.rawMap = new WeakMap();
    cache.bufferCount = 0;
    cache.rawCount = 0;
    // A handed-in device outlives the renderer, so these are released here rather than with it.
    destroyDynamicUniforms(cache.dynamicUniforms);
    cache.dynamicUniforms = createDynamicUniformBuffers();
}

/**
 * Takes an aligned allocation of `size` bytes and returns its offset. It lands in `dynamicUniforms.active`,
 * whose staging view the caller packs into and whose GPU buffer the caller binds at that offset.
 */
export function allocDynamicUniform(cache: BufferCache, device: GPUDevice, size: number): number {
    if (size > DYNAMIC_BUFFER_BYTES) {
        throw new Error(`[gpucat] a ${size}-byte uniform block is larger than a ${DYNAMIC_BUFFER_BYTES}-byte dynamic buffer`);
    }
    const buffers = cache.dynamicUniforms;
    const align = device.limits.minUniformBufferOffsetAlignment;

    // A full active buffer is done: schedule it for the submit.
    if (buffers.active !== null && DYNAMIC_BUFFER_BYTES - roundUp(buffers.active.size, align) < size) {
        buffers.usedBuffers.push(buffers.active);
        buffers.active = null;
    }

    if (buffers.active === null) {
        const gpuBuffer = buffers.gpuBuffers.pop() ?? {
            buffer: device.createBuffer({
                label: 'dynamic-uniforms',
                size: DYNAMIC_BUFFER_BYTES,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            }),
            id: buffers.nextBufferId++,
        };
        buffers.active = { gpuBuffer, staging: takeStagingBuffer(buffers, device), size: 0 };
    }

    const active = buffers.active;
    const offset = roundUp(active.size, align);
    active.size = offset + size;
    cache.info.buffers.dynamicAllocations++;
    cache.info.buffers.dynamicAllocationBytes += size;
    return offset;
}

/** A remapped staging buffer when one is back, a new one under the cap, else a CPU copy. */
function takeStagingBuffer(buffers: DynamicUniformBuffers, device: GPUDevice): StagingBuffer {
    const mapped = buffers.stagingBuffers.pop();
    if (mapped !== undefined) return mapped;
    if (buffers.mappedStagingCount < MAX_MAPPED_STAGING_BUFFERS) {
        buffers.mappedStagingCount++;
        return createStagingBuffer(device);
    }
    const cpuCopy = buffers.cpuStagingBuffers.pop();
    if (cpuCopy !== undefined) return cpuCopy;
    buffers.cpuStagingCount++;
    return { buffer: null, view: new DataView(new ArrayBuffer(DYNAMIC_BUFFER_BYTES)) };
}

/**
 * Resident dynamic uniform buffers and staging (mapped or CPU). Pools only grow until dispose, so these
 * settle at the peak a scene needs; one that climbs frame over frame means allocations are not returning.
 */
export function getDynamicUniformStats(cache: BufferCache): { gpuBuffers: number; stagingBuffers: number } {
    const buffers = cache.dynamicUniforms;
    return { gpuBuffers: buffers.nextBufferId, stagingBuffers: buffers.mappedStagingCount + buffers.cpuStagingCount };
}

function createStagingBuffer(device: GPUDevice): StagingBuffer {
    const buffer = device.createBuffer({
        label: 'dynamic-uniforms-staging',
        size: DYNAMIC_BUFFER_BYTES,
        usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
        mappedAtCreation: true,
    });
    return { buffer, view: new DataView(buffer.getMappedRange()) };
}

/** The GPU buffer a binding recorded by id, for building the bind group that addresses it. */
export function dynamicUniformBuffer(cache: BufferCache, id: number): GPUBuffer {
    const buffers = cache.dynamicUniforms;
    if (buffers.active?.gpuBuffer.id === id) return buffers.active.gpuBuffer.buffer;
    for (const used of buffers.usedBuffers) if (used.gpuBuffer.id === id) return used.gpuBuffer.buffer;
    throw new Error(`[gpucat] dynamic uniform buffer ${id} is not part of this frame`);
}

/**
 * Unmaps every staging buffer filled since the last submit and records their copies into their GPU
 * buffers, in a command buffer the frame submits ahead of its own. Returns null when nothing was written.
 */
export function submitDynamicUniforms(cache: BufferCache, device: GPUDevice): GPUCommandBuffer | null {
    const buffers = cache.dynamicUniforms;
    if (buffers.active !== null) {
        buffers.usedBuffers.push(buffers.active);
        buffers.active = null;
    }
    const used = buffers.usedBuffers;
    if (used.length === 0) return null;

    const encoder = device.createCommandEncoder({ label: 'dynamic-uniforms' });
    // Backwards, so the next frame pops the GPU buffers in the order this one used them.
    for (let index = used.length - 1; index >= 0; index--) {
        const { gpuBuffer, staging, size } = used[index];
        const bytes = alignTo4(size);
        if (staging.buffer === null) {
            // Lands ahead of the submit, like the copies, and frees the CPU copy at once.
            device.queue.writeBuffer(gpuBuffer.buffer, 0, staging.view.buffer, 0, bytes);
            buffers.cpuStagingBuffers.push(staging);
        } else {
            staging.buffer.unmap();
            encoder.copyBufferToBuffer(staging.buffer, 0, gpuBuffer.buffer, 0, bytes);
            buffers.pendingStagingBuffers.push(staging);
        }
        recordBufferWrite(cache.info, bytes, 'uniform', false, 'dynamic-uniforms');
        buffers.gpuBuffers.push(gpuBuffer);
    }
    used.length = 0;
    return encoder.finish({ label: 'dynamic-uniforms' });
}

/** After the submit: remaps the staging buffers it copied from, which resolves once the GPU is done reading them. */
export function onDynamicUniformsSubmitted(cache: BufferCache): void {
    const buffers = cache.dynamicUniforms;
    for (const staging of buffers.pendingStagingBuffers) {
        const buffer = staging.buffer!;
        buffer.mapAsync(GPUMapMode.WRITE).then(
            () => {
                // A renderer disposed while the map was pending has already released this buffer.
                if (buffers.destroyed) return;
                staging.view = new DataView(buffer.getMappedRange());
                buffers.stagingBuffers.push(staging);
            },
            // The map fails when the device is lost; the buffer cannot be reused.
            () => {
                buffer.destroy();
                buffers.mappedStagingCount--;
            },
        );
    }
    buffers.pendingStagingBuffers.length = 0;
}

/** For a frame discarded rather than submitted: its buffers go back unsubmitted, the staging ones still mapped. */
export function rewindDynamicUniforms(cache: BufferCache): void {
    const buffers = cache.dynamicUniforms;
    if (buffers.active !== null) {
        buffers.usedBuffers.push(buffers.active);
        buffers.active = null;
    }
    for (let index = buffers.usedBuffers.length - 1; index >= 0; index--) {
        const { gpuBuffer, staging } = buffers.usedBuffers[index];
        buffers.gpuBuffers.push(gpuBuffer);
        (staging.buffer === null ? buffers.cpuStagingBuffers : buffers.stagingBuffers).push(staging);
    }
    buffers.usedBuffers.length = 0;
}

function destroyDynamicUniforms(buffers: DynamicUniformBuffers): void {
    buffers.destroyed = true;
    for (const gpuBuffer of buffers.gpuBuffers) gpuBuffer.buffer.destroy();
    for (const staging of buffers.stagingBuffers) staging.buffer?.destroy();
    for (const staging of buffers.pendingStagingBuffers) staging.buffer?.destroy();
    for (const used of buffers.usedBuffers) {
        used.gpuBuffer.buffer.destroy();
        used.staging.buffer?.destroy();
    }
    if (buffers.active !== null) {
        buffers.active.gpuBuffer.buffer.destroy();
        buffers.active.staging.buffer?.destroy();
    }
}

function roundUp(value: number, multiple: number): number {
    return Math.ceil(value / multiple) * multiple;
}

// Stats

/**
 * Returns approximate buffer counts tracked by this cache.
 */
export function getBufferCacheStats(cache: BufferCache): BufferCacheStats {
    return {
        bufferCount: cache.bufferCount,
        rawCount: cache.rawCount,
    };
}

function alignTo4(n: number): number {
    return Math.ceil(n / 4) * 4;
}
