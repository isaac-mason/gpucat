import { createVertexBuffer, createIndexBuffer } from '../core/gpu-buffer';
import { Geometry } from '../geometry/geometry';
import { Material } from '../material/material';
import { Mesh } from './mesh';
import { type Raycaster, type Intersection, rayIntersectsBox3 } from '../math/raycaster';
import { vec3, mat4, type Vec3, type Mat4 } from 'mathcat';
import * as d from '../schema/schema';
import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    modelWorldMatrix,
    screenSize,
    uniform,
    vec2f,
    vec4f,
    f32,
    normalize,
    cross,
    div,
    mul,
    add,
    sub,
    type Node,
    type UniformNode,
} from '../nodes/nodes';

// ─── Geometry ────────────────────────────────────────────────────────────────

/**
 * Shared inner loop, writes one quad into pre-allocated arrays at segment slot `segmentOffset + s`.
 */
function writeQuad(
    s: number,
    segmentOffset: number,
    sx: number,
    sy: number,
    sz: number,
    ex: number,
    ey: number,
    ez: number,
    instanceStart: Float32Array,
    instanceEnd: Float32Array,
    side: Float32Array,
    uv: Float32Array,
    indices: Uint32Array,
): void {
    const vi = (segmentOffset + s) * 4;

    for (let v = 0; v < 4; v++) {
        instanceStart[(vi + v) * 3 + 0] = sx;
        instanceStart[(vi + v) * 3 + 1] = sy;
        instanceStart[(vi + v) * 3 + 2] = sz;
        instanceEnd[(vi + v) * 3 + 0] = ex;
        instanceEnd[(vi + v) * 3 + 1] = ey;
        instanceEnd[(vi + v) * 3 + 2] = ez;
    }

    side[vi + 0] = -1;
    side[vi + 1] = -1;
    side[vi + 2] = 1;
    side[vi + 3] = 1;

    uv[(vi + 0) * 2] = 0;
    uv[(vi + 0) * 2 + 1] = 0;
    uv[(vi + 1) * 2] = 1;
    uv[(vi + 1) * 2 + 1] = 0;
    uv[(vi + 2) * 2] = 0;
    uv[(vi + 2) * 2 + 1] = 1;
    uv[(vi + 3) * 2] = 1;
    uv[(vi + 3) * 2 + 1] = 1;

    const ii = (segmentOffset + s) * 6;
    indices[ii + 0] = vi + 0;
    indices[ii + 1] = vi + 1;
    indices[ii + 2] = vi + 2;
    indices[ii + 3] = vi + 1;
    indices[ii + 4] = vi + 3;
    indices[ii + 5] = vi + 2;
}

/**
 * Write polyline segment quads: each point connects to the next, wrapping at `pointCount`
 * for closed lines (segmentCount === pointCount) or stopping one short for open lines
 * (segmentCount === pointCount - 1).
 */
function writePolylineSegments(
    src: Float32Array,
    pointCount: number,
    segmentCount: number,
    instanceStart: Float32Array,
    instanceEnd: Float32Array,
    side: Float32Array,
    uv: Float32Array,
    indices: Uint32Array,
    segmentOffset: number = 0,
): void {
    for (let s = 0; s < segmentCount; s++) {
        const ni = (s + 1) % pointCount;
        writeQuad(
            s,
            segmentOffset,
            src[s * 3],
            src[s * 3 + 1],
            src[s * 3 + 2],
            src[ni * 3],
            src[ni * 3 + 1],
            src[ni * 3 + 2],
            instanceStart,
            instanceEnd,
            side,
            uv,
            indices,
        );
    }
}

/**
 * Write line-segments quads: points are consumed as independent pairs [p0,p1, p2,p3, ...].
 * segmentCount === floor(pointCount / 2).
 */
function writeSegmentPairs(
    src: Float32Array,
    segmentCount: number,
    instanceStart: Float32Array,
    instanceEnd: Float32Array,
    side: Float32Array,
    uv: Float32Array,
    indices: Uint32Array,
    segmentOffset: number = 0,
): void {
    for (let s = 0; s < segmentCount; s++) {
        const si = s * 2;
        writeQuad(
            s,
            segmentOffset,
            src[si * 3],
            src[si * 3 + 1],
            src[si * 3 + 2],
            src[(si + 1) * 3],
            src[(si + 1) * 3 + 1],
            src[(si + 1) * 3 + 2],
            instanceStart,
            instanceEnd,
            side,
            uv,
            indices,
        );
    }
}

