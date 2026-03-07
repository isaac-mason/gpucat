/**
 * geometries.ts - Geometry state coordination for RenderObjects.
 *
 * Aligned with Three.js Geometries class:
 * - Coordinates attribute updates for render objects
 * - Handles wireframe index generation
 * - Tracks geometry initialization state
 *
 * This is a higher-level system that uses Attributes for GPU buffer management.
 */

import type { Geometry } from '../geometry/geometry';
import type { BufferAttribute, IndexAttribute } from '../core/attribute';
import { IndexAttribute as IndexAttributeClass } from '../core/attribute';
import type { RenderObject } from './render-object';
import type { AttributesState } from './attributes';
import * as attributes from './attributes';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-geometry tracking data.
 */
export type GeometryData = {
    /** Whether the geometry has been initialized (attributes uploaded). */
    initialized: boolean;

    /** Cached attribute version sums for dirty checking. */
    attributeVersionSum: number;

    /** Cached index version for dirty checking. */
    indexVersion: number;
};

/**
 * Geometries state - manages geometry attribute coordination.
 */
export type GeometriesState = {
    /** Reference to the Attributes system. */
    attributes: AttributesState;

    /** Per-geometry tracking data. */
    data: WeakMap<Geometry, GeometryData>;

    /** Cached wireframe index buffers per geometry. */
    wireframes: WeakMap<Geometry, IndexAttribute>;

    /** Memory statistics. */
    memory: {
        geometries: number;
    };
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new Geometries state.
 *
 * @param attributesState - The Attributes system state
 */
export function createGeometriesState(attributesState: AttributesState): GeometriesState {
    return {
        attributes: attributesState,
        data: new WeakMap(),
        wireframes: new WeakMap(),
        memory: {
            geometries: 0,
        },
    };
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize a geometry for rendering.
 *
 * This uploads all vertex attributes and the index buffer (if present).
 * Called once when a geometry is first encountered.
 *
 * @param state - The Geometries state
 * @param geometry - The geometry to initialize
 */
export function initGeometry(state: GeometriesState, geometry: Geometry): void {
    let data = state.data.get(geometry);

    if (data && data.initialized) {
        return; // Already initialized
    }

    // Create tracking data
    if (!data) {
        data = {
            initialized: false,
            attributeVersionSum: 0,
            indexVersion: 0,
        };
        state.data.set(geometry, data);
        state.memory.geometries++;
    }

    // Upload all vertex attributes
    let versionSum = 0;
    for (const [_name, attr] of geometry.attributes) {
        attributes.updateAttribute(state.attributes, attr, 'vertex');
        versionSum += attr.version;
    }
    data.attributeVersionSum = versionSum;

    // Upload index buffer if present
    if (geometry.index) {
        attributes.updateAttribute(
            state.attributes,
            geometry.index as unknown as BufferAttribute,
            'index',
        );
        data.indexVersion = geometry.index.version;
    }

    // Upload indirect buffer if present
    if (geometry.indirect) {
        attributes.updateAttribute(
            state.attributes,
            geometry.indirect as unknown as BufferAttribute,
            'indirect',
        );
    }

    data.initialized = true;

    // Set up disposal callback
    geometry._onDispose = () => {
        disposeGeometry(state, geometry);
    };
}

// ---------------------------------------------------------------------------
// Per-Frame Updates
// ---------------------------------------------------------------------------

/**
 * Update a geometry for rendering.
 *
 * This checks for version changes and re-uploads modified attributes.
 * Called every frame for each visible geometry.
 *
 * @param state - The Geometries state
 * @param renderObject - The RenderObject containing the geometry
 */
export function updateForRender(state: GeometriesState, renderObject: RenderObject): void {
    const geometry = renderObject.geometry;
    let data = state.data.get(geometry);

    // Initialize if needed
    if (!data || !data.initialized) {
        initGeometry(state, geometry);
        data = state.data.get(geometry)!;
    }

    // Check for vertex attribute version changes
    let versionSum = 0;
    for (const [_name, attr] of geometry.attributes) {
        versionSum += attr.version;
    }

    if (versionSum !== data.attributeVersionSum) {
        // One or more attributes changed - re-upload all
        // (A more sophisticated system could track per-attribute versions)
        for (const [_name, attr] of geometry.attributes) {
            attributes.updateAttribute(state.attributes, attr, 'vertex');
        }
        data.attributeVersionSum = versionSum;
    }

    // Check for index buffer version changes
    if (geometry.index && geometry.index.version !== data.indexVersion) {
        attributes.updateAttribute(
            state.attributes,
            geometry.index as unknown as BufferAttribute,
            'index',
        );
        data.indexVersion = geometry.index.version;
    }

    // Check for indirect buffer version changes
    if (geometry.indirect) {
        attributes.updateAttribute(
            state.attributes,
            geometry.indirect as unknown as BufferAttribute,
            'indirect',
        );
    }
}

// ---------------------------------------------------------------------------
// Index Buffer Access
// ---------------------------------------------------------------------------

/**
 * Get the index buffer for a RenderObject.
 *
 * For wireframe rendering, this returns a generated wireframe index buffer.
 * Otherwise, returns the geometry's index buffer.
 *
 * @param state - The Geometries state
 * @param renderObject - The RenderObject
 * @param wireframe - Whether wireframe mode is active
 * @returns The index buffer or null for non-indexed geometry
 */
export function getIndex(
    state: GeometriesState,
    renderObject: RenderObject,
    wireframe: boolean = false,
): IndexAttribute | null {
    const geometry = renderObject.geometry;

    if (wireframe) {
        // Get or generate wireframe indices
        let wireframeIndex = state.wireframes.get(geometry);
        if (!wireframeIndex) {
            wireframeIndex = generateWireframeIndices(geometry);
            state.wireframes.set(geometry, wireframeIndex);

            // Upload wireframe index buffer
            attributes.updateAttribute(
                state.attributes,
                wireframeIndex as unknown as BufferAttribute,
                'index',
            );
        }
        return wireframeIndex;
    }

    return geometry.index ?? null;
}

// ---------------------------------------------------------------------------
// Wireframe Index Generation
// ---------------------------------------------------------------------------

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

    // Determine number of triangles
    let numTriangles: number;
    let getIndex: (i: number) => number;

    if (index) {
        numTriangles = Math.floor(index.array.length / 3);
        getIndex = (i: number) => index.array[i];
    } else {
        numTriangles = Math.floor(position.count / 3);
        getIndex = (i: number) => i;
    }

    // Each triangle produces 3 lines = 6 indices
    const wireframeIndices = new Uint32Array(numTriangles * 6);

    let wireframeIdx = 0;
    for (let i = 0; i < numTriangles; i++) {
        const a = getIndex(i * 3);
        const b = getIndex(i * 3 + 1);
        const c = getIndex(i * 3 + 2);

        // Line a-b
        wireframeIndices[wireframeIdx++] = a;
        wireframeIndices[wireframeIdx++] = b;

        // Line b-c
        wireframeIndices[wireframeIdx++] = b;
        wireframeIndices[wireframeIdx++] = c;

        // Line c-a
        wireframeIndices[wireframeIdx++] = c;
        wireframeIndices[wireframeIdx++] = a;
    }

    return new IndexAttributeClass(wireframeIndices);
}

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

/**
 * Dispose a geometry and clean up GPU resources.
 *
 * @param state - The Geometries state
 * @param geometry - The geometry to dispose
 */
export function disposeGeometry(state: GeometriesState, geometry: Geometry): void {
    const data = state.data.get(geometry);
    if (!data) return;

    // Delete vertex attribute GPU buffers
    for (const [_name, attr] of geometry.attributes) {
        attributes.deleteAttribute(state.attributes, attr);
    }

    // Delete index buffer
    if (geometry.index) {
        attributes.deleteAttribute(state.attributes, geometry.index);
    }

    // Delete wireframe index buffer if it exists
    const wireframeIndex = state.wireframes.get(geometry);
    if (wireframeIndex) {
        attributes.deleteAttribute(state.attributes, wireframeIndex);
        state.wireframes.delete(geometry);
    }

    // Remove tracking data
    state.data.delete(geometry);
    state.memory.geometries--;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Get geometry memory statistics.
 */
export function getGeometriesStats(state: GeometriesState): { geometries: number } {
    return { ...state.memory };
}
