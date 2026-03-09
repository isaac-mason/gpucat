import type { Geometry } from '../geometry/geometry';
import type { BufferAttribute, IndexAttribute, IndirectStorageBufferAttribute } from '../core/attribute';
import { IndexAttribute as IndexAttributeClass } from '../core/attribute';
import type { RenderObject } from './render-object';
import * as buffers from './buffers';

/**
 * Attribute type for routing to correct buffer upload function.
 */
export type AttributeType = 'vertex' | 'index' | 'storage' | 'indirect';

/** Per-geometry tracking data */
export type GeometryData = {
    /** Whether the geometry has been initialized (attributes uploaded). */
    initialized: boolean;
};

/**
 * GeometriesState - manages geometry and attribute GPU buffers with deduplication.
 *
 * Combines the responsibilities of the former Geometries and Attributes systems.
 */
export type GeometriesState = {
    /** Reference to the underlying buffer cache. */
    bufferCache: buffers.BufferCache;

    /** GPU device reference. */
    device: GPUDevice;

    /**
     * Tracks the last render call ID when each attribute was updated.
     * Prevents duplicate updates within the same frame.
     */
    attributeCall: WeakMap<BufferAttribute | IndexAttribute | IndirectStorageBufferAttribute, number>;

    /**
     * Current render call ID. Incremented at the start of each render call.
     * Used for deduplication.
     */
    currentCallId: number;

    /** Per-geometry tracking data. */
    geometryData: WeakMap<Geometry, GeometryData>;

    /** Cached wireframe index buffers per geometry. */
    wireframes: WeakMap<Geometry, IndexAttribute>;

    /** Memory statistics. */
    memory: {
        geometries: number;
        attributes: number;
        indexAttributes: number;
        storageAttributes: number;
        indirectAttributes: number;
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
        attributeCall: new WeakMap(),
        currentCallId: 0,
        geometryData: new WeakMap(),
        wireframes: new WeakMap(),
        memory: {
            geometries: 0,
            attributes: 0,
            indexAttributes: 0,
            storageAttributes: 0,
            indirectAttributes: 0,
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
 * Update an attribute, uploading to GPU if needed.
 * Implements per-frame deduplication - each attribute is uploaded at most once per frame.
 *
 * Version tracking is delegated to buffers.ts — we only track per-frame deduplication here.
 *
 * @param state - The Geometries state
 * @param attribute - The attribute to update
 * @param type - The attribute type for routing
 */
export function updateAttribute(
    state: GeometriesState,
    attribute: BufferAttribute,
    type: AttributeType,
): void {
    const callId = state.currentCallId;

    // Check if already updated this frame
    const lastCallId = state.attributeCall.get(attribute);
    if (lastCallId === callId) {
        return; // Already updated this frame
    }

    // Mark as updated for this frame
    state.attributeCall.set(attribute, callId);

    // Route to appropriate upload function in buffers.ts
    // buffers.ts handles version tracking internally
    switch (type) {
        case 'vertex':
            buffers.uploadVertex(state.bufferCache, attribute);
            break;
        case 'index':
            buffers.uploadIndex(state.bufferCache, attribute as unknown as IndexAttribute);
            break;
        case 'storage':
            // Storage attributes are handled separately through StorageNodes
            break;
        case 'indirect':
            buffers.uploadIndirect(state.bufferCache, attribute as unknown as IndirectStorageBufferAttribute);
            break;
    }
}

/**
 * Get the GPU buffer for an indirect attribute.
 * Returns undefined if not uploaded yet.
 */
export function getIndirectBuffer(
    state: GeometriesState,
    attribute: IndirectStorageBufferAttribute,
): GPUBuffer | undefined {
    return buffers.getIndirect(state.bufferCache, attribute);
}

/**
 * Delete an attribute from the deduplication tracking.
 * Note: This doesn't destroy the GPU buffer - buffers.ts handles that via WeakMap GC.
 *
 * @param state - The Geometries state
 * @param attribute - The attribute to delete
 */
export function deleteAttribute(
    state: GeometriesState,
    attribute: BufferAttribute | IndexAttribute,
): void {
    state.attributeCall.delete(attribute);
}

/**
 * Initialize a geometry for rendering.
 *
 * This uploads all vertex attributes and the index buffer (if present).
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

    // upload all vertex attributes
    for (const [_name, attr] of geometry.attributes) {
        updateAttribute(state, attr, 'vertex');
        state.memory.attributes++;
    }

    // upload index buffer if present
    if (geometry.index) {
        updateAttribute(state, geometry.index as unknown as BufferAttribute, 'index');
        state.memory.indexAttributes++;
    }

    // upload indirect buffer if present
    if (geometry.indirect) {
        updateAttribute(state, geometry.indirect as unknown as BufferAttribute, 'indirect');
        state.memory.indirectAttributes++;
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
 * This checks for version changes and re-uploads modified attributes.
 * Called every frame for each visible geometry.
 *
 * Note: Version tracking is handled by buffers.ts. We just ensure each
 * attribute goes through the upload path (with per-frame deduplication).
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

    // Update all vertex attributes (buffers.ts handles version checking)
    for (const [_name, attr] of geometry.attributes) {
        updateAttribute(state, attr, 'vertex');
    }

    // Update index buffer if present
    if (geometry.index) {
        updateAttribute(state, geometry.index as unknown as BufferAttribute, 'index');
    }

    // Update indirect buffer if present
    if (geometry.indirect) {
        updateAttribute(state, geometry.indirect as unknown as BufferAttribute, 'indirect');
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
): IndexAttribute | null {
    const geometry = renderObject.geometry;

    if (wireframe) {
        // get or generate wireframe indices
        let wireframeIndex = state.wireframes.get(geometry);
        if (!wireframeIndex) {
            wireframeIndex = generateWireframeIndices(geometry);
            state.wireframes.set(geometry, wireframeIndex);

            // upload wireframe index buffer
            updateAttribute(state, wireframeIndex as unknown as BufferAttribute, 'index');
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
 * @returns A new IndexAttribute with wireframe line indices
 */
function generateWireframeIndices(geometry: Geometry): IndexAttribute {
    const index = geometry.index;
    const position = geometry.attributes.get('position');

    if (!position) {
        throw new Error('[Geometries] Cannot generate wireframe: no position attribute');
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

    return new IndexAttributeClass(wireframeIndices);
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

    // delete vertex attribute tracking
    for (const [_name, attr] of geometry.attributes) {
        deleteAttribute(state, attr);
    }

    // delete index buffer tracking
    if (geometry.index) {
        deleteAttribute(state, geometry.index);
    }

    // delete wireframe index buffer if it exists
    const wireframeIndex = state.wireframes.get(geometry);
    if (wireframeIndex) {
        deleteAttribute(state, wireframeIndex);
        state.wireframes.delete(geometry);
    }

    // remove tracking data
    state.geometryData.delete(geometry);
    state.memory.geometries--;
}

/** Get geometry and attribute memory statistics */
export function getGeometriesStats(state: GeometriesState): {
    geometries: number;
    attributes: number;
    indexAttributes: number;
    storageAttributes: number;
    indirectAttributes: number;
} {
    return { ...state.memory };
}
