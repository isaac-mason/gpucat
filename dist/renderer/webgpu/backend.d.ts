import { WebGPUBackend, type WebGPUBackendOptions } from './webgpu-backend';
/** WebGPU owns a device and no canvas: a pass acquires the context for whichever one it names. */
export declare function webgpu(opts?: WebGPUBackendOptions): WebGPUBackend;
