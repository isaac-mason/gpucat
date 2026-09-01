/**
 * update-ranges.ts (renderer core) — backend-neutral merge of a buffer's pending dirty ranges into
 * the minimal set of spans worth uploading. Shared by the WebGL attribute path (one `bufferSubData`
 * per span) and the WebGL storage-buffer-as-texture path (one `texSubImage2D` run per span), so the
 * merge lives in exactly one place and cannot drift between them.
 */

import type { UpdateRange } from '../../core/gpu-buffer';

/**
 * Sort and merge adjacent/overlapping dirty ranges IN PLACE, trimming the array to the survivors.
 * Mirrors three.js `WebGLAttributes.updateBuffer`: fewer, larger uploads cut GL command overhead,
 * which is the empirical win for callers queueing many small ranges per frame. Merging in place
 * keeps the hot path allocation-free; it is safe because callers clear the ranges once uploaded.
 *
 * Ranges are flat indices in whatever unit the caller queued them in (array components, for a
 * `GpuBuffer`), and the merge is unit-agnostic — a caller uploading into a 2D grid converts the
 * surviving spans to its own geometry afterwards.
 */
export function mergeUpdateRanges(ranges: UpdateRange[]): void {
    if (ranges.length === 0) return;
    ranges.sort((a, b) => a.start - b.start);
    let mergeIndex = 0;
    for (let i = 1; i < ranges.length; i++) {
        const prev = ranges[mergeIndex]!;
        const r = ranges[i]!;
        // +1 so exactly-adjacent ranges merge (safe over positive integer indices).
        if (r.start <= prev.start + prev.count + 1) {
            prev.count = Math.max(prev.count, r.start + r.count - prev.start);
        } else {
            mergeIndex++;
            ranges[mergeIndex] = r;
        }
    }
    ranges.length = mergeIndex + 1;
}
