/**
 * render-object-gpu.ts - WebGPU-owned per-draw device payload for RenderObjects.
 *
 * RenderObject (in core/) is backend-neutral and must not reference raw WebGPU
 * types. The per-draw GPU handles (pipeline, bind groups, resolved attribute
 * buffers) live here instead, keyed by RenderObject identity in a WeakMap -
 * mirroring how GpuBuffer/GpuTexture keep their GPU handles in renderer-side
 * caches (see buffers.ts BufferCache).
 *
 * The cache is a per-renderer instance (held on WebGPURenderer as
 * `_renderObjectGpu`), not a module-global.
 */

import type { GpuBuffer } from '../../core/gpu-buffer';
import type { Any } from '../../schema/schema';
import type { RenderObject } from '../core/render-object';

/**
 * The WebGPU device payload for a single RenderObject.
 *
 * These fields used to live directly on RenderObject; they were relocated here
 * to keep raw GPU types (GPURenderPipeline, GPUBindGroup) out of the neutral
 * core type.
 */
export type RenderObjectGpu = {
    /**
     * GPU render pipeline.
     * null until pipeline is created.
     */
    pipeline: GPURenderPipeline | null;

    /**
     * GPU bind groups [render, object, storage].
     * null until bindings are created.
     */
    bindGroups: GPUBindGroup[] | null;

    /**
     * Vertex buffers used by this draw.
     * null until buffers are resolved.
     */
    vertexBuffers: GpuBuffer<Any>[] | null;

    /**
     * Index buffer (if indexed draw).
     * null for non-indexed draws.
     */
    indexBuffer: GpuBuffer<Any> | null;
};

/**
 * Per-renderer cache mapping RenderObject -> its WebGPU device payload.
 */
export type RenderObjectGpuCache = {
    /** RenderObject -> device payload. */
    data: WeakMap<RenderObject, RenderObjectGpu>;
};

/** Create a new RenderObjectGpu cache. */
export function createRenderObjectGpuCache(): RenderObjectGpuCache {
    return {
        data: new WeakMap(),
    };
}

/** Create an empty device payload. */
function createRenderObjectGpu(): RenderObjectGpu {
    return {
        pipeline: null,
        bindGroups: null,
        vertexBuffers: null,
        indexBuffer: null,
    };
}

/**
 * Get the WebGPU device payload for a RenderObject, lazily creating the entry.
 */
export function getRenderObjectGpu(cache: RenderObjectGpuCache, renderObject: RenderObject): RenderObjectGpu {
    let gpu = cache.data.get(renderObject);
    if (!gpu) {
        gpu = createRenderObjectGpu();
        cache.data.set(renderObject, gpu);
    }
    return gpu;
}

/**
 * Peek at the WebGPU device payload for a RenderObject without creating it.
 * Returns undefined if the RenderObject has no entry yet.
 */
export function peekRenderObjectGpu(cache: RenderObjectGpuCache, renderObject: RenderObject): RenderObjectGpu | undefined {
    return cache.data.get(renderObject);
}

/**
 * Reset the device payload for a RenderObject (clears pipeline/bindGroups/buffers).
 * Used on disposal / invalidation.
 */
export function clearRenderObjectGpu(cache: RenderObjectGpuCache, renderObject: RenderObject): void {
    const gpu = cache.data.get(renderObject);
    if (!gpu) return;
    gpu.pipeline = null;
    gpu.bindGroups = null;
    gpu.vertexBuffers = null;
    gpu.indexBuffer = null;
}

/** Delete the device payload entry for a RenderObject entirely. */
export function deleteRenderObjectGpu(cache: RenderObjectGpuCache, renderObject: RenderObject): void {
    cache.data.delete(renderObject);
}
