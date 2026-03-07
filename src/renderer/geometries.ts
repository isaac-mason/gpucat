import type { Geometry } from '../geometry/geometry';
import type { BufferAttribute, IndexAttribute } from '../core/attribute';
import { IndexAttribute as IndexAttributeClass } from '../core/attribute';
import type { RenderObject } from './render-object';
import type { AttributesState } from './attributes';
import * as attributes from './attributes';

/** Per-geometry tracking data */
export type GeometryData = {
    /** Whether the geometry has been initialized (attributes uploaded). */
    initialized: boolean;

    /** Cached per-attribute versions for dirty checking. */
    attributeVersions: Map<string, number>;

    /** Cached index version for dirty checking. */
    indexVersion: number;
};

/** Geometries state - manages geometry attribute coordination. */
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

/**
 * Create a new Geometries state.
 * @param attributesState the Attributes system state
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
    let data = state.data.get(geometry);

    if (data && data.initialized) {
        return; // already initialized
    }

    // create tracking data
    if (!data) {
        data = {
            initialized: false,
            attributeVersions: new Map(),
            indexVersion: 0,
        };
        state.data.set(geometry, data);
        state.memory.geometries++;
    }

    // upload all vertex attributes and record their versions
    for (const [name, attr] of geometry.attributes) {
        attributes.updateAttribute(state.attributes, attr, 'vertex');
        data.attributeVersions.set(name, attr.version);
    }

    // upload index buffer if present
    if (geometry.index) {
        attributes.updateAttribute(
            state.attributes,
            geometry.index as unknown as BufferAttribute,
            'index',
        );
        data.indexVersion = geometry.index.version;
    }

    // upload indirect buffer if present
    if (geometry.indirect) {
        attributes.updateAttribute(
            state.attributes,
            geometry.indirect as unknown as BufferAttribute,
            'indirect',
        );
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
 * @param state the Geometries state
 * @param renderObject the RenderObject containing the geometry
 */
export function updateForRender(state: GeometriesState, renderObject: RenderObject): void {
    const geometry = renderObject.geometry;
    let data = state.data.get(geometry);

    // initialize if needed
    if (!data || !data.initialized) {
        initGeometry(state, geometry);
        data = state.data.get(geometry)!;
    }

    // check for vertex attribute version changes and re-upload only dirty attributes
    for (const [name, attr] of geometry.attributes) {
        const knownVersion = data.attributeVersions.get(name);
        if (knownVersion === undefined || attr.version !== knownVersion) {
            attributes.updateAttribute(state.attributes, attr, 'vertex');
            data.attributeVersions.set(name, attr.version);
        }
    }

    // check for index buffer version changes
    if (geometry.index && geometry.index.version !== data.indexVersion) {
        attributes.updateAttribute(
            state.attributes,
            geometry.index as unknown as BufferAttribute,
            'index',
        );
        data.indexVersion = geometry.index.version;
    }

    // check for indirect buffer version changes
    if (geometry.indirect) {
        attributes.updateAttribute(
            state.attributes,
            geometry.indirect as unknown as BufferAttribute,
            'indirect',
        );
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
 * Dispose a geometry and clean up GPU resources.
 *
 * @param state the Geometries state
 * @param geometry the geometry to dispose
 */
export function disposeGeometry(state: GeometriesState, geometry: Geometry): void {
    const data = state.data.get(geometry);
    if (!data) return;

    // delete vertex attribute GPU buffers
    for (const [_name, attr] of geometry.attributes) {
        attributes.deleteAttribute(state.attributes, attr);
    }

    // delete index buffer
    if (geometry.index) {
        attributes.deleteAttribute(state.attributes, geometry.index);
    }

    // delete wireframe index buffer if it exists
    const wireframeIndex = state.wireframes.get(geometry);
    if (wireframeIndex) {
        attributes.deleteAttribute(state.attributes, wireframeIndex);
        state.wireframes.delete(geometry);
    }

    // remove tracking data
    state.data.delete(geometry);
    state.memory.geometries--;
}

/** Get geometry memory statistics */
export function getGeometriesStats(state: GeometriesState): { geometries: number } {
    return { ...state.memory };
}
