import type { GpuBuffer, GpuTypedArray } from '../../core/gpu-buffer';
import type { Renderer } from './renderer';
/** copies `data` into a `cpu: false` buffer at `byteOffset` before returning; `dataOffset` and `size` count elements of `data`. */
export declare function writeBuffer(renderer: Renderer, buffer: GpuBuffer, byteOffset: number, data: GpuTypedArray, dataOffset?: number, size?: number): void;
