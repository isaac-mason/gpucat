import type { GpuBuffer } from '../../core/gpu-buffer';
import type { Geometry } from '../../geometry/geometry';
import type { Any } from '../../schema/schema';
import type { RenderObject } from '../core/render-object';
import type { BackendState } from './backend-state';
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
 * Delete a buffer from the deduplication tracking.
 * Note: This doesn't destroy the GPU buffer - buffers.ts handles that via WeakMap GC.
 */
export declare function deleteBuffer(state: GeometriesState, buffer: GpuBuffer<Any>): void;
/**
 * Update a geometry for rendering.
 *
 * This checks for version changes and re-uploads modified buffers.
 * Called every frame for each visible geometry.
 *
 * Note: Version tracking is handled by buffers.ts. We just ensure each
 * buffer goes through the upload path (with per-frame deduplication).
 */
export declare function updateForRender(b: BackendState, renderObject: RenderObject): void;
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
