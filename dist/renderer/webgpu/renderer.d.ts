import type { Vec4 } from 'mathcat';
import type { Camera } from '../../camera/camera';
import type { GpuBuffer } from '../../core/gpu-buffer';
import type { Object3D } from '../../core/object3d';
import type { CubeRenderTarget } from '../../core/cube-render-target';
import type { RenderTarget } from '../../core/render-target';
import type { InspectorBase } from '../../inspector/inspector-base';
import type { Material } from '../../material/material';
import type { ComputeNode, MRTNode } from '../../nodes/nodes';
import type { Scene } from '../../scene/scene';
import type * as d from '../../schema/schema';
import type { DepthTextureFormat } from '../../texture/depth-texture';
import { CanvasTarget } from '../core/canvas-target';
import * as NodeManager from '../core/node-manager';
import * as RenderContext from '../core/pass-context';
import * as RenderLists from '../core/render-list';
import * as RenderObjects from '../core/render-objects';
import type { Renderer } from '../core/renderer-interface';
import type { DeviceLostInfo, RendererState } from '../core/renderer-ops';
import { type BindGroupLayoutCache } from './bind-group-layout';
import * as Bindings from './bindings';
import * as Buffers from './buffers';
import * as Geometries from './geometries';
import * as Pipelines from './pipelines';
import * as RenderObjectGpu from './render-object-gpu';
import * as RenderPass from './render-pass';
import * as Textures from './textures';
export type WebGPURendererOptions = {
    /** Enable 4x MSAA antialiasing. Overridden by `samples` if both set. */
    antialias?: boolean;
    /** Explicit MSAA sample count. 0 or 1 = no MSAA. Takes precedence over antialias. */
    samples?: number;
    /** Allocate a stencil buffer for the swapchain (depth24plus-stencil8). Default false. Ignored if `depthFormat` is set. */
    stencil?: boolean;
    /**
     * Explicit swapchain depth(-stencil) format, e.g. 'depth32float' for higher depth precision or
     * 'depth32float-stencil8' for float depth + stencil. Overrides `stencil`. Default: derived from `stencil`
     * ('depth24plus' or 'depth24plus-stencil8').
     */
    depthFormat?: DepthTextureFormat;
    /** GPURequestAdapterOptions forwarded to navigator.gpu.requestAdapter(). */
    adapterOptions?: GPURequestAdapterOptions;
    /**
     * Top-level GPU power-preference (parity with `WebGLRendererOptions.powerPreference`). Maps to the
     * adapter's `powerPreference`; takes precedence over `adapterOptions.powerPreference` if both set.
     */
    powerPreference?: GPUPowerPreference;
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
    /** Device pixel ratio. Applied to the canvas target before the first setSize. Ignored when `headless` is true. */
    pixelRatio?: number;
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
/**
 * WebGPU renderer — the concrete integrator. It owns its WebGPU device state (device/adapter/format,
 * the canvas context, the swapchain textures, the frame encoder) and every resource cache directly as
 * fields, and its methods sequence the neutral render-loop utilities (`../core/renderer-ops`) together
 * with the concrete `webgpu/*` free functions (render-pass, compute, prepare). It also structurally
 * satisfies the neutral `RendererState` so those utils accept `this`.
 */
export declare class WebGPURenderer implements Renderer, RendererState {
    /** Which graphics backend this renderer drives. Runtime discriminant for feature-detection. */
    readonly backend: "webgpu";
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
    /** The WebGPU GPU device in use. Assigned in `init()`. @internal */
    device: GPUDevice;
    /** The WebGPU adapter in use. Assigned in `init()`. @internal */
    adapter: GPUAdapter;
    /** The primary color/attachment format of the swapchain. Assigned in `init()`. @internal */
    format: GPUTextureFormat;
    /** @internal */
    readonly buffers: Buffers.BufferCache;
    /** @internal */
    readonly textures: Textures.TextureCache;
    /** @internal */
    readonly pipelines: Pipelines.PipelinesState;
    /** @internal */
    readonly bindings: Bindings.BindingsState;
    /** Per-draw WebGPU device payload (pipeline, bind groups, buffers) side table. @internal */
    readonly renderObjectGpu: RenderObjectGpu.RenderObjectGpuCache;
    /** @internal */
    readonly geometries: Geometries.GeometriesState;
    /** Value-keyed bind group layout cache, shared by pipelines + bindings. @internal */
    readonly bindGroupLayoutCache: BindGroupLayoutCache;
    /** WebGPU canvas contexts, one per canvas target. Acquired lazily and configured against the current device. @internal */
    readonly canvasContexts: WeakMap<CanvasTarget, GPUCanvasContext>;
    /** Swapchain attachment inputs (canvas target, samples, depth/msaa textures). @internal */
    readonly swapchain: RenderPass.SwapchainState;
    /** True when the device was handed in pre-created — dispose() must NOT destroy it. @internal */
    private readonly _deviceProvided;
    /**
     * Command encoder for the current top-level render frame. `render()` creates it at depth 1 and
     * nested renders (a PassNode rendering to a texture during updateBefore) reuse it, so one frame
     * lands in a single command buffer. Null between frames. @internal
     */
    private _currentEncoder;
    /** WebGPU device/adapter/format/swapchain construction options, captured for init(). @internal */
    private readonly _opts;
    /** MSAA sample count (0 or 1 = no MSAA). */
    samples: number;
    /** Whether the swapchain depth buffer has a stencil aspect. Derived from the resolved `depthFormat`/`stencil`. */
    readonly stencil: boolean;
    /**
     * A callback function that is executed when a device loss occurs.
     * @example
     * renderer.onDeviceLost = (info) => {
     *     console.error('GPU device lost:', info.message);
     *     // Optionally: show error UI, attempt recovery, etc.
     * };
     */
    onDeviceLost: ((info: DeviceLostInfo) => void) | null;
    /** @internal */
    _renderContexts: RenderContext.RenderContextsState;
    /** @internal */
    _computeContext: RenderContext.ComputeContext;
    /** @internal */
    _nodes: NodeManager.NodeManagerState;
    /** @internal */
    _renderObjects: RenderObjects.RenderObjectsState;
    /** @internal */
    _renderLists: RenderLists.RenderListsState;
    /** Render call depth for nested render support. 0 = top-level render. @internal */
    _renderCallDepth: number;
    /** clear color for the final swapchain composite pass. defaults to opaque black. */
    clearColor: [number, number, number, number];
    /** when false, render() preserves the attachment's existing contents (loadOp:'load') instead of
     *  clearing to clearColor. Set false (after an initial clear()) to composite several
     *  viewport/scissor views into ONE canvas — a grid of independent 3D views. */
    autoClear: boolean;
    /** When true (and autoClear is true), the stencil buffer is cleared to clearStencilValue each render. */
    autoClearStencil: boolean;
    /** Value the stencil buffer is cleared to (0-255). Default 0. */
    clearStencilValue: number;
    /** @internal */
    _viewport: Vec4 | null;
    /** @internal */
    _scissor: Vec4 | null;
    /** @internal */
    _scissorTest: boolean;
    /** @internal */
    _viewportMinDepth: number;
    /** @internal */
    _viewportMaxDepth: number;
    /** current MRT configuration. when set, materials using mrt() nodes write to multiple color attachments. */
    mrt: MRTNode | null;
    /** current render target. when set, render() renders to this target instead of the swapchain. */
    renderTarget: RenderTarget | null;
    /** when set, all meshes in the scene render with this material instead of their own. */
    overrideMaterial: Material | null;
    /** @internal current canvas target. the inspector viewer swaps this for preview renders. null in headless mode. */
    _canvasTarget: CanvasTarget | null;
    /** swap the active canvas target (used by inspector viewer for preview renders). */
    setCanvasTarget(canvasTarget: CanvasTarget | null): this;
    getCanvasTarget(): CanvasTarget | null;
    constructor(opts?: WebGPURendererOptions);
    /**
     * Get (or lazily create + configure) the WebGPU canvas context for a canvas target. Used by the
     * inspector's preview renders.
     */
    getContext(canvasTarget: CanvasTarget, format: GPUTextureFormat, alphaMode?: GPUCanvasAlphaMode): GPUCanvasContext;
    /**
     * Initialise the WebGPU adapter, device, and canvas context.
     * Must be called (and awaited) before the first call to pipeline.render().
     *
     * @throws if WebGPU is not available or no suitable adapter is found.
     */
    init(): Promise<this>;
    /**
     * Bring up the WebGPU device and swapchain. Uses the pre-created device when one was supplied,
     * otherwise requests an adapter/device (enabling every supported feature), wires the device-lost
     * handler, and resolves the preferred canvas format + configures the canvas context. Finally
     * publishes the swapchain formats to the pipelines layer and allocates the depth/msaa textures
     * (skipped in headless mode, where there is no canvas target).
     * @internal
     */
    private _initDevice;
    /** Resize the swapchain to the given physical-pixel size, recreating depth/msaa if the size changed. @internal */
    private _resize;
    /** set the device pixel ratio. call before setSize(). Throws in headless mode. */
    setPixelRatio(value: number): void;
    /** resize the canvas to logical pixel dimensions (physical = logical * pixelRatio). Throws in headless mode. */
    setSize(width: number, height: number, updateStyle?: boolean): void;
    /**
     * Restrict rendering to a sub-rectangle of the framebuffer, in LOGICAL (CSS) pixels — top-left
     * origin, multiplied by the canvas pixelRatio internally. Accepts a `Vec4` tuple [x, y, width, height]
     * or the individual components. Persists until changed. Combine with setScissor + setScissorTest(true)
     * and autoClear=false to render many independent 3D views into one canvas (a grid of previews). Reset
     * via setViewport(0, 0, w, h).
     */
    setViewport(rect: Vec4): void;
    setViewport(x: number, y: number, width: number, height: number, minDepth?: number, maxDepth?: number): void;
    /** The current viewport as a `Vec4` [x, y, width, height] in logical px (full frame if none set). */
    getViewport(): Vec4;
    /** Set the scissor rectangle in LOGICAL (CSS) pixels (top-left origin), as a `Vec4` tuple
     *  [x, y, width, height] or individual components. Clips draws only while the scissor test is
     *  enabled — see setScissorTest. Does NOT affect loadOp clears. */
    setScissor(rect: Vec4): void;
    setScissor(x: number, y: number, width: number, height: number): void;
    /** The current scissor rect as a `Vec4` [x, y, width, height] in logical px (full frame if none set). */
    getScissor(): Vec4;
    /** Enable or disable the scissor test. When on, draw calls are clipped to the setScissor rect. */
    setScissorTest(enable: boolean): void;
    getScissorTest(): boolean;
    /**
     * Manually clear the current framebuffer (color and/or depth) to clearColor, ignoring
     * autoClear and viewport/scissor. Pair with autoClear=false to clear once, then render() a
     * series of viewport/scissor views on top. `stencil` only takes effect on a stencil-capable
     * attachment (see the renderer `stencil` option / a target's `stencilBuffer`).
     */
    clear(color?: boolean, depth?: boolean, stencil?: boolean): void;
    /** Finalize a cube render target after all six faces are captured (generate its mipmaps). */
    finalizeCubeCapture(renderTarget: CubeRenderTarget, mipLevel: number): void;
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
    /**
     * Render a scene from a camera's perspective.
     * Renders to `this.renderTarget` if set, otherwise to the swapchain.
     */
    render(scene: Object3D, camera: Camera, passId?: string): void;
    /**
     * Dispose the renderer and release all GPU resources.
     *
     * Destroys all cached GPU buffers, textures, pipelines, and the device
     * itself (unless a pre-created device was provided). After calling dispose(),
     * the renderer cannot be used again.
     */
    dispose(): void;
}
/** Information about a device lost event. Re-exported from the neutral render-loop core. */
export type { DeviceLostInfo };
