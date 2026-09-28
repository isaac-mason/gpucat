/**
 * render-object-gpu.ts - WebGPU-owned device payload for RenderObjects.
 *
 * RenderObject (in core/) is backend-neutral and must not reference raw WebGPU
 * types. Its GPU pipeline lives here instead (bind groups are per draw, see
 * `DrawBindings`), keyed by RenderObject identity in a WeakMap -
 * mirroring how GpuBuffer/GpuTexture keep their GPU handles in renderer-side
 * caches (see buffers.ts BufferCache).
 *
 * The cache is a per-renderer instance (held on WebGPUBackend as
 * `_renderObjectGpu`), not a module-global.
 */
import type { RenderObject } from '../core/render-object';
import type { DrawBindings } from './bindings';
/**
 * The WebGPU device payload for a single RenderObject.
 *
 * This used to live directly on RenderObject; it was relocated here to keep raw
 * GPU types out of the neutral core type.
 */
export type RenderObjectGpu = {
    /**
     * GPU render pipeline.
     * null until pipeline is created.
     */
    pipeline: GPURenderPipeline | null;
    /**
     * A copy of what the object's most recent draw bound, kept only while an inspector is attached, for
     * the pipeline probe that redraws it. Draw bindings themselves are pooled per pass and reused.
     */
    probeBindings: DrawBindings | null;
};
/**
 * Per-renderer cache mapping RenderObject -> its WebGPU device payload.
 */
export type RenderObjectGpuCache = {
    /** RenderObject -> device payload. */
    data: WeakMap<RenderObject, RenderObjectGpu>;
};
/** Create a new RenderObjectGpu cache. */
export declare function createRenderObjectGpuCache(): RenderObjectGpuCache;
/**
 * Get the WebGPU device payload for a RenderObject, lazily creating the entry.
 */
export declare function getRenderObjectGpu(cache: RenderObjectGpuCache, renderObject: RenderObject): RenderObjectGpu;
/**
 * Peek at the WebGPU device payload for a RenderObject without creating it.
 * Returns undefined if the RenderObject has no entry yet.
 */
export declare function peekRenderObjectGpu(cache: RenderObjectGpuCache, renderObject: RenderObject): RenderObjectGpu | undefined;