/**
 * Screen-space expanded line geometry.
 *
 * Allocates GPU buffers once at construction for up to `maxPoints` points.
 * Subsequent calls to `update()` write into the existing buffers and adjust
 * `drawRange.count`, no reallocation unless the point array exceeds `maxPoints`.
 *
 * Vertex buffers (per-vertex, 4 verts per segment):
 *   'instanceStart'  vec3f  - world-space segment start
 *   'instanceEnd'    vec3f  - world-space segment end
 *   'side'           f32    - +1 / -1 expansion side
 *   'uv'             vec2f  - u along segment, v across width
 *
 * Pair with a `LineMaterial`.
 *
 * @param points    Initial flat [x,y,z,...] point list. At least 2 points required.
 * @param closed    Connect last point back to first. Default false.
 * @param maxPoints Maximum points this geometry will ever hold. Defaults to the
 *                  initial point count. Pass a larger value to avoid reallocation
 *                  when calling update() with more points later.
 */
export class LineGeometry extends Geometry {
    private _maxSegments: number;
    private _segmentCount: number;
    private _closed: boolean;

    constructor(points: Float32Array | number[], closed = false, maxPoints?: number) {
        super();

        const src = points instanceof Float32Array ? points : new Float32Array(points);
        const pointCount = Math.floor(src.length / 3);
        if (pointCount < 2) throw new Error('LineGeometry: need at least 2 points');

        const segmentCount = closed ? pointCount : pointCount - 1;
        const maxSegs = maxPoints !== undefined ? (closed ? maxPoints : maxPoints - 1) : segmentCount;

        if (maxSegs < segmentCount) {
            throw new Error('LineGeometry: maxPoints is smaller than the initial point count');
        }

        const maxVerts = maxSegs * 4;

        const instanceStart = new Float32Array(maxVerts * 3);
        const instanceEnd = new Float32Array(maxVerts * 3);
        const side = new Float32Array(maxVerts);
        const uv = new Float32Array(maxVerts * 2);
        const indices = new Uint32Array(maxSegs * 6);

        writePolylineSegments(src, pointCount, segmentCount, instanceStart, instanceEnd, side, uv, indices);

        this.setBuffer('instanceStart', createVertexBuffer(d.vec3f, instanceStart));
        this.setBuffer('instanceEnd', createVertexBuffer(d.vec3f, instanceEnd));
        this.setBuffer('side', createVertexBuffer(d.f32, side));
        this.setBuffer('uv', createVertexBuffer(d.vec2f, uv));
        this.setIndex(createIndexBuffer(indices));

        this._maxSegments = maxSegs;
        this._segmentCount = segmentCount;
        this._closed = closed;
        this.drawRange = { start: 0, count: segmentCount * 6 };
    }

    /** Number of segments currently drawn. */
    get segmentCount(): number {
        return this._segmentCount;
    }

    /**
     * Update the line's point data in-place.
     *
     * If the new point count fits within the pre-allocated capacity, this only
     * writes into existing typed arrays and adjusts `drawRange.count`, no GPU
     * buffer reallocation occurs. If the new count exceeds capacity, buffers are
     * reallocated to the new size (capacity grows, never shrinks).
     *
     * @param points  New flat [x,y,z,...] array. At least 2 points.
     * @param closed  Whether the line is closed. Defaults to the value set at construction.
     */
    update(points: Float32Array | number[], closed = this._closed): void {
        const src = points instanceof Float32Array ? points : new Float32Array(points);
        const pointCount = Math.floor(src.length / 3);
        if (pointCount < 2) throw new Error('LineGeometry.update: need at least 2 points');

        const segmentCount = closed ? pointCount : pointCount - 1;

        if (segmentCount > this._maxSegments) {
            // Grow: reallocate all buffers at the new size
            const maxVerts = segmentCount * 4;
            const instanceStart = new Float32Array(maxVerts * 3);
            const instanceEnd = new Float32Array(maxVerts * 3);
            const side = new Float32Array(maxVerts);
            const uv = new Float32Array(maxVerts * 2);
            const indices = new Uint32Array(segmentCount * 6);

            writePolylineSegments(src, pointCount, segmentCount, instanceStart, instanceEnd, side, uv, indices);

            this.setBuffer('instanceStart', createVertexBuffer(d.vec3f, instanceStart));
            this.setBuffer('instanceEnd', createVertexBuffer(d.vec3f, instanceEnd));
            this.setBuffer('side', createVertexBuffer(d.f32, side));
            this.setBuffer('uv', createVertexBuffer(d.vec2f, uv));
            this.setIndex(createIndexBuffer(indices));

            this._maxSegments = segmentCount;
        } else {
            // Write into existing buffers, no reallocation
            const startBuf = this.getBuffer<d.vec3f>('instanceStart')!;
            const endBuf = this.getBuffer<d.vec3f>('instanceEnd')!;
            const sideBuf = this.getBuffer<d.f32>('side')!;
            const uvBuf = this.getBuffer<d.vec2f>('uv')!;
            const idxBuf = this.index!;

            writePolylineSegments(
                src,
                pointCount,
                segmentCount,
                startBuf.array as Float32Array,
                endBuf.array as Float32Array,
                sideBuf.array as Float32Array,
                uvBuf.array as Float32Array,
                idxBuf.array as Uint32Array,
            );

            startBuf.version++;
            endBuf.version++;
            sideBuf.version++;
            uvBuf.version++;
            idxBuf.version++;
        }

        this._segmentCount = segmentCount;
        this._closed = closed;
        this.drawRange = { start: 0, count: segmentCount * 6 };
    }

