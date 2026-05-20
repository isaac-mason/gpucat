import type { Geometry } from '../geometry/geometry';
import { createIndexBuffer, type GpuBuffer } from '../core/gpu-buffer';
import type { Any } from '../schema/schema';
import type { RenderObject } from './render-object';
import type { BufferCache } from './buffers';
import * as Buffers from './buffers';

/**
 * @deprecated No longer used — all buffer types route through ensureUploaded.
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
export function createGeometriesState(): GeometriesState {
    return {
        bufferCall: new WeakMap(),
        currentCallId: 0,
        geometryData: new WeakMap(),
        wireframes: new WeakMap(),
        memory: {
            geometries: 0,
            buffers: 0,
            indexBuffers: 0,
            indirectBuffers: 0,
        },
    };
}

/**
 * Increment the call ID at the start of each render call.
 * This enables per-frame deduplication.
 */
export function incrementCallId(state: GeometriesState): void {
    state.currentCallId++;
}

/**
 * Update a buffer, uploading to GPU if needed.
 * Implements per-frame deduplication - each buffer is uploaded at most once per frame.
 *
 * Version tracking is delegated to buffers.ts — we only track per-frame deduplication here.
 */
export function updateBuffer(
    state: GeometriesState,
    bufferCache: BufferCache,
    device: GPUDevice,
    buffer: GpuBuffer<Any>,
    type: BufferType,
): void {
    const callId = state.currentCallId;

    // Check if already updated this frame
    const lastCallId = state.bufferCall.get(buffer);
    if (lastCallId === callId) {
        return; // Already updated this frame
    }

    // Mark as updated for this frame
    state.bufferCall.set(buffer, callId);

    // Route to unified upload function in buffers.ts
    // buffers.ts handles version tracking internally
    switch (type) {
        case 'vertex':
        case 'indirect':
            Buffers.ensureUploaded(bufferCache, device, buffer);
            break;
        // Note: 'index' type uses updateIndex() instead
    }
}

/**
 * Update an index buffer, uploading to GPU if needed.
 */
export function updateIndex(
    state: GeometriesState,
    bufferCache: BufferCache,
    device: GPUDevice,
    index: GpuBuffer<Any>,
): void {
    const callId = state.currentCallId;

    // Check if already updated this frame
    const lastCallId = state.bufferCall.get(index);
    if (lastCallId === callId) {
        return; // Already updated this frame
    }

    // Mark as updated for this frame
    state.bufferCall.set(index, callId);

    Buffers.ensureUploaded(bufferCache, device, index);
}

/**
 * Get the GPU buffer for an indirect buffer.
 * Returns undefined if not uploaded yet.
 */
export function getIndirectBuffer(
    bufferCache: BufferCache,
    buffer: GpuBuffer<Any>,
): GPUBuffer | undefined {
    return Buffers.getUploaded(bufferCache, buffer);
}

/**
 * Delete a buffer from the deduplication tracking.
 * Note: This doesn't destroy the GPU buffer - buffers.ts handles that via WeakMap GC.
 */
export function deleteBuffer(
    state: GeometriesState,
    buffer: GpuBuffer<Any>,
): void {
    state.bufferCall.delete(buffer);
}

/**
 * Initialize a geometry for rendering.
 *
 * This uploads all vertex buffers and the index buffer (if present).
 * Called once when a geometry is first encountered.
 */
export function initGeometry(
    state: GeometriesState,
    bufferCache: BufferCache,
    device: GPUDevice,
    geometry: Geometry,
): void {
    let data = state.geometryData.get(geometry);

    if (data && data.initialized) {
        return; // already initialized
    }

    // create tracking data
    if (!data) {
        data = {
            initialized: false,
        };
        state.geometryData.set(geometry, data);
        state.memory.geometries++;
    }

    // upload all vertex buffers
    for (const [_name, buffer] of geometry.buffers) {
        if (buffer.usage.has('vertex')) {
            updateBuffer(state, bufferCache, device, buffer, 'vertex');
            state.memory.buffers++;
        }
    }

    // upload index buffer if present
    if (geometry.index) {
        updateIndex(state, bufferCache, device, geometry.index);
        state.memory.indexBuffers++;
    }

    // upload indirect buffer if present
    if (geometry.indirect) {
        updateBuffer(state, bufferCache, device, geometry.indirect, 'indirect');
        state.memory.indirectBuffers++;
    }

    data.initialized = true;

    // set up disposal callback
    geometry._onDispose = () => {
        disposeGeometry(state, geometry);
    };
}

/**
 * Update a geometry for rendering.
 *
 * This checks for version changes and re-uploads modified buffers.
 * Called every frame for each visible geometry.
 *
 * Note: Version tracking is handled by buffers.ts. We just ensure each
 * buffer goes through the upload path (with per-frame deduplication).
 */
