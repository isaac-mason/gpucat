import type { RenderTarget } from '../../core/render-target';
import type { ComputeNode } from '../../nodes/nodes';
import { yieldToMain } from '../../utils/yield-to-main';
import type { CanvasTarget } from '../core/canvas-target';
import type { DeviceBackend } from '../core/device-backend';
import type { ComputePassDesc, DispatchRecord, PassDesc, PassEntry, RenderBundle } from '../core/frame';
import { GPUFeatureName } from '../core/gpu-constants';
import * as Info from '../core/info';
import type { RenderContext } from '../core/pass-context';
import type { RenderObject } from '../core/render-object';
import type { Renderer } from '../core/renderer';
import * as ops from '../core/renderer-ops';
import type { BackendState } from './backend-state';
import { type BindGroupLayoutCache, createBindGroupLayoutCache, getBindGroupLayoutCacheStats } from './bind-group-layout';
import * as Bindings from './bindings';
import * as Buffers from './buffers';
import * as Compute from './compute';
import * as FrameBackend from './frame-backend';
import * as Geometries from './geometries';
import * as Pipelines from './pipelines';
import * as Prepare from './prepare';
import * as ReadPixels from './read-pixels';
import * as RenderObjectGpu from './render-object-gpu';
import * as RenderPass from './render-pass';
import * as Samplers from './samplers';
import * as Textures from './textures';

export type WebGPUBackendOptions = {
    /** GPURequestAdapterOptions forwarded to navigator.gpu.requestAdapter(). */
    adapterOptions?: GPURequestAdapterOptions;

    /** Maps to the adapter's `powerPreference`, winning over `adapterOptions.powerPreference`. */
    powerPreference?: GPUPowerPreference;

    /** GPUDeviceDescriptor forwarded to adapter.requestDevice(). */
    deviceDescriptor?: GPUDeviceDescriptor;

    /** Pre-created GPUDevice. When provided, skips navigator.gpu initialization. */
    device?: GPUDevice;

    /** Pre-created GPUAdapter. Required when `device` is provided. */
    adapter?: GPUAdapter;

    /** Canvas texture format. Defaults to navigator.gpu.getPreferredCanvasFormat(), or 'bgra8unorm' with a pre-created device. */
    format?: GPUTextureFormat;
};

/**
 * WebGPU's device half: the device, adapter, format, every resource cache, the swapchain and the
 * frame encoder. The node graph, render objects and pass contexts belong to the `Renderer` this is
 * given at `init`, which is also what drives it.
 */
export class WebGPUBackend implements DeviceBackend, BackendState {
    readonly name = 'webgpu' as const;

    /** A context is acquired per canvas target, so no single canvas is the device's. */
    readonly deviceCanvasTarget = null;

    // A backend is constructed before its renderer and before its device, so these four alone cannot
    // hold a real value until `init`. Everything below them is built at construction.

    /** @internal */ renderer: Renderer<DeviceBackend> = null!;
    /** @internal */ device: GPUDevice = null!;
    /** @internal */ adapter: GPUAdapter = null!;
    /** @internal */ format: GPUTextureFormat = null!;

    /** The only cache `init` has to build, because it stores the renderer's `info` by reference. @internal */
    buffers: Buffers.BufferCache = null!;

    /** @internal */ bindGroupLayoutCache: BindGroupLayoutCache = createBindGroupLayoutCache();
    /** @internal */ textures: Textures.TextureCache = Textures.createTextureCache();
    samplers: Samplers.SamplerCache = Samplers.createSamplerCache();
    /** @internal */ pipelines: Pipelines.PipelinesState = Pipelines.createPipelinesState(this.bindGroupLayoutCache);
    /** @internal */ bindings: Bindings.BindingsState = Bindings.createBindingsState(this.bindGroupLayoutCache);
    /** @internal */ renderObjectGpu: RenderObjectGpu.RenderObjectGpuCache = RenderObjectGpu.createRenderObjectGpuCache();
    /** @internal */ geometries: Geometries.GeometriesState = Geometries.createGeometriesState();

