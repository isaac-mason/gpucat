import type { Renderer } from '../core/renderer';
import type { WebGPUBackend } from './webgpu-backend';

/**
 * The escape hatches, for work gpucat does not cover: interop with another WebGPU library, a raw
 * pipeline, a query set. Typed on `Renderer<WebGPUBackend>`, so reaching for a WebGPU device on a
 * WebGL2 renderer is a compile error rather than an undefined at run time.
 */
export function gpuDevice(renderer: Renderer<WebGPUBackend>): GPUDevice {
    return renderer.backend.device;
}

export function gpuAdapter(renderer: Renderer<WebGPUBackend>): GPUAdapter {
    return renderer.backend.adapter;
}

/** The colour format every canvas on this device is configured with. */
export function canvasFormat(renderer: Renderer<WebGPUBackend>): GPUTextureFormat {
    return renderer.backend.format;
}

/** Keeps `GPUFeatureName` rather than widening to `string`, which is the whole point of it not being neutral. */
export function hasFeature(renderer: Renderer<WebGPUBackend>, feature: GPUFeatureName): boolean {
    return renderer.backend.hasFeature(feature);
}
