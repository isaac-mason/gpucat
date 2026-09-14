import type { GpuBuffer } from '../../core/gpu-buffer';
/** What a backend should do to bring one buffer up to date. */
export declare const enum BufferUpload {
    /** already current; no GPU work. */
    Skip = 0,
    /** no GPU buffer yet, or the data outgrew it: (re)allocate, then write the whole array. */
    Allocate = 1,
    /** write only `buffer.updateRanges`, which `planBufferUpload` has already merged. */
    Partial = 2,
    /** the version moved with no ranges queued: rewrite the whole array in place. */
    Full = 3
}
/**
 * Decide how `buffer` reaches the GPU, and merge its pending ranges in place.
 *
 * Precedence:
 *
 *   1. ALLOCATE, keyed off SIZE rather than version, so growing an arena without bumping the version
 *      still uploads correctly instead of writing partially into a buffer too small to hold it.
 *   2. PARTIAL over FULL: queued ranges are the streaming path and need no version bump, so a caller
 *      doing both gets the cheaper write. Merging here means both backends write identical spans.
 *   3. FULL for a version bump with nothing queued. Correct, but re-sends the whole allocation.
 *
 * `capacityBytes` and `lastVersion` describe what the backend holds, and are ignored when `exists` is
 * false. Merging mutates `buffer.updateRanges` in place, keeping the hot path allocation-free.
 */
export declare function planBufferUpload(buffer: GpuBuffer, exists: boolean, capacityBytes: number, lastVersion: number): BufferUpload;
