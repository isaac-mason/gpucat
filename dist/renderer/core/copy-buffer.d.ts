import type { GpuBuffer } from '../../core/gpu-buffer';
import type { Renderer } from './renderer';
/**
 * copies `byteSize` bytes of `source` from `sourceByteOffset` into a `cpu: false` `destination` at
 * `destinationByteOffset`, on the GPU. Queued at once, like `writeBuffer`: after the writes before it,
 * ahead of any frame not yet submitted. Omitted offsets start at 0; an omitted size copies the rest of
 * `source`.
 */
export declare function copyBuffer(renderer: Renderer, source: GpuBuffer, destination: GpuBuffer, sourceByteOffset?: number, destinationByteOffset?: number, byteSize?: number): void;
