import { Camera } from '../camera/camera';
import { getIndexFormat, GpuBuffer as GpuBufferClass, type GpuBuffer } from '../core/gpu-buffer';
import { Object3D } from '../core/object3d';
import type { RenderTarget } from '../core/render-target';
import { InspectorBase } from '../inspector/inspector-base';
import type { Material } from '../material/material';
import { ComputeNode, MRTNode } from '../nodes/nodes';
import * as d from '../schema/schema';
import { Scene } from '../scene/scene';
import { yieldToMain } from '../utils/yield-to-main';
import * as bindings from './bindings';
import * as buffers from './buffers';
import { CanvasTarget } from './canvas-target';
import * as geometries from './geometries';
import { GPUFeatureName } from './gpu-constants';
import * as nodeManager from './node-manager';
import * as RenderContext from './pass-context';
import * as pipelines from './pipelines';
import { DEPTH_FORMAT } from './pipelines';
import type { RenderItem } from './render-list';
import * as renderLists from './render-list';
import type { RenderObject } from './render-object';
import * as renderObjects from './render-objects';
import * as textures from './textures';
import { disposeMipmapState } from './mipmap-utils';

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
    /** Whether the renderer has been initialized (adapter/device/context created) or not. @internal */
    _initialized = false;

    /** Indicates whether the device has been lost or not. When this is set to `true`, rendering isn't possible anymore. @internal */
    _isDeviceLost = false;

    /** Inspector. Replace with a RendererInspector or Inspector instance to enable profiling. */
    inspector: InspectorBase = new InspectorBase();

    /** The canvas dom element for the current canvas target */
    get domElement(): HTMLCanvasElement {
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

    /** MSAA color texture (null when samples <= 1). Only used for swapchain passes */
    _msaaTexture: GPUTexture | null = null;

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
    _renderCallDepth: number = 0;

    /** clear color for the final swapchain composite pass. defaults to opaque black. */
    clearColor: [number, number, number, number] = [0, 0, 0, 1];

    /** current MRT configuration. when set, materials using mrt() nodes write to multiple color attachments. */
    mrt: MRTNode | null = null;

    /** current render target. when set, render() renders to this target instead of the swapchain. */
    renderTarget: RenderTarget | null = null;

    /** when set, all meshes in the scene render with this material instead of their own. */
    overrideMaterial: Material | null = null;

    /** @internal current canvas target. the inspector viewer swaps this for preview renders. */
    private _canvasTarget!: CanvasTarget;

    /** swap the active canvas target (used by inspector viewer for preview renders). */
    setCanvasTarget(canvasTarget: CanvasTarget): this {
        this._canvasTarget = canvasTarget;
        return this;
    }

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
        this.samples = samples;
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

        this._renderContexts = RenderContext.createRenderContextsState();
        this._computeContext = RenderContext.createComputeContext();
        this._nodes = nodeManager.createNodeManagerState();
        this._renderLists = renderLists.createRenderListsState();
        this._bindings = bindings.createBindingsState();
        this._pipelines = pipelines.createPipelinesState();
        this._renderObjects = renderObjects.createRenderObjectsState();
        this._buffers = buffers.createBufferCache();
        this._textures = textures.createTextureCache();
        this._geometries = geometries.createGeometriesState();
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
            const requiredFeatures = Object.values(GPUFeatureName).filter(
                (f) => adapter.features.has(f),
            ) as GPUFeatureName[];

            // merge with any caller-supplied descriptor, deduplicating features.
            const callerFeatures = this._deviceDescriptor?.requiredFeatures ?? [];
            const mergedFeatures = [
                ...new Set([...requiredFeatures, ...callerFeatures]),
            ] as GPUFeatureName[];
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
            this._canvasTarget.getContext(this._device, this._format, 'opaque');
        }

        const w = this.domElement.width || 1;
        const h = this.domElement.height || 1;
        this._depthTexture = this._createDepthTexture(w, h);
        if (this.samples > 1) {
            this._msaaTexture = this._createMsaaTexture(w, h);
        }

        this._initialized = true;
        this.inspector.setRenderer(this);
        this.inspector.init();
        return this;
    }

    /** recreate depth/msaa textures after a resize. */
    private _onResize(width: number, height: number): void {
        this._depthTexture?.destroy();
        this._depthTexture = this._createDepthTexture(width, height);

        if (this.samples > 1) {
            this._msaaTexture?.destroy();
            this._msaaTexture = this._createMsaaTexture(width, height);
        }
    }

    /** set the device pixel ratio. call before setSize(). */
    setPixelRatio(value: number): void {
        this._canvasTarget.setPixelRatio(value);
    }

    /** call once per animation frame before any compute() or render() calls. bumps frameId, updates time/deltaTime. */
    beginFrame(): number {
        this._nodes.nodeFrame.update();
        const frameId = this._nodes.nodeFrame.frameId;
        this.inspector.begin(frameId);
        return frameId;
    }

    /** call once per animation frame after all compute() and render() calls. */
    endFrame(): void {
        this.inspector.finish(this._nodes.nodeFrame.frameId);
    }

    /** resize the canvas to logical pixel dimensions (physical = logical * pixelRatio). */
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
        return this._device?.features?.has(feature) ?? false;
    }

    /**
     * Pre-compile render pipelines and pre-upload GPU resources for a scene.
     * Optional — resources are created on-demand during the first render if not pre-warmed.
     */
    async compile(
        scene: Scene,
        camera: Camera,
        samples?: number,
        format?: GPUTextureFormat,
    ): Promise<void> {
        if (!this._initialized) {
            throw new Error('[WebGPURenderer] compile() called before init(). Await renderer.init() first.');
        }

        const resolvedSamples = samples ?? this.samples;
        const resolvedFormat = format ?? this._format;

        // use new RenderLists system to collect visible meshes
        const renderList = renderLists.collectRenderList(this._renderLists, scene, camera);
        const allItems = [...renderList.opaque, ...renderList.transparent];

        if (allItems.length === 0) return;

        // create a temporary RenderContext for compilation
        // this is needed because RenderObjects are cached by (mesh, material, renderContext)
        const compileContext = RenderContext.getRenderContext(this._renderContexts, null, null, 0);
        compileContext.sampleCount = resolvedSamples;
        compileContext.width = this.domElement.width || 1;
        compileContext.height = this.domElement.height || 1;

        const depthFormat = this.renderTarget?.depthTexture?.format ?? DEPTH_FORMAT;
        const width = compileContext.width;
        const height = compileContext.height;

        // phase 1: Kick off all async pipeline compilations in parallel
        const initPromises: Promise<void>[] = [];

        for (const item of allItems) {
            if (!item.mesh || !item.material || !item.geometry) continue;

            // get or create RenderObject
            const renderObject = renderObjects.getRenderObject(
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
            renderObjects.initRenderObjectWithPromises(
                this._nodes,
                this._geometries,
                this._bindings,
                this._pipelines,
                this._device,
                this._buffers,
                renderObject,
                resolvedFormat,
                depthFormat,
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
            const renderObject = renderObjects.getRenderObject(
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
                    const buffer = buffers.resolveStorageBuffer(s.node, geometry);
                    buffers.ensureUploaded(this._buffers, this._device, buffer);
                }

                // upload vertex buffers
                for (const attrEntry of nodeState.attributes) {
                    if (attrEntry.kind === 'geometry') {
                        const bufAttr = geometry.buffers.get(attrEntry.name!);
                        if (bufAttr) {
                            buffers.ensureUploaded(this._buffers, this._device, bufAttr);
                        }
                    } else {
                        const gpuBuffer = attrEntry.node.buffer;
                        if (!gpuBuffer) {
                            throw new Error(`[gpucat] AttributeNode has no buffer for ${attrEntry.shaderName}`);
                        }
                        const arr = gpuBuffer.array;
                        if (arr) {
                            buffers.uploadRaw(
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
                    buffers.ensureUploaded(this._buffers, this._device, geometry.index);
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
            renderObjects.updateRenderObject(
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
        pipelines.getForCompute(this._pipelines, this._device, this._nodes, computeNode, this._computeContext, promises);
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

        const entry = pipelines.getForCompute(this._pipelines, this._device, this._nodes, node, this._computeContext);

        const perfId = `compute: ${node.id}`;
        this.inspector.perf.start(perfId);

        const encoder = this._device.createCommandEncoder();

        if (dispatchOrIndirect instanceof GpuBufferClass) {
            const gpuBuf = buffers.ensureUploaded(this._buffers, this._device, dispatchOrIndirect);
            this._dispatchComputeNode(entry, node, encoder, undefined, gpuBuf, 0);
        } else {
            this._dispatchComputeNode(entry, node, encoder, dispatchOrIndirect, undefined, undefined);
        }

        this._device.queue.submit([encoder.finish()]);

        this.inspector.perf.end(perfId);
    }

    private _dispatchComputeNode(
        entry: pipelines.ComputePipelineEntry,
        node: ComputeNode,
        encoder: GPUCommandEncoder,
        dispatch: [number, number, number] | undefined,
        indirectBuffer: GPUBuffer | undefined,
        indirectOffset: number | undefined,
    ): void {
        const { nodeBuilderState } = entry;
        const frame = this._nodes.nodeFrame;
        frame.renderer = this;
        frame.width = this.domElement.width || 1;
        frame.height = this.domElement.height || 1;

        // Update node uniforms
        this.inspector.perf.start('updateForCompute');
        nodeManager.updateForCompute(this._nodes, node);
        this.inspector.perf.end('updateForCompute');

        // Update all bindings and get GPUBindGroups
        const gpuBindGroups = bindings.updateComputeBindings(this._bindings, nodeBuilderState, frame, this._device, this._buffers, this._textures);

        // Notify inspector before creating pass (so timestamp writes are available)
        this.inspector.beginCompute(node, this._nodes.nodeFrame.frameId);

        // Get timestamp writes for GPU timing (if available)
        const timestampWrites = this.inspector.getTimestampWrites(node.id);

        // Encode the compute pass
        const computePass = encoder.beginComputePass({ timestampWrites });
        computePass.setPipeline(entry.pipeline!);

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
        this.inspector.finishCompute(node.id, this._nodes.nodeFrame.frameId);
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

        // Save previous renderId to support nested renders (e.g. PassNode calling render() in updateBefore).
        // Each render() call gets its own renderId so RENDER-level updates run once per render call.
        // At top level (depth 0), just increment. When nested, save/restore parent's renderId.
        const frame = this._nodes.nodeFrame;
        const previousRenderId = frame.renderId;
        this._renderCallDepth++;
        frame.renderId++;
        this.inspector.perf.start('render');

        const renderTarget = this.renderTarget;
        const mrt = this.mrt;

        if (mrt && renderTarget) {
            mrt.resolveOutputs((name: string) => renderTarget.getTextureIndex(name));
        }

        const ownEncoder = !commandEncoder;
        const encoder = commandEncoder ?? this._device.createCommandEncoder();

        const samples = renderTarget?.samples ?? this.samples;
        const colorFormat = renderTarget?.colorFormat ?? this._format;
        const depthFormat = renderTarget?.depthTexture?.format ?? DEPTH_FORMAT;
        const width = this.domElement.width || 1;
        const height = this.domElement.height || 1;
        const [cr, cg, cb, ca] = this.clearColor;

        this.inspector.beginRenderScene(passId, scene, samples, colorFormat, frame.frameId);
        this.inspector.beginRender(passId, frame.frameId);

        frame.renderer = this;
        frame.camera = camera;
        frame.scene = scene;
        frame.encoder = encoder;
        frame.width = width;
        frame.height = height;

        geometries.incrementCallId(this._geometries);

        const passCtx = RenderContext.getRenderContext(this._renderContexts, renderTarget, mrt, 0);
        passCtx.sampleCount = samples;
        passCtx.width = width;
        passCtx.height = height;
        passCtx.camera = camera;
        passCtx.clearColorValue = { r: cr, g: cg, b: cb, a: ca };

        const clearColor = { r: cr, g: cg, b: cb, a: ca };
        const { colorAttachments, depthAttachment } = this._render_resolve(renderTarget, clearColor);

        this._device.pushErrorScope('validation');

        const preparedObjects = this._render_prepare(
            scene, camera, passCtx, passId, colorFormat, depthFormat, this.overrideMaterial,
        );

        this._render_draw(encoder, preparedObjects, colorAttachments, depthAttachment, passId);

        if (ownEncoder) {
            this._device.queue.submit([encoder.finish()]);
        }

        this._device.popErrorScope().then((err) => {
            if (err) console.error('[WebGPU render validation error]', err.message);
        });

        this.inspector.perf.end('render');

        // Restore previous renderId only for nested renders. Top-level keeps its incremented value.
        this._renderCallDepth--;
        if (this._renderCallDepth > 0) {
            frame.renderId = previousRenderId;
        }
    }

    /** Build GPU color and depth attachments for the current render target or swapchain. */
    private _render_resolve(
        renderTarget: RenderTarget | null,
        clearColor: GPUColorDict,
    ): {
        colorAttachments: GPURenderPassColorAttachment[];
        depthAttachment: GPURenderPassDepthStencilAttachment | undefined;
    } {
        const colorAttachments: GPURenderPassColorAttachment[] = [];

        if (renderTarget) {
            this._ensureRenderTargetAllocated(renderTarget);

            for (const tex of renderTarget.textures) {
                const textureData = textures.getTextureData(this._textures, tex._gpuTexture);
                if (!textureData) {
                    throw new Error('[WebGPURenderer] Render target texture not found in cache');
                }
                colorAttachments.push({
                    view: textureData.texture.createView(),
                    clearValue: clearColor,
                    loadOp: 'clear',
                    storeOp: 'store',
                });
            }
        } else {
            const ctx = this._canvasTarget.getContext(this._device, this._format, 'opaque');
            const swapchainView = ctx.getCurrentTexture().createView();
            if (this.samples > 1 && this._msaaTexture) {
                colorAttachments.push({
                    view: this._msaaTexture.createView(),
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
        }

        let depthAttachment: GPURenderPassDepthStencilAttachment | undefined;
        if (renderTarget) {
            if (renderTarget.depthTexture) {
                const depthTextureData = textures.getTextureData(this._textures, renderTarget.depthTexture._gpuTexture);
                if (depthTextureData) {
                    depthAttachment = {
                        view: depthTextureData.texture.createView(),
                        depthClearValue: 1.0,
                        depthLoadOp: 'clear',
                        depthStoreOp: 'store',
                    };
                }
            }
        } else {
            depthAttachment = {
                view: this._depthTexture.createView(),
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            };
        }

        return { colorAttachments, depthAttachment };
    }

    /** Collect visible meshes, init render objects, and run updateBefore (may trigger nested renders). */
    private _render_prepare(
        scene: Object3D,
        camera: Camera,
        passCtx: RenderContext.RenderContext,
        passId: string,
        colorFormat: GPUTextureFormat,
        depthFormat: GPUTextureFormat,
        overrideMaterial: Material | null,
    ): PreparedRenderObject[] {
        this.inspector.perf.start('collectRenderList');
        const renderList = renderLists.collectRenderList(this._renderLists, scene, camera, overrideMaterial);
        this.inspector.perf.end('collectRenderList');

        const preparedObjects: PreparedRenderObject[] = [];

        for (const items of [renderList.opaque, renderList.transparent]) {
            for (const item of items) {
                if (!item.mesh || !item.material || !item.geometry) continue;

                const renderObject = renderObjects.getRenderObject(
                    this._renderObjects,
                    item.mesh,
                    item.material,
                    scene,
                    camera,
                    passCtx,
                    passId,
                );

                const initialized = renderObjects.initRenderObject(
                    this._nodes,
                    this._geometries,
                    this._bindings,
                    this._pipelines,
                    this._device,
                    this._buffers,
                    renderObject,
                    colorFormat,
                    depthFormat,
                );
                if (!initialized || !renderObject.pipeline) {
                    console.warn('[gpucat] initRenderObject failed or pipeline missing', { initialized, pipeline: renderObject.pipeline });
                    continue;
                }

                if (!renderObject.nodeBuilderState) {
                    console.warn('[gpucat] no nodeBuilderState');
                    continue;
                }

                this.inspector.perf.start('updateBefore');
                nodeManager.updateBefore(this._nodes, renderObject);
                this.inspector.perf.end('updateBefore');

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
        const timestampWrites = this.inspector.getTimestampWrites(passId);
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

        this.inspector.perf.start('drawCalls');

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

            nodeManager.updateForRender(this._nodes, renderObject);

            this.inspector.perf.start('updateForRender');
            renderObjects.updateRenderObject(
                this._bindings,
                this._geometries,
                this._device,
                this._buffers,
                this._textures,
                renderObject,
                frame,
            );
            this.inspector.perf.end('updateForRender');

            if (renderObject.pipeline !== currentSets.pipeline) {
                passSetPipeline(gpuPass, this.inspector, renderObject.pipeline!, mesh.name || material.constructor.name);
                currentSets.pipeline = renderObject.pipeline;
            }

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

            let slot = 0;
            for (const group of nodeState.vertexBufferGroups) {
                let gpuBuf: GPUBuffer;
                if (group.name !== null) {
                    // Geometry-based group - resolve buffer by name
                    const bufAttr = geometry.buffers.get(group.name);
                    if (!bufAttr) { slot++; continue; }
                    gpuBuf = buffers.ensureUploaded(this._buffers, this._device, bufAttr);
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
                    gpuBuf = buffers.uploadRaw(
                        this._buffers,
                        this._device,
                        gpuBuffer,
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

            if (geometry.index) {
                const idxBuf = buffers.ensureUploaded(this._buffers, this._device, geometry.index);
                if (currentSets.index !== idxBuf) {
                    passSetIndexBuffer(gpuPass, this.inspector, idxBuf, getIndexFormat(geometry.index.array)!);
                    currentSets.index = idxBuf;
                }
                if (geometry.indirect) {
                    const indirect = geometry.indirect;
                    const indBuf = buffers.ensureUploaded(this._buffers, this._device, indirect);
                    const byteStride = indirect.itemSize * 4;
                    const baseOffset = geometry.indirectOffset;
                    for (let d = 0; d < indirect.count; d++) {
                        passDrawIndexedIndirect(gpuPass, this.inspector, indBuf, baseOffset + d * byteStride);
                    }
                } else {
                    const indexCount = Math.min(geometry.drawRange.count, geometry.index.array!.length);
                    passDrawIndexed(gpuPass, this.inspector, indexCount, mesh.count, geometry.drawRange.start);
                }
            } else {
                if (geometry.indirect) {
                    const indirect = geometry.indirect;
                    const indBuf = buffers.ensureUploaded(this._buffers, this._device, indirect);
                    const byteStride = indirect.itemSize * 4;
                    const baseOffset = geometry.indirectOffset;
                    for (let d = 0; d < indirect.count; d++) {
                        passDrawIndirect(gpuPass, this.inspector, indBuf, baseOffset + d * byteStride);
                    }
                } else {
                    passDraw(gpuPass, this.inspector, geometry.drawRange.count, mesh.count, geometry.drawRange.start);
                }
            }

            this.inspector.perf.start('updateAfter');
            nodeManager.updateAfter(this._nodes, renderObject);
            this.inspector.perf.end('updateAfter');
        }

        this.inspector.perf.end('drawCalls');

        gpuPass.end();
        this.inspector.finishRender(passId, this._nodes.nodeFrame.frameId);
    }

    private _ensureRenderTargetAllocated(renderTarget: RenderTarget): void {
        // Check if already allocated at correct size via texture cache
        // For depth-only render targets (count: 0), check the depth texture instead
        const firstTex = renderTarget.textures[0] ?? renderTarget.depthTexture;
        if (firstTex) {
            const existingData = textures.getTextureData(this._textures, firstTex._gpuTexture);
            if (existingData && existingData.texture.width === renderTarget.width && existingData.texture.height === renderTarget.height) {
                return;
            }
        }

        // Dispose old resources via render target (which calls texture cache removal)
        renderTarget.dispose();

        // Allocate new GPU resources
        const sampleCount = renderTarget.samples > 1 ? renderTarget.samples : 1;

        for (const tex of renderTarget.textures) {
            const gpuTexture = this._device.createTexture({
                size: [renderTarget.width, renderTarget.height],
                format: tex.format ?? renderTarget.colorFormat,
                usage:
                    GPUTextureUsage.RENDER_ATTACHMENT |
                    GPUTextureUsage.TEXTURE_BINDING |
                    GPUTextureUsage.COPY_SRC,
                sampleCount,
            });

            // Register in texture cache (keyed by GpuTexture)
            textures.setRenderTargetTexture(this._textures, tex._gpuTexture, gpuTexture);
        }

        if (renderTarget.depthTexture) {
            const gpuDepthTexture = this._device.createTexture({
                size: [renderTarget.width, renderTarget.height],
                format: renderTarget.depthTexture.format, // DepthTexture always has format set
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
                sampleCount,
            });

            // Register in texture cache (keyed by GpuTexture)
            textures.setRenderTargetTexture(this._textures, renderTarget.depthTexture._gpuTexture, gpuDepthTexture);
        }
    }

    private _createDepthTexture(width: number, height: number): GPUTexture {
        return this._device.createTexture({
            size: [width, height],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
            sampleCount: this.samples > 1 ? this.samples : 1,
        });
    }

    private _createMsaaTexture(width: number, height: number): GPUTexture {
        return this._device.createTexture({
            size: [width, height],
            format: this._format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
            sampleCount: this.samples,
        });
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
        // one — device.destroy() invalidates all GPU resources, and the individual
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
        this._canvasTarget.dispose();

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
    firstVertex: number,
): void {
    pass.draw(vertexCount, instanceCount, firstVertex);
    inspector.draw(vertexCount, instanceCount);
}

function passDrawIndexed(
    pass: GPURenderPassEncoder,
    inspector: InspectorBase,
    indexCount: number,
    instanceCount: number,
    firstIndex: number,
): void {
    pass.drawIndexed(indexCount, instanceCount, firstIndex);
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
