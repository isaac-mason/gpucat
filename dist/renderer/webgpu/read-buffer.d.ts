import { type GpuBuffer, type GpuTypedArray } from '../../core/gpu-buffer';
import type { WebGPUBackend } from './webgpu-backend';
/**
 * `count` elements of `buffer` from element `offset`, copied into a staging buffer the CPU maps for reading. The buffer
 * must have been uploaded, by a write or by a pass that bound it.
 */
export declare function readBuffer(backend: WebGPUBackend, buffer: GpuBuffer, offset: number, count: number): Promise<GpuTypedArray>;
