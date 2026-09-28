/**
 * update-ranges.ts (renderer core) — backend-neutral merge of a buffer's pending dirty ranges into
 * the minimal set of spans worth uploading. Shared by the WebGL attribute path (one `bufferSubData`
 * per span), the WebGL storage-buffer-as-texture path (one `texSubImage2D` run per span) and the
 * WebGPU buffer path (one `writeBuffer` per span), so the merge lives in exactly one place and
 * cannot drift between them.
 *
 * three.js merges on WebGL only (`WebGLAttributes.updateBuffer`); its WebGPU backend walks the raw
 * ranges. gpucat merges on both: the per-call cost that motivates it on WebGL is a staging-buffer
 * copy on WebGPU rather than a GL command, but it is still per-call, and sharing one helper is the
 * whole reason this module exists.
 */

import type { UpdateRange } from '../../core/gpu-buffer';

/**
 * Sort and merge the first `count` dirty ranges IN PLACE, returning how many survive at the front.
 * Mirrors three.js `WebGLAttributes.updateBuffer`: fewer, larger uploads cut GL command overhead,
 * which is the empirical win for callers queueing many small ranges per frame.
 *
 * Allocation-free, since callers queue ranges every frame: records are only ever swapped, never
 * assigned over, so each stays in the array exactly once and the ones past the survivors are spare
 * for the owner to reuse. Ranges queued in order skip the sort; the rest take an in-place heapsort
 * (`Array.prototype.sort` allocates its own work array).
 *
 * Ranges are flat indices in whatever unit the caller queued them in (array components, for a
 * `GpuBuffer`), and the merge is unit-agnostic: a caller uploading into a 2D grid converts the
 * surviving spans to its own geometry afterwards.
 */
export function mergeUpdateRanges(ranges: UpdateRange[], count: number): number {
    if (count === 0) return 0;
    if (!sortedByStart(ranges, count)) heapSortByStart(ranges, count);
    let mergeIndex = 0;
    for (let i = 1; i < count; i++) {
        const prev = ranges[mergeIndex]!;
        const r = ranges[i]!;
        // +1 so exactly-adjacent ranges merge (safe over positive integer indices).
        if (r.start <= prev.start + prev.count + 1) {
            prev.count = Math.max(prev.count, r.start + r.count - prev.start);
        } else {
            mergeIndex++;
            swap(ranges, mergeIndex, i);
        }
    }
    return mergeIndex + 1;
}

function sortedByStart(ranges: UpdateRange[], count: number): boolean {
    for (let i = 1; i < count; i++) if (ranges[i]!.start < ranges[i - 1]!.start) return false;
    return true;
}

function heapSortByStart(ranges: UpdateRange[], count: number): void {
    for (let i = (count >> 1) - 1; i >= 0; i--) siftDown(ranges, i, count);
    for (let end = count - 1; end > 0; end--) {
        swap(ranges, 0, end);
        siftDown(ranges, 0, end);
    }
}

function siftDown(ranges: UpdateRange[], root: number, end: number): void {
    while (true) {
        const left = root * 2 + 1;
        if (left >= end) return;
        const right = left + 1;
        const child = right < end && ranges[right]!.start > ranges[left]!.start ? right : left;
        if (ranges[child]!.start <= ranges[root]!.start) return;
        swap(ranges, root, child);
        root = child;
    }
}

function swap(ranges: UpdateRange[], a: number, b: number): void {
    const held = ranges[a]!;
    ranges[a] = ranges[b]!;
    ranges[b] = held;
}
