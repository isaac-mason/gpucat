import type { GpuBuffer } from '../../core/gpu-buffer';
import type { RangeQueue } from '../core/buffer-upload';
/** a buffer's copies and the version the last hand-out saw */
type Copies = {
    queues: RangeQueue[];
    version: number;
};
export type BufferCopies = WeakMap<GpuBuffer, Copies>;
export declare function createBufferCopies(): BufferCopies;
/** A copy of `buffer` made, current as of now: the queue the ranges written to `buffer` from here on are handed to. */
export declare function addCopy(copies: BufferCopies, buffer: GpuBuffer): RangeQueue;
export declare function removeCopy(copies: BufferCopies, buffer: GpuBuffer, queue: RangeQueue): void;
/**
 * `buffer`'s queued ranges handed to every copy of it, and its queue cleared. A version moved with none queued is a
 * whole rewrite (`pack()`, `needsUpdate`), which no copy's earlier ranges describe, so each copy drops them and its
 * own version check rewrites it whole.
 */
export declare function handOut(copies: BufferCopies, buffer: GpuBuffer): void;
export {};
