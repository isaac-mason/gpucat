/*
 * buffer-upload.ts (renderer core) — the backend-neutral decision of HOW a buffer reaches the GPU.
 *
 * Both backends call this and execute what comes back, so the rule cannot differ between them.
 * Same reasoning as `update-ranges.ts` and `partial-upload.ts`.
 *
 * Nothing device-shaped belongs here: WebGPU aligns allocations to 4 bytes and WebGL does not, so
 * this says "allocate" and the backend decides the size.
 */

import type { GpuBuffer } from '../../core/gpu-buffer';
import { mergeUpdateRanges } from './update-ranges';

/** What a backend should do to bring one buffer up to date. */
export const enum BufferUpload {
    /** already current; no GPU work. */
    Skip = 0,
    /** no GPU buffer yet, or the data outgrew it: (re)allocate, then write the whole array. */
    Allocate = 1,
    /** write only `buffer.updateRanges`, which `planBufferUpload` has already merged. */
    Partial = 2,
    /** the version moved with no ranges queued: rewrite the whole array in place. */
    Full = 3,
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
export function planBufferUpload(buffer: GpuBuffer, exists: boolean, capacityBytes: number, lastVersion: number): BufferUpload {
    const array = buffer.array;
    // CPU data was released after upload: whatever is on the GPU is all there is.
    if (array === null || array === undefined) return BufferUpload.Skip;

    if (!exists || capacityBytes < array.byteLength) return BufferUpload.Allocate;

    if (buffer.updateRanges.length > 0) {
        mergeUpdateRanges(buffer.updateRanges);
        return BufferUpload.Partial;
    }

    return buffer.version !== lastVersion ? BufferUpload.Full : BufferUpload.Skip;
}