    /** @internal */ readonly renderBundles = new WeakMap<
        RenderBundle,
        WeakMap<object, Map<number, { gpu: GPURenderBundle; version: number; rebuilds: number }>>
    >();

    /** @internal */ readonly canvasContexts = new WeakMap<CanvasTarget, GPUCanvasContext>();
    /** @internal */ readonly swapchain: RenderPass.SwapchainState = RenderPass.createSwapchainState();

    /** A frame is one command buffer; `beginFrame` opens the encoder. @internal */
    _currentEncoder: GPUCommandEncoder | null = null;

    /** Error scopes resolve after the pass that opened them, so a caller has to await these to see one. @internal */
    _pendingValidation: Promise<void>[] = [];
    /** @internal */ _validationErrors: string[] = [];

    private readonly _opts: WebGPUBackendOptions;
    /** A handed-in device is the caller's to destroy, not ours. */
    private readonly _deviceProvided: boolean;
    private _frame: FrameBackend.WebGPUFrameBackendState = null!;

    constructor(opts: WebGPUBackendOptions = {}) {
        this._opts = opts;
        this._deviceProvided = opts.device !== undefined;
    }

    /**
     * Bring up the device: a pre-created one, or an adapter/device requesting every supported feature.
     * A canvas context is acquired lazily, by the first pass that names that canvas.
     *
     * @throws if WebGPU is not available or no suitable adapter is found.
     */
    async init(renderer: Renderer<DeviceBackend>): Promise<void> {
        this.renderer = renderer;

        this.buffers = Buffers.createBufferCache(renderer.info);

        const opts = this._opts;
        if (opts.device) {
            this.device = opts.device;
            this.adapter = opts.adapter!;
            this.format = opts.format ?? 'bgra8unorm';
        } else {
            if (!navigator.gpu) {
                throw new Error('[webgpu] WebGPU is not supported in this environment.');
            }

            const adapterOptions: GPURequestAdapterOptions | undefined =
                opts.powerPreference !== undefined
                    ? { ...opts.adapterOptions, powerPreference: opts.powerPreference }
                    : opts.adapterOptions;
            const requestedAdapter = await navigator.gpu.requestAdapter(adapterOptions);
            if (!requestedAdapter) {
                throw new Error('[webgpu] No WebGPU adapter found. Is WebGPU enabled?');
            }
            this.adapter = requestedAdapter;

            const requiredFeatures = Object.values(GPUFeatureName).filter((f) =>
                this.adapter.features.has(f),
            ) as GPUFeatureName[];
            const callerFeatures = opts.deviceDescriptor?.requiredFeatures ?? [];
            const mergedFeatures = [...new Set([...requiredFeatures, ...callerFeatures])] as GPUFeatureName[];
            this.device = await this.adapter.requestDevice({ ...opts.deviceDescriptor, requiredFeatures: mergedFeatures });

            this.device.lost.then((info) => {
                if (info.reason === 'destroyed') return; // intentional teardown
                ops.handleDeviceLost(renderer, {
                    api: 'WebGPU',
                    message: info.message || 'Unknown reason',
                    reason: info.reason || null,
                    originalEvent: info,
                });
            });

            this.format = opts.format ?? navigator.gpu.getPreferredCanvasFormat();
        }

        // Every canvas on one device shares this colour format; a pass's depth format comes from its
        // own target, so only the colour one is published here.
        this.pipelines.canvasFormat = this.format;
        this._frame = FrameBackend.createWebGPUFrameBackendState(renderer, this);
    }

    beginFrame(): void {
        FrameBackend.beginFrame(this._frame);
    }

    encodePass(desc: PassDesc, records: readonly PassEntry[], count: number): void {
        FrameBackend.encodePass(this._frame, desc, records, count);
    }

    encodeComputePass(desc: ComputePassDesc, records: readonly DispatchRecord[], count: number): void {
        FrameBackend.encodeComputePass(this._frame, desc, records, count);
    }

