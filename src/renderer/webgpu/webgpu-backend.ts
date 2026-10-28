import type { GpuBuffer } from '../../core/gpu-buffer';
import type { GpuTexture } from '../../core/gpu-texture';
import type { RenderTarget } from '../../core/render-target';
import type { TextureOrigin, TextureRegion } from '../../core/texture-region';
import type { ComputeNode } from '../../nodes/nodes';
import { yieldToMain } from '../../utils/yield-to-main';
import type { CanvasTarget } from '../core/canvas-target';
import type { DeviceBackend } from '../core/device-backend';
import type {
    ComputePassDesc,
    DispatchRecord,
    PassDesc,
    PassEntry,
    RenderBundle,
    TransformFeedbackPassDesc,
    TransformFeedbackRecord,
} from '../core/frame';
import { GPUFeatureName } from '../core/gpu-constants';
import * as Info from '../core/info';
import { aimNodeFrame } from '../core/node-frame';
import type { RenderObject } from '../core/render-object';
import type { RenderPassParams } from '../core/render-types';
import type { Renderer } from '../core/renderer';
import * as ops from '../core/renderer-ops';
import {
    type BindGroupLayoutCache,
    createBindGroupLayoutCache,
    disposeBindGroupLayoutCache,
    getBindGroupLayoutCacheStats,
} from './bind-group-layout';
import * as Bindings from './bindings';
import * as Buffers from './buffers';
import * as Compute from './compute';
import * as CopyTexture from './copy-texture';
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

    /**
     * How validation errors are caught. `'device'` (the default) hears them from the device as they happen, naming
     * nothing; `'per-pass'` opens an error scope around every pass and submit, so each error names its pass, at a few
     * calls and a promise a pass.
     */
    validation?: 'device' | 'per-pass';
};

/** the most validation errors kept for `takeValidationErrors`, the newest */
const MAX_VALIDATION_ERRORS = 64;

/**
 * WebGPU's device half: the device, adapter, format, every resource cache, the swapchain and the
 * frame encoder. The node graph, render objects and pass contexts belong to the `Renderer` this is
 * given at `init`, which is also what drives it.
 */
export class WebGPUBackend implements DeviceBackend {
    readonly name = 'webgpu' as const;

    /** A context is acquired per canvas target, so no single canvas is the device's. */
    readonly deviceCanvasTarget = null;

    // A backend is constructed before its renderer and before its device, so these four alone cannot
    // hold a real value until `init`. Everything below them is built at construction.

    /** @internal */ renderer: Renderer<DeviceBackend> = null!;
    /** @internal */ device: GPUDevice = null!;
    /** @internal */ adapter: GPUAdapter = null!;
    /** The colour format every canvas on this device is configured with. @internal */
    format: GPUTextureFormat = null!;

    /** The only cache `init` has to build, because it stores the renderer's `info` by reference. @internal */
    buffers: Buffers.BufferCache = null!;

    /** Value-keyed, shared by pipelines and bindings so one entry shape yields one layout. @internal */
    bindGroupLayoutCache: BindGroupLayoutCache = createBindGroupLayoutCache();
    /** Every GPU allocation this backend holds, shared by its buffer, texture and swapchain caches. @internal */
    readonly memoryTally: Info.MemoryTally = Info.createMemoryTally();
    /** @internal */ textures: Textures.TextureCache = Textures.createTextureCache(this.memoryTally);
    /** @internal */ samplers: Samplers.SamplerCache = Samplers.createSamplerCache();
    /** @internal */ pipelines: Pipelines.PipelinesState = Pipelines.createPipelinesState(this.bindGroupLayoutCache);
    /** @internal */ bindings: Bindings.BindingsState = Bindings.createBindingsState(this.bindGroupLayoutCache);
    /** @internal */ renderObjectGpu: RenderObjectGpu.RenderObjectGpuCache = RenderObjectGpu.createRenderObjectGpuCache();
    /** @internal */ geometries: Geometries.GeometriesState = Geometries.createGeometriesState();

    /** Per (bundle, camera, render context, replay in the frame); here rather than on the neutral bundle, which may name no device object. @internal */
    readonly renderBundles = new WeakMap<RenderBundle, WeakMap<object, Map<number, RenderPass.BundleRecordings>>>();

    /** @internal */ readonly canvasContexts = new WeakMap<CanvasTarget, GPUCanvasContext>();
    /** @internal */ readonly swapchain: RenderPass.SwapchainState = RenderPass.createSwapchainState(this.memoryTally);

    /** A frame is one command buffer; `beginFrame` opens the encoder. @internal */
    _currentEncoder: GPUCommandEncoder | null = null;

