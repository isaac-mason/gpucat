import type { Box3, Sphere } from 'mathcat';
import { StorageNode } from '../nodes/nodes';

type GpuTypedArray =
    | Float32Array
    | Int32Array
    | Uint32Array
    | Int16Array
    | Uint16Array
    | Int8Array
    | Uint8Array;

export type UpdateRange = { start: number; count: number };

// ---------------------------------------------------------------------------
// BufferAttribute — base class for all buffer attributes
// ---------------------------------------------------------------------------

/**
 * Base class for buffer attributes. Stores data for vertex attributes, storage
 * buffers, etc. Aligned with Three.js BufferAttribute.
 */
export class BufferAttribute {
    readonly isBufferAttribute: true = true;

    /** CPU-side typed array. May be null after onUpload releases memory. */
    array: GpuTypedArray | null;

    /** Number of data-type components per element (e.g., 3 for vec3). */
    readonly itemSize: number;

    /** Number of elements (array.length / itemSize). */
    readonly count: number;

    /**
     * Monotonically incremented whenever needsUpdate is set to true.
     * The renderer compares against its cached version to decide re-upload.
     */
    version: number = 0;

    /** Pending partial-upload ranges (flat component indices). */
    readonly updateRanges: UpdateRange[] = [];

    /**
     * Callback executed after the renderer uploads the data to the GPU.
     * Can be used to release CPU memory via `this.array = null`.
     */
    onUpload: (() => void) | null = null;

    /**
     * Byte stride between elements. 0 = tightly packed.
     * Used for interleaved vertex buffers.
     */
    stride: number = 0;

    /**
     * Byte offset within each stride.
     * Used for interleaved vertex buffers.
     */
    offset: number = 0;

    /**
     * GPUVertexFormat for vertex buffers (e.g., 'float32x3').
     * Set explicitly or derived from array type + itemSize.
     */
    format: GPUVertexFormat | undefined;

    constructor(array: GpuTypedArray, itemSize: number, format?: GPUVertexFormat) {
        this.array = array;
        this.itemSize = itemSize;
        this.count = array.length / itemSize;
        this.format = format ?? deriveVertexFormat(array, itemSize);
    }

    /** Setting needsUpdate = true increments version. */
    set needsUpdate(_: true) {
        this.version++;
    }

    /** Register a dirty range for partial re-upload. */
    addUpdateRange(start: number, count: number): void {
        this.updateRanges.push({ start, count });
    }

    /** Clear all pending update ranges. Called by renderer after upload. */
    clearUpdateRanges(): void {
        this.updateRanges.length = 0;
    }
}

// ---------------------------------------------------------------------------
// StorageBufferAttribute — for storage buffers (compute shaders)
// ---------------------------------------------------------------------------

/**
 * Buffer attribute for storage buffers. Extends BufferAttribute.
 * Aligned with Three.js StorageBufferAttribute.
 */
export class StorageBufferAttribute extends BufferAttribute {
    readonly isStorageBufferAttribute: true = true;

    /**
     * @param array  A typed array, OR a count (number of elements).
     * @param itemSize  Components per element (e.g., 4 for vec4f).
     * @param typeClass  TypedArray constructor if `array` is a count.
     */
    constructor(
        array: GpuTypedArray | number,
        itemSize: number,
        typeClass: new (length: number) => GpuTypedArray = Float32Array,
    ) {
        const arr = typeof array === 'number'
            ? new typeClass(array * itemSize)
            : array;
        super(arr, itemSize);
    }
}

// ---------------------------------------------------------------------------
// InstancedBufferAttribute — for instanced vertex attributes
// ---------------------------------------------------------------------------

export class InstancedBufferAttribute extends BufferAttribute {
    readonly isInstancedBufferAttribute: true = true;

    /**
     * Defines how often a value of this buffer attribute should be repeated.
     * A value of 1 means each value is used for a single instance.
     * A value of 2 means each value is used for two consecutive instances, etc.
     */
    readonly meshPerAttribute: number;

    constructor(array: GpuTypedArray, itemSize: number, meshPerAttribute = 1) {
        super(array, itemSize);
        this.meshPerAttribute = meshPerAttribute;
    }
}

