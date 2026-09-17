/**
 * buffers.ts (webgl) - `GpuBuffer -> WebGLBuffer` cache, the GL sibling of `webgpu/buffers.ts`.
 *
 * Two maps, matching WebGPU's, because there are two genuinely different cases:
 *
 *  - `bufferMap` keys by `GpuBuffer` identity, for anything a GpuBuffer backs: vertex attributes,
 *    indices, transform-feedback IO. One GpuBuffer therefore means exactly one GL buffer, no matter
 *    how many geometries or passes reach it. `webgl/renderer.ts` `readBufferAsync` has always
 *    documented that invariant; before this module there was nothing to enforce it.
 *  - `rawMap` keys by an arbitrary object, for device buffers with no GpuBuffer behind them. Uniform
 *    blocks are the only case: a block is a byte blob packed from many uniform nodes through a
 *    compile-time layout, with no version of its own, so change detection belongs to the caller.
 *
 * Owning the mapping is also what makes release possible. A `GpuBuffer` that reaches the device
 * through a geometry used to be freed only when that geometry was, because no module knew the
 * mapping existed.
 *
 * GL buffers are typeless; the bind target passed here only says how to reach the buffer for this
 * upload. It matters because `ELEMENT_ARRAY_BUFFER` bindings are captured into whatever VAO is bound,
 * so callers must upload with VAO 0 bound (see `prepareGeometry`).
 */

import type { GpuBuffer, GpuTypedArray } from '../../core/gpu-buffer';
import { BufferUpload, planBufferUpload } from '../core/buffer-upload';
import { primaryBufferUsage, type RendererInfo, recordBufferWrite } from '../core/info';
import { mergeUpdateRanges } from '../core/update-ranges';

type CacheEntry = {
    glBuffer: WebGLBuffer;
    /** `buffer.version` at last upload, the re-upload gate. */
    version: number;
    /** last allocated byte size, the resize guard. */
    byteLength: number;
};

type RawEntry = {
    glBuffer: WebGLBuffer;
    byteLength: number;
};

export type BufferCache = {
    /** GL buffer per `GpuBuffer`, shared across every geometry and pass that reaches it. */
    bufferMap: WeakMap<GpuBuffer, CacheEntry>;
    /** GL buffer per opaque key, for uniform blocks (no backing `GpuBuffer`). */
    rawMap: WeakMap<object, RawEntry>;
    /** Every live GL buffer, for teardown. The maps are weak and cannot be walked. */
    all: Set<WebGLBuffer>;
    bufferCount: number;
    rawCount: number;
    /** Where upload volume is tallied. Held by reference so the frame boundary that zeroes it stays
     *  in one place (the renderer) and every reader sees the same numbers; see `core/info.ts`. */
    info: RendererInfo;
};

export type BufferCacheStats = {
    bufferCount: number;
    rawCount: number;
};

export function createBufferCache(info: RendererInfo): BufferCache {
    return { bufferMap: new WeakMap(), rawMap: new WeakMap(), all: new Set(), bufferCount: 0, rawCount: 0, info };
}

/**
 * GL usage hint from the buffer's declared usage, the analogue of WebGPU's `deriveGPUUsage`.
 *
 * A hint only, never correctness: GL is free to ignore it. Transform-feedback outputs are the case
 * worth getting right, since they are GPU-written and GPU-consumed; a `*_READ` hint there makes the
 * driver stage through host memory on every capture.
 */
export function glUsageHint(gl: WebGL2RenderingContext, buffer: GpuBuffer): number {
    if (buffer.usage.has('indirect')) return gl.DYNAMIC_COPY;
    if (buffer.usage.has('storage')) return gl.DYNAMIC_COPY;
    if (buffer.usage.has('uniform')) return gl.DYNAMIC_DRAW;
    return gl.STATIC_DRAW;
}

/**
 * Release a buffer's GL object when its `GpuBuffer` is disposed.
 *
 * Chained, not assigned: the storage-texture path in `textures.ts` also hangs a callback on a
 * buffer's dispose, and whichever registers second must not drop the first.
 */
function setupBufferDispose(gl: WebGL2RenderingContext, cache: BufferCache, buffer: GpuBuffer): void {
    const previous = buffer._onDispose;
    buffer._onDispose = (): void => {
        previous?.();
        const entry = cache.bufferMap.get(buffer);
        if (!entry) return;
        gl.deleteBuffer(entry.glBuffer);
        cache.all.delete(entry.glBuffer);
        cache.bufferCount--;
        cache.bufferMap.delete(buffer);
    };
}

/** Push the buffer's pending `updateRanges` as partial `bufferSubData` uploads, one per merged span. */
function uploadDirtyRanges(
    gl: WebGL2RenderingContext,
    cache: BufferCache,
    target: GLenum,
    array: GpuTypedArray,
    buffer: GpuBuffer,
    label: string,
): void {
    const ranges = buffer.updateRanges;
    mergeUpdateRanges(ranges);
    const bytesPerElement = array.BYTES_PER_ELEMENT;
    const usage = primaryBufferUsage(buffer);
    for (let i = 0; i < ranges.length; i++) {
        const r = ranges[i]!;
        gl.bufferSubData(target, r.start * bytesPerElement, array, r.start, r.count);
        recordBufferWrite(cache.info, r.count * bytesPerElement, usage, false, label);
    }
    buffer.clearUpdateRanges();
}