    /**
     * Compute cumulative arc-length distances along the polyline and store them
     * as 'instanceDistanceStart' / 'instanceDistanceEnd' vertex buffers.
     *
     * Each segment vertex carries the cumulative distance at its start and end
     * endpoint in world units. Used by dash shaders.
     *
     * Call after construction or after update(). Returns `this` for chaining.
     */
    computeLineDistances(): this {
        const n = this._segmentCount;
        const startBuf = this.getBuffer<d.vec3f>('instanceStart')!;
        const endBuf = this.getBuffer<d.vec3f>('instanceEnd')!;
        const starts = startBuf.array as Float32Array;
        const ends = endBuf.array as Float32Array;

        // One f32 per vertex (4 verts per segment)
        const dStart = new Float32Array(n * 4);
        const dEnd = new Float32Array(n * 4);

        let cumulative = 0;
        for (let s = 0; s < n; s++) {
            // All 4 verts of a segment share the same start/end, read vertex 0 of the quad
            const vi = s * 4;
            const ax = starts[vi * 3],
                ay = starts[vi * 3 + 1],
                az = starts[vi * 3 + 2];
            const bx = ends[vi * 3],
                by = ends[vi * 3 + 1],
                bz = ends[vi * 3 + 2];
            const len = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2);

            const ds = cumulative;
            const de = cumulative + len;
            cumulative = de;

            for (let v = 0; v < 4; v++) {
                dStart[vi + v] = ds;
                dEnd[vi + v] = de;
            }
        }

        const existingDS = this.getBuffer<d.f32>('instanceDistanceStart');
        const existingDE = this.getBuffer<d.f32>('instanceDistanceEnd');

        if (existingDS?.array && existingDS.array.length === dStart.length) {
            (existingDS.array as Float32Array).set(dStart);
            existingDS.version++;
            (existingDE!.array as Float32Array).set(dEnd);
            existingDE!.version++;
        } else {
            this.setBuffer('instanceDistanceStart', createVertexBuffer(d.f32, dStart));
            this.setBuffer('instanceDistanceEnd', createVertexBuffer(d.f32, dEnd));
        }

        return this;
    }
}

/**
 * Geometry for rendering independent line segments from disjoint point pairs.
 *
 * Points are consumed as pairs: [p0,p1, p2,p3, ...]. Each pair is one segment.
 * An odd trailing point is ignored. There is no concept of "closed".
 *
 * Allocates GPU buffers once at construction for up to `maxPoints` points.
 * Subsequent calls to `update()` write into the existing buffers and adjust
 * `drawRange.count`, no reallocation unless the point array exceeds `maxPoints`.
 *
 * Pair with a `LineMaterial`.
 *
 * @param points    Initial flat [x,y,z,...] point list. At least 2 points (one pair).
 * @param maxPoints Maximum points this geometry will ever hold. Defaults to the
 *                  initial point count. Pass a larger value to avoid reallocation.
 */
export class LineSegmentsGeometry extends Geometry {
    private _maxSegments: number;
    private _segmentCount: number;

    constructor(points: Float32Array | number[], maxPoints?: number) {
        super();

        const src = points instanceof Float32Array ? points : new Float32Array(points);
        const pointCount = Math.floor(src.length / 3);
        if (pointCount < 2) throw new Error('LineSegmentsGeometry: need at least 2 points (one pair)');

        const segmentCount = Math.floor(pointCount / 2);
        const maxSegs = maxPoints !== undefined ? Math.floor(maxPoints / 2) : segmentCount;

        if (maxSegs < segmentCount) {
            throw new Error('LineSegmentsGeometry: maxPoints is smaller than the initial point count');
        }

        const maxVerts = maxSegs * 4;

        const instanceStart = new Float32Array(maxVerts * 3);
        const instanceEnd = new Float32Array(maxVerts * 3);
        const side = new Float32Array(maxVerts);
        const uv = new Float32Array(maxVerts * 2);
        const indices = new Uint32Array(maxSegs * 6);

        writeSegmentPairs(src, segmentCount, instanceStart, instanceEnd, side, uv, indices);

        this.setBuffer('instanceStart', createVertexBuffer(d.vec3f, instanceStart));
        this.setBuffer('instanceEnd', createVertexBuffer(d.vec3f, instanceEnd));
        this.setBuffer('side', createVertexBuffer(d.f32, side));
        this.setBuffer('uv', createVertexBuffer(d.vec2f, uv));
        this.setIndex(createIndexBuffer(indices));

        this._maxSegments = maxSegs;
        this._segmentCount = segmentCount;
        this.drawRange = { start: 0, count: segmentCount * 6 };
    }

