import type { Geometry, IndexBuffer } from '../geometry/geometry';
import { createIndexBuffer } from '../geometry/geometry';
import type { GpuBuffer } from '../core/buffer';
import type { Any } from '../nodes/schema';
import type { RenderObject } from './render-object';
import * as buffers from './buffers';

/**
 * Buffer type for routing to correct buffer upload function.
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
    /** Reference to the underlying buffer cache. */
    bufferCache: buffers.BufferCache;

    /** GPU device reference. */
    device: GPUDevice;

    /**
     * Tracks the last render call ID when each buffer was updated.
     * Prevents duplicate updates within the same frame.
     */
    bufferCall: WeakMap<GpuBuffer<Any> | IndexBuffer, number>;

    /**
     * Current render call ID. Incremented at the start of each render call.
     * Used for deduplication.
     */
    currentCallId: number;

    /** Per-geometry tracking data. */
    geometryData: WeakMap<Geometry, GeometryData>;

    /** Cached wireframe index buffers per geometry. */
    wireframes: WeakMap<Geometry, IndexBuffer>;

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
 *
 * @param bufferCache - The underlying buffer cache (from buffers.ts)
 */
export function createGeometriesState(bufferCache: buffers.BufferCache): GeometriesState {
    return {
        bufferCache,
        device: bufferCache.device,
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
 *
 * @param state - The Geometries state
 * @param buffer - The GpuBuffer to update
 * @param type - The buffer type for routing
 */
export function updateBuffer(
    state: GeometriesState,
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

    // Route to appropriate upload function in buffers.ts
    // buffers.ts handles version tracking internally
    switch (type) {
        case 'vertex':
            buffers.uploadVertex(state.bufferCache, buffer);
            break;
        case 'indirect':
            buffers.uploadIndirect(state.bufferCache, buffer);
            break;
        // Note: 'index' type uses updateIndex() instead
    }
}

/**
 * Update an index buffer, uploading to GPU if needed.
 */
export function updateIndex(
    state: GeometriesState,
    index: IndexBuffer,
): void {
    const callId = state.currentCallId;

    // Check if already updated this frame
    const lastCallId = state.bufferCall.get(index);
    if (lastCallId === callId) {
        return; // Already updated this frame
    }

    // Mark as updated for this frame
    state.bufferCall.set(index, callId);

    buffers.uploadIndex(state.bufferCache, index);
}

/**
 * Get the GPU buffer for an indirect buffer.
 * Returns undefined if not uploaded yet.
 */
export function getIndirectBuffer(
    state: GeometriesState,
    buffer: GpuBuffer<Any>,
): GPUBuffer | undefined {
    return buffers.getIndirect(state.bufferCache, buffer);
}

/**
 * Delete a buffer from the deduplication tracking.
 * Note: This doesn't destroy the GPU buffer - buffers.ts handles that via WeakMap GC.
 *
 * @param state - The Geometries state
 * @param buffer - The buffer to delete
 */
export function deleteBuffer(
    state: GeometriesState,
    buffer: GpuBuffer<Any> | IndexBuffer,
): void {
    state.bufferCall.delete(buffer);
}

/**
 * Initialize a geometry for rendering.
 *
 * This uploads all vertex buffers and the index buffer (if present).
 * Called once when a geometry is first encountered.
 *
 * @param state the Geometries state
 * @param geometry the geometry to initialize
 */
export function initGeometry(state: GeometriesState, geometry: Geometry): void {
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
            updateBuffer(state, buffer, 'vertex');
            state.memory.buffers++;
        }
    }

    // upload index buffer if present
    if (geometry.index) {
        updateIndex(state, geometry.index);
        state.memory.indexBuffers++;
    }

    // upload indirect buffer if present
    if (geometry.indirect) {
        updateBuffer(state, geometry.indirect, 'indirect');
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
 *
 * @param state the Geometries state
 * @param renderObject the RenderObject containing the geometry
 */
export function updateForRender(state: GeometriesState, renderObject: RenderObject): void {
    const geometry = renderObject.geometry;
    let data = state.geometryData.get(geometry);

    // initialize if needed
    if (!data || !data.initialized) {
        initGeometry(state, geometry);
        return; // initGeometry already uploads everything
    }

    // Update all vertex buffers (buffers.ts handles version checking)
    for (const [_name, buffer] of geometry.buffers) {
        if (buffer.usage.has('vertex')) {
            updateBuffer(state, buffer, 'vertex');
        }
    }

    // Update index buffer if present
    if (geometry.index) {
        updateIndex(state, geometry.index);
    }

    // Update indirect buffer if present
    if (geometry.indirect) {
        updateBuffer(state, geometry.indirect, 'indirect');
    }
}

/**
 * Get the index buffer for a RenderObject.
 *
 * For wireframe rendering, this returns a generated wireframe index buffer.
 * Otherwise, returns the geometry's index buffer.
 *
 * @param state the Geometries state
 * @param renderObject the RenderObject
 * @param wireframe whether wireframe mode is active
 * @returns the index buffer or null for non-indexed geometry
 */
export function getIndex(
    state: GeometriesState,
    renderObject: RenderObject,
    wireframe: boolean = false,
): IndexBuffer | null {
    const geometry = renderObject.geometry;

    if (wireframe) {
        // get or generate wireframe indices
        let wireframeIndex = state.wireframes.get(geometry);
        if (!wireframeIndex) {
            wireframeIndex = generateWireframeIndices(geometry);
            state.wireframes.set(geometry, wireframeIndex);

            // upload wireframe index buffer
            updateIndex(state, wireframeIndex);
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
 *
 * @param geometry - The source geometry
 * @returns A new IndexBuffer with wireframe line indices
 */
function generateWireframeIndices(geometry: Geometry): IndexBuffer {
    const index = geometry.index;
    const position = geometry.buffers.get('position');

    if (!position) {
        throw new Error('[Geometries] Cannot generate wireframe: no position buffer');
    }

    // determine number of triangles
    let numTriangles: number;
    let getIndex: (i: number) => number;

    if (index) {
        numTriangles = Math.floor(index.array.length / 3);
        getIndex = (i: number) => index.array[i];
    } else {
        numTriangles = Math.floor(position.count / 3);
        getIndex = (i: number) => i;
    }

    // each triangle produces 3 lines = 6 indices
    const wireframeIndices = new Uint32Array(numTriangles * 6);

    let wireframeIdx = 0;
    for (let i = 0; i < numTriangles; i++) {
        const a = getIndex(i * 3);
        const b = getIndex(i * 3 + 1);
        const c = getIndex(i * 3 + 2);

        // line a-b
        wireframeIndices[wireframeIdx++] = a;
        wireframeIndices[wireframeIdx++] = b;

        // line b-c
        wireframeIndices[wireframeIdx++] = b;
        wireframeIndices[wireframeIdx++] = c;

        // line c-a
        wireframeIndices[wireframeIdx++] = c;
        wireframeIndices[wireframeIdx++] = a;
    }

    return createIndexBuffer(wireframeIndices);
}

/**
 * Dispose a geometry and clean up tracking.
 *
 * @param state the Geometries state
 * @param geometry the geometry to dispose
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