/**
 * Get (or create) the GL buffer for a `GpuBuffer`, uploading whatever changed since last time.
 *
 * `target` is the bind target to upload through; `name` is a fallback label for the upload breakdown
 * when the buffer carries none. The allocate / partial / full decision is `core/buffer-upload.ts`'s,
 * shared with the WebGPU backend so the rule cannot drift.
 *
 * `usageHint` overrides the hint derived from `buffer.usage`, for the caller that knows better than
 * the declared usage does. Transform feedback is the case: its outputs are GPU-written and
 * GPU-consumed, so they want `DYNAMIC_COPY` whatever they are declared as. WebGPU needs no such
 * escape hatch, because its usage flags are correctness rather than an advisory hint.
 */
export function ensureUploaded(
    gl: WebGL2RenderingContext,
    cache: BufferCache,
    buffer: GpuBuffer,
    target: GLenum,
    name: string,
    usageHint?: number,
): WebGLBuffer {
    const array = buffer.array;
    if (!array) throw new Error(`[WebGLRenderer] buffer '${buffer.label ?? name}' has no CPU array to upload.`);

    const label = buffer.label ?? name;
    let entry = cache.bufferMap.get(buffer);
    const plan = planBufferUpload(buffer, entry !== undefined, entry?.byteLength ?? -1, entry?.version ?? -1);
    if (plan === BufferUpload.Skip && entry) return entry.glBuffer;

    if (plan === BufferUpload.Allocate) {
        if (!entry) {
            const created = gl.createBuffer();
            if (!created) throw new Error('[WebGLRenderer] gl.createBuffer returned null.');
            entry = { glBuffer: created, version: -1, byteLength: -1 };
            cache.bufferMap.set(buffer, entry);
            cache.all.add(created);
            cache.bufferCount++;
            setupBufferDispose(gl, cache, buffer);
        }
        gl.bindBuffer(target, entry.glBuffer);
        gl.bufferData(target, array, usageHint ?? glUsageHint(gl, buffer));
        recordBufferWrite(cache.info, array.byteLength, primaryBufferUsage(buffer), true, label);
        entry.byteLength = array.byteLength;
        entry.version = buffer.version;
        // the allocate path wrote everything, so pending ranges are already covered.
        buffer.clearUpdateRanges();
        return entry.glBuffer;
    }

    gl.bindBuffer(target, entry!.glBuffer);
    if (plan === BufferUpload.Partial) {
        uploadDirtyRanges(gl, cache, target, array, buffer, label);
    } else {
        gl.bufferSubData(target, 0, array);
        recordBufferWrite(cache.info, array.byteLength, primaryBufferUsage(buffer), true, label);
    }
    entry!.version = buffer.version;
    return entry!.glBuffer;
}

/** The GL buffer already created for a `GpuBuffer`, or undefined. Never uploads. */
export function getUploaded(cache: BufferCache, buffer: GpuBuffer): WebGLBuffer | undefined {
    return cache.bufferMap.get(buffer)?.glBuffer;
}

export type UploadRawResult = {
    glBuffer: WebGLBuffer;
    /** True when the GL buffer was newly created or grown, so dependent bindings must be refreshed. */
    created: boolean;
};

/** Identity for a raw write, supplied by callers that have it (uniform blocks do). */
export type RawWriteDetail = {
    material?: string;
    updateType?: string;
    changedBytes?: number;
};

/**
 * Upload one packed uniform block, identified by an arbitrary key.
 *
 * The one case with no `GpuBuffer` to gate on, so this writes unconditionally and change detection
 * stays with the caller. `full` is recorded as false: this path has no concept of ranges and always
 * writes everything, so flagging it would make the full-re-upload signal tautological.
 */
export function uploadUniformBlock(
    gl: WebGL2RenderingContext,
    cache: BufferCache,
    key: object,
    data: ArrayBuffer,
    detail?: RawWriteDetail,
): UploadRawResult {
    let entry = cache.rawMap.get(key);
    let created = false;

    if (!entry || entry.byteLength !== data.byteLength) {
        if (!entry) {
            const glBuffer = gl.createBuffer();
            if (!glBuffer) throw new Error('[WebGLRenderer] gl.createBuffer returned null (uniform block).');
            entry = { glBuffer, byteLength: data.byteLength };
            cache.rawMap.set(key, entry);
            cache.all.add(glBuffer);
            cache.rawCount++;
        }
        entry.byteLength = data.byteLength;
        gl.bindBuffer(gl.UNIFORM_BUFFER, entry.glBuffer);
        gl.bufferData(gl.UNIFORM_BUFFER, data, gl.DYNAMIC_DRAW);
        created = true;
    } else {
        gl.bindBuffer(gl.UNIFORM_BUFFER, entry.glBuffer);
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, data);
    }

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
    return { glBuffer: entry.glBuffer, created };
}

/** The GL buffer for a raw key, or undefined. Never uploads. */
export function getRaw(cache: BufferCache, key: object): WebGLBuffer | undefined {
    return cache.rawMap.get(key)?.glBuffer;
}

/** Delete every GL buffer this cache holds (called on renderer dispose). */
export function disposeBufferCache(gl: WebGL2RenderingContext, cache: BufferCache): void {
    for (const glBuffer of cache.all) gl.deleteBuffer(glBuffer);
    cache.all.clear();
    cache.bufferCount = 0;
    cache.rawCount = 0;
}

export function getBufferCacheStats(cache: BufferCache): BufferCacheStats {
    return { bufferCount: cache.bufferCount, rawCount: cache.rawCount };
}