    /** Number of segments currently drawn. */
    get segmentCount(): number {
        return this._segmentCount;
    }

    /**
     * Update the segment data in-place.
     *
     * If the new point count fits within the pre-allocated capacity, this only
     * writes into existing typed arrays and adjusts `drawRange.count`, no GPU
     * buffer reallocation occurs. If the new count exceeds capacity, buffers are
     * reallocated to the new size (capacity grows, never shrinks).
     *
     * @param points  New flat [x,y,z,...] array. At least 2 points.
     */
    update(points: Float32Array | number[]): void {
        const src = points instanceof Float32Array ? points : new Float32Array(points);
        const pointCount = Math.floor(src.length / 3);
        if (pointCount < 2) throw new Error('LineSegmentsGeometry.update: need at least 2 points');

        const segmentCount = Math.floor(pointCount / 2);

        if (segmentCount > this._maxSegments) {
            const maxVerts = segmentCount * 4;
            const instanceStart = new Float32Array(maxVerts * 3);
            const instanceEnd = new Float32Array(maxVerts * 3);
            const side = new Float32Array(maxVerts);
            const uv = new Float32Array(maxVerts * 2);
            const indices = new Uint32Array(segmentCount * 6);

            writeSegmentPairs(src, segmentCount, instanceStart, instanceEnd, side, uv, indices);

            this.setBuffer('instanceStart', createVertexBuffer(d.vec3f, instanceStart));
            this.setBuffer('instanceEnd', createVertexBuffer(d.vec3f, instanceEnd));
            this.setBuffer('side', createVertexBuffer(d.f32, side));
            this.setBuffer('uv', createVertexBuffer(d.vec2f, uv));
            this.setIndex(createIndexBuffer(indices));

            this._maxSegments = segmentCount;
        } else {
            const startBuf = this.getBuffer<d.vec3f>('instanceStart')!;
            const endBuf = this.getBuffer<d.vec3f>('instanceEnd')!;
            const sideBuf = this.getBuffer<d.f32>('side')!;
            const uvBuf = this.getBuffer<d.vec2f>('uv')!;
            const idxBuf = this.index!;

            writeSegmentPairs(
                src,
                segmentCount,
                startBuf.array as Float32Array,
                endBuf.array as Float32Array,
                sideBuf.array as Float32Array,
                uvBuf.array as Float32Array,
                idxBuf.array as Uint32Array,
            );

            startBuf.version++;
            endBuf.version++;
            sideBuf.version++;
            uvBuf.version++;
            idxBuf.version++;
        }

        this._segmentCount = segmentCount;
        this.drawRange = { start: 0, count: segmentCount * 6 };
    }

    /**
     * Compute per-segment distances and store as 'instanceDistanceStart' /
     * 'instanceDistanceEnd' vertex buffers.
     *
     * For disjoint pairs each segment is independent: distanceStart = 0,
     * distanceEnd = length(end - start). Used by dash shaders.
     *
     * Call after construction or after update(). Returns `this` for chaining.
     */
    computeLineDistances(): this {
        const n = this._segmentCount;
        const startBuf = this.getBuffer<d.vec3f>('instanceStart')!;
        const endBuf = this.getBuffer<d.vec3f>('instanceEnd')!;
        const starts = startBuf.array as Float32Array;
        const ends = endBuf.array as Float32Array;

        const dStart = new Float32Array(n * 4);
        const dEnd = new Float32Array(n * 4);

        for (let s = 0; s < n; s++) {
            const vi = s * 4;
            const ax = starts[vi * 3],
                ay = starts[vi * 3 + 1],
                az = starts[vi * 3 + 2];
            const bx = ends[vi * 3],
                by = ends[vi * 3 + 1],
                bz = ends[vi * 3 + 2];
            const len = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2);

            for (let v = 0; v < 4; v++) {
                dStart[vi + v] = 0;
                dEnd[vi + v] = len;
            }
        }

        const existingDS = this.getBuffer<d.f32>('instanceDistanceStart');
        const existingDE = this.getBuffer<d.f32>('instanceDistanceEnd');

        if (existingDS?.array && existingDS.array.length === dStart.length) {
            (existingDS.array as Float32Array).set(dStart);
            existingDS.version++;
            (existingDE!.array as Float32Array).set(dEnd);
            existingDE!.version++;
        } else {
            this.setBuffer('instanceDistanceStart', createVertexBuffer(d.f32, dStart));
            this.setBuffer('instanceDistanceEnd', createVertexBuffer(d.f32, dEnd));
        }

        return this;
    }
}

// ─── Vertex node ─────────────────────────────────────────────────────────────