    readonly validation: 'device' | 'per-pass';
    /** Error scopes resolve after the pass that opened them, so a caller has to await these to see one; each leaves
     *  as it settles. @internal */
    readonly _pendingValidation = new Set<Promise<void>>();
    /** @internal */ _validationErrors: string[] = [];

    /** Buffers with a read map in flight, released ahead of the device on dispose: Firefox's wgpu crashes
     *  (its GPU process, or the whole browser where it runs without one) when a device is destroyed while a
     *  read map is pending. A destroyed buffer rejects its map, as the device's destruction would. @internal */
    readonly _readbacks = new Set<GPUBuffer>();

    private readonly _opts: WebGPUBackendOptions;
    /** A handed-in device is the caller's to destroy, not ours. */
    private readonly _deviceProvided: boolean;
    private _frame: FrameBackend.WebGPUFrameBackendState = null!;

    constructor(opts: WebGPUBackendOptions = {}) {
        this._opts = opts;
        this._deviceProvided = opts.device !== undefined;
        this.validation = opts.validation ?? 'device';
    }

    /** Logs a validation error and keeps it for `takeValidationErrors`, the newest MAX_VALIDATION_ERRORS. @internal */
    _reportValidation(message: string): void {
        console.error(message);
        this._validationErrors.push(message);
        if (this._validationErrors.length > MAX_VALIDATION_ERRORS) this._validationErrors.shift();
    }

    /** Opens a pass's or submit's error scope, with `validation: 'per-pass'`. @internal */
    _openValidationScope(): void {
        if (this.validation === 'per-pass') this.device.pushErrorScope('validation');
    }

    /** Closes the scope `_openValidationScope` opened, reporting what it caught as the `kind` of work, in `pass`. @internal */
    _closeValidationScope(kind: 'render' | 'compute' | 'submit', pass?: string): void {
        if (this.validation !== 'per-pass') return;
        const where = pass === undefined ? '' : ` pass '${pass}':`;
        const pending = this.device.popErrorScope().then((err) => {
            if (err) this._reportValidation(`[WebGPU ${kind} validation error]${where} ${err.message}`);
        });
        this._pendingValidation.add(pending);
        void pending.finally(() => this._pendingValidation.delete(pending));
    }

    /**
     * Bring up the device: a pre-created one, or an adapter/device requesting every supported feature.
     * A canvas context is acquired lazily, by the first pass that names that canvas.
     *
     * @throws if WebGPU is not available or no suitable adapter is found.
     */
    async init(renderer: Renderer<DeviceBackend>): Promise<void> {
        this.renderer = renderer;

        this.buffers = Buffers.createBufferCache(renderer.info, this.memoryTally);

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

        // a listener rather than `onuncapturederror`, which a handed-in device's owner may have set
        if (this.validation === 'device') {
            this.device.addEventListener('uncapturederror', (event) => {
                this._reportValidation(`[WebGPU validation error] ${(event as GPUUncapturedErrorEvent).error.message}`);
            });
        }

        // Every canvas on one device shares this colour format; a pass's depth format comes from its
        // own target, so only the colour one is published here.
        this.pipelines.canvasFormat = this.format;
        this._frame = FrameBackend.createWebGPUFrameBackendState(renderer, this);
    }

    beginFrame(): void {
        FrameBackend.beginFrame(this._frame);
    }

    beginPass(desc: PassDesc): void {
        FrameBackend.beginPass(this._frame, desc);
    }

    recordEntry(entry: PassEntry): void {
        FrameBackend.recordEntry(this._frame, entry);
    }

    encodePass(desc: PassDesc): void {
        FrameBackend.encodePass(this._frame, desc);
    }

    beginComputePass(desc: ComputePassDesc): void {
        FrameBackend.beginComputePass(this._frame, desc);
    }

    recordDispatch(record: DispatchRecord): void {
        FrameBackend.recordDispatch(this._frame, record);
    }

    /** Transform feedback is WebGL2's; the frame refuses one on this backend before it records. */
    beginTransformFeedbackPass(_desc: TransformFeedbackPassDesc): void {}

    recordTransformFeedback(_record: TransformFeedbackRecord): void {}

    encodeComputePass(desc: ComputePassDesc): void {
        FrameBackend.encodeComputePass(this._frame, desc);
    }

