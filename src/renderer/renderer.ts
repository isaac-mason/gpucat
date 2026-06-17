import { Camera } from '../camera/camera';
import { getIndexFormat, type GpuBuffer } from '../core/gpu-buffer';
import { GpuTexture } from '../core/gpu-texture';
import { Object3D } from '../core/object3d';
import type { RenderTarget } from '../core/render-target';
import { CubeRenderTarget } from '../core/cube-render-target';
import { InspectorBase } from '../inspector/inspector-base';
import type { Material } from '../material/material';
import { ComputeNode, MRTNode } from '../nodes/nodes';
import * as d from '../schema/schema';
import { Scene } from '../scene/scene';
import { yieldToMain } from '../utils/yield-to-main';
import * as Bindings from './bindings';
import * as Buffers from './buffers';
import { CanvasTarget } from './canvas-target';
import * as Geometries from './geometries';
import { GPUFeatureName } from './gpu-constants';
import * as NodeManager from './node-manager';
import * as RenderContext from './pass-context';
import * as Pipelines from './pipelines';
import { DEPTH_FORMAT } from './pipelines';
import type { RenderItem } from './render-list';
import * as RenderLists from './render-list';
import type { RenderObject } from './render-object';
import * as RenderObjects from './render-objects';
import * as Textures from './textures';
import { disposeMipmapState } from './mipmap-utils';

/**
 * Storage formats whose mips can be auto-generated. Render-pass mip generation samples
 * the prior level through a filtering sampler, so only filterable renderable formats qualify
 * (8-bit unorm + 16-bit float). Integer and 32-bit-float storage formats are excluded.
 */
const FILTERABLE_STORAGE_FORMATS = new Set<string>([
    'rgba8unorm', 'rgba8snorm', 'bgra8unorm', 'rgba16float',
]);
function isFilterableStorageFormat(format: string): boolean {
    return FILTERABLE_STORAGE_FORMATS.has(format);
}

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