/**
 * Build a vertex Node<vec4f> for screen-space expanded lines.
 *
 * Reads 'instanceStart', 'instanceEnd', 'side', 'uv' from the geometry and
 * applies MVP + screen-space width expansion.
 *
 * The `uv` attribute's x component selects which clip position this vertex
 * sits at: u < 0.5 → start end of segment, u >= 0.5 → end of segment.
 *
 * @param lineWidthNode  Node<f32>: width in pixels (or world units if worldUnits=true).
 * @param worldUnits     Scale width by clip-space w so it stays constant in world space.
 */
function lineVertex(lineWidthNode: Node<d.f32>, worldUnits = false): Node<d.vec4f> {
    const startAttr = attribute('instanceStart', d.vec3f);
    const endAttr = attribute('instanceEnd', d.vec3f);
    const sideAttr = attribute('side', d.f32);
    const uvAttr = attribute('uv', d.vec2f);

    // model-view transform both endpoints to view (camera) space
    const mv = mul(cameraViewMatrix, modelWorldMatrix);
    const toView = (p: Node<d.vec3f>) => mul(mv, vec4f(p, 1)) as Node<d.vec4f>;

    const viewStart = toView(startAttr);
    const viewEnd = toView(endAttr);

    // select view position for this vertex: u=0 → start, u=1 → end
    const atEnd = uvAttr.x.greaterThanEqual(f32(0.5));
    const viewPos = atEnd.select(viewEnd, viewStart) as unknown as Node<d.vec4f>;

    if (worldUnits) {
        // world-units path: expand in view space
        // line direction in view space
        const lineDir = normalize(sub(viewEnd.xyz, viewStart.xyz));

        // view-space forward: direction from midpoint to camera (camera is at origin in view space)
        const midpoint = mul(add(viewStart.xyz, viewEnd.xyz), f32(0.5));
        const viewFwd = normalize(midpoint.negate());

        // perpendicular to both line direction and view forward
        const up = normalize(cross(lineDir, viewFwd));

        // offset in view space
        const hw = mul(lineWidthNode, f32(0.5));
        const offset = mul(up, mul(hw, sideAttr));

        // apply offset to view-space position
        const offsetView = vec4f(add(viewPos.xyz, offset), f32(1));

        // project to clip space
        return mul(cameraProjectionMatrix, offsetView) as Node<d.vec4f>;
    }

    // screen-space pixel path (original)
    const clipStart = mul(cameraProjectionMatrix, viewStart) as Node<d.vec4f>;
    const clipEnd = mul(cameraProjectionMatrix, viewEnd) as Node<d.vec4f>;
    const clipPos = atEnd.select(clipEnd, clipStart) as unknown as Node<d.vec4f>;

    // NDC xy (perspective divide)
    const ndcStart = div(clipStart.xy, clipStart.w);
    const ndcEnd = div(clipEnd.xy, clipEnd.w);

    // screen-space direction, corrected for aspect ratio
    const aspect = div(screenSize.x, screenSize.y);
    const rawDir = sub(ndcEnd, ndcStart);
    const dirCorrected = vec2f(mul(rawDir.x, aspect), rawDir.y);
    const dir = normalize(dirCorrected);

    // perpendicular in screen space, un-corrected back to NDC
    const perp = vec2f(div(dir.y.negate(), aspect), dir.x);

    // offset magnitude: pixels → NDC (divide by screen height)
    const halfOffset = mul(perp, div(mul(lineWidthNode, f32(0.5)), screenSize.y));

    // apply offset in clip space (multiply by w to go NDC → clip)
    const offsetClip = mul(halfOffset, clipPos.w as unknown as Node<d.f32>);
    const finalXY = add(clipPos.xy, mul(offsetClip, sideAttr));

    return vec4f(finalXY, clipPos.zw) as unknown as Node<d.vec4f>;
}

// ─── Material ────────────────────────────────────────────────────────────────

export type LineMaterialOptions = {
    /** RGBA color node. Defaults to opaque white. */
    color?: Node<d.vec4f>;
    /** Line width in pixels (or world units if worldUnits=true). Default 2. */
    lineWidth?: number;
    /** When true lineWidth is in world units, not pixels. Default false. */
    worldUnits?: boolean;
    /** Enable alpha blending. Default false. */
    transparent?: boolean;
    /** Custom blend state. Only used when transparent=true. */
    blend?: GPUBlendState;
};

/**
 * Material for rendering screen-space expanded lines.
 *
 * Pair with a `LineGeometry`.
 *
 * @example
 * const geom = new LineGeometry([0,0,0, 1,0,0, 1,1,0]);
 * const mat  = new LineMaterial({ color: vec4f(1, 0.3, 0, 1), lineWidth: 3 });
 * scene.add(new Mesh(geom, mat));
 */
export class LineMaterial extends Material {
    private lineWidthUniform: UniformNode<d.f32>;
    readonly worldUnits: boolean;

