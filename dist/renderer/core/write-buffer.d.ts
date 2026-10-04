import type { GpuBuffer, GpuTypedArray } from '../../core/gpu-buffer';
import type { Renderer } from './renderer';
/**
 * Writes `data` into a `cpu: false` buffer at `byteOffset`, copying it before returning, so the caller may reuse,
 * transfer or drop it straight away. `dataOffset` and `size` count elements of `data`, as `GPUQueue.writeBuffer`
 * does for a typed array; `size` defaults to the rest of it. Byte offset and byte size must be multiples of 4.
 *
 * The buffer's GPU storage is created zeroed by the first write or binding. Like any upload, a write made while a
 * frame is being recorded is seen by that whole frame on WebGPU, and by the work recorded after it on WebGL.
 */
export declare function writeBuffer(renderer: Renderer, buffer: GpuBuffer, byteOffset: number, data: GpuTypedArray, dataOffset?: number, size?: number): void;