    /** Unreachable: `frame.transformFeedback()` rejects this backend before a pass can open. */
    encodeTransformFeedbackPass(): never {
        throw new Error('[webgpu] transform feedback is WebGL2-only');
    }

    submitFrame(): void {
        FrameBackend.submitFrame(this._frame);
    }

    discardFrame(): void {
        FrameBackend.discardFrame(this._frame);
    }

    /** Phase 1 compiles every pipeline in parallel; phase 2's uploads are per drawable, not per material. */
    async compileObjects(objects: RenderObject[], context: RenderContext): Promise<void> {
        const nodes = this.renderer._nodes;
        const pipelinePromises: Promise<void>[] = [];
        for (const renderObject of objects) {
            Prepare.compileRenderObject(this, nodes, renderObject, pipelinePromises);
        }
        await Promise.all(pipelinePromises);

        const preWarmFrame = nodes.nodeFrame;
        for (const renderObject of objects) {
            preWarmFrame.renderer = this.renderer;
            preWarmFrame.camera = context.camera;
            preWarmFrame.object = renderObject.mesh;
            preWarmFrame.material = renderObject.material;
            preWarmFrame.width = context.width;
            preWarmFrame.height = context.height;
            Prepare.uploadRenderObjectResources(this, renderObject, renderObject.geometry, preWarmFrame);
            await yieldToMain();
        }
    }

    readPixels(renderTarget: RenderTarget, attachmentIndex: number, layer: number): Promise<Uint8Array> {
        return ReadPixels.readPixels(this, renderTarget, attachmentIndex, layer);
    }

    /** Off the `DeviceBackend` contract on purpose: a neutral signature would widen this to `string`. */
    awaitCompletion(): Promise<void> {
        return this.device.queue.onSubmittedWorkDone();
    }

    hasFeature(feature: GPUFeatureName): boolean {
        return this.device?.features?.has(feature) ?? false;
    }

    readMemoryStats(memory: Info.MemoryInfo): void {
        const buffers = Buffers.getBufferCacheStats(this.buffers);
        const pipelines = Pipelines.getPipelineCacheStats(this.pipelines);
        memory.buffers = buffers.bufferCount + buffers.rawCount;
        memory.geometries = Geometries.getGeometriesStats(this.geometries).geometries;
        // count + bytes + per-format breakdown, straight from the cache's running tally.
        Info.readTextureTally(this.textures.tally, memory);
        memory.samplers = Samplers.getSamplerCacheStats(this.samplers).samplerCount;
        memory.backend.rawBuffers = buffers.rawCount;
        memory.backend.renderPipelines = pipelines.renderCount;
        memory.backend.computePipelines = pipelines.computeCount;
        memory.backend.bindGroupLayouts = getBindGroupLayoutCacheStats(this.bindGroupLayoutCache).layoutCount;
    }

    dispose(): void {
        RenderPass.disposeDevice(this, this._deviceProvided);
    }

    /** The canvas context for a target, configured against this device. Acquired lazily per canvas. */
    getContext(canvasTarget: CanvasTarget, format: GPUTextureFormat, alphaMode?: GPUCanvasAlphaMode): GPUCanvasContext {
        return RenderPass.getContext(this.canvasContexts, this.device, canvasTarget, format, alphaMode);
    }

    /** Pre-compile a compute pipeline; one promise list, since awaiting per node would serialize them. */
    async compileCompute(nodes: ComputeNode[]): Promise<void> {
        const promises: Promise<void>[] = [];
        for (const node of nodes) {
            Compute.compileComputePipeline(
                this.device,
                this.pipelines,
                this.renderer._nodes,
                node,
                this.renderer._computeContext,
                promises,
            );
        }
        await Promise.all(promises);
    }

    /** Awaits every open error scope and returns what they reported, emptying both lists. */
    async takeValidationErrors(): Promise<string[]> {
        await Promise.all(this._pendingValidation);
        this._pendingValidation.length = 0;
        return this._validationErrors.splice(0);
    }
}
