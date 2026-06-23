import { Camera } from '../camera/camera';
import { type GpuBuffer } from '../core/gpu-buffer';
import { Object3D } from '../core/object3d';
import type { RenderTarget } from '../core/render-target';
import { InspectorBase } from '../inspector/inspector-base';
import type { Material } from '../material/material';
import { ComputeNode, MRTNode } from '../nodes/nodes';
import * as d from '../schema/schema';
import { Scene } from '../scene/scene';
import * as Bindings from './bindings';
import * as Buffers from './buffers';
import { CanvasTarget } from './canvas-target';
import * as Geometries from './geometries';
import * as NodeManager from './node-manager';
import * as RenderContext from './pass-context';
import * as Pipelines from './pipelines';
import * as RenderLists from './render-list';
import * as RenderObjects from './render-objects';
import * as Textures from './textures';
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
    /** Canvas element to render into. If not provided, one will be created. Ignored when `headless` is true. */
    canvas?: HTMLCanvasElement;
    /** When true, the canvas context uses premultiplied alpha compositing. Defaults to false (opaque). */
    alpha?: boolean;
    /**
     * Headless mode, no canvas, no swapchain. Requires a pre-created `device`.
     * Renders must target a `RenderTarget` (set via `renderer.renderTarget`).
     * Useful for Node.js with a native WebGPU library, or for off-screen rendering pipelines.
     */
    headless?: boolean;
};
/**
 * A single compute dispatch in a `WebGPURenderer.compute()` batch.
 *
 * Either `dispatch` (CPU-side workgroup counts) or `indirect` (GPU buffer holding counts)
 * must be provided. `buffers` (optional, on either form) overrides named storage refs.
 */
