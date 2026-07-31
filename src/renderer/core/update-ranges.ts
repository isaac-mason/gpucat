/**
 * update-ranges.ts (renderer core) — backend-neutral collapse of pending dirty ranges into a covering
 * row span for a partial 2D upload. Shared by the WebGPU + WebGL texture paths and the WebGL
 * storage-buffer-as-texture path, so the min/max-row math lives in exactly one place.
 */

/** A pending dirty range in some linear unit (texels for a texture, components for a buffer). */
export type LinearRange = { start: number; count: number };

/** Whole rows `[rowStart, rowStart + rowCount)` of a 2D grid. */
export type RowSpan = { rowStart: number; rowCount: number };

/**
 * Collapse dirty {@link LinearRange}s into a single covering row span. `unitsPerRow` is the grid width
 * expressed in the ranges' own unit — texels/row for a texture's texel ranges, or components/row
 * (`width · channels`) for a buffer reinterpreted as a texel grid. Row-granular: the span is just the
 * min/max row touched, so there's no same-row/straddle bookkeeping. Returns `null` when no range is
 * non-empty. Callers apply their own clamp and `> ½ dirty → full` fallback (both backend-specific).
 */
export function collapseUpdateRanges(ranges: readonly LinearRange[], unitsPerRow: number): RowSpan | null {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const r of ranges) {
        if (r.count <= 0) continue;
        if (r.start < min) min = r.start;
        if (r.start + r.count - 1 > max) max = r.start + r.count - 1;
    }
    if (!Number.isFinite(min)) return null;
    const rowStart = Math.floor(min / unitsPerRow);
    const rowEnd = Math.floor(max / unitsPerRow);
    return { rowStart, rowCount: rowEnd - rowStart + 1 };
}
