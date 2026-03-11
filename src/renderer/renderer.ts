import * as buffers from './buffers';
import * as textures from './textures';
import * as pipelines from './pipelines';
import { getIndexFormat, GpuBuffer as GpuBufferClass, type GpuBuffer } from '../core/buffer';
import {
    ComputeNode,
    MRTNode,
} from '../nodes/nodes';
import * as d from '../nodes/schema';

import * as RenderContext from './pass-context';
import * as geometries from './geometries';
import * as nodeManager from './node-manager';
import * as bindings from './bindings';
import * as renderObjects from './render-objects';
import * as renderLists from './render-list';
import type { RenderItem } from './render-list';

import { Scene } from '../scene/scene';
import { Object3D } from '../core/object3d';
import { Camera } from '../camera/camera';
import { InspectorBase } from '../inspector/inspector-base';
import type { RenderTarget } from '../core/render-target';
import { GPUFeatureName } from './gpu-constants';
import { CanvasTarget } from './canvas-target';
import { yieldToMain } from '../utils/yield-to-main';

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
};

export class WebGPURenderer {
    get domElement(): HTMLCanvasElement {
        return this._canvasTarget.domElement;
    }

    adapter!: GPUAdapter;
    device!: GPUDevice;

    private format!: GPUTextureFormat;

    private _samples: number;
    private _adapterOptions: GPURequestAdapterOptions | undefined;
    private _deviceDescriptor: GPUDeviceDescriptor | undefined;

    /** @internal */
    buffers!: buffers.BufferCache;

    /** @internal */
    textures!: textures.TextureCache;
    
    /** @internal Unified pipeline cache for render and compute pipelines. */
    pipelines!: pipelines.PipelinesState;

    /** Inspector. Replace with a RendererInspector or Inspector instance to enable profiling. */
    inspector: InspectorBase = new InspectorBase();

    /** Whether the renderer has been initialized (adapter/device/context created) or not. */
    private _initialized = false;

    /** Indicates whether the device has been lost or not. When this is set to `true`, rendering isn't possible anymore. */
    private _isDeviceLost = false;

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
    private depthTexture!: GPUTexture;

    /** MSAA color texture (null when samples <= 1). Only used for swapchain passes */
    private msaaTexture: GPUTexture | null = null;

    /** @internal */
    renderContexts!: RenderContext.RenderContextsState;

    /** @internal */
    computeContext!: RenderContext.ComputeContext;

    /** @internal */
    geometries!: geometries.GeometriesState;

    /** @internal */
    nodes!: nodeManager.NodeManagerState;

    /** @internal */
    bindings!: bindings.BindingsState;

    /** @internal */
    renderObjects!: renderObjects.RenderObjectsState;

    /** @internal */
    renderLists!: renderLists.RenderListsState;

    /** clear color for the final swapchain composite pass. defaults to opaque black. */
    clearColor: [number, number, number, number] = [0, 0, 0, 1];

    /** the current MRT configuration. When set, materials using mrt() nodes will write to multiple color attachments. @internal */
    private _mrt: MRTNode | null = null;

    /**
     * Sets the MRT (Multiple Render Targets) configuration.
     * When set, renderScene() will use the MRT node to determine
     * which outputs map to which color attachments.
     *
     * @param mrt - The MRT node, or null to disable MRT.
     * @returns This renderer for chaining.
     */
    setMRT(mrt: MRTNode | null): this {
        this._mrt = mrt;
        return this;
    }

    /**
     * Returns the current MRT configuration.
     *
     * @returns The current MRT node, or null if MRT is disabled.
     */
    getMRT(): MRTNode | null {
        return this._mrt;
    }

    /**
     * The current render target. When set, render() will render to this
     * target instead of the swapchain.
     * @internal
     */
    private _renderTarget: RenderTarget | null = null;

    /**
     * Sets the current render target.
     * When set, subsequent render() calls will render to this target
     * instead of the canvas swapchain.
     *
     * Mirrors Three.js `renderer.setRenderTarget(renderTarget)`.
     *
     * @param renderTarget - The render target, or null to render to the canvas.
     * @returns This renderer for chaining.
     */
    setRenderTarget(renderTarget: RenderTarget | null): this {
        this._renderTarget = renderTarget;
        return this;
    }

    /**
     * Returns the current render target.
     *
     * @returns The current render target, or null if rendering to canvas.
     */
    getRenderTarget(): RenderTarget | null {
        return this._renderTarget;
    }

    /**
     * The current canvas target. Always non-null — initialized in constructor with the main canvas.
     * The inspector viewer swaps this via setCanvasTarget() around each preview render.
     * @internal
     */
    private _canvasTarget!: CanvasTarget;

    /**
     * Bound handler for canvas resize events. Added/removed in setCanvasTarget().
     */
    private _onCanvasTargetResize: (() => void) | null = null;

