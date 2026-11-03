import { type GpuBuffer, type GpuTypedArray } from '../../core/gpu-buffer';
import * as Buffers from './buffers';
/**
 * `count` elements of `buffer` from element `offset`, read back through a fresh STREAM_READ staging buffer (reading
 * from a buffer bound to a transform-feedback binding point is illegal, and staging leaves the source as it was for
 * further ping-pong). The fence is polled across event-loop ticks rather than spun on: a synchronous busy-loop never
 * signals on a single-threaded GL backend. The buffer needs a GL buffer, which a transform feedback that wrote it
 * gives it; a storage buffer lives in a texture here and is not read back yet.
 */
export declare function readBuffer(gl: WebGL2RenderingContext, buffers: Buffers.BufferCache, buffer: GpuBuffer, offset: number, count: number): Promise<GpuTypedArray>;