    constructor(opts: LineMaterialOptions = {}) {
        const lineWidthUniform = uniform(f32(opts.lineWidth ?? 2), 'lineWidth');
        const color = opts.color ?? (vec4f(1, 1, 1, 1) as unknown as Node<d.vec4f>);

        super({
            vertex: lineVertex(lineWidthUniform, opts.worldUnits ?? false),
            fragment: color,
            cullMode: 'none',
            transparent: opts.transparent ?? false,
            blend: opts.blend,
            depthWrite: !(opts.transparent ?? false),
        });

        this.lineWidthUniform = lineWidthUniform;
        this.worldUnits = opts.worldUnits ?? false;
    }

    /** Line width in pixels (or world units if the material was created with worldUnits=true). */
    get lineWidth(): number {
        return this.lineWidthUniform.value as number;
    }

    set lineWidth(px: number) {
        this.lineWidthUniform.value = px;
    }
}

// ─── Scene objects ────────────────────────────────────────────────────────────

// Reusable temp allocations for raycast math
const _start: Vec3 = [0, 0, 0];
const _end: Vec3 = [0, 0, 0];
// [x, y, z, w] vecs used in screen-space projection
const _start4 = new Float64Array(4);
const _end4 = new Float64Array(4);

/** Apply a column-major Mat4 to a vec4 (x,y,z,w), writing result into `out`. */
function applyMat4Vec4(out: Float64Array, m: Mat4, x: number, y: number, z: number, w: number): void {
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
    out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
}

/**
 * Closest point on segment [a, b] to `point`, written into `out`.
 * Returns the interpolation parameter t ∈ [0, 1].
 */
function closestPointOnSegment(out: Vec3, point: Vec3, a: Vec3, b: Vec3): number {
    const dx = b[0] - a[0],
        dy = b[1] - a[1],
        dz = b[2] - a[2];
    const len2 = dx * dx + dy * dy + dz * dz;
    let t = 0;
    if (len2 > 1e-20) {
        t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy + (point[2] - a[2]) * dz) / len2;
        t = Math.max(0, Math.min(1, t));
    }
    out[0] = a[0] + t * dx;
    out[1] = a[1] + t * dy;
    out[2] = a[2] + t * dz;
    return t;
}

/**
 * Closest point on ray to segment [a, b].
 * Writes closest point on segment into `pointOnLine`, closest point on ray into `point`.
 * Both are in the same space as inputs.
 */
function distanceSqToSegment(rayOrigin: Vec3, rayDir: Vec3, a: Vec3, b: Vec3, point: Vec3, pointOnLine: Vec3): number {
    // Closest point on segment to ray origin (approximation)
    closestPointOnSegment(pointOnLine, rayOrigin, a, b);

    // Project pointOnLine onto ray
    const dx = pointOnLine[0] - rayOrigin[0];
    const dy = pointOnLine[1] - rayOrigin[1];
    const dz = pointOnLine[2] - rayOrigin[2];
    const t = dx * rayDir[0] + dy * rayDir[1] + dz * rayDir[2];
    point[0] = rayOrigin[0] + t * rayDir[0];
    point[1] = rayOrigin[1] + t * rayDir[1];
    point[2] = rayOrigin[2] + t * rayDir[2];

    const ex = pointOnLine[0] - point[0];
    const ey = pointOnLine[1] - point[1];
    const ez = pointOnLine[2] - point[2];
    return ex * ex + ey * ey + ez * ez;
}

function raycastWorldUnits(
    object: Mesh,
    starts: Float32Array,
    ends: Float32Array,
    n: number,
    matrixWorld: Mat4,
    raycaster: Raycaster,
    lineWidth: number,
    intersects: Intersection[],
): void {
    const ray = raycaster.ray;
    const point: Vec3 = [0, 0, 0];
    const pointOnLine: Vec3 = [0, 0, 0];

    for (let s = 0; s < n; s++) {
        const vi = s * 4 * 3;

        // Transform endpoints to world space
        _start[0] = starts[vi];
        _start[1] = starts[vi + 1];
        _start[2] = starts[vi + 2];
        _end[0] = ends[vi];
        _end[1] = ends[vi + 1];
        _end[2] = ends[vi + 2];
        vec3.transformMat4(_start, _start, matrixWorld);
        vec3.transformMat4(_end, _end, matrixWorld);

        distanceSqToSegment(ray.origin, ray.direction, _start, _end, point, pointOnLine);
        const isInside =
            Math.sqrt((point[0] - pointOnLine[0]) ** 2 + (point[1] - pointOnLine[1]) ** 2 + (point[2] - pointOnLine[2]) ** 2) <
            lineWidth * 0.5;

        if (isInside) {
            intersects.push({
                distance: vec3.distance(ray.origin, point),
                point: [...point] as Vec3,
                object,
                faceIndex: s,
            });
        }
    }
}

