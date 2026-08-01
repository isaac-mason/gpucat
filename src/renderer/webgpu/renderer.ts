import type { Vec4 } from 'mathcat';
import type { Camera } from '../../camera/camera';
import { CoordinateSystem } from '../../core/coordinate-system';
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
import { yieldToMain } from '../../utils/yield-to-main';
import { CanvasTarget } from '../core/canvas-target';
import { GPUFeatureName } from '../core/gpu-constants';
import * as NodeManager from '../core/node-manager';
import * as RenderContext from '../core/pass-context';
import type { BackendComputeEntry, RenderPassParams } from '../core/render-types';
import * as RenderLists from '../core/render-list';
import * as RenderObjects from '../core/render-objects';
import type { Renderer } from '../core/renderer-interface';
import * as ops from '../core/renderer-ops';
import type { DeviceLostInfo, RendererState } from '../core/renderer-ops';
import { type BindGroupLayoutCache, createBindGroupLayoutCache } from './bind-group-layout';
import * as Bindings from './bindings';
import * as Buffers from './buffers';
import * as Compute from './compute';
import * as Geometries from './geometries';
import { DEPTH_FORMAT, DEPTH_STENCIL_FORMAT, formatHasStencil } from './pipelines';
import * as Pipelines from './pipelines';
import * as Prepare from './prepare';
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
export type ComputeDispatch =
    | {
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
      }
    | {
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
export class WebGPURenderer implements Renderer, RendererState {
    /** Which graphics backend this renderer drives. Runtime discriminant for feature-detection. */
    readonly backend = 'webgpu' as const;

    /** Whether the renderer has been initialized (adapter/device/context created) or not. @internal */
    _initialized = false;

    /** Indicates whether the device has been lost or not. When this is set to `true`, rendering isn't possible anymore. @internal */
    _isDeviceLost = false;

    /** @internal */
    _inspector: InspectorBase | null = null;

    /**
     * Inspector. `null` means no inspector is attached, hot path pays zero cost.
     * Assigning (`renderer.inspector = new Inspector()`) attaches it, and so does
     * `setInspector(...)`; both are equivalent. Assigning `null` detaches and
     * disposes the old one. Ordering relative to `renderer.init()` does not matter.
     */
    get inspector(): InspectorBase | null {
        return this._inspector;
    }
    set inspector(next: InspectorBase | null) {
        this.setInspector(next);
    }

    /**
     * Install or remove the inspector. Equivalent to assigning `renderer.inspector`.
     * Safe to call at any time, including before `renderer.init()`. Passing `null`
     * triggers the old inspector's detach path (releases GPU resources, removes DOM,
     * drops listeners).
     */
    setInspector(next: InspectorBase | null): void {
        if (this._inspector === next) return;
        this._inspector?.setRenderer(null); // detach signal, old disposes
        this._inspector = next;
        next?.setRenderer(this); // attach signal, new sets up
    }

    /** The canvas dom element for the current canvas target. Throws in headless mode. */
    get domElement(): HTMLCanvasElement {
        if (!this._canvasTarget) {
            throw new Error(
                '[WebGPURenderer] no canvas: renderer was created in headless mode. Render to a RenderTarget instead.',
            );
        }
        return this._canvasTarget.domElement;
    }

    // -----------------------------------------------------------------------
    // WebGPU device state — owned directly as fields (previously the backend
    // factory's closure). Device handles are assigned in init(); caches are
    // created in the constructor and immutable thereafter.
    // -----------------------------------------------------------------------

    /** The WebGPU GPU device in use. Assigned in `init()`. @internal */
    device: GPUDevice = null!;
    /** The WebGPU adapter in use. Assigned in `init()`. @internal */
    adapter: GPUAdapter = null!;
    /** The primary color/attachment format of the swapchain. Assigned in `init()`. @internal */
    format: GPUTextureFormat = null!;

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
    readonly canvasContexts = new WeakMap<CanvasTarget, GPUCanvasContext>();

    /** Swapchain attachment inputs (canvas target, samples, depth/msaa textures). @internal */
    readonly swapchain: RenderPass.SwapchainState;

    /** True when the device was handed in pre-created — dispose() must NOT destroy it. @internal */
    private readonly _deviceProvided: boolean;

    /**
     * Command encoder for the current top-level render frame. `render()` creates it at depth 1 and
     * nested renders (a PassNode rendering to a texture during updateBefore) reuse it, so one frame
     * lands in a single command buffer. Null between frames. @internal
     */
    private _currentEncoder: GPUCommandEncoder | null = null;

    /** WebGPU device/adapter/format/swapchain construction options, captured for init(). @internal */
    private readonly _opts: WebGPURendererOptions;

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
    onDeviceLost: ((info: DeviceLostInfo) => void) | null = null;

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
    _renderCallDepth: number = 0;

    /** clear color for the final swapchain composite pass. defaults to opaque black. */
    clearColor: [number, number, number, number] = [0, 0, 0, 1];

    /** when false, render() preserves the attachment's existing contents (loadOp:'load') instead of
     *  clearing to clearColor. Set false (after an initial clear()) to composite several
     *  viewport/scissor views into ONE canvas — a grid of independent 3D views. */
    autoClear: boolean = true;

    /** When true (and autoClear is true), the stencil buffer is cleared to clearStencilValue each render. */
    autoClearStencil: boolean = true;

    /** Value the stencil buffer is cleared to (0-255). Default 0. */
    clearStencilValue: number = 0;

    // Swapchain viewport/scissor as Vec4 [x, y, width, height] in LOGICAL (CSS) pixels;
    // resolveViewportScissor converts them to physical pixels (× canvas pixelRatio) per render.
    // null = full frame. Persist until changed. The viewport depth range is kept separately.
    /** @internal */
    _viewport: Vec4 | null = null;
    /** @internal */
    _scissor: Vec4 | null = null;
    /** @internal */
    _scissorTest = false;
    /** @internal */
    _viewportMinDepth = 0;
    /** @internal */
    _viewportMaxDepth = 1;

    /** current MRT configuration. when set, materials using mrt() nodes write to multiple color attachments. */
    mrt: MRTNode | null = null;

    /** current render target. when set, render() renders to this target instead of the swapchain. */
    renderTarget: RenderTarget | null = null;

    /** when set, all meshes in the scene render with this material instead of their own. */
    overrideMaterial: Material | null = null;

    /** @internal current canvas target. the inspector viewer swaps this for preview renders. null in headless mode. */
    _canvasTarget: CanvasTarget | null = null;

    /** swap the active canvas target (used by inspector viewer for preview renders). */
    setCanvasTarget(canvasTarget: CanvasTarget | null): this {
        this._canvasTarget = canvasTarget;
        // The swapchain path resolves its context + present target from swapchain.canvasTarget, so it
        // must track the active target — otherwise every render presents into the target that happened
        // to be current at init and swapping (multi-canvas rooms, inspector preview) leaves the visible
        // canvas black. Depth/MSAA textures are reconciled to the new target's size on the next render
        // (_resize + resolveSwapchainAttachments), so only the reference needs updating here.
        this.swapchain.canvasTarget = canvasTarget;
        return this;
    }

    getCanvasTarget(): CanvasTarget | null {
        return this._canvasTarget;
    }

    constructor(opts: WebGPURendererOptions = {}) {
        this._opts = opts;

        let samples = 0;
        if (opts.samples !== undefined) {
            samples = opts.samples <= 1 ? 0 : opts.samples;
        } else if (opts.antialias) {
            samples = 4;
        }
        this.samples = samples;
        const swapchainDepthFormat = opts.depthFormat ?? (opts.stencil ? DEPTH_STENCIL_FORMAT : DEPTH_FORMAT);
        this.stencil = formatHasStencil(swapchainDepthFormat);

        // Device resource caches — created once here, immutable references thereafter. The bind group
        // layout cache is shared by the pipelines and bindings layers (both receive this instance).
        this.buffers = Buffers.createBufferCache();
        this.textures = Textures.createTextureCache();
        this.bindGroupLayoutCache = createBindGroupLayoutCache();
        this.pipelines = Pipelines.createPipelinesState(this.bindGroupLayoutCache);
        this.bindings = Bindings.createBindingsState(this.bindGroupLayoutCache);
        this.geometries = Geometries.createGeometriesState();
        this.renderObjectGpu = RenderObjectGpu.createRenderObjectGpuCache();

        this.swapchain = RenderPass.createSwapchainState(samples, swapchainDepthFormat);
        this._deviceProvided = opts.device !== undefined;

        if (opts.headless) {
            if (!opts.device) {
                throw new Error('[WebGPURenderer] headless mode requires a pre-created `device`.');
            }
            // _canvasTarget stays null
        } else {
            // Create the main canvas and wrap it as the default CanvasTarget.
            // Use provided canvas if given, otherwise create one.
            const canvas = opts.canvas ?? document.createElement('canvas');
            if (!opts.canvas) {
                canvas.style.display = 'block';
            }
            this._canvasTarget = new CanvasTarget(canvas, { alphaMode: opts.alpha ? 'premultiplied' : 'opaque' });
            this._canvasTarget.isDefaultCanvasTarget = true;
            if (opts.pixelRatio !== undefined) this._canvasTarget.setPixelRatio(opts.pixelRatio);
        }

        this._renderContexts = RenderContext.createRenderContextsState();
        this._computeContext = RenderContext.createComputeContext();
        this._nodes = NodeManager.createNodeManagerState();
        this._renderLists = RenderLists.createRenderListsState();
        this._renderObjects = RenderObjects.createRenderObjectsState();
    }

    /**
     * Get (or lazily create + configure) the WebGPU canvas context for a canvas target. Used by the
     * inspector's preview renders.
     */
    getContext(canvasTarget: CanvasTarget, format: GPUTextureFormat, alphaMode?: GPUCanvasAlphaMode): GPUCanvasContext {
        return RenderPass.getContext(this.canvasContexts, this.device, canvasTarget, format, alphaMode);
    }

    /**
     * Initialise the WebGPU adapter, device, and canvas context.
     * Must be called (and awaited) before the first call to pipeline.render().
     *
     * @throws if WebGPU is not available or no suitable adapter is found.
     */
    async init(): Promise<this> {
        if (this._initialized) return this;

        // Resolve the initial swapchain size from the canvas target (1×1 in headless mode).
        const width = this._canvasTarget ? this.domElement.width || 1 : 1;
        const height = this._canvasTarget ? this.domElement.height || 1 : 1;
        await this._initDevice(this._canvasTarget, width, height);

        this._initialized = true;
        return this;
    }

    /**
     * Bring up the WebGPU device and swapchain. Uses the pre-created device when one was supplied,
     * otherwise requests an adapter/device (enabling every supported feature), wires the device-lost
     * handler, and resolves the preferred canvas format + configures the canvas context. Finally
     * publishes the swapchain formats to the pipelines layer and allocates the depth/msaa textures
     * (skipped in headless mode, where there is no canvas target).
     * @internal
     */
    private async _initDevice(canvasTarget: CanvasTarget | null, width: number, height: number): Promise<void> {
        const opts = this._opts;
        if (opts.device) {
            this.device = opts.device;
            this.adapter = opts.adapter!;
            this.format = opts.format ?? 'bgra8unorm';
        } else {
            if (!navigator.gpu) {
                throw new Error('[WebGPURenderer] WebGPU is not supported in this environment.');
            }

            const adapterOptions: GPURequestAdapterOptions | undefined =
                opts.powerPreference !== undefined
                    ? { ...opts.adapterOptions, powerPreference: opts.powerPreference }
                    : opts.adapterOptions;
            const requestedAdapter = await navigator.gpu.requestAdapter(adapterOptions);
            if (!requestedAdapter) {
                throw new Error('[WebGPURenderer] No WebGPU adapter found. Is WebGPU enabled?');
            }
            this.adapter = requestedAdapter;

            // request every feature the adapter supports
            const requiredFeatures = Object.values(GPUFeatureName).filter((f) =>
                this.adapter.features.has(f),
            ) as GPUFeatureName[];

            // merge with any caller-supplied descriptor, deduplicating features.
            const callerFeatures = opts.deviceDescriptor?.requiredFeatures ?? [];
            const mergedFeatures = [...new Set([...requiredFeatures, ...callerFeatures])] as GPUFeatureName[];
            const deviceDescriptor: GPUDeviceDescriptor = {
                ...opts.deviceDescriptor,
                requiredFeatures: mergedFeatures,
            };

            this.device = await this.adapter.requestDevice(deviceDescriptor);

            // set up device lost handler
            this.device.lost.then((info) => {
                // ignore intentional device destruction
                if (info.reason === 'destroyed') return;
                ops.handleDeviceLost(this, {
                    api: 'WebGPU',
                    message: info.message || 'Unknown reason',
                    reason: info.reason || null,
                    originalEvent: info,
                });
            });

            // initialize the main canvas target context.
            this.format = opts.format ?? navigator.gpu.getPreferredCanvasFormat();
            if (canvasTarget) RenderPass.getContext(this.canvasContexts, this.device, canvasTarget, this.format);
        }

        // Publish the swapchain formats to the pipelines layer so the fallback path
        // (renderTarget === null) builds pipelines with the right attachment formats.
        this.pipelines.canvasFormat = this.format;
        this.pipelines.canvasDepthFormat = this.swapchain.depthFormat;

        this.swapchain.canvasTarget = canvasTarget;

        // Swapchain depth/msaa textures are only needed when rendering to a canvas.
        // In headless mode the RenderTarget owns its own depth/msaa.
        if (canvasTarget) {
            RenderPass.recreateSwapchainTextures(this.device, this.swapchain, this.format, width, height);
        }
    }

    /** Resize the swapchain to the given physical-pixel size, recreating depth/msaa if the size changed. @internal */
    private _resize(width: number, height: number): void {
        if (!this.swapchain.canvasTarget) return;
        const depth = this.swapchain.depthTexture;
        if (depth && depth.width === width && depth.height === height) return;
        RenderPass.recreateSwapchainTextures(this.device, this.swapchain, this.format, width, height);
    }

    /** set the device pixel ratio. call before setSize(). Throws in headless mode. */
    setPixelRatio(value: number): void {
        ops.setPixelRatio(this, value);
    }

    /** resize the canvas to logical pixel dimensions (physical = logical * pixelRatio). Throws in headless mode. */
    setSize(width: number, height: number, updateStyle: boolean = true): void {
        if (!this._canvasTarget) {
            throw new Error('[WebGPURenderer] setSize is not available in headless mode. Resize the RenderTarget instead.');
        }
        this._canvasTarget.setSize(width, height, updateStyle);

        if (!this._initialized) return;

        const { width: pw, height: ph } = this._canvasTarget.getDrawingBufferSize();
        this._resize(pw, ph);
    }

    /**
     * Restrict rendering to a sub-rectangle of the framebuffer, in LOGICAL (CSS) pixels — top-left
     * origin, multiplied by the canvas pixelRatio internally. Accepts a `Vec4` tuple [x, y, width, height]
     * or the individual components. Persists until changed. Combine with setScissor + setScissorTest(true)
     * and autoClear=false to render many independent 3D views into one canvas (a grid of previews). Reset
     * via setViewport(0, 0, w, h).
     */
    setViewport(rect: Vec4): void;
    setViewport(x: number, y: number, width: number, height: number, minDepth?: number, maxDepth?: number): void;
    setViewport(x: number | Vec4, y = 0, width = 0, height = 0, minDepth = 0, maxDepth = 1): void {
        ops.setViewport(this, x, y, width, height, minDepth, maxDepth);
    }

    /** The current viewport as a `Vec4` [x, y, width, height] in logical px (full frame if none set). */
    getViewport(): Vec4 {
        return ops.getViewport(this);
    }

    /** Set the scissor rectangle in LOGICAL (CSS) pixels (top-left origin), as a `Vec4` tuple
     *  [x, y, width, height] or individual components. Clips draws only while the scissor test is
     *  enabled — see setScissorTest. Does NOT affect loadOp clears. */
    setScissor(rect: Vec4): void;
    setScissor(x: number, y: number, width: number, height: number): void;
    setScissor(x: number | Vec4, y = 0, width = 0, height = 0): void {
        ops.setScissor(this, x, y, width, height);
    }

    /** The current scissor rect as a `Vec4` [x, y, width, height] in logical px (full frame if none set). */
    getScissor(): Vec4 {
        return ops.getScissor(this);
    }

    /** Enable or disable the scissor test. When on, draw calls are clipped to the setScissor rect. */
    setScissorTest(enable: boolean): void {
        ops.setScissorTest(this, enable);
    }

    getScissorTest(): boolean {
        return this._scissorTest;
    }

    /**
     * Manually clear the current framebuffer (color and/or depth) to clearColor, ignoring
     * autoClear and viewport/scissor. Pair with autoClear=false to clear once, then render() a
     * series of viewport/scissor views on top. `stencil` only takes effect on a stencil-capable
     * attachment (see the renderer `stencil` option / a target's `stencilBuffer`).
     */
    clear(color = true, depth = true, stencil = false): void {
        if (this._isDeviceLost || !this._initialized) return;
        if (!this.renderTarget) {
            if (!this._canvasTarget) return;
            if (this.domElement.width === 0 || this.domElement.height === 0) return;
        }
        const [cr, cg, cb, ca] = this.clearColor;
        RenderPass.clear(
            this.canvasContexts,
            this.device,
            this.textures,
            this.swapchain,
            this.format,
            {
                renderTarget: this.renderTarget,
                clearColor: { r: cr, g: cg, b: cb, a: ca },
                autoClear: true,
                autoClearStencil: this.autoClearStencil,
                clearStencilValue: this.clearStencilValue,
                swapchainStencil: this.stencil,
                passId: 'clear',
            },
            color,
            depth,
            stencil,
        );
    }

    /** Finalize a cube render target after all six faces are captured (generate its mipmaps). */
    finalizeCubeCapture(renderTarget: CubeRenderTarget, mipLevel: number): void {
        Textures.finalizeCubeRenderTargetCapture(this.textures, this.device, renderTarget, mipLevel);
    }

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
    hasFeature(feature: GPUFeatureName): boolean {
        return this.device?.features?.has(feature) ?? false;
    }

    /**
     * Pre-compile render pipelines and pre-upload GPU resources for a scene.
     * Optional, resources are created on-demand during the first render if not pre-warmed.
     */
    async compile(scene: Scene, camera: Camera, samples?: number): Promise<void> {
        if (!this._initialized) {
            throw new Error('[WebGPURenderer] compile() called before init(). Await renderer.init() first.');
        }

        const resolvedSamples = samples ?? this.samples;

        // collect visible meshes
        const renderList = RenderLists.collectRenderList(this._renderLists, scene, camera);
        const allItems = [...renderList.opaque, ...renderList.transparent];

        if (allItems.length === 0) return;

        // create a temporary RenderContext for compilation
        // this is needed because RenderObjects are cached by (mesh, material, renderContext)
        const compileContext = RenderContext.getRenderContext(this._renderContexts, null, null, 0);
        compileContext.sampleCount = resolvedSamples;
        compileContext.width = ops.frameWidth(this);
        compileContext.height = ops.frameHeight(this);

        const width = compileContext.width;
        const height = compileContext.height;

        // phase 1: Kick off all async pipeline compilations in parallel
        const initPromises: Promise<void>[] = [];

        for (const item of allItems) {
            if (!item.mesh || !item.material || !item.geometry) continue;

            const renderObject = RenderObjects.getRenderObject(
                this._renderObjects,
                item.mesh,
                item.material,
                scene,
                camera,
                compileContext,
                'compile',
            );

            const pipelinePromises: Promise<void>[] = [];
            Prepare.compileRenderObject(
                this.device,
                this.geometries,
                this.bindings,
                this.pipelines,
                this.buffers,
                this.renderObjectGpu,
                this._nodes,
                renderObject,
                pipelinePromises,
            );
            initPromises.push(...pipelinePromises);
        }

        // wait for all pipelines to compile
        await Promise.all(initPromises);

        // phase 2: pre-upload all GPU resources, yielding between objects
        for (const item of allItems) {
            if (!item.mesh || !item.material || !item.geometry) continue;

            const mesh = item.mesh;
            const geometry = item.geometry;

            const renderObject = RenderObjects.getRenderObject(
                this._renderObjects,
                mesh,
                item.material,
                scene,
                camera,
                compileContext,
                'compile',
            );

            // upload uniforms and rebuild bind groups against a temporary pre-warm frame.
            const preWarmFrame = this._nodes.nodeFrame;
            preWarmFrame.renderer = this;
            preWarmFrame.camera = camera;
            preWarmFrame.object = renderObject.mesh;
            preWarmFrame.scene = renderObject.scene;
            preWarmFrame.material = renderObject.material;
            preWarmFrame.width = width;
            preWarmFrame.height = height;
            Prepare.uploadRenderObjectResources(
                this.device,
                this.bindings,
                this.geometries,
                this.buffers,
                this.textures,
                this.renderObjectGpu,
                renderObject,
                geometry,
                preWarmFrame,
            );

            // yield to main thread between objects to keep animations smooth
            await yieldToMain();
        }
    }

    /**
     * Pre-compile a compute pipeline before the render loop starts.
     * This is optional, pipelines are compiled on-demand during the first
     * dispatch if not pre-warmed.
     *
     * @param computeNode The ComputeNode to pre-compile.
     * @throws if the renderer has not been initialised yet.
     */
    async compileCompute(computeNode: ComputeNode): Promise<void> {
        if (!this._initialized) {
            throw new Error('[WebGPURenderer] compileCompute() called before init(). Await renderer.init() first.');
        }
        const promises: Promise<void>[] = [];
        Compute.compileComputePipeline(this.device, this.pipelines, this._nodes, computeNode, this._computeContext, promises);
        await Promise.all(promises);
    }

    /** save the current renderer state into a plain object and return it */
    saveRendererState(): {
        renderTarget: RenderTarget | null;
        mrt: MRTNode | null;
        clearColor: [number, number, number, number];
        overrideMaterial: Material | null;
    } {
        return {
            renderTarget: this.renderTarget,
            mrt: this.mrt,
            clearColor: [...this.clearColor] as [number, number, number, number],
            overrideMaterial: this.overrideMaterial,
        };
    }

    /** restore renderer state previously saved with `saveRendererState()` */
    restoreRendererState(state: ReturnType<WebGPURenderer['saveRendererState']>): void {
        this.renderTarget = state.renderTarget;
        this.mrt = state.mrt;
        this.clearColor = state.clearColor;
        this.overrideMaterial = state.overrideMaterial;
    }

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
    compute(entries: ComputeDispatch[]): void {
        if (this._isDeviceLost) return;

        if (!this._initialized) {
            throw new Error('[WebGPURenderer] compute() called before init(). Await renderer.init() first.');
        }

        if (entries.length === 0) return;

        const frame = this._nodes.nodeFrame;
        const inspector = this.inspector;
        // Top-level entry: advance the frame id and open the inspector frame
        // (one top-level render()/compute() call == one frame).
        if (this._renderCallDepth === 0) {
            frame.frameId++;
            if (inspector) inspector.begin(frame.frameId);
        }
        this._renderCallDepth++;

        frame.renderer = this;
        frame.width = ops.frameWidth(this);
        frame.height = ops.frameHeight(this);

        if (inspector) inspector.perf.start('compute');

        // Device work (per-entry pipeline/bindings/pass/dispatch + post-submit mip regen) owns its own
        // command stream (a local encoder), independent of the render frame.
        Compute.dispatchCompute(
            this.device,
            this.bindings,
            this.buffers,
            this.textures,
            this.pipelines,
            this._nodes,
            this._computeContext,
            entries as BackendComputeEntry[],
            inspector,
        );

        if (inspector) inspector.perf.end('compute');

        // Top-level call complete (encoder submitted): close the inspector frame.
        this._renderCallDepth--;
        if (this._renderCallDepth === 0 && inspector) inspector.finish(frame.frameId);
    }

    /**
     * Render a scene from a camera's perspective.
     * Renders to `this.renderTarget` if set, otherwise to the swapchain.
     */
    render(scene: Object3D, camera: Camera, passId = 'render'): void {
        if (this._isDeviceLost) return;

        if (!this._initialized) {
            throw new Error('[WebGPURenderer] render() called before init(). Await renderer.init() first.');
        }

        if (!this.renderTarget) {
            if (!this._canvasTarget) {
                throw new Error('[WebGPURenderer] render() in headless mode requires renderer.renderTarget to be set.');
            }
            // Skip swapchain renders when canvas has zero dimensions (e.g. minimized or hidden).
            if (this.domElement.width === 0 || this.domElement.height === 0) return;
        }

        // Stamp this renderer's clip-space convention onto the camera; rebuild the projection if it changed.
        if (camera.coordinateSystem !== CoordinateSystem.WEBGPU) {
            camera.coordinateSystem = CoordinateSystem.WEBGPU;
            camera.updateProjectionMatrix();
        }

        const frame = this._nodes.nodeFrame;
        const inspector = this.inspector;
        // Top-level entry: advance the frame id and open the inspector frame.
        // A "frame" is one top-level render()/compute() call; nested renders (PassNode)
        // run at depth > 0 and share the same frameId.
        if (this._renderCallDepth === 0) {
            frame.frameId++;
            if (inspector) inspector.begin(frame.frameId);
        }
        this._renderCallDepth++;
        // Each render() gets a fresh, globally-unique renderId so RENDER-scope updates
        // run once per render call. Nested renders restore the parent's id on exit.
        const previousRenderId = frame.beginRender();
        if (inspector) inspector.perf.start('render');

        const renderTarget = this.renderTarget;
        const mrt = this.mrt;

        if (mrt && renderTarget) {
            mrt.resolveOutputs((name: string) => renderTarget.getTextureIndex(name));
        }

        // The top-level render() owns the frame's command stream; nested renders (PassNode) reuse it.
        // _renderCallDepth was incremented above, so depth 1 is the top-level call. beginFrame/endFrame
        // create+submit the encoder; nested renders skip them and record into the same stream.
        const isTopLevel = this._renderCallDepth === 1;
        if (isTopLevel) this._currentEncoder = this.device.createCommandEncoder();

        const samples = renderTarget?.samples ?? this.samples;
        const primaryColorFormat = renderTarget?.textures[0]?.format ?? this.format;
        const width = renderTarget ? renderTarget.width : this.domElement.width || 1;
        const height = renderTarget ? renderTarget.height : this.domElement.height || 1;
        const [cr, cg, cb, ca] = this.clearColor;

        if (inspector) {
            inspector.beginRenderScene(passId, scene, samples, primaryColorFormat, frame.frameId);
            inspector.beginRender(passId, frame.frameId);
        }

        frame.renderer = this;
        frame.camera = camera;
        frame.scene = scene;
        frame.width = width;
        frame.height = height;

        // Advance the per-render geometry call id (dedupes per-render geometry uploads).
        Geometries.incrementCallId(this.geometries);

        const passCtx = RenderContext.getRenderContext(this._renderContexts, renderTarget, mrt, 0);
        passCtx.sampleCount = samples;
        passCtx.width = width;
        passCtx.height = height;
        passCtx.camera = camera;
        passCtx.clearColorValue = { r: cr, g: cg, b: cb, a: ca };
        // Render targets set stencil from their depth format in getRenderContext; the swapchain's is the renderer flag.
        if (!renderTarget) passCtx.stencil = this.stencil;
        ops.resolveViewportScissor(this, passCtx);

        // Recreate depth/MSAA textures if the canvas was resized externally (bypassing setSize).
        // Only the default framebuffer (swapchain) path resizes here; render targets own their size.
        if (!renderTarget) this._resize(width, height);

        // Validation scope wraps the device work (prepare + pass): pipeline/bind-group creation and the
        // draw calls. Prepare may nest (PassNode.updateBefore renders into the same command stream).
        this.device.pushErrorScope('validation');

        const preparedObjects = ops.prepareRenderObjects(
            this,
            scene,
            camera,
            passCtx,
            passId,
            this.overrideMaterial,
            (nodes, renderObject) =>
                Prepare.prepareRenderObject(
                    this.device,
                    this.geometries,
                    this.bindings,
                    this.pipelines,
                    this.buffers,
                    this.renderObjectGpu,
                    nodes,
                    renderObject,
                ),
        );

        const passParams: RenderPassParams = {
            renderTarget,
            clearColor: { r: cr, g: cg, b: cb, a: ca },
            autoClear: this.autoClear,
            autoClearStencil: this.autoClearStencil,
            clearStencilValue: this.clearStencilValue,
            swapchainStencil: this.stencil,
            passId,
        };
        RenderPass.executeRenderPass(
            this.canvasContexts,
            this.device,
            this.bindings,
            this.geometries,
            this.buffers,
            this.textures,
            this.renderObjectGpu,
            this.swapchain,
            this.format,
            this._currentEncoder!,
            this._nodes,
            passCtx,
            preparedObjects,
            passParams,
            inspector,
        );

        if (isTopLevel) {
            this.device.queue.submit([this._currentEncoder!.finish()]);
            this._currentEncoder = null;
        }

        this.device.popErrorScope().then((err) => {
            const msg = err ? err.message : null;
            if (msg) console.error('[WebGPU render validation error]', msg);
        });

        if (inspector) inspector.perf.end('render');

        // Restore previous renderId only for nested renders. Top-level keeps its fresh value.
        this._renderCallDepth--;
        if (this._renderCallDepth > 0) {
            frame.endRender(previousRenderId);
        } else if (inspector) {
            // Top-level call complete (encoder already submitted): close the inspector frame.
            inspector.finish(frame.frameId);
        }
    }

    /**
     * Dispose the renderer and release all GPU resources.
     *
     * Destroys all cached GPU buffers, textures, pipelines, and the device
     * itself (unless a pre-created device was provided). After calling dispose(),
     * the renderer cannot be used again.
     */
    dispose(): void {
        // Drop render object caches. No need to call disposeRenderObject on each
        // one, device.destroy() invalidates all GPU resources, and the individual
        // onDispose callbacks just do WeakMap/Set bookkeeping we're about to clear.
        this._renderObjects.renderObjects.clear();
        this._renderObjects.passCaches.clear();

        // Clear neutral render-loop caches owned by the renderer.
        this._renderContexts.contexts.clear();
        this._nodes.computeStates.clear();

        // Release all device resources: unconfigure the canvas context, then destroy swapchain
        // textures, caches, and the device (unless pre-created).
        RenderPass.disposeDevice(
            this.canvasContexts,
            this.device,
            this._deviceProvided,
            this.textures,
            this.pipelines,
            this.bindGroupLayoutCache,
            this.swapchain,
        );

        // Dispose the canvas target (device-side context already released above).
        if (this._canvasTarget) this._canvasTarget.dispose();

        this._initialized = false;
        this._isDeviceLost = true;
    }
}

/** Information about a device lost event. Re-exported from the neutral render-loop core. */
export type { DeviceLostInfo };
