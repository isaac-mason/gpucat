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

export class StorageBufferAttribute {
    readonly isStorageBufferAttribute: true = true;

    /** CPU-side typed array. The primary data store — mirrors Three.js `.array`. */
    array: GpuTypedArray | null;

    /** Number of data-type components per element. */
    readonly itemSize: number;

    /** Number of elements (array.length / itemSize). */
    readonly count: number;

    /**
     * Monotonically incremented whenever the user sets `needsUpdate = true`.
     * The renderer compares this against its cached version to decide whether
     * to re-upload. Starts at 0.
     */
    version: number = 0;

    /**
     * Pending partial-upload ranges.
     * Units: flat component indices (same as Three.js BufferAttribute.updateRanges).
     */
    readonly updateRanges: UpdateRange[] = [];

    /**
     * Callback executed after the renderer uploads the data to the GPU.
     * Can be used to release CPU memory via `this.array = null`.
     *
     * @example
     * attr.onUpload = () => { attr.array = null; };
     */
    onUpload: (() => void) | null = null;

    constructor(array: GpuTypedArray, itemSize: number) {
        this.array    = array;
        this.itemSize = itemSize;
        this.count    = array.length / itemSize;
    }

    /**
     * Setting needsUpdate = true increments `version`, causing the renderer to
     * re-upload the entire `array` on the next frame.
     */
    set needsUpdate(_: true) {
        this.version++;
    }

    /**
     * Register a dirty range for partial re-upload.
     * @param start  First flat component index to re-upload.
     * @param count  Number of components to re-upload.
     */
    addUpdateRange(start: number, count: number): void {
        this.updateRanges.push({ start, count });
    }

    /**
     * Clear all pending update ranges.
     * Called automatically by the renderer after a partial upload.
     */
    clearUpdateRanges(): void {
        this.updateRanges.length = 0;
    }
}

export class InstancedBufferAttribute extends StorageBufferAttribute {
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

export class StorageInstancedBufferAttribute extends InstancedBufferAttribute {
    readonly isStorageInstancedBufferAttribute: true = true;

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


export class IndirectStorageBufferAttribute extends StorageBufferAttribute {
    readonly isIndirectStorageBufferAttribute: true = true;

    /** true → drawIndexedIndirect, false → drawIndirect. */
    readonly indexed: boolean;

    /** Number of packed draw structs in this buffer. */
    readonly drawCount: number;

    /** u32 elements per draw (4 for non-indexed, 5 for indexed). */
    readonly stride: number;

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
        const stride = indexed ? 5 : 4;
        let array: Uint32Array;
        let drawCount: number;

        if (arrayOrDrawCount instanceof Uint32Array) {
            if (arrayOrDrawCount.length % stride !== 0) {
                throw new Error(
                    `[gpucat] IndirectStorageBufferAttribute: array.length (${arrayOrDrawCount.length}) must be a multiple of stride (${stride})`
                );
            }
            array = arrayOrDrawCount;
            drawCount = arrayOrDrawCount.length / stride;
        } else {
            drawCount = typeof arrayOrDrawCount === 'number' ? arrayOrDrawCount : 1;
            array = new Uint32Array(drawCount * stride);
        }

        // itemSize=1 (each element is a single u32) — count = total u32 slots
        super(array, 1);

        this.indexed = indexed;
        this.stride = stride;
        this.drawCount = drawCount;
    }

    // -----------------------------------------------------------------------
    // Typed array accessor — convenience alias consistent with the old .data API
    // -----------------------------------------------------------------------
    /**
     * The raw Uint32Array backing this buffer.
     * Same as `.array` — provided so callers that used the old IndirectBuffer.data
     * API can migrate more easily. `.array` is the canonical name.
     */
    get data(): Uint32Array {
        return this.array as Uint32Array;
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
// BufferAttribute — a single named vertex buffer
// ---------------------------------------------------------------------------

export class BufferAttribute {
    /** CPU-side typed array. */
    data: Float32Array | Int32Array | Uint32Array;
    /** GPUVertexFormat string, e.g. 'float32x3'. */
    format: GPUVertexFormat;
    /** Byte stride between elements. 0 = tightly packed. */
    stride: number;
    /** Byte offset within each stride. */
    offset: number;
    /** Set to true when data changes; the renderer resets it after upload. */
    needsUpdate: boolean = true;

    constructor(
        data: Float32Array | Int32Array | Uint32Array,
        format: GPUVertexFormat,
        stride = 0,
        offset = 0,
    ) {
        this.data = data;
        this.format = format;
        this.stride = stride;
        this.offset = offset;
    }
}

// ---------------------------------------------------------------------------
// IndexAttribute
// ---------------------------------------------------------------------------

export class IndexAttribute {
    data: Uint16Array | Uint32Array;
    format: 'uint16' | 'uint32';
    needsUpdate: boolean = true;

    constructor(data: Uint16Array | Uint32Array) {
        this.data = data;
        this.format = data instanceof Uint16Array ? 'uint16' : 'uint32';
    }
}

// ---------------------------------------------------------------------------
// Geometry
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
     * Convenience alias for `this.attributes.set(name, attr)`.
     *
     * @example
     * geo.setAttribute('position', new BufferAttribute(positions, 'float32x3'))
     */
    setAttribute(name: string, attr: BufferAttribute): this {
        this.attributes.set(name, attr);
        return this;
    }
}


export function createBoxGeometry(width = 1, height = 1, depth = 1): Geometry {
    const hw = width  / 2;
    const hh = height / 2;
    const hd = depth  / 2;

    // Each face: 4 vertices, 2 triangles (6 indices)
    // Faces: +X, -X, +Y, -Y, +Z, -Z
    //
    // positions (3 floats), normals (3 floats), uvs (2 floats) per vertex — interleaved in
    // separate arrays for simplicity (renderer can interleave if desired).

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
    geom.attributes.set('position', new BufferAttribute(new Float32Array(positions), 'float32x3'));
    geom.attributes.set('normal',   new BufferAttribute(new Float32Array(normals),   'float32x3'));
    geom.attributes.set('uv',       new BufferAttribute(new Float32Array(uvs),       'float32x2'));
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
    geom.attributes.set('position', new BufferAttribute(new Float32Array(positions), 'float32x3'));
    geom.attributes.set('normal',   new BufferAttribute(new Float32Array(normals),   'float32x3'));
    geom.attributes.set('uv',       new BufferAttribute(new Float32Array(uvs),       'float32x2'));
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
    geom.attributes.set('position', new BufferAttribute(positions, 'float32x3'));
    geom.attributes.set('normal',   new BufferAttribute(normals,   'float32x3'));
    geom.attributes.set('uv',       new BufferAttribute(uvsData,   'float32x2'));
    geom.index = new IndexAttribute(indexData);
    geom.vertexCount = 4;
    geom.boundingBox = [-hw, -hh, 0, hw, hh, 0];
    geom.boundingSphere = { center: [0, 0, 0], radius: Math.sqrt(hw * hw + hh * hh) };
    return geom;
}