export class WebGPURenderer {
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
        this._inspector?.setRenderer(null);   // detach signal, old disposes
        this._inspector = next;
        next?.setRenderer(this);              // attach signal, new sets up
    }

    /** The canvas dom element for the current canvas target. Throws in headless mode. */
    get domElement(): HTMLCanvasElement {
        if (!this._canvasTarget) {
            throw new Error('[WebGPURenderer] no canvas: renderer was created in headless mode. Render to a RenderTarget instead.');
        }
        return this._canvasTarget.domElement;
    }

    /** The WebGPU GPU adapter in use. */
    _adapter: GPUAdapter = null!;

    /** The WebGPU GPU device in use. */
    _device: GPUDevice = null!;

    /** The WebGPU texture format used for the swapchain. */
    _format: GPUTextureFormat = null!;

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
    onDeviceLost: ((info: DeviceLostInfo) => void) | null = null;

    /** swapchain depth texture (recreated on resize) */
    _depthTexture: GPUTexture = null!;
    /** Cached view of `_depthTexture` (recreated alongside the texture, not per frame). */
    _depthTextureView: GPUTextureView = null!;

    /** MSAA color texture (null when samples <= 1). Only used for swapchain passes */
    _msaaTexture: GPUTexture | null = null;
    /** Cached view of `_msaaTexture` (recreated alongside the texture, not per frame). */
    _msaaTextureView: GPUTextureView | null = null;

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
    _renderCallDepth: number = 0;

    /** clear color for the final swapchain composite pass. defaults to opaque black. */
    clearColor: [number, number, number, number] = [0, 0, 0, 1];

    /** current MRT configuration. when set, materials using mrt() nodes write to multiple color attachments. */
    mrt: MRTNode | null = null;

    /** current render target. when set, render() renders to this target instead of the swapchain. */
    renderTarget: RenderTarget | null = null;

    /** when set, all meshes in the scene render with this material instead of their own. */
    overrideMaterial: Material | null = null;

    /** @internal current canvas target. the inspector viewer swaps this for preview renders. null in headless mode. */
    private _canvasTarget: CanvasTarget | null = null;

    /** swap the active canvas target (used by inspector viewer for preview renders). */
    setCanvasTarget(canvasTarget: CanvasTarget | null): this {
        this._canvasTarget = canvasTarget;
        return this;
    }

    getCanvasTarget(): CanvasTarget | null {
        return this._canvasTarget;
    }

    /** @internal Pre-created device (for device sharing or testing) */
    private _preDevice?: GPUDevice;
    /** @internal Pre-created adapter */
    private _preAdapter?: GPUAdapter;
    /** @internal Pre-specified format */
    private _preFormat?: GPUTextureFormat;

    constructor(opts: WebGPURendererOptions = {}) {
        let samples = 0;
        if (opts.samples !== undefined) {
            samples = opts.samples <= 1 ? 0 : opts.samples;
        } else if (opts.antialias) {
            samples = 4;
        }
        this.samples = samples;
        this._adapterOptions = opts.adapterOptions;
        this._deviceDescriptor = opts.deviceDescriptor;
        this._preDevice = opts.device;
        this._preAdapter = opts.adapter;
        this._preFormat = opts.format;

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
        }

        this._renderContexts = RenderContext.createRenderContextsState();
        this._computeContext = RenderContext.createComputeContext();
        this._nodes = NodeManager.createNodeManagerState();
        this._renderLists = RenderLists.createRenderListsState();
        this._bindings = Bindings.createBindingsState();
        this._pipelines = Pipelines.createPipelinesState();
        this._renderObjects = RenderObjects.createRenderObjectsState();
        this._buffers = Buffers.createBufferCache();
        this._textures = Textures.createTextureCache();
        this._geometries = Geometries.createGeometriesState();
    }

    /**
     * Initialise the WebGPU adapter, device, and canvas context.
     * Must be called (and awaited) before the first call to pipeline.render().
     *
     * @throws if WebGPU is not available or no suitable adapter is found.
     */
    async init(): Promise<this> {
        if (this._initialized) return this;

        // use pre-created device if provided, otherwise use navigator.gpu
        if (this._preDevice) {
            this._device = this._preDevice;
            this._adapter = this._preAdapter!;
            this._format = this._preFormat ?? 'bgra8unorm';
        } else {
            // check for WebGPU support
            if (!navigator.gpu) {
                throw new Error('[WebGPURenderer] WebGPU is not supported in this environment.');
            }

            // request adapter
            const adapter = await navigator.gpu.requestAdapter(this._adapterOptions);

            if (!adapter) {
                throw new Error('[WebGPURenderer] No WebGPU adapter found. Is WebGPU enabled?');
            }

            this._adapter = adapter;

            // request every feature the adapter supports
            const requiredFeatures = Object.values(GPUFeatureName).filter((f) => adapter.features.has(f)) as GPUFeatureName[];

            // merge with any caller-supplied descriptor, deduplicating features.
            const callerFeatures = this._deviceDescriptor?.requiredFeatures ?? [];
            const mergedFeatures = [...new Set([...requiredFeatures, ...callerFeatures])] as GPUFeatureName[];
            const deviceDescriptor: GPUDeviceDescriptor = {
                ...this._deviceDescriptor,
                requiredFeatures: mergedFeatures,
            };

            this._device = await adapter.requestDevice(deviceDescriptor);

            // set up device lost handler
            this._device.lost.then((info) => {
                // ignore intentional device destruction
                if (info.reason === 'destroyed') return;

                const deviceLossInfo: DeviceLostInfo = {
                    api: 'WebGPU',
                    message: info.message || 'Unknown reason',
                    reason: info.reason || null,
                    originalEvent: info,
                };

                console.error(
                    `[WebGPURenderer] WebGPU Device Lost:\n` +
                        `  Message: ${deviceLossInfo.message}\n` +
                        `  Reason: ${deviceLossInfo.reason ?? 'unknown'}`,
                );

                this._isDeviceLost = true;
                this.onDeviceLost?.(deviceLossInfo);
            });

            // initialize the main canvas target context.
            this._format = navigator.gpu.getPreferredCanvasFormat();
            this._canvasTarget!.getContext(this._device, this._format);
        }

        // Publish the swapchain formats to the pipelines layer so the fallback path
        // (renderTarget === null) builds pipelines with the right attachment formats.
        this._pipelines.canvasFormat = this._format;
        this._pipelines.canvasDepthFormat = DEPTH_FORMAT;

        // Swapchain depth/msaa textures are only needed when rendering to a canvas.
        // In headless mode the RenderTarget owns its own depth/msaa.
        if (this._canvasTarget) {
            const w = this.domElement.width || 1;
            const h = this.domElement.height || 1;
            this._recreateSwapchainTextures(w, h);
        }

        this._initialized = true;
        return this;
    }

    /** recreate depth/msaa textures after a resize. */
    private _onResize(width: number, height: number): void {
        this._recreateSwapchainTextures(width, height);
    }

    /**
     * (Re)create the swapchain depth and (optional) MSAA textures and cache their
     * views. The views are stable until the next resize, so attachment resolution
     * reuses them rather than calling createView() every frame.
     */
    private _recreateSwapchainTextures(width: number, height: number): void {
        const sampleCount = this.samples > 1 ? this.samples : 1;

        this._depthTexture?.destroy();
        this._depthTexture = Textures.createSwapchainDepthTexture(this._device, width, height, sampleCount);
        this._depthTextureView = this._depthTexture.createView();

        if (this.samples > 1) {
            this._msaaTexture?.destroy();
            this._msaaTexture = Textures.createSwapchainMsaaTexture(this._device, width, height, this._format, this.samples);
            this._msaaTextureView = this._msaaTexture.createView();
        }
    }

    /** set the device pixel ratio. call before setSize(). Throws in headless mode. */
    setPixelRatio(value: number): void {
        if (!this._canvasTarget) {
            throw new Error('[WebGPURenderer] setPixelRatio is not available in headless mode.');
        }
        this._canvasTarget.setPixelRatio(value);
    }

    /** resize the canvas to logical pixel dimensions (physical = logical * pixelRatio). Throws in headless mode. */
    setSize(width: number, height: number, updateStyle: boolean = true): void {
        if (!this._canvasTarget) {
            throw new Error('[WebGPURenderer] setSize is not available in headless mode. Resize the RenderTarget instead.');
        }
        this._canvasTarget.setSize(width, height, updateStyle);

        if (!this._initialized) return;

        const { width: pw, height: ph } = this._canvasTarget.getDrawingBufferSize();
        this._onResize(pw, ph);
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
        return this._device?.features?.has(feature) ?? false;
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

        // use new RenderLists system to collect visible meshes
        const renderList = RenderLists.collectRenderList(this._renderLists, scene, camera);
        const allItems = [...renderList.opaque, ...renderList.transparent];

        if (allItems.length === 0) return;

        // create a temporary RenderContext for compilation
        // this is needed because RenderObjects are cached by (mesh, material, renderContext)
        const compileContext = RenderContext.getRenderContext(this._renderContexts, null, null, 0);
        compileContext.sampleCount = resolvedSamples;
        compileContext.width = this.domElement.width || 1;
        compileContext.height = this.domElement.height || 1;

        const width = compileContext.width;
        const height = compileContext.height;

        // phase 1: Kick off all async pipeline compilations in parallel
        const initPromises: Promise<void>[] = [];

        for (const item of allItems) {
            if (!item.mesh || !item.material || !item.geometry) continue;

            // get or create RenderObject
            const renderObject = RenderObjects.getRenderObject(
                this._renderObjects,
                item.mesh,
                item.material,
                scene,
                camera,
                compileContext,
                'compile',
            );

            // kick off async initialization (compiles shader, creates pipeline)
            const pipelinePromises: Promise<void>[] = [];
            RenderObjects.initRenderObjectWithPromises(
                this._nodes,
                this._geometries,
                this._bindings,
                this._pipelines,
                this._device,
                this._buffers,
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

            // get the existing RenderObject (already created and initialized above)
            const renderObject = RenderObjects.getRenderObject(
                this._renderObjects,
                mesh,
                item.material,
                scene,
                camera,
                compileContext,
                'compile',
            );

            const nodeState = renderObject.nodeBuilderState;

            if (nodeState) {
                // upload storage buffers
                for (const s of nodeState.storage) {
                    const buffer = Buffers.resolveStorageBuffer(s.node, geometry, null);
                    Buffers.ensureUploaded(this._buffers, this._device, buffer);
                }

                // upload vertex buffers
                for (const attrEntry of nodeState.attributes) {
                    if (attrEntry.kind === 'geometry') {
                        const bufAttr = geometry.buffers.get(attrEntry.name!);
                        if (bufAttr) {
                            Buffers.ensureUploaded(this._buffers, this._device, bufAttr);
                        }
                    } else {
                        const gpuBuffer = attrEntry.node.buffer;
                        if (!gpuBuffer) {
                            throw new Error(`[gpucat] AttributeNode has no buffer for ${attrEntry.shaderName}`);
                        }
                        const arr = gpuBuffer.array;
                        if (arr) {
                            Buffers.uploadRaw(
                                this._buffers,
                                this._device,
                                attrEntry.node,
                                arr,
                                GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                            );
                        }
                    }
                }

                // upload index buffer if present
                if (geometry.index) {
                    Buffers.ensureUploaded(this._buffers, this._device, geometry.index);
                }
            }

            // upload uniforms and rebuild bind groups
            // (must be after texture upload so bind groups can reference GPU resources)
            // for pre-warming, we create a temporary frame context
            const preWarmFrame = this._nodes.nodeFrame;
            preWarmFrame.renderer = this;
            preWarmFrame.camera = camera;
            preWarmFrame.object = renderObject.mesh;
            preWarmFrame.scene = renderObject.scene;
            preWarmFrame.material = renderObject.material;
            preWarmFrame.width = width;
            preWarmFrame.height = height;
            RenderObjects.updateRenderObject(
                this._bindings,
                this._geometries,
                this._device,
                this._buffers,
                this._textures,
                renderObject,
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
        Pipelines.getForCompute(this._pipelines, this._device, this._nodes, computeNode, this._computeContext, promises);
        await Promise.all(promises);
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
        frame.width = this.domElement.width || 1;
        frame.height = this.domElement.height || 1;

        if (inspector) inspector.perf.start('compute');

        const encoder = this._device.createCommandEncoder();

        // Storage textures written this batch that want their mips regenerated after submit.
        const mipDirty = new Set<GpuTexture<d.StorageTexture>>();

        for (const entry of entries) {
            const { node } = entry;
            const pipelineEntry = Pipelines.getForCompute(this._pipelines, this._device, this._nodes, node, this._computeContext);
            const { nodeBuilderState } = pipelineEntry;
            const buffers = entry.buffers ?? null;

            // Track written storage textures (with mips + auto-update) for post-submit mip regen.
            for (const bg of nodeBuilderState.bindings) {
                for (const b of bg.bindings) {
                    if (b.kind !== 'storageTexture' || b.entry.access === 'read') continue;
                    const tex = b.entry.node.value;
                    if (tex && tex.mipmapsAutoUpdate && tex.mipLevelCount > 1) mipDirty.add(tex);
                }
            }

            if (inspector) {
                inspector.perf.start(`compute: ${node.id}`);
                inspector.perf.start('updateForCompute');
            }
            // Update node uniforms
            NodeManager.updateForCompute(this._nodes, node);
            if (inspector) inspector.perf.end('updateForCompute');

            // Update all bindings and get GPUBindGroups
            const gpuBindGroups = Bindings.updateComputeBindings(
                this._bindings,
                nodeBuilderState,
                frame,
                this._device,
                this._buffers,
                this._textures,
                buffers,
            );

            // Notify inspector before creating pass (so timestamp writes are available)
            let timestampWrites: GPUComputePassTimestampWrites | undefined;
            if (inspector) {
                inspector.beginCompute(node, frame.frameId);
                timestampWrites = inspector.getTimestampWrites(node.id);
            }

            const computePass = encoder.beginComputePass({ timestampWrites });
            computePass.setPipeline(pipelineEntry.pipeline!);

            for (let i = 0; i < gpuBindGroups.length; i++) {
                computePass.setBindGroup(i, gpuBindGroups[i]);
            }

            if (entry.indirect) {
                const gpuBuf = Buffers.ensureUploaded(this._buffers, this._device, entry.indirect);
                computeDispatchWorkgroupsIndirect(computePass, inspector, gpuBuf, entry.indirectOffset ?? 0);
            } else {
                const [dx, dy, dz] = entry.dispatch;
                computeDispatchWorkgroups(computePass, inspector, dx, dy, dz);
            }

            computePass.end();
            if (inspector) {
                inspector.finishCompute(node.id, frame.frameId);
                inspector.perf.end(`compute: ${node.id}`);
            }
        }

        this._device.queue.submit([encoder.finish()]);

        // Regenerate mips for written storage textures so a later render pass can sample
        // them mipmapped. Render-pass mip-gen samples through a filtering sampler, so only
        // filterable renderable formats are supported (others would need a compute downsample).
        for (const tex of mipDirty) {
            if (isFilterableStorageFormat(tex.format)) {
                Textures.generateTextureMipmaps(this._textures, this._device, tex as unknown as GpuTexture);
            } else {
                console.warn(
                    `[WebGPURenderer] mipmapsAutoUpdate skipped: storage format '${tex.format}' is not ` +
                    `filterable, so render-pass mip generation can't sample it. Set mipmapsAutoUpdate=false ` +
                    `and generate mips manually, or use a filterable format (rgba8unorm/rgba16float).`,
                );
            }
        }

        if (inspector) inspector.perf.end('compute');

        // Top-level call complete (encoder submitted): close the inspector frame.
        this._renderCallDepth--;
        if (this._renderCallDepth === 0 && inspector) inspector.finish(frame.frameId);
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
     * Render a scene from a camera's perspective.
     * Renders to `this.renderTarget` if set, otherwise to the swapchain.
     */
    render(scene: Object3D, camera: Camera, commandEncoder?: GPUCommandEncoder, passId = 'render'): void {
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

        const ownEncoder = !commandEncoder;
        const encoder = commandEncoder ?? this._device.createCommandEncoder();

        const samples = renderTarget?.samples ?? this.samples;
        const primaryColorFormat = renderTarget?.textures[0]?.format ?? this._format;
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
        frame.encoder = encoder;
        frame.width = width;
        frame.height = height;

        Geometries.incrementCallId(this._geometries);

        const passCtx = RenderContext.getRenderContext(this._renderContexts, renderTarget, mrt, 0);
        passCtx.sampleCount = samples;
        passCtx.width = width;
        passCtx.height = height;
        passCtx.camera = camera;
        passCtx.clearColorValue = { r: cr, g: cg, b: cb, a: ca };

        // Recreate depth/MSAA textures if the canvas was resized externally (bypassing setSize).
        if (!renderTarget && (this._depthTexture.width !== width || this._depthTexture.height !== height)) {
            this._onResize(width, height);
        }

        const clearColor = { r: cr, g: cg, b: cb, a: ca };
        const { colorAttachments, depthAttachment } = this._render_resolve(renderTarget, clearColor);

        this._device.pushErrorScope('validation');

        const preparedObjects = this._render_prepare(
            scene,
            camera,
            passCtx,
            passId,
            this.overrideMaterial,
        );

        this._render_draw(encoder, preparedObjects, colorAttachments, depthAttachment, passId);

        if (ownEncoder) {
            this._device.queue.submit([encoder.finish()]);
        }

        this._device.popErrorScope().then((err) => {
            if (err) console.error('[WebGPU render validation error]', err.message);
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

    /** Build GPU color and depth attachments, dispatching on the target kind. */
    private _render_resolve(
        renderTarget: RenderTarget | null,
        clearColor: GPUColorDict,
    ): {
        colorAttachments: GPURenderPassColorAttachment[];
        depthAttachment: GPURenderPassDepthStencilAttachment | undefined;
    } {
        if (renderTarget?.isCubeRenderTarget) return this._resolveCubeAttachments(renderTarget as CubeRenderTarget, clearColor);
        if (renderTarget) return this._resolveRenderTargetAttachments(renderTarget, clearColor);
        return this._resolveSwapchainAttachments(clearColor);
    }

    /** Attachments for a 2D render target (one color per attachment, MRT supported). */
    private _resolveRenderTargetAttachments(
        renderTarget: RenderTarget,
        clearColor: GPUColorDict,
    ): {
        colorAttachments: GPURenderPassColorAttachment[];
        depthAttachment: GPURenderPassDepthStencilAttachment | undefined;
    } {
        Textures.ensureRenderTargetTexturesAllocated(this._textures, this._device, renderTarget);

        const colorAttachments: GPURenderPassColorAttachment[] = [];
        for (const tex of renderTarget.textures) {
            const textureData = Textures.getTextureData(this._textures, tex._gpuTexture);
            if (!textureData) {
                throw new Error('[WebGPURenderer] Render target texture not found in cache');
            }
            // MSAA: render into the multisampled texture and resolve into the sampled
            // single-sample texture. Otherwise render directly into the single texture.
            const msaaView = Textures.getRenderTargetMsaaView(textureData);
            colorAttachments.push(msaaView
                ? {
                    view: msaaView,
                    resolveTarget: Textures.getRenderTargetView(textureData),
                    clearValue: clearColor,
                    loadOp: 'clear',
                    storeOp: 'store',
                }
                : {
                    view: Textures.getRenderTargetView(textureData),
                    clearValue: clearColor,
                    loadOp: 'clear',
                    storeOp: 'store',
                });
        }

        let depthAttachment: GPURenderPassDepthStencilAttachment | undefined;
        if (renderTarget.depthTexture) {
            const depthTextureData = Textures.getTextureData(this._textures, renderTarget.depthTexture._gpuTexture);
            if (depthTextureData) {
                depthAttachment = {
                    view: Textures.getRenderTargetView(depthTextureData),
                    depthClearValue: 1.0,
                    depthLoadOp: 'clear',
                    depthStoreOp: 'store',
                };
            }
        }

        return { colorAttachments, depthAttachment };
    }

    /** Attachments for the swapchain (canvas), resolving MSAA when enabled. */
    private _resolveSwapchainAttachments(
        clearColor: GPUColorDict,
    ): {
        colorAttachments: GPURenderPassColorAttachment[];
        depthAttachment: GPURenderPassDepthStencilAttachment | undefined;
    } {
        const ctx = this._canvasTarget!.getContext(this._device, this._format);
        const swapchainView = ctx.getCurrentTexture().createView();

        const colorAttachments: GPURenderPassColorAttachment[] = [];
        if (this.samples > 1 && this._msaaTextureView) {
            colorAttachments.push({
                view: this._msaaTextureView,
                resolveTarget: swapchainView,
                clearValue: clearColor,
                loadOp: 'clear',
                storeOp: 'discard',
            });
        } else {
            colorAttachments.push({
                view: swapchainView,
                clearValue: clearColor,
                loadOp: 'clear',
                storeOp: 'store',
            });
        }

        return {
            colorAttachments,
            depthAttachment: {
                view: this._depthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        };
    }

    /** Collect visible meshes, init render objects, and run updateBefore (may trigger nested renders). */
    private _render_prepare(
        scene: Object3D,
        camera: Camera,
        passCtx: RenderContext.RenderContext,
        passId: string,
        overrideMaterial: Material | null,
    ): PreparedRenderObject[] {
        const inspector = this.inspector;
        if (inspector) inspector.perf.start('collectRenderList');
        const renderList = RenderLists.collectRenderList(this._renderLists, scene, camera, overrideMaterial);
        if (inspector) inspector.perf.end('collectRenderList');

        const preparedObjects: PreparedRenderObject[] = [];

        for (const items of [renderList.opaque, renderList.transparent]) {
            for (const item of items) {
                if (!item.mesh || !item.material || !item.geometry) continue;

                const renderObject = RenderObjects.getRenderObject(
                    this._renderObjects,
                    item.mesh,
                    item.material,
                    scene,
                    camera,
                    passCtx,
                    passId,
                );

                const initialized = RenderObjects.initRenderObject(
                    this._nodes,
                    this._geometries,
                    this._bindings,
                    this._pipelines,
                    this._device,
                    this._buffers,
                    renderObject,
                );
                if (!initialized || !renderObject.pipeline) {
                    console.warn('[gpucat] initRenderObject failed or pipeline missing', {
                        initialized,
                        pipeline: renderObject.pipeline,
                    });
                    continue;
                }

                if (!renderObject.nodeBuilderState) {
                    console.warn('[gpucat] no nodeBuilderState');
                    continue;
                }

                if (inspector) inspector.perf.start('updateBefore');
                NodeManager.updateBefore(this._nodes, renderObject);
                if (inspector) inspector.perf.end('updateBefore');

                preparedObjects.push({ renderObject, item });
            }
        }

        return preparedObjects;
    }

    /** Begin the GPU render pass, issue all draw calls, and end the pass. */
    private _render_draw(
        encoder: GPUCommandEncoder,
        preparedObjects: PreparedRenderObject[],
        colorAttachments: GPURenderPassColorAttachment[],
        depthAttachment: GPURenderPassDepthStencilAttachment | undefined,
        passId: string,
    ): void {
        const inspector = this.inspector;
        const timestampWrites = inspector ? inspector.getTimestampWrites(passId) : undefined;
        const gpuPass = encoder.beginRenderPass({
            colorAttachments,
            depthStencilAttachment: depthAttachment,
            timestampWrites,
        });

        const currentSets: CurrentSets = {
            bindingGroups: [],
            attributes: [],
            index: null,
            pipeline: null,
        };

        if (inspector) inspector.perf.start('drawCalls');

        for (const { renderObject, item } of preparedObjects) {
            const mesh = item.mesh!;
            const material = item.material!;
            const geometry = item.geometry!;
            const nodeState = renderObject.nodeBuilderState!;

            if (mesh.count === 0) continue;

            const frame = this._nodes.nodeFrame;
            frame.object = mesh;
            frame.material = material;
            frame.camera = renderObject.camera;
            frame.scene = renderObject.scene;

            NodeManager.updateForRender(this._nodes, renderObject);

            if (inspector) inspector.perf.start('updateForRender');
            RenderObjects.updateRenderObject(
                this._bindings,
                this._geometries,
                this._device,
                this._buffers,
                this._textures,
                renderObject,
                frame,
            );
            if (inspector) inspector.perf.end('updateForRender');

            if (renderObject.pipeline !== currentSets.pipeline) {
                passSetPipeline(gpuPass, inspector, renderObject.pipeline!, mesh.name || material.constructor.name);
                currentSets.pipeline = renderObject.pipeline;
            }

            const bindGroups = renderObject.bindGroups;
            const logicalBindGroups = renderObject._bindings;
            if (bindGroups && logicalBindGroups) {
                for (let i = 0; i < bindGroups.length; i++) {
                    const bindGroupId = logicalBindGroups[i]?.id ?? -1;
                    if (currentSets.bindingGroups[i] !== bindGroupId) {
                        passSetBindGroup(gpuPass, inspector, i, bindGroups[i], mesh.name || '');
                        currentSets.bindingGroups[i] = bindGroupId;
                    }
                }
            }

            let slot = 0;
            for (const group of nodeState.vertexBufferGroups) {
                let gpuBuf: GPUBuffer;
                if (group.name !== null) {
                    // Geometry-based group - resolve buffer by name
                    const bufAttr = geometry.buffers.get(group.name);
                    if (!bufAttr) {
                        slot++;
                        continue;
                    }
                    gpuBuf = Buffers.ensureUploaded(this._buffers, this._device, bufAttr);
                } else {
                    // Direct buffer group
                    const gpuBuffer = group.buffer;
                    if (!gpuBuffer) {
                        throw new Error(`[gpucat] VertexBufferGroup has no buffer`);
                    }
                    const arr = gpuBuffer.array;
                    if (!arr) {
                        throw new Error(`[gpucat] VertexBufferGroup buffer array is null`);
                    }
                    gpuBuf = Buffers.uploadRaw(
                        this._buffers,
                        this._device,
                        gpuBuffer,
                        arr,
                        GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                    ).buffer;
                }
                if (currentSets.attributes[slot] !== gpuBuf) {
                    passSetVertexBuffer(gpuPass, inspector, slot, gpuBuf);
                    currentSets.attributes[slot] = gpuBuf;
                }
                slot++;
            }

            if (geometry.index) {
                const idxBuf = Buffers.ensureUploaded(this._buffers, this._device, geometry.index);
                if (currentSets.index !== idxBuf) {
                    passSetIndexBuffer(gpuPass, inspector, idxBuf, getIndexFormat(geometry.index.array)!);
                    currentSets.index = idxBuf;
                }
                if (geometry.indirect) {
                    const indirect = geometry.indirect;
                    const indBuf = Buffers.ensureUploaded(this._buffers, this._device, indirect);
                    const byteStride = indirect.itemSize * 4;
                    const baseOffset = geometry.indirectOffset;
                    const drawCount = geometry.indirectDrawCount ?? indirect.count;
                    for (let d = 0; d < drawCount; d++) {
                        passDrawIndexedIndirect(gpuPass, inspector, indBuf, baseOffset + d * byteStride);
                    }
                } else {
                    const indexCount = Math.min(geometry.drawRange.count, geometry.index.array!.length);
                    passDrawIndexed(gpuPass, inspector, indexCount, mesh.count, geometry.drawRange.start);
                }
            } else {
                if (geometry.indirect) {
                    const indirect = geometry.indirect;
                    const indBuf = Buffers.ensureUploaded(this._buffers, this._device, indirect);
                    const byteStride = indirect.itemSize * 4;
                    const baseOffset = geometry.indirectOffset;
                    const drawCount = geometry.indirectDrawCount ?? indirect.count;
                    for (let d = 0; d < drawCount; d++) {
                        passDrawIndirect(gpuPass, inspector, indBuf, baseOffset + d * byteStride);
                    }
                } else {
                    passDraw(gpuPass, inspector, geometry.drawRange.count, mesh.count, geometry.drawRange.start);
                }
            }

            if (inspector) inspector.perf.start('updateAfter');
            NodeManager.updateAfter(this._nodes, renderObject);
            if (inspector) inspector.perf.end('updateAfter');
        }

        if (inspector) inspector.perf.end('drawCalls');

        gpuPass.end();
        if (inspector) inspector.finishRender(passId, this._nodes.nodeFrame.frameId);
    }

    /** Build the color/depth attachments for a cube render target's active face. */
    private _resolveCubeAttachments(
        renderTarget: CubeRenderTarget,
        clearColor: GPUColorDict,
    ): {
        colorAttachments: GPURenderPassColorAttachment[];
        depthAttachment: GPURenderPassDepthStencilAttachment | undefined;
    } {
        Textures.ensureRenderTargetTexturesAllocated(this._textures, this._device, renderTarget);

        const cubeData = Textures.getTextureData(this._textures, renderTarget.texture._gpuTexture);
        if (!cubeData) {
            throw new Error('[WebGPURenderer] Cube render target texture not found in cache');
        }

        // A 2D view of the single selected face (layer) of the cube texture.
        const colorAttachments: GPURenderPassColorAttachment[] = [{
            view: cubeData.texture.createView({
                dimension: '2d',
                baseArrayLayer: renderTarget.activeFace,
                arrayLayerCount: 1,
                baseMipLevel: renderTarget.activeMipmapLevel,
                mipLevelCount: 1,
            }),
            clearValue: clearColor,
            loadOp: 'clear',
            storeOp: 'store',
        }];

        let depthAttachment: GPURenderPassDepthStencilAttachment | undefined;
        if (renderTarget.depthTexture) {
            const depthData = Textures.getTextureData(this._textures, renderTarget.depthTexture._gpuTexture);
            if (depthData) {
                depthAttachment = {
                    view: Textures.getRenderTargetView(depthData),
                    depthClearValue: 1.0,
                    depthLoadOp: 'clear',
                    depthStoreOp: 'store',
                };
            }
        }

        return { colorAttachments, depthAttachment };
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
        // onDispose callbacks just do ChainMap/Set bookkeeping we're about to clear.
        this._renderObjects.renderObjects.clear();
        this._renderObjects.chainMaps.clear();

        // Destroy swapchain textures
        this._depthTexture?.destroy();
        this._msaaTexture?.destroy();

        // Destroy default placeholder textures
        for (const tex of this._textures.defaultTextures.values()) {
            tex.destroy();
        }
        this._textures.defaultTextures.clear();
        this._textures.samplerCache.clear();

        // Dispose mipmap generation state
        if (this._textures.mipmapState) {
            disposeMipmapState(this._textures.mipmapState);
            this._textures.mipmapState = null;
        }

        // Clear pipeline caches
        this._pipelines.renderPipelines.clear();
        this._pipelines.computePipelines.clear();
        this._pipelines.bindGroupLayoutCache.cache.clear();

        // Clear render context caches
        this._renderContexts.contexts.clear();

        // Clear compute node states
        this._nodes.computeStates.clear();

        // Unconfigure the canvas context
        this._canvasTarget?.dispose();

        // Destroy the device unless it was externally provided
        if (!this._preDevice && this._device) {
            this._device.destroy();
        }

        this._initialized = false;
        this._isDeviceLost = true;
    }
}

type PreparedRenderObject = {
    renderObject: RenderObject;
    item: RenderItem;
};

/** tracks currently set GPU state to avoid redundant setBindGroup/setVertexBuffer/setIndexBuffer calls */
type CurrentSets = {
    bindingGroups: number[];
    attributes: (GPUBuffer | null)[];
    index: GPUBuffer | null;
    pipeline: GPURenderPipeline | null;
};

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

// ---------------------------------------------------------------------------
// Pass-command helpers, issue the real GPU encoder call AND the inspector hook
// in one place so neither renderer.ts call sites nor the inspector interface
// accumulate per-command boilerplate.
// ---------------------------------------------------------------------------

function passSetPipeline(pass: GPURenderPassEncoder, inspector: InspectorBase | null, pipeline: GPURenderPipeline, label: string): void {
    pass.setPipeline(pipeline);
    if (inspector) inspector.setPipeline(label);
}

function passSetBindGroup(
    pass: GPURenderPassEncoder,
    inspector: InspectorBase | null,
    index: number,
    bindGroup: GPUBindGroup,
    label: string,
): void {
    pass.setBindGroup(index, bindGroup);
    if (inspector) inspector.setBindGroup(index, label);
}

function passSetVertexBuffer(pass: GPURenderPassEncoder, inspector: InspectorBase | null, slot: number, buffer: GPUBuffer): void {
    pass.setVertexBuffer(slot, buffer);
    if (inspector) inspector.setVertexBuffer(slot);
}

function passSetIndexBuffer(
    pass: GPURenderPassEncoder,
    inspector: InspectorBase | null,
    buffer: GPUBuffer,
    format: GPUIndexFormat,
): void {
    pass.setIndexBuffer(buffer, format);
    if (inspector) inspector.setIndexBuffer();
}

function passDraw(
    pass: GPURenderPassEncoder,
    inspector: InspectorBase | null,
    vertexCount: number,
    instanceCount: number,
    firstVertex: number,
): void {
    pass.draw(vertexCount, instanceCount, firstVertex);
    if (inspector) inspector.draw(vertexCount, instanceCount);
}

function passDrawIndexed(
    pass: GPURenderPassEncoder,
    inspector: InspectorBase | null,
    indexCount: number,
    instanceCount: number,
    firstIndex: number,
): void {
    pass.drawIndexed(indexCount, instanceCount, firstIndex);
    if (inspector) inspector.drawIndexed(indexCount, instanceCount);
}

function passDrawIndirect(
    pass: GPURenderPassEncoder,
    inspector: InspectorBase | null,
    indirectBuffer: GPUBuffer,
    indirectOffset: number,
): void {
    pass.drawIndirect(indirectBuffer, indirectOffset);
    if (inspector) inspector.drawIndirect();
}

function passDrawIndexedIndirect(
    pass: GPURenderPassEncoder,
    inspector: InspectorBase | null,
    indirectBuffer: GPUBuffer,
    indirectOffset: number,
): void {
    pass.drawIndexedIndirect(indirectBuffer, indirectOffset);
    if (inspector) inspector.drawIndexedIndirect();
}

function computeDispatchWorkgroups(pass: GPUComputePassEncoder, inspector: InspectorBase | null, x: number, y: number, z: number): void {
    pass.dispatchWorkgroups(x, y, z);
    if (inspector) inspector.dispatchWorkgroups(x, y, z);
}

function computeDispatchWorkgroupsIndirect(
    pass: GPUComputePassEncoder,
    inspector: InspectorBase | null,
    indirectBuffer: GPUBuffer,
    offset: number,
): void {
    pass.dispatchWorkgroupsIndirect(indirectBuffer, offset);
    if (inspector) inspector.dispatchWorkgroupsIndirect(indirectBuffer, offset);
}