// ---------------------------------------------------------------------------
// StorageInstancedBufferAttribute — instanced storage buffer attribute
// ---------------------------------------------------------------------------

export class StorageInstancedBufferAttribute extends InstancedBufferAttribute {
    readonly isStorageInstancedBufferAttribute: true = true;
    readonly isStorageBufferAttribute: true = true;

    /**
     * @param count     Number of instances, OR a pre-allocated TypedArray.
     * @param itemSize  Number of components per instance (ignored if count is a TypedArray).
     * @param typeClass TypedArray constructor (default Float32Array).
     */
    constructor(
        count: number | GpuTypedArray,
        itemSize: number,
        typeClass: new (length: number) => GpuTypedArray = Float32Array,
    ) {
        const array = ArrayBuffer.isView(count)
            ? count as GpuTypedArray
            : new typeClass(count * itemSize);
        super(array, itemSize);
    }
}

// ---------------------------------------------------------------------------
// IndirectStorageBufferAttribute — for indirect draw buffers
// ---------------------------------------------------------------------------

export class IndirectStorageBufferAttribute extends StorageBufferAttribute {
    readonly isIndirectStorageBufferAttribute: true = true;

    /** true → drawIndexedIndirect, false → drawIndirect. */
    readonly indexed: boolean;

    /** Number of packed draw structs in this buffer. */
    readonly drawCount: number;

    /** u32 elements per draw (4 for non-indexed, 5 for indexed). */
    readonly indirectStride: number;

    /** Lazily created flat StorageNode. */
    private _storageNode: StorageNode<'u32'> | null = null;

    /** Lazily created struct-typed StorageNode. */
    private _structStorageNode: StorageNode<string> | null = null;

    /**
     * Constructor:
     *   new IndirectStorageBufferAttribute(indexed)
     *     → single draw, array zero-initialised
     *
     *   new IndirectStorageBufferAttribute(indexed, drawCount: number)
     *     → N draws, array zero-initialised
     *
     *   new IndirectStorageBufferAttribute(indexed, array: Uint32Array)
     *     → array.length must equal drawCount * stride; drawCount inferred
     */
    constructor(
        indexed: boolean,
        arrayOrDrawCount?: Uint32Array | number
    ) {
        const indirectStride = indexed ? 5 : 4;
        let array: Uint32Array;
        let drawCount: number;

        if (arrayOrDrawCount instanceof Uint32Array) {
            if (arrayOrDrawCount.length % indirectStride !== 0) {
                throw new Error(
                    `[gpucat] IndirectStorageBufferAttribute: array.length (${arrayOrDrawCount.length}) must be a multiple of stride (${indirectStride})`
                );
            }
            array = arrayOrDrawCount;
            drawCount = arrayOrDrawCount.length / indirectStride;
        } else {
            drawCount = typeof arrayOrDrawCount === 'number' ? arrayOrDrawCount : 1;
            array = new Uint32Array(drawCount * indirectStride);
        }

        // itemSize=1 (each element is a single u32) — count = total u32 slots
        super(array, 1);

        this.indexed = indexed;
        this.indirectStride = indirectStride;
        this.drawCount = drawCount;
    }

    /**
     * Internal: return the cached StorageNode if it exists, without creating one.
     * Returns the struct-typed node if present, otherwise the flat array<u32> node.
     * Used by BufferCache to detect shared-buffer indirect nodes.
     */
    get _cachedStorageNode(): StorageNode<string> | StorageNode<'u32'> | null {
        return this._structStorageNode ?? this._storageNode;
    }
}

// ---------------------------------------------------------------------------
// IndexAttribute — for index buffers
// ---------------------------------------------------------------------------

export class IndexAttribute {
    readonly isIndexAttribute: true = true;
    
    array: Uint16Array | Uint32Array;
    format: 'uint16' | 'uint32';
    version: number = 0;

    constructor(array: Uint16Array | Uint32Array) {
        this.array = array;
        this.format = array instanceof Uint16Array ? 'uint16' : 'uint32';
    }

    set needsUpdate(_: true) {
        this.version++;
    }
}

// ---------------------------------------------------------------------------
// Geometry — container for vertex/index buffers
// ---------------------------------------------------------------------------

