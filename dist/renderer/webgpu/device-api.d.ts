import type { Renderer } from '../core/renderer';
import type { WebGPUBackend } from './webgpu-backend';
/**
 * The escape hatches, for work gpucat does not cover: interop with another WebGPU library, a raw
 * pipeline, a query set. Typed on `Renderer<WebGPUBackend>`, so reaching for a WebGPU device on a
 * WebGL2 renderer is a compile error rather than an undefined at run time.
 */
export declare function gpuDevice(renderer: Renderer<WebGPUBackend>): GPUDevice;
export declare function gpuAdapter(renderer: Renderer<WebGPUBackend>): GPUAdapter;
/** The colour format every canvas on this device is configured with. */
export declare function canvasFormat(renderer: Renderer<WebGPUBackend>): GPUTextureFormat;
/** Keeps `GPUFeatureName` rather than widening to `string`, which is the whole point of it not being neutral. */
export declare function hasFeature(renderer: Renderer<WebGPUBackend>, feature: GPUFeatureName): boolean;