    /**
     * Sets the current canvas target.
     * Removes the resize listener from the old target, attaches it to the new one.
     *
     * @param canvasTarget - The new canvas target.
     * @returns This renderer for chaining.
     */
    setCanvasTarget(canvasTarget: CanvasTarget): this {
        if (this._canvasTarget === canvasTarget) return this;

        // Remove resize listener from old target
        if (this._onCanvasTargetResize) {
            this._canvasTarget.removeEventListener('resize', this._onCanvasTargetResize);
        }

        this._canvasTarget = canvasTarget;

        // Add resize listener to new target
        if (this._onCanvasTargetResize) {
            this._canvasTarget.addEventListener('resize', this._onCanvasTargetResize);
        }

        return this;
    }

    /**
     * Returns the current canvas target.
     */
    getCanvasTarget(): CanvasTarget {
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
        this._samples = samples;
        this._adapterOptions = opts.adapterOptions;
        this._deviceDescriptor = opts.deviceDescriptor;
        this._preDevice = opts.device;
        this._preAdapter = opts.adapter;
        this._preFormat = opts.format;

        // Create the main canvas and wrap it as the default CanvasTarget.
        // Use provided canvas if given, otherwise create one.
        const canvas = opts.canvas ?? document.createElement('canvas');
        if (!opts.canvas) {
            canvas.style.display = 'block';
        }
        this._canvasTarget = new CanvasTarget(canvas);
        this._canvasTarget.isDefaultCanvasTarget = true;
    }

    get samples(): number {
        return this._samples;
    }

