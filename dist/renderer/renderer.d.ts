import { Camera } from '../camera/camera';
import { type GpuBuffer } from '../core/gpu-buffer';
import { Object3D } from '../core/object3d';
import type { RenderTarget } from '../core/render-target';
import { InspectorBase } from '../inspector/inspector-base';
import type { Material } from '../material/material';
import { ComputeNode, MRTNode } from '../nodes/nodes';
import * as d from '../schema/schema';
import { Scene } from '../scene/scene';
import * as bindings from './bindings';
import * as buffers from './buffers';
import { CanvasTarget } from './canvas-target';
import * as geometries from './geometries';
import * as nodeManager from './node-manager';
import * as RenderContext from './pass-context';
import * as pipelines from './pipelines';
import * as renderLists from './render-list';
import * as renderObjects from './render-objects';
import * as textures from './textures';
export type WebGPURendererOptions = {
    /** Enable 4x MSAA antialiasing. Overridden by `samples` if both set. */
    antialias?: boolean;
    /** Explicit MSAA sample count. 0 or 1 = no MSAA. Takes precedence over antialias. */
    samples?: number;
    /** GPURequestAdapterOptions forwarded to navigator.gpu.requestAdapter(). */
    adapterOptions?: GPURequestAdapterOptions;
    /** GPUDeviceDescriptor forwarded to adapter.requestDevice(). */
    deviceDescriptor?: GPUDeviceDescriptor;
    /** Pre-created GPUDevice. When provided, skips navigator.gpu initialization. */
    device?: GPUDevice;
    /** Pre-created GPUAdapter. Required when `device` is provided. */
    adapter?: GPUAdapter;
    /** Canvas texture format. Defaults to navigator.gpu.getPreferredCanvasFormat() or 'bgra8unorm' when using a pre-created device. */
    format?: GPUTextureFormat;
    /** Canvas element to render into. If not provided, one will be created */
    canvas?: HTMLCanvasElement;
    /** When true, the canvas context uses premultiplied alpha compositing (like three.js `alpha`). Defaults to false (opaque). */
    alpha?: boolean;
};
export declare class WebGPURenderer {
    /** Whether the renderer has been initialized (adapter/device/context created) or not. @internal */
    _initialized: boolean;
    /** Indicates whether the device has been lost or not. When this is set to `true`, rendering isn't possible anymore. @internal */
    _isDeviceLost: boolean;
    /** Inspector. Replace with a RendererInspector or Inspector instance to enable profiling. */
    inspector: InspectorBase;
    /** The canvas dom element for the current canvas target */
    get domElement(): HTMLCanvasElement;
    /** The WebGPU GPU adapter in use. */
    _adapter: GPUAdapter;
    /** The WebGPU GPU device in use. */
    _device: GPUDevice;
    /** The WebGPU texture format used for the swapchain. */
    _format: GPUTextureFormat;
    /** MSAA sample count (0 or 1 = no MSAA). */
    samples: number;
    /** GPURequestAdapterOptions forwarded to navigator.gpu.requestAdapter(). */
    _adapterOptions: GPURequestAdapterOptions | undefined;
    /** GPUDeviceDescriptor forwarded to adapter.requestDevice(). */
    _deviceDescriptor: GPUDeviceDescriptor | undefined;
    /**
     * A callback function that is executed when a device loss occurs.
     * @example
     * renderer.onDeviceLost = (info) => {
     *     console.error('GPU device lost:', info.message);
     *     // Optionally: show error UI, attempt recovery, etc.
     * };
     */
    onDeviceLost: ((info: DeviceLostInfo) => void) | null;
    /** swapchain depth texture (recreated on resize) */
    _depthTexture: GPUTexture;
    /** MSAA color texture (null when samples <= 1). Only used for swapchain passes */
    _msaaTexture: GPUTexture | null;
    /** @internal */
    _buffers: buffers.BufferCache;
    /** @internal */
    _textures: textures.TextureCache;
    /** @internal */
    _pipelines: pipelines.PipelinesState;
    /** @internal */
    _renderContexts: RenderContext.RenderContextsState;
    /** @internal */
    _computeContext: RenderContext.ComputeContext;
    /** @internal */
    _geometries: geometries.GeometriesState;
    /** @internal */
    _nodes: nodeManager.NodeManagerState;
    /** @internal */
    _bindings: bindings.BindingsState;
    /** @internal */
    _renderObjects: renderObjects.RenderObjectsState;
    /** @internal */
    _renderLists: renderLists.RenderListsState;
    /** Render call depth for nested render support. 0 = top-level render. @internal */
    _renderCallDepth: number;
    /** clear color for the final swapchain composite pass. defaults to opaque black. */
    clearColor: [number, number, number, number];
    /** current MRT configuration. when set, materials using mrt() nodes write to multiple color attachments. */
    mrt: MRTNode | null;
    /** current render target. when set, render() renders to this target instead of the swapchain. */
    renderTarget: RenderTarget | null;
    /** when set, all meshes in the scene render with this material instead of their own. */
    overrideMaterial: Material | null;
    /** @internal current canvas target. the inspector viewer swaps this for preview renders. */
    private _canvasTarget;
    /** swap the active canvas target (used by inspector viewer for preview renders). */
    setCanvasTarget(canvasTarget: CanvasTarget): this;
    getCanvasTarget(): CanvasTarget;
    /** @internal Pre-created device (for device sharing or testing) */
    private _preDevice?;
    /** @internal Pre-created adapter */
    private _preAdapter?;
    /** @internal Pre-specified format */
    private _preFormat?;
    constructor(opts?: WebGPURendererOptions);
    /**
     * Initialise the WebGPU adapter, device, and canvas context.
     * Must be called (and awaited) before the first call to pipeline.render().
     *
     * @throws if WebGPU is not available or no suitable adapter is found.
     */
    init(): Promise<this>;
    /** recreate depth/msaa textures after a resize. */
    private _onResize;
    /** set the device pixel ratio. call before setSize(). */
    setPixelRatio(value: number): void;
    /** call once per animation frame before any compute() or render() calls. bumps frameId, updates time/deltaTime. */
    beginFrame(): number;
    /** call once per animation frame after all compute() and render() calls. */
    endFrame(): void;
    /** resize the canvas to logical pixel dimensions (physical = logical * pixelRatio). */
    setSize(width: number, height: number, updateStyle?: boolean): void;
    /**
     * Check if a GPU feature is available on the current device.
     *
     * @example
     * ```ts
     * if (renderer.hasFeature('shader-f16')) {
     *     // Can use f16, vec2h, vec3h, vec4h, mat*h types
     * }
     * ```
     */
    hasFeature(feature: GPUFeatureName): boolean;
    /**
     * Pre-compile render pipelines and pre-upload GPU resources for a scene.
     * Optional — resources are created on-demand during the first render if not pre-warmed.
     */
    compile(scene: Scene, camera: Camera, samples?: number, format?: GPUTextureFormat): Promise<void>;
    /**
     * Pre-compile a compute pipeline before the render loop starts.
     * This is optional — pipelines are compiled on-demand during the first
     * dispatch if not pre-warmed.
     *
     * @param computeNode The ComputeNode to pre-compile.
     * @throws if the renderer has not been initialised yet.
     */
    compileCompute(computeNode: ComputeNode): Promise<void>;
    /**
     * Encode a compute dispatch for `node` using the renderer's current
     * command encoder.  Must be called **inside** a `requestAnimationFrame`
     * callback, before `renderPipeline.render()`, so that the compute pass is
     * submitted in the same command buffer as the render pass.
     *
     * Typical usage:
     * ```ts
     * await renderer.compile(updateParticles);
     * const renderPipeline = new RenderPipeline(renderer, outputNode);
     *
     * function frame() {
     *     renderer.compute(updateParticles, [particleCount / 64, 1, 1]);
     *     renderPipeline.render();
     *     requestAnimationFrame(frame);
     * }
     * ```
     *
     * @param node The ComputeNode to dispatch.
     * @param dispatch Workgroup counts [x, y, z] to dispatch.
     * @throws if the renderer has not been initialised.
     * @throws if the pipeline has not been compiled yet (call renderer.compile() first).
     */
    compute(node: ComputeNode, dispatch: [number, number, number]): void;
    /**
     * Encode an indirect compute dispatch. Workgroup counts are read from
     * the GPU buffer backing `indirectBuffer` — no CPU-side dispatch count needed.
     *
     * The `GpuBuffer` must hold `[countX, countY, countZ]`
     * as u32 values (same layout as `dispatchWorkgroupsIndirect`).
     * Must have 'indirect' usage.
     *
     * Typically the indirect buffer is written by a small "workgroup kernel"
     * compute shader earlier in the frame.
     *
     * @param node The ComputeNode to dispatch.
     * @param indirectBuffer The indirect buffer holding GPU-side dispatch counts.
     */
    compute(node: ComputeNode, indirectBuffer: GpuBuffer<d.Any>): void;
    private _dispatchComputeNode;
    /** save the current renderer state into a plain object and return it */
    saveRendererState(): {
        renderTarget: RenderTarget | null;
        mrt: MRTNode | null;
        clearColor: [number, number, number, number];
        overrideMaterial: Material | null;
    };
    /** restore renderer state previously saved with `saveRendererState()` */
    restoreRendererState(state: ReturnType<WebGPURenderer['saveRendererState']>): void;
    /**
     * Render a scene from a camera's perspective.
     * Renders to `this.renderTarget` if set, otherwise to the swapchain.
     */
    render(scene: Object3D, camera: Camera, commandEncoder?: GPUCommandEncoder, passId?: string): void;
    /** Build GPU color and depth attachments for the current render target or swapchain. */
    private _render_resolve;
    /** Collect visible meshes, init render objects, and run updateBefore (may trigger nested renders). */
    private _render_prepare;
    /** Begin the GPU render pass, issue all draw calls, and end the pass. */
    private _render_draw;
    private _ensureRenderTargetAllocated;
    private _createDepthTexture;
    private _createMsaaTexture;
    /**
     * Dispose the renderer and release all GPU resources.
     *
     * Destroys all cached GPU buffers, textures, pipelines, and the device
     * itself (unless a pre-created device was provided). After calling dispose(),
     * the renderer cannot be used again.
     */
    dispose(): void;
}
/** Information about a device lost event. */
export type DeviceLostInfo = {
    /** The API that lost the device ('WebGPU'). */
    api: 'WebGPU';
    /** Human-readable message about the loss. */
    message: string;
    /** The reason for the loss, if available. */
    reason: GPUDeviceLostReason | null;
    /** The original GPUDeviceLostInfo event. */
    originalEvent: GPUDeviceLostInfo;
};