function raycastScreenSpace(
    object: Mesh,
    starts: Float32Array,
    ends: Float32Array,
    n: number,
    matrixWorld: Mat4,
    raycaster: Raycaster,
    lineWidth: number,
    intersects: Intersection[],
): void {
    const camera = raycaster.camera!;
    const proj = camera.projectionMatrix;

    const screenVal = screenSize.value as number[] | null;
    if (!screenVal) return;
    const sw = screenVal[0],
        sh = screenVal[1];

    const mv: Mat4 = mat4.create();
    mat4.multiply(mv, camera.matrixWorldInverse, matrixWorld);

    const near = -camera.near;

    // Project a point 1 unit along the ray to screen pixels (avoids w=0 at camera origin)
    const ssOrigin = new Float64Array(4);
    ssOrigin[0] = raycaster.ray.origin[0] + raycaster.ray.direction[0];
    ssOrigin[1] = raycaster.ray.origin[1] + raycaster.ray.direction[1];
    ssOrigin[2] = raycaster.ray.origin[2] + raycaster.ray.direction[2];
    ssOrigin[3] = 1.0;
    applyMat4Vec4(
        ssOrigin as unknown as Float64Array,
        camera.matrixWorldInverse,
        ssOrigin[0],
        ssOrigin[1],
        ssOrigin[2],
        ssOrigin[3],
    );
    applyMat4Vec4(ssOrigin as unknown as Float64Array, proj, ssOrigin[0], ssOrigin[1], ssOrigin[2], ssOrigin[3]);
    const ssOw = ssOrigin[3];
    // NDC → screen pixels; zero out z (we do 2D test)
    const ssOx = (ssOrigin[0] / ssOw) * sw * 0.5;
    const ssOy = (ssOrigin[1] / ssOw) * sh * 0.5;

    const point: Vec3 = [0, 0, 0];
    const pointOnLine: Vec3 = [0, 0, 0];

    for (let s = 0; s < n; s++) {
        const vi = s * 4 * 3;

        const ax = starts[vi],
            ay = starts[vi + 1],
            az = starts[vi + 2];
        const bx = ends[vi],
            by = ends[vi + 1],
            bz = ends[vi + 2];

        // To camera space via mv
        _start4[0] = mv[0] * ax + mv[4] * ay + mv[8] * az + mv[12];
        _start4[1] = mv[1] * ax + mv[5] * ay + mv[9] * az + mv[13];
        _start4[2] = mv[2] * ax + mv[6] * ay + mv[10] * az + mv[14];
        _start4[3] = 1.0;

        _end4[0] = mv[0] * bx + mv[4] * by + mv[8] * bz + mv[12];
        _end4[1] = mv[1] * bx + mv[5] * by + mv[9] * bz + mv[13];
        _end4[2] = mv[2] * bx + mv[6] * by + mv[10] * bz + mv[14];
        _end4[3] = 1.0;

        // Skip if entirely behind near plane
        if (_start4[2] > near && _end4[2] > near) continue;

        // Clip to near plane, lerp toward the other endpoint
        if (_start4[2] > near) {
            const t = (_start4[2] - near) / (_start4[2] - _end4[2]);
            _start4[0] = _start4[0] + t * (_end4[0] - _start4[0]);
            _start4[1] = _start4[1] + t * (_end4[1] - _start4[1]);
            _start4[2] = near;
        } else if (_end4[2] > near) {
            const t = (_end4[2] - near) / (_end4[2] - _start4[2]);
            _end4[0] = _end4[0] + t * (_start4[0] - _end4[0]);
            _end4[1] = _end4[1] + t * (_start4[1] - _end4[1]);
            _end4[2] = near;
        }

        // To clip space
        applyMat4Vec4(_start4, proj, _start4[0], _start4[1], _start4[2], 1.0);
        applyMat4Vec4(_end4, proj, _end4[0], _end4[1], _end4[2], 1.0);

        // NDC
        const sInvW = 1 / _start4[3];
        const eInvW = 1 / _end4[3];
        _start4[0] *= sInvW;
        _start4[1] *= sInvW;
        _start4[2] *= sInvW;
        _end4[0] *= eInvW;
        _end4[1] *= eInvW;
        _end4[2] *= eInvW;

        // Screen pixels
        const spx = _start4[0] * sw * 0.5;
        const spy = _start4[1] * sh * 0.5;
        const epx = _end4[0] * sw * 0.5;
        const epy = _end4[1] * sh * 0.5;

        // 2D closest point on screen-space segment to ssOrigin
        const sdx = epx - spx,
            sdy = epy - spy;
        const segLen2 = sdx * sdx + sdy * sdy;
        let param = 0;
        if (segLen2 > 1e-10) {
            param = Math.max(0, Math.min(1, ((ssOx - spx) * sdx + (ssOy - spy) * sdy) / segLen2));
        }
        const cpx = spx + param * sdx;
        const cpy = spy + param * sdy;
        const cpz = _start4[2] + param * (_end4[2] - _start4[2]); // interpolated NDC z

        // Depth check: must be within clip space
        if (cpz < -1 || cpz > 1) continue;

        // Pixel distance from ray to closest point on segment
        const pixDist = Math.sqrt((ssOx - cpx) ** 2 + (ssOy - cpy) ** 2);

        // Compare pixel distance directly to lineWidth/2
        const isInside = pixDist < lineWidth * 0.5;

        if (isInside) {
            // World-space hit point: transform original (unclipped) endpoints to world space,
            // then find closest point on that segment to the ray
            _start[0] = starts[vi];
            _start[1] = starts[vi + 1];
            _start[2] = starts[vi + 2];
            _end[0] = ends[vi];
            _end[1] = ends[vi + 1];
            _end[2] = ends[vi + 2];
            vec3.transformMat4(_start, _start, matrixWorld);
            vec3.transformMat4(_end, _end, matrixWorld);

            distanceSqToSegment(raycaster.ray.origin, raycaster.ray.direction, _start, _end, point, pointOnLine);

            intersects.push({
                distance: vec3.distance(raycaster.ray.origin, point),
                point: [...point] as Vec3,
                object,
                faceIndex: s,
            });
        }
    }
}