export type ComputeDispatch = {
    /** The ComputeNode to dispatch. */
    node: ComputeNode;
    /** Workgroup counts [x, y, z] dispatched from the CPU. */
    dispatch: [number, number, number];
    indirect?: never;
    indirectOffset?: never;
    /**
     * Override map for named storage buffers (those declared via `storage('name', schema, ...)`).
     * Takes precedence over the node's value/geometry, lets one ComputeNode be reused
     * across different buffers without recompiling the pipeline.
     */
    buffers?: Record<string, GpuBuffer<d.Any>>;
} | {
    /** The ComputeNode to dispatch. */
    node: ComputeNode;
    /**
     * GPU buffer holding `[countX, countY, countZ]` as u32 (matches `dispatchWorkgroupsIndirect` layout).
     * Buffer must have 'indirect' usage. Typically written by an earlier compute pass.
     */
    indirect: GpuBuffer<d.Any>;
    /** Byte offset into `indirect`. Defaults to 0. */
    indirectOffset?: number;
    dispatch?: never;
    /** See `dispatch` form for details. */
    buffers?: Record<string, GpuBuffer<d.Any>>;
};
export declare class WebGPURenderer {
    /** Whether the renderer has been initialized (adapter/device/context created) or not. @internal */
    _initialized: boolean;
    /** Indicates whether the device has been lost or not. When this is set to `true`, rendering isn't possible anymore. @internal */
    _isDeviceLost: boolean;
    /** @internal */
    _inspector: InspectorBase | null;
    /**
     * Inspector. `null` means no inspector is attached, hot path pays zero cost.
     * Assigning (`renderer.inspector = new Inspector()`) attaches it, and so does
     * `setInspector(...)`; both are equivalent. Assigning `null` detaches and
     * disposes the old one. Ordering relative to `renderer.init()` does not matter.
     */
    get inspector(): InspectorBase | null;
    set inspector(next: InspectorBase | null);
    /**
     * Install or remove the inspector. Equivalent to assigning `renderer.inspector`.
     * Safe to call at any time, including before `renderer.init()`. Passing `null`
     * triggers the old inspector's detach path (releases GPU resources, removes DOM,
     * drops listeners).
     */
    setInspector(next: InspectorBase | null): void;
    /** The canvas dom element for the current canvas target. Throws in headless mode. */
    get domElement(): HTMLCanvasElement;
    private _frameWidth;
    private _frameHeight;
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
    /** Cached view of `_depthTexture` (recreated alongside the texture, not per frame). */
    _depthTextureView: GPUTextureView;
    /** MSAA color texture (null when samples <= 1). Only used for swapchain passes */
    _msaaTexture: GPUTexture | null;
    /** Cached view of `_msaaTexture` (recreated alongside the texture, not per frame). */
    _msaaTextureView: GPUTextureView | null;
    /** @internal */
    _buffers: Buffers.BufferCache;
    /** @internal */
    _textures: Textures.TextureCache;
    /** @internal */
    _pipelines: Pipelines.PipelinesState;
    /** @internal */
    _renderContexts: RenderContext.RenderContextsState;
    /** @internal */
    _computeContext: RenderContext.ComputeContext;
    /** @internal */
    _geometries: Geometries.GeometriesState;
    /** @internal */
    _nodes: NodeManager.NodeManagerState;
    /** @internal */
    _bindings: Bindings.BindingsState;
    /** @internal */
    _renderObjects: RenderObjects.RenderObjectsState;
    /** @internal */
    _renderLists: RenderLists.RenderListsState;
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
    /** @internal current canvas target. the inspector viewer swaps this for preview renders. null in headless mode. */
    private _canvasTarget;
    /** swap the active canvas target (used by inspector viewer for preview renders). */
    setCanvasTarget(canvasTarget: CanvasTarget | null): this;
    getCanvasTarget(): CanvasTarget | null;
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
    /**
     * (Re)create the swapchain depth and (optional) MSAA textures and cache their
     * views. The views are stable until the next resize, so attachment resolution
     * reuses them rather than calling createView() every frame.
     */
    private _recreateSwapchainTextures;
    /** set the device pixel ratio. call before setSize(). Throws in headless mode. */
    setPixelRatio(value: number): void;
    /** resize the canvas to logical pixel dimensions (physical = logical * pixelRatio). Throws in headless mode. */
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
     * Optional, resources are created on-demand during the first render if not pre-warmed.
     */
    compile(scene: Scene, camera: Camera, samples?: number): Promise<void>;
    /**
     * Pre-compile a compute pipeline before the render loop starts.
     * This is optional, pipelines are compiled on-demand during the first
     * dispatch if not pre-warmed.
     *
     * @param computeNode The ComputeNode to pre-compile.
     * @throws if the renderer has not been initialised yet.
     */
    compileCompute(computeNode: ComputeNode): Promise<void>;
    /**
     * Encode and submit a batch of compute dispatches. Must be called **inside** a
     * `requestAnimationFrame` callback, before `renderPipeline.render()`, so the
     * compute work is submitted alongside the render pass.
     *
     * All entries share a single command encoder and a single `queue.submit()`,
     * minimizing CPU round-trip overhead. Each entry gets its own compute pass
     * so per-node inspector hooks (timestamps, perf) still work.
     *
     * Each entry supplies `dispatch: [x, y, z]` (CPU-side counts) or
     * `indirect: gpuBuffer` (GPU-side counts). Optional `buffers` overrides named
     * storage refs without recompiling the pipeline.
     *
     * ```ts
     * renderer.compute([
     *     { node: updateParticles, dispatch: [Math.ceil(N / 64), 1, 1] },
     * ]);
     *
     * renderer.compute([
     *     { node: cull,  dispatch: [n, 1, 1], buffers: { visible: bufA } },
     *     { node: build, indirect: indirectBuf },
     * ]);
     * ```
     *
     * @throws if the renderer has not been initialised.
     */
    compute(entries: ComputeDispatch[]): void;
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
    /** Build GPU color and depth attachments, dispatching on the target kind. */
    private _render_resolve;
    /** Attachments for a 2D render target (one color per attachment, MRT supported). */
    private _resolveRenderTargetAttachments;
    /** Attachments for the swapchain (canvas), resolving MSAA when enabled. */
    private _resolveSwapchainAttachments;
    /** Collect visible meshes, init render objects, and run updateBefore (may trigger nested renders). */
    private _render_prepare;
    /** Begin the GPU render pass, issue all draw calls, and end the pass. */
    private _render_draw;
    /** Build the color/depth attachments for a cube render target's active face. */
    private _resolveCubeAttachments;
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
