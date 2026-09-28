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
export declare function mergeUpdateRanges(ranges: UpdateRange[], count: number): number;