export class Geometry {
    /** Named vertex buffer attributes. Standard names: position, normal, uv, tangent. */
    readonly attributes: Map<string, BufferAttribute> = new Map();
    /** Optional index buffer. */
    index: IndexAttribute | undefined = undefined;
    /** Number of vertices. Used for non-indexed draws. */
    vertexCount: number = 0;
    /**
     * Optional indirect draw buffer. When set, the renderer calls
     * drawIndirect / drawIndexedIndirect using this buffer instead of
     * draw / drawIndexed. `mesh.count` is ignored when this is set.
     */
    indirect: IndirectStorageBufferAttribute | undefined = undefined;
    /**
     * Axis-aligned bounding box in local space.
     * Set by createBoxGeometry / createSphereGeometry / createPlaneGeometry.
     * You may set this manually for custom geometry to enable frustum culling.
     */
    boundingBox: Box3 | undefined = undefined;
    /**
     * Bounding sphere in local space.
     * Set by createBoxGeometry / createSphereGeometry / createPlaneGeometry.
     * You may set this manually for custom geometry to enable frustum culling.
     */
    boundingSphere: Sphere | undefined = undefined;

    /**
     * Set to true after dispose() is called.
     * The renderer checks this flag to skip rendering and clean up GPU resources.
     */
    disposed: boolean = false;

    /**
     * Internal callback set by the renderer to clean up GPU resources.
     * @internal
     */
    _onDispose: (() => void) | null = null;

    /**
     * Convenience alias for `this.attributes.set(name, attr)`.
     *
     * @example
     * geo.setAttribute('position', new BufferAttribute(positions, 3))
     */
    setAttribute(name: string, attr: BufferAttribute): this {
        this.attributes.set(name, attr);
        return this;
    }

