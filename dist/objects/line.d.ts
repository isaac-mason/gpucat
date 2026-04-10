import { Geometry } from '../geometry/geometry';
import { Material } from '../material/material';
import { Mesh } from './mesh';
import { type Raycaster, type Intersection } from '../math/raycaster';
import * as d from '../schema/schema';
import { type Node } from '../nodes/nodes';
/**
 * Screen-space expanded line geometry.
 *
 * Allocates GPU buffers once at construction for up to `maxPoints` points.
 * Subsequent calls to `update()` write into the existing buffers and adjust
 * `drawRange.count` — no reallocation unless the point array exceeds `maxPoints`.
 *
 * Vertex buffers (per-vertex, 4 verts per segment):
 *   'instanceStart'  vec3f  – world-space segment start
 *   'instanceEnd'    vec3f  – world-space segment end
 *   'side'           f32    – +1 / -1 expansion side
 *   'uv'             vec2f  – u along segment, v across width
 *
 * Pair with a `LineMaterial`.
 *
 * @param points    Initial flat [x,y,z,...] point list. At least 2 points required.
 * @param closed    Connect last point back to first. Default false.
 * @param maxPoints Maximum points this geometry will ever hold. Defaults to the
 *                  initial point count. Pass a larger value to avoid reallocation
 *                  when calling update() with more points later.
 */
export declare class LineGeometry extends Geometry {
    private _maxSegments;
    private _segmentCount;
    private _closed;
    constructor(points: Float32Array | number[], closed?: boolean, maxPoints?: number);
    /** Number of segments currently drawn. */
    get segmentCount(): number;
    /**
     * Update the line's point data in-place.
     *
     * If the new point count fits within the pre-allocated capacity, this only
     * writes into existing typed arrays and adjusts `drawRange.count` — no GPU
     * buffer reallocation occurs. If the new count exceeds capacity, buffers are
     * reallocated to the new size (capacity grows, never shrinks).
     *
     * @param points  New flat [x,y,z,...] array. At least 2 points.
     * @param closed  Whether the line is closed. Defaults to the value set at construction.
     */
    update(points: Float32Array | number[], closed?: boolean): void;
    /**
     * Compute cumulative arc-length distances along the polyline and store them
     * as 'instanceDistanceStart' / 'instanceDistanceEnd' vertex buffers.
     *
     * Each segment vertex carries the cumulative distance at its start and end
     * endpoint in world units. Used by dash shaders.
     *
     * Call after construction or after update(). Returns `this` for chaining.
     */
    computeLineDistances(): this;
}
/**
 * Geometry for rendering independent line segments from disjoint point pairs.
 *
 * Points are consumed as pairs: [p0,p1, p2,p3, ...]. Each pair is one segment.
 * An odd trailing point is ignored. There is no concept of "closed".
 *
 * Allocates GPU buffers once at construction for up to `maxPoints` points.
 * Subsequent calls to `update()` write into the existing buffers and adjust
 * `drawRange.count` — no reallocation unless the point array exceeds `maxPoints`.
 *
 * Pair with a `LineMaterial`.
 *
 * @param points    Initial flat [x,y,z,...] point list. At least 2 points (one pair).
 * @param maxPoints Maximum points this geometry will ever hold. Defaults to the
 *                  initial point count. Pass a larger value to avoid reallocation.
 */
export declare class LineSegmentsGeometry extends Geometry {
    private _maxSegments;
    private _segmentCount;
    constructor(points: Float32Array | number[], maxPoints?: number);
    /** Number of segments currently drawn. */
    get segmentCount(): number;
    /**
     * Update the segment data in-place.
     *
     * If the new point count fits within the pre-allocated capacity, this only
     * writes into existing typed arrays and adjusts `drawRange.count` — no GPU
     * buffer reallocation occurs. If the new count exceeds capacity, buffers are
     * reallocated to the new size (capacity grows, never shrinks).
     *
     * @param points  New flat [x,y,z,...] array. At least 2 points.
     */
    update(points: Float32Array | number[]): void;
    /**
     * Compute per-segment distances and store as 'instanceDistanceStart' /
     * 'instanceDistanceEnd' vertex buffers.
     *
     * For disjoint pairs each segment is independent: distanceStart = 0,
     * distanceEnd = length(end - start). Used by dash shaders.
     *
     * Call after construction or after update(). Returns `this` for chaining.
     */
    computeLineDistances(): this;
}
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
export declare class LineMaterial extends Material {
    private lineWidthUniform;
    readonly worldUnits: boolean;
    constructor(opts?: LineMaterialOptions);
    /** Line width in pixels (or world units if the material was created with worldUnits=true). */
    get lineWidth(): number;
    set lineWidth(px: number);
}
/**
 * Scene object for rendering independent line segment pairs with `LineSegmentsGeometry` and `LineMaterial`.
 */
export declare class LineSegments extends Mesh {
    /**
     * Extra pick radius added to `material.lineWidth` for raycasting, in the same
     * units as the material (pixels for screen-space, world units for world-units mode).
     */
    threshold: number;
    constructor(geometry: LineSegmentsGeometry, material: LineMaterial);
    raycast(raycaster: Raycaster, intersects: Intersection[]): void;
}
/**
 * Scene object for rendering a continuous polyline with `LineGeometry` and `LineMaterial`.
 */
export declare class Line extends Mesh {
    /**
     * Extra pick radius added to `material.lineWidth` for raycasting, in the same
     * units as the material (pixels for screen-space, world units for world-units mode).
     */
    threshold: number;
    constructor(geometry: LineGeometry, material: LineMaterial);
    raycast(raycaster: Raycaster, intersects: Intersection[]): void;
}
