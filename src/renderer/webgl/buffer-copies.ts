import type { GpuBuffer } from '../../core/gpu-buffer';
import type { RangeQueue } from '../core/buffer-upload';
import { mergeUpdateRanges } from '../core/update-ranges';

// WebGL can keep two copies of one GpuBuffer: its GL buffer, which draws read as attributes and indices, and the
// texture a `storage()` read of it goes through. Both are brought up to date from the buffer's one queue of written
// ranges, so whichever synced first would drain the queue and leave the other believing it was current. Instead, the
// first sync after a write hands the queued ranges to every copy the buffer has, and each copy writes its own share.

/** a buffer's copies and the version the last hand-out saw */
type Copies = { queues: RangeQueue[]; version: number };

export type BufferCopies = WeakMap<GpuBuffer, Copies>;

export function createBufferCopies(): BufferCopies {
    return new WeakMap();
}

/** A copy of `buffer` made, current as of now: the queue the ranges written to `buffer` from here on are handed to. */
export function addCopy(copies: BufferCopies, buffer: GpuBuffer): RangeQueue {
    const queue: RangeQueue = { updateRanges: [], updateRangeCount: 0 };
    let entry = copies.get(buffer);
    if (entry === undefined) {
        entry = { queues: [], version: buffer.version };
        copies.set(buffer, entry);
    }
    entry.queues.push(queue);
    return queue;
}

export function removeCopy(copies: BufferCopies, buffer: GpuBuffer, queue: RangeQueue): void {
    const entry = copies.get(buffer);
    if (entry === undefined) return;
    const at = entry.queues.indexOf(queue);
    if (at >= 0) entry.queues.splice(at, 1);
    if (entry.queues.length === 0) copies.delete(buffer);
}

/**
 * `buffer`'s queued ranges handed to every copy of it, and its queue cleared. A version moved with none queued is a
 * whole rewrite (`pack()`, `needsUpdate`), which no copy's earlier ranges describe, so each copy drops them and its
 * own version check rewrites it whole.
 */
export function handOut(copies: BufferCopies, buffer: GpuBuffer): void {
    const entry = copies.get(buffer);
    if (entry === undefined) return;
    const queued = buffer.updateRangeCount;
    if (queued === 0) {
        if (buffer.version !== entry.version) for (const queue of entry.queues) queue.updateRangeCount = 0;
        entry.version = buffer.version;
        return;
    }
    const ranges = buffer.updateRanges;
    for (const queue of entry.queues) {
        for (let i = 0; i < queued; i++) {
            const from = ranges[i]!;
            const into = queue.updateRanges[queue.updateRangeCount];
            if (into === undefined) queue.updateRanges.push({ start: from.start, count: from.count });
            else {
                into.start = from.start;
                into.count = from.count;
            }
            queue.updateRangeCount++;
        }
        // a copy no pass syncs for a while keeps its spans, not every write
        queue.updateRangeCount = mergeUpdateRanges(queue.updateRanges, queue.updateRangeCount);
    }
    buffer.clearUpdateRanges();
    entry.version = buffer.version;
}
