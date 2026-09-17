/**
 * draw-range.ts (renderer core) — resolving a geometry's `drawRange` into the concrete first/count a
 * draw call takes.
 *
 * Both backends call this. The clamping is arithmetic over neutral geometry fields with no device in
 * it, and it had already drifted: the WebGL path clamped against the elements REMAINING after `start`
 * while the WebGPU path clamped against the whole buffer, so a non-zero `drawRange.start` could run
 * past the end. Same reasoning as `update-ranges.ts`, `buffer-upload.ts` and `render-state.ts`.
 *
 * `drawRange` defaults to `{ start: 0, count: Infinity }`, meaning "all of it", so resolving is not
 * optional: handing `Infinity` to a draw call is not a clamp the API does for you.
 */

import type { Geometry } from '../../geometry/geometry';

/** A draw range resolved against what the geometry actually holds. */
export type ResolvedDrawRange = {
    /** First index (indexed draws) or first vertex (non-indexed). */
    first: number;
    /** Elements to draw, never more than remain after `first`. */
    count: number;
};

/**
 * The index range to draw. Clamped against the indices remaining after `start`, not the whole buffer:
 * clamping against the whole buffer lets `start + count` overrun it, which reads garbage on WebGPU and
 * is an "insufficient buffer" validation error on WebGL.
 */
export function resolveIndexedDrawRange(geometry: Geometry): ResolvedDrawRange {
    const first = geometry.drawRange.start;
    const total = geometry.index?.array?.length ?? 0;
    const remaining = Math.max(0, total - first);
    return { first, count: Math.min(geometry.drawRange.count, remaining) };
}

/**
 * The vertex range to draw, sized from the `position` attribute, which is the only buffer every
 * non-indexed geometry is guaranteed to have. A geometry with no position and no explicit count has
 * nothing to size against; 3 (one triangle) is the historical fallback rather than a meaningful
 * answer, and is kept so behaviour does not change.
 */
export function resolveVertexDrawRange(geometry: Geometry): ResolvedDrawRange {
    const first = geometry.drawRange.start;
    const positionCount = geometry.buffers.get('position')?.count;
    const total = positionCount ?? (geometry.drawRange.count === Infinity ? 3 : geometry.drawRange.count);
    const remaining = Math.max(0, total - first);
    return { first, count: Math.min(geometry.drawRange.count, remaining) };
}