    /**
     * Frees GPU-related resources allocated for this geometry.
     * Call this method when the geometry is no longer used.
     * Mirrors Three.js BufferGeometry.dispose().
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this._onDispose?.();
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive GPUVertexFormat from typed array type and itemSize.
 */
function deriveVertexFormat(array: GpuTypedArray, itemSize: number): GPUVertexFormat | undefined {
    if (array instanceof Float32Array) {
        switch (itemSize) {
            case 1: return 'float32';
            case 2: return 'float32x2';
            case 3: return 'float32x3';
            case 4: return 'float32x4';
        }
    } else if (array instanceof Int32Array) {
        switch (itemSize) {
            case 1: return 'sint32';
            case 2: return 'sint32x2';
            case 3: return 'sint32x3';
            case 4: return 'sint32x4';
        }
    } else if (array instanceof Uint32Array) {
        switch (itemSize) {
            case 1: return 'uint32';
            case 2: return 'uint32x2';
            case 3: return 'uint32x3';
            case 4: return 'uint32x4';
        }
    } else if (array instanceof Int16Array) {
        switch (itemSize) {
            case 2: return 'sint16x2';
            case 4: return 'sint16x4';
        }
    } else if (array instanceof Uint16Array) {
        switch (itemSize) {
            case 2: return 'uint16x2';
            case 4: return 'uint16x4';
        }
    } else if (array instanceof Int8Array) {
        switch (itemSize) {
            case 2: return 'sint8x2';
            case 4: return 'sint8x4';
        }
    } else if (array instanceof Uint8Array) {
        switch (itemSize) {
            case 2: return 'uint8x2';
            case 4: return 'uint8x4';
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Geometry factory functions
// ---------------------------------------------------------------------------

export function createBoxGeometry(width = 1, height = 1, depth = 1): Geometry {
    const hw = width  / 2;
    const hh = height / 2;
    const hd = depth  / 2;

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    function face(
        ax: number, ay: number, az: number,
        bx: number, by: number, bz: number,
        cx: number, cy: number, cz: number,
        dx: number, dy: number, dz: number,
        nx: number, ny: number, nz: number,
    ): void {
        const base = positions.length / 3;
        positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
        normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
        uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
        indices.push(base, base+1, base+2, base, base+2, base+3);
    }

    // +X
    face( hw,-hh,-hd,  hw, hh,-hd,  hw, hh, hd,  hw,-hh, hd,  1, 0, 0);
    // -X
    face(-hw,-hh, hd, -hw, hh, hd, -hw, hh,-hd, -hw,-hh,-hd, -1, 0, 0);
    // +Y
    face(-hw, hh,-hd, -hw, hh, hd,  hw, hh, hd,  hw, hh,-hd,  0, 1, 0);
    // -Y
    face(-hw,-hh, hd, -hw,-hh,-hd,  hw,-hh,-hd,  hw,-hh, hd,  0,-1, 0);
    // +Z
    face(-hw,-hh, hd,  hw,-hh, hd,  hw, hh, hd, -hw, hh, hd,  0, 0, 1);
    // -Z
    face( hw,-hh,-hd, -hw,-hh,-hd, -hw, hh,-hd,  hw, hh,-hd,  0, 0,-1);

    const geom = new Geometry();
    geom.attributes.set('position', new BufferAttribute(new Float32Array(positions), 3));
    geom.attributes.set('normal',   new BufferAttribute(new Float32Array(normals),   3));
    geom.attributes.set('uv',       new BufferAttribute(new Float32Array(uvs),       2));
    geom.index = new IndexAttribute(new Uint16Array(indices));
    geom.vertexCount = positions.length / 3;
    geom.boundingBox = [-hw, -hh, -hd, hw, hh, hd];
    geom.boundingSphere = { center: [0, 0, 0], radius: Math.sqrt(hw * hw + hh * hh + hd * hd) };
    return geom;
}

export function createSphereGeometry(radius = 0.5, widthSegments = 16, heightSegments = 8): Geometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (let iy = 0; iy <= heightSegments; iy++) {
        const v = iy / heightSegments;
        const phi = v * Math.PI;
        for (let ix = 0; ix <= widthSegments; ix++) {
            const u = ix / widthSegments;
            const theta = u * Math.PI * 2;
            const sinPhi = Math.sin(phi);
            const nx = Math.cos(theta) * sinPhi;
            const ny = Math.cos(phi);
            const nz = Math.sin(theta) * sinPhi;
            positions.push(nx * radius, ny * radius, nz * radius);
            normals.push(nx, ny, nz);
            uvs.push(u, v);
        }
    }

    for (let iy = 0; iy < heightSegments; iy++) {
        for (let ix = 0; ix < widthSegments; ix++) {
            const a = iy * (widthSegments + 1) + ix;
            const b = a + widthSegments + 1;
            indices.push(a, b, a+1, b, b+1, a+1);
        }
    }

    const geom = new Geometry();
    geom.attributes.set('position', new BufferAttribute(new Float32Array(positions), 3));
    geom.attributes.set('normal',   new BufferAttribute(new Float32Array(normals),   3));
    geom.attributes.set('uv',       new BufferAttribute(new Float32Array(uvs),       2));
    geom.index = new IndexAttribute(new Uint16Array(indices));
    geom.vertexCount = positions.length / 3;
    geom.boundingBox = [-radius, -radius, -radius, radius, radius, radius];
    geom.boundingSphere = { center: [0, 0, 0], radius };
    return geom;
}

export function createPlaneGeometry(width = 1, height = 1): Geometry {
    const hw = width  / 2;
    const hh = height / 2;

    const positions = new Float32Array([-hw,-hh, 0,  hw,-hh, 0,  hw, hh, 0, -hw, hh, 0]);
    const normals   = new Float32Array([  0,  0, 1,   0,  0, 1,   0,  0, 1,   0,  0, 1]);
    const uvsData   = new Float32Array([  0,  0, 1,   0,  1,  1,  0,  1]);
    const indexData = new Uint16Array([0, 1, 2, 0, 2, 3]);

    const geom = new Geometry();
    geom.attributes.set('position', new BufferAttribute(positions, 3));
    geom.attributes.set('normal',   new BufferAttribute(normals,   3));
    geom.attributes.set('uv',       new BufferAttribute(uvsData,   2));
    geom.index = new IndexAttribute(indexData);
    geom.vertexCount = 4;
    geom.boundingBox = [-hw, -hh, 0, hw, hh, 0];
    geom.boundingSphere = { center: [0, 0, 0], radius: Math.sqrt(hw * hw + hh * hh) };
    return geom;
}