export function updateForRender(
    state: GeometriesState,
    bufferCache: BufferCache,
    device: GPUDevice,
    renderObject: RenderObject,
): void {
    const geometry = renderObject.geometry;
    let data = state.geometryData.get(geometry);

    // initialize if needed
    if (!data || !data.initialized) {
        initGeometry(state, bufferCache, device, geometry);
        return; // initGeometry already uploads everything
    }

    // Update all vertex buffers (buffers.ts handles version checking)
    for (const [_name, buffer] of geometry.buffers) {
        if (buffer.usage.has('vertex')) {
            updateBuffer(state, bufferCache, device, buffer, 'vertex');
        }
    }

    // Update index buffer if present
    if (geometry.index) {
        updateIndex(state, bufferCache, device, geometry.index);
    }

    // Update indirect buffer if present
    if (geometry.indirect) {
        updateBuffer(state, bufferCache, device, geometry.indirect, 'indirect');
    }
}

/**
 * Get the index buffer for a RenderObject.
 *
 * For wireframe rendering, this returns a generated wireframe index buffer.
 * Otherwise, returns the geometry's index buffer.
 *
 * @returns the index buffer or null for non-indexed geometry
 */
export function getIndex(
    state: GeometriesState,
    bufferCache: BufferCache,
    device: GPUDevice,
    renderObject: RenderObject,
    wireframe: boolean = false,
): GpuBuffer<Any> | null {
    const geometry = renderObject.geometry;

    if (wireframe) {
        // get or generate wireframe indices
        let wireframeIndex = state.wireframes.get(geometry);
        if (!wireframeIndex) {
            wireframeIndex = generateWireframeIndices(geometry);
            state.wireframes.set(geometry, wireframeIndex);

            // upload wireframe index buffer
            updateIndex(state, bufferCache, device, wireframeIndex);
        }
        return wireframeIndex;
    }

    return geometry.index ?? null;
}

/**
 * Generate wireframe indices for a geometry.
 *
 * Converts triangles to line segments:
 * - Triangle (a, b, c) becomes lines (a,b), (b,c), (c,a)
 *
 * For indexed geometry, processes the index buffer.
 * For non-indexed geometry, generates indices from vertex count.
 */
function generateWireframeIndices(geometry: Geometry): GpuBuffer<Any> {
    const index = geometry.index;
    const position = geometry.buffers.get('position');

    if (!position) {
        throw new Error('[Geometries] Cannot generate wireframe: no position buffer');
    }

    // determine number of triangles
    let numTriangles: number;
    let getIdx: (i: number) => number;

    if (index && index.array) {
        const arr = index.array as Uint16Array | Uint32Array;
        numTriangles = Math.floor(arr.length / 3);
        getIdx = (i: number) => arr[i];
    } else {
        numTriangles = Math.floor(position.count / 3);
        getIdx = (i: number) => i;
    }

    // each triangle produces 3 lines = 6 indices
    const wireframeIndices = new Uint32Array(numTriangles * 6);

    let wireframeI = 0;
    for (let i = 0; i < numTriangles; i++) {
        const a = getIdx(i * 3);
        const b = getIdx(i * 3 + 1);
        const c = getIdx(i * 3 + 2);

        // line a-b
        wireframeIndices[wireframeI++] = a;
        wireframeIndices[wireframeI++] = b;

        // line b-c
        wireframeIndices[wireframeI++] = b;
        wireframeIndices[wireframeI++] = c;

        // line c-a
        wireframeIndices[wireframeI++] = c;
        wireframeIndices[wireframeI++] = a;
    }

    return createIndexBuffer(wireframeIndices);
}

/**
 * Dispose a geometry and clean up tracking.
 */
export function disposeGeometry(state: GeometriesState, geometry: Geometry): void {
    const data = state.geometryData.get(geometry);
    if (!data) return;

    // delete buffer tracking
    for (const [_name, buffer] of geometry.buffers) {
        deleteBuffer(state, buffer);
    }

    // delete index buffer tracking
    if (geometry.index) {
        deleteBuffer(state, geometry.index);
    }

    // delete wireframe index buffer if it exists
    const wireframeIndex = state.wireframes.get(geometry);
    if (wireframeIndex) {
        deleteBuffer(state, wireframeIndex);
        state.wireframes.delete(geometry);
    }

    // remove tracking data
    state.geometryData.delete(geometry);
    state.memory.geometries--;
}

/** Get geometry and buffer memory statistics */
export function getGeometriesStats(state: GeometriesState): {
    geometries: number;
    buffers: number;
    indexBuffers: number;
    indirectBuffers: number;
} {
    return { ...state.memory };
}