/**
 * Core raycast implementation shared by `LineSegments` and `Line`.
 */
function raycastLine(
    object: Mesh,
    material: LineMaterial,
    geometry: LineSegmentsGeometry | LineGeometry,
    raycaster: Raycaster,
    threshold: number,
    intersects: Intersection[],
): void {
    const matrixWorld = object.matrixWorld;
    const startBuf = geometry.getBuffer<d.vec3f>('instanceStart');
    const endBuf = geometry.getBuffer<d.vec3f>('instanceEnd');
    if (!startBuf?.array || !endBuf?.array) return;

    const starts = startBuf.array as Float32Array;
    const ends = endBuf.array as Float32Array;
    const n = geometry.segmentCount;

    const lineWidth = material.lineWidth + threshold;

    if (material.worldUnits) {
        if (geometry.boundingBox) {
            // Bounding box test in world space
            const worldBox: [number, number, number, number, number, number] = [
                geometry.boundingBox[0],
                geometry.boundingBox[1],
                geometry.boundingBox[2],
                geometry.boundingBox[3],
                geometry.boundingBox[4],
                geometry.boundingBox[5],
            ];
            // Expand by lineWidth/2 (world units)
            const m = lineWidth * 0.5;
            worldBox[0] -= m;
            worldBox[1] -= m;
            worldBox[2] -= m;
            worldBox[3] += m;
            worldBox[4] += m;
            worldBox[5] += m;
            if (!rayIntersectsBox3(raycaster.ray.origin, raycaster.ray.direction, worldBox, raycaster.far)) return;
        }
        raycastWorldUnits(object, starts, ends, n, matrixWorld, raycaster, lineWidth, intersects);
    } else {
        if (!raycaster.camera) {
            console.error('LineSegments/Line: raycaster.camera must be set for screen-space raycasting.');
            return;
        }
        const screenVal = screenSize.value as number[] | null;
        if (!screenVal) return;
        raycastScreenSpace(object, starts, ends, n, matrixWorld, raycaster, lineWidth, intersects);
    }
}

/**
 * Scene object for rendering independent line segment pairs with `LineSegmentsGeometry` and `LineMaterial`.
 */
export class LineSegments extends Mesh {
    /**
     * Extra pick radius added to `material.lineWidth` for raycasting, in the same
     * units as the material (pixels for screen-space, world units for world-units mode).
     */
    threshold: number = 0;

    constructor(geometry: LineSegmentsGeometry, material: LineMaterial) {
        super(geometry, material);
    }

    override raycast(raycaster: Raycaster, intersects: Intersection[]): void {
        raycastLine(
            this,
            this.material as LineMaterial,
            this.geometry as LineSegmentsGeometry,
            raycaster,
            this.threshold,
            intersects,
        );
    }
}

/**
 * Scene object for rendering a continuous polyline with `LineGeometry` and `LineMaterial`.
 */
export class Line extends Mesh {
    readonly isLine = true;
    /**
     * Extra pick radius added to `material.lineWidth` for raycasting, in the same
     * units as the material (pixels for screen-space, world units for world-units mode).
     */
    threshold: number = 0;

    constructor(geometry: LineGeometry, material: LineMaterial) {
        super(geometry, material);
    }

    override raycast(raycaster: Raycaster, intersects: Intersection[]): void {
        raycastLine(this, this.material as LineMaterial, this.geometry as LineGeometry, raycaster, this.threshold, intersects);
    }
}
