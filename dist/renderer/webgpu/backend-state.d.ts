import type { CanvasTarget } from '../core/canvas-target';
import type { RenderBundle } from '../core/frame';
import type { BindGroupLayoutCache } from './bind-group-layout';
import type * as Bindings from './bindings';
import type * as Buffers from './buffers';
import type * as Geometries from './geometries';
import type * as Pipelines from './pipelines';
import type * as RenderObjectGpu from './render-object-gpu';
import type { SwapchainState } from './render-pass';
import type * as Samplers from './samplers';
import type * as Textures from './textures';
/** Every device handle and cache the backend owns, as one argument. `WebGPUBackend implements` it,
 *  so there is no second copy to keep in step. */
export type BackendState = {
    device: GPUDevice;
    adapter: GPUAdapter;
    /** The colour format every canvas on this device is configured with. */
    format: GPUTextureFormat;
    buffers: Buffers.BufferCache;
    textures: Textures.TextureCache;
    samplers: Samplers.SamplerCache;
    pipelines: Pipelines.PipelinesState;
    bindings: Bindings.BindingsState;
    geometries: Geometries.GeometriesState;
    renderObjectGpu: RenderObjectGpu.RenderObjectGpuCache;
    /** Value-keyed, shared by pipelines and bindings so one entry shape yields one layout. */
    bindGroupLayoutCache: BindGroupLayoutCache;
    /**
     * Recorded device bundles, per (bundle, camera, render context) as three.js keys its own. Lives
     * on the backend rather than the bundle, which is neutral and may name no device object.
     */
    renderBundles: WeakMap<RenderBundle, WeakMap<object, Map<number, {
        gpu: GPURenderBundle;
        version: number;
        rebuilds: number;
    }>>>;
    canvasContexts: WeakMap<CanvasTarget, GPUCanvasContext>;
    swapchain: SwapchainState;
};
