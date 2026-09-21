import type { RenderTarget } from '../../core/render-target';
import type { ComputeNode } from '../../nodes/nodes';
import type { CanvasTarget } from '../core/canvas-target';
import type { DeviceBackend } from '../core/device-backend';
import type { ComputePassDesc, DispatchRecord, PassDesc, PassEntry, RenderBundle } from '../core/frame';
import * as Info from '../core/info';
import type { RenderObject } from '../core/render-object';
import type { RenderPassParams } from '../core/render-types';
import type { Renderer } from '../core/renderer';
import { type BindGroupLayoutCache } from './bind-group-layout';
import * as Bindings from './bindings';
import * as Buffers from './buffers';
import * as Geometries from './geometries';
import * as Pipelines from './pipelines';
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
export declare class WebGPUBackend implements DeviceBackend {
    readonly name: "webgpu";
    /** A context is acquired per canvas target, so no single canvas is the device's. */
    readonly deviceCanvasTarget: null;
    /** @internal */ renderer: Renderer<DeviceBackend>;
    /** @internal */ device: GPUDevice;
    /** @internal */ adapter: GPUAdapter;
    /** The colour format every canvas on this device is configured with. @internal */
    format: GPUTextureFormat;
    /** The only cache `init` has to build, because it stores the renderer's `info` by reference. @internal */
    buffers: Buffers.BufferCache;
    /** Value-keyed, shared by pipelines and bindings so one entry shape yields one layout. @internal */
    bindGroupLayoutCache: BindGroupLayoutCache;
    /** @internal */ textures: Textures.TextureCache;
    /** @internal */ samplers: Samplers.SamplerCache;
    /** @internal */ pipelines: Pipelines.PipelinesState;
    /** @internal */ bindings: Bindings.BindingsState;
    /** @internal */ renderObjectGpu: RenderObjectGpu.RenderObjectGpuCache;
    /** @internal */ geometries: Geometries.GeometriesState;
    /** Per (bundle, camera, render context); here rather than on the neutral bundle, which may name no device object. @internal */
    readonly renderBundles: WeakMap<RenderBundle, WeakMap<object, Map<number, {
        gpu: GPURenderBundle;
        version: number;
        rebuilds: number;
    }>>>;
    /** @internal */ readonly canvasContexts: WeakMap<CanvasTarget, GPUCanvasContext>;
    /** @internal */ readonly swapchain: RenderPass.SwapchainState;
    /** A frame is one command buffer; `beginFrame` opens the encoder. @internal */
    _currentEncoder: GPUCommandEncoder | null;
    /** Error scopes resolve after the pass that opened them, so a caller has to await these to see one. @internal */
    _pendingValidation: Promise<void>[];
    /** @internal */ _validationErrors: string[];
    private readonly _opts;
    /** A handed-in device is the caller's to destroy, not ours. */
    private readonly _deviceProvided;
    private _frame;
    constructor(opts?: WebGPUBackendOptions);
    /**
     * Bring up the device: a pre-created one, or an adapter/device requesting every supported feature.
     * A canvas context is acquired lazily, by the first pass that names that canvas.
     *
     * @throws if WebGPU is not available or no suitable adapter is found.
     */
    init(renderer: Renderer<DeviceBackend>): Promise<void>;
    beginFrame(): void;
    encodePass(desc: PassDesc, records: readonly PassEntry[], count: number): void;
    encodeComputePass(desc: ComputePassDesc, records: readonly DispatchRecord[], count: number): void;
    /** Unreachable: `frame.transformFeedback()` rejects this backend before a pass can open. */
    /** Unreachable: `frame.transformFeedback()` rejects this backend by name before a dispatch can be recorded. */
    encodeTransformFeedbackPass(): never;
    submitFrame(): void;
    discardFrame(): void;
    /** Phase 1 compiles every pipeline in parallel; phase 2's uploads are per drawable, not per material. */
    /** @internal */
    compileObjects(objects: RenderObject[], params: RenderPassParams): Promise<void>;
    readPixels(renderTarget: RenderTarget, attachmentIndex: number, layer: number, mipLevel: number): Promise<Uint8Array>;
    /** Off the `DeviceBackend` contract on purpose: a neutral signature would widen this to `string`. */
    awaitCompletion(): Promise<void>;
    hasFeature(feature: GPUFeatureName): boolean;
    readMemoryStats(memory: Info.MemoryInfo): void;
    dispose(): void;
    /** The canvas context for a target, configured against this device. Acquired lazily per canvas. */
    getContext(canvasTarget: CanvasTarget, format: GPUTextureFormat, alphaMode?: GPUCanvasAlphaMode): GPUCanvasContext;
    /** Pre-compile a compute pipeline; one promise list, since awaiting per node would serialize them. */
    compileCompute(nodes: readonly ComputeNode[]): Promise<void>;
    /** Awaits every open error scope and returns what they reported, emptying both lists. */
    takeValidationErrors(): Promise<string[]>;
}