    /** Unreachable: `frame.transformFeedback()` rejects this backend by name before a pass can open. */
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
    /** @internal */
    async compileObjects(objects: RenderObject[], params: RenderPassParams): Promise<void> {
        const nodes = this.renderer._nodes;
        const pipelinePromises: Promise<void>[] = [];
        for (const renderObject of objects) {
            Prepare.compileRenderObject(this, nodes, renderObject, pipelinePromises);
        }
        await Promise.all(pipelinePromises);

        aimNodeFrame(this.renderer, params.camera, params.width, params.height);
        const preWarmFrame = nodes.nodeFrame;
        for (const renderObject of objects) {
            preWarmFrame.object = renderObject.mesh;
            preWarmFrame.material = renderObject.material;
            Prepare.uploadRenderObjectResources(this, renderObject, renderObject.geometry, preWarmFrame);
            await yieldToMain();
        }
    }

    readPixels(renderTarget: RenderTarget, attachmentIndex: number, layer: number, mipLevel: number): Promise<Uint8Array> {
        return ReadPixels.readPixels(this, renderTarget, attachmentIndex, layer, mipLevel);
    }

    writeBuffer(buffer: GpuBuffer, byteOffset: number, data: ArrayBufferView, dataByteOffset: number, byteSize: number): void {
        Buffers.writeBufferBytes(this.buffers, this.device, buffer, byteOffset, data, dataByteOffset, byteSize);
    }

    writeTexture(texture: GpuTexture, region: TextureRegion, data: ArrayBufferView): void {
        Textures.writeTextureRegion(this.textures, this.device, texture, region, data);
    }

    copyBuffer(
        source: GpuBuffer,
        sourceByteOffset: number,
        destination: GpuBuffer,
        destinationByteOffset: number,
        byteSize: number,
    ): void {
        Buffers.copyBufferBytes(
            this.buffers,
            this.device,
            source,
            sourceByteOffset,
            destination,
            destinationByteOffset,
            byteSize,
        );
    }

    copyTexture(source: GpuTexture, region: TextureRegion, destination: GpuTexture, origin: TextureOrigin): void {
        CopyTexture.copyTextureRegion(this.textures, this.device, source, region, destination, origin);
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
        memory.geometries = Geometries.getGeometriesStats(this.geometries).geometries;
        Info.readMemoryTally(this.memoryTally, memory);
        memory.samplers = Samplers.getSamplerCacheStats(this.samplers).samplerCount;
        memory.backend.rawBuffers = buffers.rawCount;
        memory.backend.renderPipelines = pipelines.renderCount;
        memory.backend.computePipelines = pipelines.computeCount;
        memory.backend.bindGroupLayouts = getBindGroupLayoutCacheStats(this.bindGroupLayoutCache).layoutCount;
        const dynamicUniforms = Buffers.getDynamicUniformStats(this.buffers);
        memory.backend.dynamicUniformBuffers = dynamicUniforms.gpuBuffers;
        memory.backend.dynamicUniformStaging = dynamicUniforms.stagingBuffers;
    }

    /** @internal */
    releaseUniformBlock(key: object): void {
        Buffers.releaseUniformBlock(this.buffers, key);
    }

    /** Map `buffer` for reading, held in `_readbacks` until the map settles. @internal */
    async mapForRead(buffer: GPUBuffer, offset?: number, size?: number): Promise<void> {
        this._readbacks.add(buffer);
        try {
            await buffer.mapAsync(GPUMapMode.READ, offset, size);
        } finally {
            this._readbacks.delete(buffer);
        }
    }

    dispose(): void {
        // whoever destroys the device, ours or the caller's, it must not meet a read map still pending
        for (const buffer of this._readbacks) buffer.destroy();
        this._readbacks.clear();
        RenderPass.disposeSwapchain(this);
        Textures.disposeTextureCache(this.textures);
        Samplers.disposeSamplerCache(this.samplers);
        Buffers.disposeBufferCache(this.buffers);
        Pipelines.disposePipelines(this.pipelines);
        disposeBindGroupLayoutCache(this.bindGroupLayoutCache);
        Info.resetMemoryTally(this.memoryTally);

        // A handed-in device is the caller's to destroy; the caches above are ours either way.
        if (!this._deviceProvided && this.device) this.device.destroy();
    }

    /** The canvas context for a target, configured against this device. Acquired lazily per canvas. */
    getContext(canvasTarget: CanvasTarget, format: GPUTextureFormat, alphaMode?: GPUCanvasAlphaMode): GPUCanvasContext {
        return RenderPass.getContext(this.canvasContexts, this.swapchain, this.device, canvasTarget, format, alphaMode);
    }

    /** Pre-compile a compute pipeline; one promise list, since awaiting per node would serialize them. */
    async compileCompute(nodes: readonly ComputeNode[]): Promise<void> {
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
        return this._validationErrors.splice(0);
    }
}