    /**
     * Initialise the WebGPU adapter, device, and canvas context.
     * Must be called (and awaited) before the first call to pipeline.render().
     *
     * @throws if WebGPU is not available or no suitable adapter is found.
     */
    async init(): Promise<this> {
        if (this._initialized) return this;

        // Use pre-created device if provided, otherwise use navigator.gpu
        if (this._preDevice) {
            this.device = this._preDevice;
            this.adapter = this._preAdapter!;
            this.format = this._preFormat ?? 'bgra8unorm';
        } else {
            // Normal mode: use navigator.gpu
            if (!navigator.gpu) {
                throw new Error('[WebGPURenderer] WebGPU is not supported in this environment.');
            }

            const adapter = await navigator.gpu.requestAdapter(this._adapterOptions);
            if (!adapter) {
                throw new Error('[WebGPURenderer] No WebGPU adapter found. Is WebGPU enabled?');
            }
            this.adapter = adapter;

            // Request every feature the adapter supports. This mirrors Three.js's
            // greedy approach: iterate all known GPUFeatureName values, filter to
            // those the adapter advertises, and pass them all into requiredFeatures.
            // This future-proofs the device against new code paths that use features
            // we haven't explicitly listed, and keeps us aligned with the spec as it
            // evolves without needing to update an explicit allowlist here.
            const requiredFeatures = Object.values(GPUFeatureName).filter(
                (f) => adapter.features.has(f),
            ) as GPUFeatureName[];

            // Merge with any caller-supplied descriptor, deduplicating features.
            const callerFeatures = this._deviceDescriptor?.requiredFeatures ?? [];
            const mergedFeatures = [
                ...new Set([...requiredFeatures, ...callerFeatures]),
            ] as GPUFeatureName[];
            const deviceDescriptor: GPUDeviceDescriptor = {
                ...this._deviceDescriptor,
                requiredFeatures: mergedFeatures,
            };

            this.device = await adapter.requestDevice(deviceDescriptor);

            // Set up device lost handler (mirrors Three.js pattern)
            this.device.lost.then((info) => {
                // Ignore intentional device destruction
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

            // Initialize the main canvas target context.
            this.format = navigator.gpu.getPreferredCanvasFormat();
            this._canvasTarget.getContext(this.device, this.format, 'opaque');
        }

        // Set up canvas resize handler.
        this._onCanvasTargetResize = () => {
            const { width, height } = this._canvasTarget.getDrawingBufferSize();
            this._onResize(width, height);
        };
        this._canvasTarget.addEventListener('resize', this._onCanvasTargetResize);

        this.buffers = buffers.createBufferCache(this.device);
        this.textures = textures.createTextureCache(this.device);

        // initialize Three.js-aligned subsystems
        this.renderContexts = RenderContext.createRenderContextsState();
        this.computeContext = RenderContext.createComputeContext();
        this.geometries = geometries.createGeometriesState(this.buffers);
        this.nodes = nodeManager.createNodeManagerState();
        this.bindings = bindings.createBindingsState(this.device, this.buffers, this.textures);
        this.pipelines = pipelines.createPipelinesState(this.device, this.format, this.nodes);
        this.renderObjects = renderObjects.createRenderObjectsState({
            nodes: this.nodes,
            geometries: this.geometries,
            bindings: this.bindings,
            pipelines: this.pipelines,
            device: this.device,
        });
        this.renderLists = renderLists.createRenderListsState();

        const w = this.domElement.width || 1;
        const h = this.domElement.height || 1;
        this.depthTexture = this._createDepthTexture(w, h);
        if (this._samples > 1) {
            this.msaaTexture = this._createMsaaTexture(w, h);
        }

        this._initialized = true;
        this.inspector.setRenderer(this);
        this.inspector.init();
        return this;
    }

    /**
     * Internal resize handler. Called when the main canvas target fires a 'resize' event,
     * or directly from setSize().
     */
    private _onResize(width: number, height: number): void {
        this.depthTexture?.destroy();
        this.depthTexture = this._createDepthTexture(width, height);

        if (this._samples > 1) {
            this.msaaTexture?.destroy();
            this.msaaTexture = this._createMsaaTexture(width, height);
        }
    }

    /**
     * Set the device pixel ratio. Call before setSize().
     *
     * @param value - The pixel ratio (e.g. window.devicePixelRatio).
     */
    setPixelRatio(value: number): void {
        this._canvasTarget.setPixelRatio(value);
    }

    /**
     * Signal the start of a new frame. Call once per animation frame before
     * any compute() or render() calls.
     *
     * This method:
     * - Increments frameId
     * - Updates time and deltaTime
     * - Notifies the inspector
     *
     * @returns The current frameId
     *
     * @example
     * ```ts
     * function frame() {
     *     renderer.beginFrame();
     *     renderer.compute(myComputeNode, [64, 1, 1]);
     *     renderer.render(scene, camera);
     *     renderer.endFrame();
     *     requestAnimationFrame(frame);
     * }
     * ```
     */
    beginFrame(): number {
        this.nodes.nodeFrame.update();
        const frameId = this.nodes.nodeFrame.frameId;
        this.inspector.begin(frameId);
        return frameId;
    }

    /**
     * Signal the end of the current frame. Call once per animation frame after
     * all compute() and render() calls.
     *
     * This method:
     * - Finalizes inspector data collection for this frame
     * - Triggers GPU timestamp resolution (if enabled)
     */
    endFrame(): void {
        this.inspector.finish(this.nodes.nodeFrame.frameId);
    }

    /**
     * Resize the canvas to logical pixel dimensions. The physical canvas size is
     * logical × pixelRatio (set via setPixelRatio()).
     *
     * Usage: renderer.setPixelRatio(window.devicePixelRatio); renderer.setSize(window.innerWidth, window.innerHeight);
     *
     * The caller is responsible for updating camera.aspect and calling
     * camera.updateProjectionMatrix() if applicable.
     *
     * @param width - Logical width in CSS pixels.
     * @param height - Logical height in CSS pixels.
     * @param updateStyle - Whether to update canvas style.width/height (default true).
     */
    setSize(width: number, height: number, updateStyle: boolean = true): void {
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
        return this.device?.features?.has(feature) ?? false;
    }

    /**
     * Pre-compile all WebGPU render pipelines and pre-upload all GPU resources
     * for a scene before the render loop starts. This is optional — resources
     * are created on-demand during the first render if not pre-warmed.
     *
     * - Async pipeline compilation (shader modules, render pipelines)
     * - Geometry buffer uploads (vertex, index)
     * - Uniform buffer uploads (render group, object group)
     * - Storage buffer uploads
     * - Texture/sampler creation
     * - Bind group creation
     * - Yields between objects to keep animations smooth
     *
     * @param scene  The scene containing meshes to pre-compile pipelines for.
     * @param camera The camera used for rendering (affects frustum culling).
     * @param samples MSAA sample count (default 1).
     * @param format  Render target format (default 'rgba8unorm').
     * @throws if the renderer has not been initialised yet.
     */
    async compile(
        scene: Scene,
        camera: Camera,
        samples: number = 1,
        format: GPUTextureFormat = 'rgba8unorm',
    ): Promise<void> {
        if (!this._initialized) {
            throw new Error('[WebGPURenderer] compile() called before init(). Await renderer.init() first.');
        }

        // use new RenderLists system to collect visible meshes
        const renderList = renderLists.collectRenderList(this.renderLists, scene, camera);
        const allItems = [...renderList.opaque, ...renderList.transparent];

        if (allItems.length === 0) return;

        // create a temporary RenderContext for compilation
        // this is needed because RenderObjects are cached by (mesh, material, renderContext)
        const compileContext = RenderContext.getRenderContext(this.renderContexts, null, null, 0);
        compileContext.sampleCount = samples;
        compileContext.width = this.domElement.width || 1;
        compileContext.height = this.domElement.height || 1;

        const depthFormat = this.pipelines.depthFormat;
        const width = compileContext.width;
        const height = compileContext.height;

        // phase 1: Kick off all async pipeline compilations in parallel
        const initPromises: Promise<void>[] = [];

        for (const item of allItems) {
            if (!item.mesh || !item.material || !item.geometry) continue;

            // get or create RenderObject
            const renderObject = renderObjects.getRenderObject(
                this.renderObjects,
                item.mesh,
                item.material,
                scene,
                camera,
                compileContext,
                'compile',
                item.group,
            );

            // kick off async initialization (compiles shader, creates pipeline)
            const pipelinePromises: Promise<void>[] = [];
            renderObjects.initRenderObjectWithPromises(this.renderObjects, renderObject, format, depthFormat, pipelinePromises);
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
            const renderObject = renderObjects.getRenderObject(
                this.renderObjects,
                mesh,
                item.material,
                scene,
                camera,
                compileContext,
                'compile',
                item.group,
            );

            const nodeState = renderObject.nodeBuilderState;

            if (nodeState) {
                // upload storage buffers
                for (const s of nodeState.storage) {
                    const buffer = buffers.resolveStorageBuffer(s.node, geometry);
                    buffers.ensureUploaded(this.buffers, buffer);
                }

                // upload vertex buffers
                for (const attrEntry of nodeState.attributes) {
                    if (attrEntry.kind === 'geometry') {
                        const bufAttr = geometry.buffers.get(attrEntry.name);
                        if (bufAttr) {
                            buffers.ensureUploaded(this.buffers, bufAttr);
                        }
                    } else {
                        const arr = attrEntry.node.buffer.array;
                        if (arr) {
                            buffers.uploadRaw(
                                this.buffers,
                                attrEntry.node,
                                arr,
                                GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                            );
                        }
                    }
                }

                // upload index buffer if present
                if (geometry.index) {
                    buffers.ensureUploaded(this.buffers, geometry.index);
                }
            }

            // upload uniforms and rebuild bind groups
            // (must be after texture upload so bind groups can reference GPU resources)
            // for pre-warming, we create a temporary frame context
            const preWarmFrame = this.nodes.nodeFrame;
            preWarmFrame.renderer = this;
            preWarmFrame.camera = camera;
            preWarmFrame.object = renderObject.mesh;
            preWarmFrame.scene = renderObject.scene;
            preWarmFrame.material = renderObject.material;
            preWarmFrame.width = width;
            preWarmFrame.height = height;
            renderObjects.updateRenderObject(
                this.renderObjects,
                renderObject,
                preWarmFrame,
            );

            // yield to main thread between objects to keep animations smooth
            await yieldToMain();
        }
    }

    /**
     * Pre-compile a compute pipeline before the render loop starts.
     * This is optional — pipelines are compiled on-demand during the first
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
        pipelines.getForCompute(this.pipelines, computeNode, this.computeContext, promises);
        await Promise.all(promises);
    }

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

    compute(node: ComputeNode, dispatchOrIndirect: [number, number, number] | GpuBuffer<d.Any>): void {
        if (this._isDeviceLost) return;

        if (!this._initialized) {
            throw new Error('[WebGPURenderer] compute() called before init(). Await renderer.init() first.');
        }

        const entry = pipelines.getForCompute(this.pipelines, node, this.computeContext);

        if (!entry.pipeline) {
            throw new Error(
                `[WebGPURenderer] compute() called for node "${node.id}" before its pipeline was compiled. ` +
                'Await renderer.compile(node) before entering the frame loop.',
            );
        }

        const encoder = this.device.createCommandEncoder();

        if (dispatchOrIndirect instanceof GpuBufferClass) {
            const gpuBuf = buffers.ensureUploaded(this.buffers, dispatchOrIndirect);
            this._dispatchComputeNode(node, encoder, undefined, gpuBuf, 0);
        } else {
            this._dispatchComputeNode(node, encoder, dispatchOrIndirect, undefined, undefined);
        }

        this.device.queue.submit([encoder.finish()]);
    }

    private _dispatchComputeNode(
        node: ComputeNode,
        encoder: GPUCommandEncoder,
        dispatch: [number, number, number] | undefined,
        indirectBuffer: GPUBuffer | undefined,
        indirectOffset: number | undefined,
    ): void {
        // Get or create the compute pipeline, passing ComputeContext for bind group caching
        const entry = pipelines.getForCompute(this.pipelines, node, this.computeContext);
        if (!entry.pipeline) return;

        const { nodeBuilderState } = entry;
        const frame = this.nodes.nodeFrame;
        frame.renderer = this;
        frame.width = this.domElement.width || 1;
        frame.height = this.domElement.height || 1;

        // Update node uniforms
        nodeManager.updateForCompute(this.nodes, node);

        // Update all bindings and get GPUBindGroups
        const gpuBindGroups = bindings.updateForCompute(this.bindings, nodeBuilderState, frame);

        // Notify inspector before creating pass (so timestamp writes are available)
        this.inspector.beginCompute(node, this.nodes.nodeFrame.frameId);

        // Get timestamp writes for GPU timing (if available)
        const timestampWrites = this.inspector.getTimestampWrites(node.id);

        // Encode the compute pass
        const computePass = encoder.beginComputePass({ timestampWrites });
        computePass.setPipeline(entry.pipeline);

        // Set bind groups
        for (let i = 0; i < gpuBindGroups.length; i++) {
            computePass.setBindGroup(i, gpuBindGroups[i]);
        }

        if (indirectBuffer) {
            computeDispatchWorkgroupsIndirect(computePass, this.inspector, indirectBuffer, indirectOffset ?? 0);
        } else {
            const [dx, dy, dz] = dispatch!;
            computeDispatchWorkgroups(computePass, this.inspector, dx, dy, dz);
        }
        computePass.end();
        this.inspector.finishCompute(node.id, this.nodes.nodeFrame.frameId);
    }

    /** save the current renderer state into a plain object and return it */
    saveRendererState(): {
        renderTarget: ReturnType<WebGPURenderer['getRenderTarget']>;
        mrt: MRTNode | null;
        clearColor: [number, number, number, number];
    } {
        return {
            renderTarget: this.getRenderTarget(),
            mrt: this.getMRT(),
            clearColor: [...this.clearColor] as [number, number, number, number],
        };
    }

    /** restore renderer state previously saved with `saveRendererState()` */
    restoreRendererState(state: ReturnType<WebGPURenderer['saveRendererState']>): void {
        this.setRenderTarget(state.renderTarget);
        this.setMRT(state.mrt);
        this.clearColor = state.clearColor;
    }

    /**
     * Renders a scene (or any Object3D like QuadMesh) from a camera's perspective.
     *
     * Three.js aligned: this is the main render entry point.
     *
     * When `setRenderTarget()` has been called, renders to that target.
     * When `setMRT()` has been called, uses MRT output mapping.
     * Otherwise renders to the swapchain (canvas).
     *
     * @param scene The scene/object to render.
     * @param camera The camera to render with.
     * @param commandEncoder Optional command encoder. If not provided, a new one is created and submitted.
     * @param passId Optional pass ID for inspector tracking.
     */
    render(
        scene: Object3D,
        camera: Camera,
        commandEncoder?: GPUCommandEncoder,
        passId = 'render',
    ): void {
        if (this._isDeviceLost) return;

        if (!this._initialized) {
            throw new Error('[WebGPURenderer] render() called before init(). Await renderer.init() first.');
        }

        // Increment renderId for RENDER-level update deduplication.
        // Multiple render() calls can happen per frame (shadows, reflections, VR).
        this.nodes.nodeFrame.renderId++;

        this.inspector.perf.start('render');

        const renderTarget = this._renderTarget;
        const mrt = this._mrt;

        // setup MRT if active - resolve output names to texture indices
        if (mrt && renderTarget) {
            mrt.resolveOutputs((name: string) => renderTarget.getTextureIndex(name));
        }

        // Determine encoder ownership:
        // - If commandEncoder was passed, we don't own it (nested render from PassNode)
        // - Otherwise create a new one and submit it when done
        const ownEncoder = !commandEncoder;
        const encoder = commandEncoder ?? this.device.createCommandEncoder();

        // Determine render target parameters
        const samples = renderTarget?.samples ?? this._samples;
        const colorFormat = renderTarget?.colorFormat ?? this.format;

        // Notify inspector of this scene render (before beginRender so scene data is
        // available when the frame is sealed in finish()).
        this.inspector.beginRenderScene(passId, scene, samples, colorFormat, this.nodes.nodeFrame.frameId);
        this.inspector.beginRender(passId, this.nodes.nodeFrame.frameId);
        const depthFormat = this.pipelines.depthFormat;
        const width = this.domElement.width || 1;
        const height = this.domElement.height || 1;
        const [cr, cg, cb, ca] = this.clearColor;

        // Set up frame context for this renderScene call
        const frame = this.nodes.nodeFrame;
        frame.renderer = this;
        frame.camera = camera;
        frame.scene = scene;
        frame.encoder = encoder;
        frame.width = width;
        frame.height = height;

        // Increment call ID for attribute deduplication
        geometries.incrementCallId(this.geometries);

        // ---------------------------------------------------------------------
        // Step 1: Get/create RenderContext for this pass
        // ---------------------------------------------------------------------
        const passCtx = RenderContext.getRenderContext(this.renderContexts, renderTarget, mrt, 0);
        // Update RenderContext with current pass configuration
        passCtx.sampleCount = samples;
        passCtx.width = width;
        passCtx.height = height;
        passCtx.camera = camera;
        passCtx.clearColorValue = { r: cr, g: cg, b: cb, a: ca };

        // ---------------------------------------------------------------------
        // Step 2: Collect visible meshes using new RenderLists system
        // ---------------------------------------------------------------------
        this.inspector.perf.start('collectRenderList');
        const renderList = renderLists.collectRenderList(this.renderLists, scene, camera);
        this.inspector.perf.end('collectRenderList');

        // ---------------------------------------------------------------------
        // Step 3: Build color attachments
        // ---------------------------------------------------------------------
        const colorAttachments: GPURenderPassColorAttachment[] = [];

        if (renderTarget) {
            // Ensure render target GPU resources are allocated
            this._ensureRenderTargetAllocated(renderTarget);

            // Render to RenderTarget - supports MRT (multiple textures)
            for (const tex of renderTarget.textures) {
                colorAttachments.push({
                    view: tex.gpuTexture!.createView(),
                    clearValue: { r: cr, g: cg, b: cb, a: ca },
                    loadOp: 'clear',
                    storeOp: 'store',
                });
            }
        } else {
            // Render to swapchain via the current canvas target
            const ctx = this._canvasTarget.getContext(this.device, this.format, 'opaque');
            const swapchainView = ctx.getCurrentTexture().createView();
            if (this._samples > 1 && this.msaaTexture) {
                colorAttachments.push({
                    view: this.msaaTexture.createView(),
                    resolveTarget: swapchainView,
                    clearValue: { r: cr, g: cg, b: cb, a: ca },
                    loadOp: 'clear',
                    storeOp: 'discard',
                });
            } else {
                colorAttachments.push({
                    view: swapchainView,
                    clearValue: { r: cr, g: cg, b: cb, a: ca },
                    loadOp: 'clear',
                    storeOp: 'store',
                });
            }
        }

        // Build depth attachment
        let depthAttachment: GPURenderPassDepthStencilAttachment | undefined;
        if (renderTarget) {
            if (renderTarget.depthTexture?.gpuTexture) {
                depthAttachment = {
                    view: renderTarget.depthTexture.gpuTexture.createView(),
                    depthClearValue: 1.0,
                    depthLoadOp: 'clear',
                    depthStoreOp: 'store',
                };
            }
        } else {
            // Use swapchain depth texture
            depthAttachment = {
                view: this.depthTexture.createView(),
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            };
        }

        this.device.pushErrorScope('validation');

        // ---------------------------------------------------------------------
        // Step 4: Initialize RenderObjects and run updateBefore BEFORE beginRenderPass
        // ---------------------------------------------------------------------
        // Three.js aligned: updateBefore must happen before the render pass starts
        // because PassNode.updateBefore() calls renderer.render() which needs to
        // start its own render pass. Can't nest render passes on the same encoder.

        type PreparedRenderObject = {
            renderObject: import('./render-object').RenderObject;
            item: RenderItem;
        };

        const preparedObjects: PreparedRenderObject[] = [];

        const prepareItems = (items: RenderItem[]) => {
            for (const item of items) {
                if (!item.mesh || !item.material || !item.geometry) continue;

                const mesh = item.mesh;
                const material = item.material;

                // Get or create RenderObject for this (mesh, material, passCtx)
                const renderObject = renderObjects.getRenderObject(
                    this.renderObjects,
                    mesh,
                    material,
                    scene,
                    camera,
                    passCtx,
                    passId,
                    item.group,
                );

                // Initialize RenderObject (compile shaders, create pipeline, bindings)
                const initialized = renderObjects.initRenderObject(
                    this.renderObjects,
                    renderObject,
                    colorFormat,
                    depthFormat,
                );
                if (!initialized || !renderObject.pipeline) {
                    console.warn('[gpucat] initRenderObject failed or pipeline missing', { initialized, pipeline: renderObject.pipeline });
                    continue;
                }

                const nodeState = renderObject.nodeBuilderState;
                if (!nodeState) {
                    console.warn('[gpucat] no nodeBuilderState');
                    continue;
                }

                // Update frame context for this specific mesh
                const frame = this.nodes.nodeFrame;
                frame.object = mesh;
                frame.material = material;

                // updateBefore - off-screen passes, pre-frame GPU work
                // This MUST happen before beginRenderPass() because PassNode.updateBefore()
                // calls renderer.render() which starts its own render pass.
                nodeManager.updateBefore(this.nodes, renderObject);

                preparedObjects.push({ renderObject, item });
            }
        };

        // Prepare all objects and run updateBefore (may trigger nested render() calls)
        prepareItems(renderList.opaque);
        prepareItems(renderList.transparent);

        // ---------------------------------------------------------------------
        // Step 5: Begin render pass and issue draw calls
        // ---------------------------------------------------------------------
        const timestampWrites = this.inspector.getTimestampWrites(passId);
        const gpuPass = encoder.beginRenderPass({
            colorAttachments,
            depthStencilAttachment: depthAttachment,
            timestampWrites,
        });

        // Track currently set GPU state to avoid redundant calls (Three.js pattern)
        const currentSets: CurrentSets = {
            bindingGroups: [],
            attributes: [],
            index: null,
            pipeline: null,
        };

        this.inspector.perf.start('drawCalls');

        for (const { renderObject, item } of preparedObjects) {
            const mesh = item.mesh!;
            const material = item.material!;
            const geometry = item.geometry!;
            const nodeState = renderObject.nodeBuilderState!;

            // Update frame context for this specific mesh
            const frame = this.nodes.nodeFrame;
            frame.object = mesh;
            frame.material = material;

            // updateForRender - uniforms, bind groups
            renderObjects.updateRenderObject(
                this.renderObjects,
                renderObject,
                frame,
            );

            // set pipeline if changed
            if (renderObject.pipeline !== currentSets.pipeline) {
                passSetPipeline(gpuPass, this.inspector, renderObject.pipeline!, mesh.name || material.constructor.name);
                currentSets.pipeline = renderObject.pipeline;
            }

            // set bind groups (skip if already bound - Three.js pattern)
            const bindGroups = renderObject.bindGroups;
            const logicalBindGroups = renderObject._bindings;
            if (bindGroups && logicalBindGroups) {
                for (let i = 0; i < bindGroups.length; i++) {
                    const bindGroupId = logicalBindGroups[i]?.id ?? -1;
                    if (currentSets.bindingGroups[i] !== bindGroupId) {
                        passSetBindGroup(gpuPass, this.inspector, i, bindGroups[i], mesh.name || '');
                        currentSets.bindingGroups[i] = bindGroupId;
                    }
                }
            }

            // set vertex buffers based on nodeBuilderState.attributes (skip if unchanged)
            let slot = 0;
            for (const attrEntry of nodeState.attributes) {
                let gpuBuf: GPUBuffer;
                if (attrEntry.kind === 'geometry') {
                    const bufAttr = geometry.buffers.get(attrEntry.name);
                    if (!bufAttr) { slot++; continue; }
                    gpuBuf = buffers.ensureUploaded(this.buffers, bufAttr);
                } else {
                    const node = attrEntry.node;
                    const arr = node.buffer.array;
                    if (!arr) {
                        throw new Error(`[gpucat] BufferAttributeNode array is null for ${attrEntry.name}`);
                    }
                    gpuBuf = buffers.uploadRaw(
                        this.buffers,
                        node,
                        arr,
                        GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                    ).buffer;
                }
                if (currentSets.attributes[slot] !== gpuBuf) {
                    passSetVertexBuffer(gpuPass, this.inspector, slot, gpuBuf);
                    currentSets.attributes[slot] = gpuBuf;
                }
                slot++;
            }

            // issue draw call (skip index buffer if unchanged)
            if (geometry.index) {
                const idxBuf = buffers.ensureUploaded(this.buffers, geometry.index);
                if (currentSets.index !== idxBuf) {
                    passSetIndexBuffer(gpuPass, this.inspector, idxBuf, getIndexFormat(geometry.index.array)!);
                    currentSets.index = idxBuf;
                }
                if (geometry.indirect) {
                    const indirect = geometry.indirect;
                    const indBuf = buffers.ensureUploaded(this.buffers, indirect);
                    const byteStride = indirect.itemSize * 4;
                    const baseOffset = geometry.indirectOffset;
                    for (let d = 0; d < indirect.count; d++) {
                        passDrawIndexedIndirect(gpuPass, this.inspector, indBuf, baseOffset + d * byteStride);
                    }
                } else {
                    passDrawIndexed(gpuPass, this.inspector, geometry.index.array!.length, mesh.count);
                }
            } else {
                if (geometry.indirect) {
                    const indirect = geometry.indirect;
                    const indBuf = buffers.ensureUploaded(this.buffers, indirect);
                    const byteStride = indirect.itemSize * 4;
                    const baseOffset = geometry.indirectOffset;
                    for (let d = 0; d < indirect.count; d++) {
                        passDrawIndirect(gpuPass, this.inspector, indBuf, baseOffset + d * byteStride);
                    }
                } else {
                    passDraw(gpuPass, this.inspector, geometry.vertexCount, mesh.count);
                }
            }

            // updateAfter - post-draw cleanup, readback, etc.
            nodeManager.updateAfter(this.nodes, renderObject);
        }

        this.inspector.perf.end('drawCalls');

        gpuPass.end();
        this.inspector.finishRender(passId, this.nodes.nodeFrame.frameId);

        // Submit if we own the encoder (top-level render call)
        if (ownEncoder) {
            this.device.queue.submit([encoder.finish()]);
        }

        this.device.popErrorScope().then((err) => {
            if (err) console.error('[WebGPU render validation error]', err.message);
        });

        this.inspector.perf.end('render');
    }

    private _ensureRenderTargetAllocated(renderTarget: RenderTarget): void {
        // Check if already allocated at correct size
        const firstTex = renderTarget.textures[0]?.gpuTexture;
        if (firstTex && firstTex.width === renderTarget.width && firstTex.height === renderTarget.height) {
            return;
        }

        // Dispose old resources
        renderTarget.dispose();

        // Allocate new GPU resources
        const sampleCount = renderTarget.samples > 1 ? renderTarget.samples : 1;

        for (const tex of renderTarget.textures) {
            tex.gpuTexture = this.device.createTexture({
                size: [renderTarget.width, renderTarget.height],
                format: tex.format ?? renderTarget.colorFormat,
                usage:
                    GPUTextureUsage.RENDER_ATTACHMENT |
                    GPUTextureUsage.TEXTURE_BINDING |
                    GPUTextureUsage.COPY_SRC,
                sampleCount,
            });

            // Create sampler alongside texture (linear filtering for post-processing)
            tex.gpuSampler = this.device.createSampler({
                magFilter: 'linear',
                minFilter: 'linear',
                mipmapFilter: 'linear',
                addressModeU: 'clamp-to-edge',
                addressModeV: 'clamp-to-edge',
            });
        }

        if (renderTarget.depthTexture) {
            renderTarget.depthTexture.gpuTexture = this.device.createTexture({
                size: [renderTarget.width, renderTarget.height],
                format: renderTarget.depthTexture.format!, // DepthTexture always has format set
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
                sampleCount,
            });

            // Depth textures also need samplers for reading in post-processing
            renderTarget.depthTexture.gpuSampler = this.device.createSampler({
                magFilter: 'nearest',
                minFilter: 'nearest',
                addressModeU: 'clamp-to-edge',
                addressModeV: 'clamp-to-edge',
            });
        }
    }

    private _createDepthTexture(width: number, height: number): GPUTexture {
        return this.device.createTexture({
            size: [width, height],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
            sampleCount: this._samples > 1 ? this._samples : 1,
        });
    }

    private _createMsaaTexture(width: number, height: number): GPUTexture {
        return this.device.createTexture({
            size: [width, height],
            format: this.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
            sampleCount: this._samples,
        });
    }

}

/** tracks currently set GPU state to avoid redundant setBindGroup/setVertexBuffer/setIndexBuffer calls */
type CurrentSets = {
    /** Currently bound bind group IDs by slot index. -1 = not set. */
    bindingGroups: number[];
    /** Currently bound vertex buffers by slot index. */
    attributes: (GPUBuffer | null)[];
    /** Currently bound index buffer. */
    index: GPUBuffer | null;
    /** Current pipeline (already tracked separately). */
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
// Pass-command helpers — issue the real GPU encoder call AND the inspector hook
// in one place so neither renderer.ts call sites nor the inspector interface
// accumulate per-command boilerplate.
// ---------------------------------------------------------------------------

function passSetPipeline(
    pass: GPURenderPassEncoder,
    inspector: InspectorBase,
    pipeline: GPURenderPipeline,
    label: string,
): void {
    pass.setPipeline(pipeline);
    inspector.setPipeline(label);
}

function passSetBindGroup(
    pass: GPURenderPassEncoder,
    inspector: InspectorBase,
    index: number,
    bindGroup: GPUBindGroup,
    label: string,
): void {
    pass.setBindGroup(index, bindGroup);
    inspector.setBindGroup(index, label);
}

function passSetVertexBuffer(
    pass: GPURenderPassEncoder,
    inspector: InspectorBase,
    slot: number,
    buffer: GPUBuffer,
): void {
    pass.setVertexBuffer(slot, buffer);
    inspector.setVertexBuffer(slot);
}

function passSetIndexBuffer(
    pass: GPURenderPassEncoder,
    inspector: InspectorBase,
    buffer: GPUBuffer,
    format: GPUIndexFormat,
): void {
    pass.setIndexBuffer(buffer, format);
    inspector.setIndexBuffer();
}

function passDraw(
    pass: GPURenderPassEncoder,
    inspector: InspectorBase,
    vertexCount: number,
    instanceCount: number,
): void {
    pass.draw(vertexCount, instanceCount);
    inspector.draw(vertexCount, instanceCount);
}

function passDrawIndexed(
    pass: GPURenderPassEncoder,
    inspector: InspectorBase,
    indexCount: number,
    instanceCount: number,
): void {
    pass.drawIndexed(indexCount, instanceCount);
    inspector.drawIndexed(indexCount, instanceCount);
}

function passDrawIndirect(
    pass: GPURenderPassEncoder,
    inspector: InspectorBase,
    indirectBuffer: GPUBuffer,
    indirectOffset: number,
): void {
    pass.drawIndirect(indirectBuffer, indirectOffset);
    inspector.drawIndirect();
}

function passDrawIndexedIndirect(
    pass: GPURenderPassEncoder,
    inspector: InspectorBase,
    indirectBuffer: GPUBuffer,
    indirectOffset: number,
): void {
    pass.drawIndexedIndirect(indirectBuffer, indirectOffset);
    inspector.drawIndexedIndirect();
}

function computeDispatchWorkgroups(
    pass: GPUComputePassEncoder,
    inspector: InspectorBase,
    x: number,
    y: number,
    z: number,
): void {
    pass.dispatchWorkgroups(x, y, z);
    inspector.dispatchWorkgroups(x, y, z);
}

function computeDispatchWorkgroupsIndirect(
    pass: GPUComputePassEncoder,
    inspector: InspectorBase,
    indirectBuffer: GPUBuffer,
    offset: number,
): void {
    pass.dispatchWorkgroupsIndirect(indirectBuffer, offset);
    inspector.dispatchWorkgroupsIndirect(indirectBuffer, offset);
}
