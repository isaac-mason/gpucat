import type { Geometry } from '../geometry/geometry';
import { type GpuBuffer } from '../core/gpu-buffer';
import type { Any } from '../schema/schema';
import type { RenderObject } from './render-object';
import type { BufferCache } from './buffers';
/**
 * @deprecated No longer used, all buffer types route through ensureUploaded.
 * Kept temporarily while call sites that pass this type are migrated.
 */
export type BufferType = 'vertex' | 'index' | 'indirect';
/** Per-geometry tracking data */
export type GeometryData = {
    /** Whether the geometry has been initialized (buffers uploaded). */
    initialized: boolean;
};
/**
 * GeometriesState - manages geometry and buffer GPU resources with deduplication.
 *
 * Combines the responsibilities of the former Geometries and Attributes systems.
 */
export type GeometriesState = {
    /**
     * Tracks the last render call ID when each buffer was updated.
     * Prevents duplicate updates within the same frame.
     */
    bufferCall: WeakMap<GpuBuffer<Any>, number>;
    /**
     * Current render call ID. Incremented at the start of each render call.
     * Used for deduplication.
     */
    currentCallId: number;
    /** Per-geometry tracking data. */
    geometryData: WeakMap<Geometry, GeometryData>;
    /** Cached wireframe index buffers per geometry. */
    wireframes: WeakMap<Geometry, GpuBuffer<Any>>;
    /** Memory statistics. */
    memory: {
        geometries: number;
        buffers: number;
        indexBuffers: number;
        indirectBuffers: number;
    };
};
/**
 * Create a new Geometries state.
 */
export declare function createGeometriesState(): GeometriesState;
/**
 * Increment the call ID at the start of each render call.
 * This enables per-frame deduplication.
 */
export declare function incrementCallId(state: GeometriesState): void;
/**
 * Update a buffer, uploading to GPU if needed.
 * Implements per-frame deduplication - each buffer is uploaded at most once per frame.
 *
 * Version tracking is delegated to buffers.ts, we only track per-frame deduplication here.
 */
export declare function updateBuffer(state: GeometriesState, bufferCache: BufferCache, device: GPUDevice, buffer: GpuBuffer<Any>, type: BufferType): void;
/**
 * Update an index buffer, uploading to GPU if needed.
 */
export declare function updateIndex(state: GeometriesState, bufferCache: BufferCache, device: GPUDevice, index: GpuBuffer<Any>): void;
/**
 * Get the GPU buffer for an indirect buffer.
 * Returns undefined if not uploaded yet.
 */
export declare function getIndirectBuffer(bufferCache: BufferCache, buffer: GpuBuffer<Any>): GPUBuffer | undefined;
/**
 * Delete a buffer from the deduplication tracking.
 * Note: This doesn't destroy the GPU buffer - buffers.ts handles that via WeakMap GC.
 */
export declare function deleteBuffer(state: GeometriesState, buffer: GpuBuffer<Any>): void;
/**
 * Initialize a geometry for rendering.
 *
 * This uploads all vertex buffers and the index buffer (if present).
 * Called once when a geometry is first encountered.
 */
export declare function initGeometry(state: GeometriesState, bufferCache: BufferCache, device: GPUDevice, geometry: Geometry): void;
/**
 * Update a geometry for rendering.
 *
 * This checks for version changes and re-uploads modified buffers.
 * Called every frame for each visible geometry.
 *
 * Note: Version tracking is handled by buffers.ts. We just ensure each
 * buffer goes through the upload path (with per-frame deduplication).
 */
export declare function updateForRender(state: GeometriesState, bufferCache: BufferCache, device: GPUDevice, renderObject: RenderObject): void;
/**
 * Get the index buffer for a RenderObject.
 *
 * For wireframe rendering, this returns a generated wireframe index buffer.
 * Otherwise, returns the geometry's index buffer.
 *
 * @returns the index buffer or null for non-indexed geometry
 */
export declare function getIndex(state: GeometriesState, bufferCache: BufferCache, device: GPUDevice, renderObject: RenderObject, wireframe?: boolean): GpuBuffer<Any> | null;
/**
 * Dispose a geometry and clean up tracking.
 */
export declare function disposeGeometry(state: GeometriesState, geometry: Geometry): void;
/** Get geometry and buffer memory statistics */
export declare function getGeometriesStats(state: GeometriesState): {
    geometries: number;
    buffers: number;
    indexBuffers: number;
    indirectBuffers: number;
};
