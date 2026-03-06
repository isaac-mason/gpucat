/**
 * renderer.ts — WebGPU renderer.
 *
 * Usage:
 *   const renderer = new WebGPURenderer({ antialias: true });
 *   await renderer.init();
 *   document.body.appendChild(renderer.domElement);
 *   renderer.setSize(window.innerWidth, window.innerHeight);
 *
 *   const scenePass = pass(scene, camera);
 *
 *   function frame() {
 *       renderer.render(scenePass.getTextureNode());
 *       requestAnimationFrame(frame);
 *   }
 *   requestAnimationFrame(frame);
 *
 * Frame loop (inside renderer.render()):
 *   1. Advance time uniforms
 *   2. Run update() callbacks for nodes discovered at compile-time
 *   3. Run updateBefore() callbacks (PassNodes render their scenes here)
 *   4. _renderOutputNode — compile outputNode as fullscreen quad color, render to swapchain
 *   5. Run updateAfter() callbacks
 *   6. queue.submit([encoder.finish()]) — one submit per frame
 */

import { Mesh } from '../objects/mesh';
import * as buffers from './buffers';
import * as textures from './textures';
import * as pipelines from './pipelines';
import {
    buildRenderGroupGPUBindGroup,
} from './bindgroups';
import { Material } from '../material/material';
import { Geometry } from '../geometry/geometry';
import { wgsl, builtin, type Node, type WgslType, VaryingNode, MRTNode } from '../nodes/nodes';
import * as d from '../nodes/schema';

// New Three.js-aligned systems
import { createRenderContextsState, getRenderContext, type RenderContextsState } from './render-contexts';
import { createAttributesState, incrementCallId, type AttributesState } from './attributes';
import { createGeometriesState, type GeometriesState } from './geometries';
import { createNodeManagerState, updateBefore, updateForRender, updateAfter, type NodeManagerState } from './node-manager';
import { createBindingsState, getBindGroupLayouts as _getBindGroupLayouts, type BindingsState } from './bindings';
import { createRenderObjectsState, getRenderObject, initRenderObject, initRenderObjectAsync, updateRenderObject, type RenderObjectsState } from './render-objects';
import { createRenderListsState, collectRenderList, type RenderListsState } from './render-lists';
import type { RenderItem } from './render-list';

import { ComputeNode } from '../nodes/nodes';
import type { UniformGroupBlock } from '../nodes/compile';
import type { RenderFrame, RenderUpdateContext, ObjectUpdateContext } from './render-frame';
import { Scene } from '../scene/scene';
import { Camera } from '../camera/camera';
import { InspectorBase } from '../inspector/inspector-base';
import type { RenderTarget } from './render-target';
import { GPUFeatureName } from './gpu-constants';
import { CanvasTarget } from './canvas-target';

// declare scheduler.yield(), available in most modern browsers
declare global {
    interface Scheduler {
        yield(): Promise<void>;
    }
    // eslint-disable-next-line no-var
    var scheduler: Scheduler | undefined;
}

/**
 * Yield to the main thread to allow animations to continue.
 * Three.js aligned: uses scheduler.yield() if available, falls back to setTimeout.
 * This prevents long-running compile operations from blocking the UI.
 */
function yieldToMain(): Promise<void> {
    // Modern browsers: scheduler.yield() is the most efficient way to yield
    if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
        return scheduler.yield();
    }
    // Fallback: setTimeout with 0ms delay yields to the event loop
    return new Promise(resolve => setTimeout(resolve, 0));
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
};

/**
 * Information about a device lost event.
 * Mirrors Three.js's device loss info structure.
 */
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

export class WebGPURenderer {
    /**
     * The canvas element managed by this renderer.
     * Three.js aligned: domElement is a getter that reads from _canvasTarget.
     */
    get domElement(): HTMLCanvasElement {
        return this._canvasTarget.domElement;
    }

    /** The GPUAdapter, available after init(). */
    adapter!: GPUAdapter;

    /** The GPUDevice, available after init(). */
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
    pipelines!: pipelines.PipelineCache;

    /** Inspector hook. Replace with a RendererInspector or Inspector instance to enable profiling. */
    public inspector: InspectorBase = new InspectorBase();

    private _initialized = false;

    /**
     * Indicates whether the device has been lost or not.
     * When this is set to `true`, rendering isn't possible anymore.
     */
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

    /**
     * GPU buffer key for compute shader renderGroup struct UBO.
     * Separate from render because compute shaders don't have camera.
     */
    private _computeRenderGroupKey: object = {};

    /**
     * Cache for _makeOutputMaterial results, keyed by `${outputNode.id}:${format}:${samples}`.
     * Prevents the stack overflow caused by rebuilding the node subgraph every frame.
     */
    private _outputMaterialCache: Map<string, { mat: Material; pipelineKey: string }> = new Map();

    // -------------------------------------------------------------------------
    // Three.js-aligned subsystems (Phase 4)
    // -------------------------------------------------------------------------

    /** @internal RenderContexts manager - caches render pass configurations */
    private _renderContexts!: RenderContextsState;

    /** @internal Attributes system - manages vertex/index buffer uploads with deduplication */
    private _attributes!: AttributesState;

    /** @internal Geometries system - coordinates geometry state for RenderObjects */
    private _geometries!: GeometriesState;

    /** @internal NodeManager - handles node compilation and update lifecycle */
    private _nodes!: NodeManagerState;

    /** @internal Bindings system - manages per-RenderObject bind groups */
    private _bindings!: BindingsState;

    /** @internal RenderObjects manager - caches RenderObjects per (mesh, material, context) */
    private _renderObjects!: RenderObjectsState;

    /** Read-only access to RenderObjects state for inspection/debugging. */
    get renderObjects(): RenderObjectsState {
        return this._renderObjects;
    }

    /**
     * Return the GPUBindGroupLayouts for a compiled RenderObject.
     * Used by the inspector probe to build a probe pipeline with the same
     * bind group layout as the source mesh pipeline.
     */
    getBindGroupLayouts(renderObject: import('./render-object').RenderObject): GPUBindGroupLayout[] {
        return _getBindGroupLayouts(this._bindings, renderObject);
    }

    /** @internal RenderLists manager - caches scene collection results */
    private _renderLists!: RenderListsState;

    /** elapsed time in seconds. */
    private elapsed = 0;

    /** the last timestamp used for time delta calculation, in milliseconds. updated on each render call. */
    private lastTimestamp = 0;

    /**
     * Monotonically-incrementing frame counter. Incremented once per render() call.
     * Used for per-frame deduplication of updateBefore() calls.
     * Three equivalent: NodeFrame.frameId
     */
    frameId = 0;

    /**
     * Monotonically-incrementing render counter. Incremented once per render() call
     * (same as frameId for now; would differ if multiple render() calls share a frame,
     * e.g. shadow passes).
     * Three equivalent: NodeFrame.renderId
     */
    renderId = 0;

    /** pending command encoder shared between compute() and render() within a single frame */
    private _frameEncoder: GPUCommandEncoder | null = null;

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
     * Three.js aligned: _canvasTarget is the single source of truth for the output canvas.
     * @internal
     */
    private _canvasTarget!: CanvasTarget;

    /**
     * Bound handler for canvas resize events. Added/removed in setCanvasTarget().
     * Three.js aligned: _onCanvasTargetResize
     */
    private _onCanvasTargetResize: (() => void) | null = null;

    /**
     * Sets the current canvas target.
     * Removes the resize listener from the old target, attaches it to the new one.
     * Three.js aligned: full swap, never a secondary override.
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
     * Three.js aligned: renderer.getCanvasTarget()
     */
    getCanvasTarget(): CanvasTarget {
        return this._canvasTarget;
    }

    /** Geometry for the internal fullscreen triangle. Created once on first use. */
    private _fullscreenGeometry: Geometry | null = null;

    /** Mesh for the internal fullscreen triangle. Created once on first use. */
    private _fullscreenMesh: Mesh | null = null;

    /** Dummy scene for fullscreen quad rendering. Created once on first use. */
    private _fullscreenScene: Scene | null = null;

    /** Dummy camera for fullscreen quad rendering. Created once on first use. */
    private _fullscreenCamera: Camera | null = null;

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

        // Create the main canvas and wrap it as the default CanvasTarget.
        // Three.js aligned: _canvasTarget is never null, always initialized in constructor.
        const canvas = document.createElement('canvas');
        canvas.style.display = 'block';
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
        // Three.js aligned: the backend lazily configures the context from the current canvasTarget.
        this.format = navigator.gpu.getPreferredCanvasFormat();
        this._canvasTarget.getContext(this.device, this.format, 'opaque');

        // Set up canvas resize handler.
        // Three.js aligned: _onCanvasTargetResize is bound in constructor and added here.
        this._onCanvasTargetResize = () => {
            const { width, height } = this._canvasTarget.getDrawingBufferSize();
            this._onResize(width, height);
        };
        this._canvasTarget.addEventListener('resize', this._onCanvasTargetResize);

        this.buffers = buffers.createBufferCache(this.device);
        this.textures = textures.createTextureCache(this.device);
        this.pipelines = pipelines.createPipelineCache(this.device, this.format);

        // Initialize Three.js-aligned subsystems
        this._renderContexts = createRenderContextsState();
        this._attributes = createAttributesState(this.buffers);
        this._geometries = createGeometriesState(this._attributes);
        this._nodes = createNodeManagerState();
        this._bindings = createBindingsState(this.device, this.buffers, this.textures);
        this._renderObjects = createRenderObjectsState({
            nodes: this._nodes,
            geometries: this._geometries,
            bindings: this._bindings,
            pipelines: this.pipelines,
            device: this.device,
        });
        this._renderLists = createRenderListsState();

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
     * Three.js aligned: renderer.setPixelRatio()
     *
     * @param value - The pixel ratio (e.g. window.devicePixelRatio).
     */
    setPixelRatio(value: number): void {
        this._canvasTarget.setPixelRatio(value);
    }

    /**
     * Resize the canvas to logical pixel dimensions. The physical canvas size is
     * logical × pixelRatio (set via setPixelRatio()).
     *
     * Three.js aligned: renderer.setSize() expects logical pixels.
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
     * Three.js aligned: performs full pre-warming including:
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

        // Use new RenderLists system to collect visible meshes
        const renderList = collectRenderList(this._renderLists, scene, camera);
        const allItems = [...renderList.opaque, ...renderList.transparent];

        if (allItems.length === 0) return;

        // Create a temporary RenderContext for compilation
        // This is needed because RenderObjects are cached by (mesh, material, renderContext)
        const compileContext = getRenderContext(this._renderContexts, null, null, 0);
        compileContext.sampleCount = samples;
        compileContext.width = this.domElement.width || 1;
        compileContext.height = this.domElement.height || 1;

        const depthFormat = this.pipelines.depthFormat;
        const width = compileContext.width;
        const height = compileContext.height;

        // Phase 1: Kick off all async pipeline compilations in parallel
        const initPromises: Promise<boolean>[] = [];

        for (const item of allItems) {
            if (!item.mesh || !item.material || !item.geometry) continue;

            // Get or create RenderObject
            const renderObject = getRenderObject(
                this._renderObjects,
                item.mesh,
                item.material,
                scene,
                camera,
                compileContext,
                'compile',
                item.group,
            );

            // Kick off async initialization (compiles shader, creates pipeline)
            initPromises.push(
                initRenderObjectAsync(this._renderObjects, renderObject, format, depthFormat),
            );
        }

        // Wait for all pipelines to compile
        await Promise.all(initPromises);

        // Phase 2: Pre-upload all GPU resources, yielding between objects
        for (const item of allItems) {
            if (!item.mesh || !item.material || !item.geometry) continue;

            const mesh = item.mesh;
            const geometry = item.geometry;

            // Get the existing RenderObject (already created and initialized above)
            const renderObject = getRenderObject(
                this._renderObjects,
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
                // Note: Texture upload is now handled by the Bindings system (Three.js aligned)
                // See bindings.ts rebuildBindGroups() - it calls updateTexture/getSampler

                // Upload storage buffers
                for (const s of nodeState.storage) {
                    buffers.uploadStorage(this.buffers, s.node);
                }

                // Upload vertex buffers
                for (const attrEntry of nodeState.attributes) {
                    if (attrEntry.kind === 'geometry') {
                        const bufAttr = geometry.attributes.get(attrEntry.name);
                        if (bufAttr) {
                            buffers.uploadVertex(this.buffers, bufAttr);
                        }
                    } else {
                        const arr = attrEntry.node.attribute.array;
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

                // Upload index buffer if present
                if (geometry.index) {
                    buffers.uploadIndex(this.buffers, geometry.index);
                }
            }

            // Upload uniforms and rebuild bind groups
            // (must be after texture upload so bind groups can reference GPU resources)
            updateRenderObject(
                this._renderObjects,
                renderObject,
                camera,
                0, // elapsed - dummy value for pre-warming
                0, // delta - dummy value for pre-warming
                width,
                height,
            );

            // Yield to main thread between objects to keep animations smooth
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
        await pipelines.getComputeAsync(this.pipelines, computeNode.id, computeNode);
    }

    /**
     * Encode a compute dispatch for `node` using the renderer's current
     * command encoder.  Must be called **inside** a `requestAnimationFrame`
     * callback, before `renderer.render()`, so that the compute pass is
     * submitted in the same command buffer as the render pass.
     *
     * Typical usage:
     * ```ts
     * await renderer.compile(updateParticles);
     *
     * function frame() {
     *     renderer.compute(updateParticles);
     *     renderer.render(outputNode);
     *     requestAnimationFrame(frame);
     * }
     * ```
     *
     * @throws if the renderer has not been initialised.
     * @throws if the pipeline has not been compiled yet (call renderer.compile() first).
     */
    compute(node: ComputeNode): void {
        if (this._isDeviceLost) return;

        if (!this._initialized) {
            throw new Error('[WebGPURenderer] compute() called before init(). Await renderer.init() first.');
        }

        const entry = pipelines.getCompute(this.pipelines, node.id, node);

        if (!entry) {
            throw new Error(
                `[WebGPURenderer] compute() called for node "${node.id}" before its pipeline was compiled. ` +
                'Await renderer.compile(node) before entering the frame loop.',
            );
        }

        // create the per-frame encoder if it does not exist yet.
        if (!this._frameEncoder) {
            this._frameEncoder = this.device.createCommandEncoder();
        }

        this._dispatchComputeNode(node, this._frameEncoder);
    }

    /**
     * Render the given node expression as a fullscreen quad to the swapchain.
     * Runs update lifecycle callbacks for all nodes discovered at compile time,
     * renders each scene into its off-screen render target, then composites
     * the expression to the canvas.
     *
     * Call this once per animation frame. Any `renderer.compute()` calls made
     * earlier in the same frame will be submitted in the same command buffer.
     */
    render(outputNode: Node<WgslType>): void {
        if (this._isDeviceLost) return;

        if (!this._initialized) {
            throw new Error('[WebGPURenderer] render() called before init(). Await renderer.init() first.');
        }

        const now = performance.now() / 1000;
        const delta = this.lastTimestamp === 0 ? 0 : now - this.lastTimestamp;
        this.lastTimestamp = now;
        this.elapsed += delta;

        // Increment frame/render counters (sync to NodeManager for update deduplication)
        this.frameId++;
        this.renderId++;
        this._nodes.frameId = this.frameId;
        this._nodes.renderId = this.renderId;

        this.inspector.begin(this.frameId);

        // Time uniforms are now uploaded via the Bindings system per RenderObject.

        // Reuse the frame encoder if compute() was called this frame; otherwise create fresh.
        const encoder = this._frameEncoder ?? this.device.createCommandEncoder();
        this._frameEncoder = null;

        // Three.js aligned: _canvasTarget is always non-null.
        // For the default target, use MSAA. For inspector preview targets, no MSAA.
        const canvasTarget = this._canvasTarget;
        const isDefaultTarget = canvasTarget.isDefaultCanvasTarget;
        const targetFormat = isDefaultTarget ? this.format : this.format; // both use the same preferred format
        const targetSamples = isDefaultTarget ? this._samples : 1;
        const targetDepthFormat: GPUTextureFormat | undefined = isDefaultTarget ? this.pipelines.depthFormat : undefined;

        const w = canvasTarget.domElement.width || 1;
        const h = canvasTarget.domElement.height || 1;

        // Increment call ID for attribute deduplication
        incrementCallId(this._attributes);

        // ---------------------------------------------------------------------
        // Step 1: Create material and get RenderObject for fullscreen quad
        // ---------------------------------------------------------------------
        const { mat } = this._makeOutputMaterial(outputNode, targetFormat, targetSamples, targetDepthFormat);
        
        // Get fullscreen quad resources
        const fullscreenMesh = this._getFullscreenMesh(mat);
        const fullscreenScene = this._getFullscreenScene();
        const fullscreenCamera = this._getFullscreenCamera();

        // Get/create RenderContext for the fullscreen pass
        const renderContext = getRenderContext(this._renderContexts, null, null, 0);
        renderContext.sampleCount = targetSamples;
        renderContext.width = w;
        renderContext.height = h;
        renderContext.camera = fullscreenCamera;
        const [cr, cg, cb, ca] = this.clearColor;
        renderContext.clearColorValue = { r: cr, g: cg, b: cb, a: ca };

        // Get/create RenderObject for fullscreen quad
        const renderObject = getRenderObject(
            this._renderObjects,
            fullscreenMesh,
            mat,
            fullscreenScene,
            fullscreenCamera,
            renderContext,
            'composite',
        );

        // Initialize RenderObject (compile shaders, create pipeline, bindings)
        const initialized = initRenderObject(
            this._renderObjects,
            renderObject,
            targetFormat,
            targetDepthFormat ?? null,
        );

        if (!initialized || !renderObject.pipeline || !renderObject.nodeBuilderState) {
            // Pipeline compilation failed
            this.device.queue.submit([encoder.finish()]);
            this.inspector.finish(this.frameId);
            return;
        }

        const nodeState = renderObject.nodeBuilderState;

        // ---------------------------------------------------------------------
        // Step 2: Run update lifecycle callbacks
        // ---------------------------------------------------------------------
        const frame: RenderFrame = { renderer: this, encoder, width: w, height: h };

        // Notify inspector of any inspectable nodes in the compiled graph.
        for (const node of nodeState.inspectableNodes) {
            this.inspector.inspect(node);
        }

        // update() — push CPU→GPU uniform data (before draw)
        updateForRender(this._nodes, renderObject, frame);

        // updateBefore() — off-screen passes, pre-frame GPU work
        updateBefore(this._nodes, renderObject, frame);

        // ---------------------------------------------------------------------
        // Step 3: Update RenderObject uniforms and bindings
        // ---------------------------------------------------------------------

        // Note: Texture upload is now handled by the Bindings system (Three.js aligned)
        // See bindings.ts rebuildBindGroups() - it calls updateTexture/getSampler

        updateRenderObject(
            this._renderObjects,
            renderObject,
            fullscreenCamera,
            this.elapsed,
            delta,
            w,
            h,
        );

        // ---------------------------------------------------------------------
        // Step 4: Render the fullscreen quad
        // ---------------------------------------------------------------------
        this._renderOutputNodeWithRenderObject(outputNode, encoder, renderObject);

        // ---------------------------------------------------------------------
        // Step 5: updateAfter() — post-draw cleanup
        // ---------------------------------------------------------------------
        updateAfter(this._nodes, renderObject, frame);

        this.device.queue.submit([encoder.finish()]);
        this.inspector.finish(this.frameId);
    }

    private _dispatchComputeNode(
        node: ComputeNode,
        encoder: GPUCommandEncoder,
    ): void {
        const key = node.id;
        const entry: pipelines.ComputePipelineEntry | undefined = pipelines.getCompute(this.pipelines, key, node);
        if (!entry) return; // Pipeline not ready yet — skip this frame (will compile async)

        const { bindGroupInfo } = entry;

        // Upload / ensure storage buffers for all outputs.
        const gpuBuffers: GPUBuffer[] = entry.compileResult.storage.map((s: { node: Parameters<typeof buffers.uploadStorage>[1] }) =>
            buffers.uploadStorage(this.buffers, s.node),
        );

        // Encode the compute pass.
        const computePass = encoder.beginComputePass();
        this.inspector.beginCompute(node.id, this.frameId);
        computePass.setPipeline(entry.pipeline);

        // Build and set bind groups using dynamic indices (Three.js aligned)
        // Storage bind group
        const storageBindGroup = bindGroupInfo.bindGroups.find((bg: { name: string }) => bg.name === 'storage');
        if (storageBindGroup && entry.compileResult.storage.length > 0) {
            const gpuBindGroup = this.device.createBindGroup({
                layout: storageBindGroup.layout,
                entries: entry.compileResult.storage.map((s: { binding: number }, i: number) => ({
                    binding: s.binding,
                    resource: { buffer: gpuBuffers[i] },
                })),
            });
            computePass.setBindGroup(storageBindGroup.index, gpuBindGroup);
        }

        // Render (time) bind group
        const renderBindGroup = bindGroupInfo.bindGroups.find((bg: { name: string }) => bg.name === 'render');
        if (renderBindGroup) {
            const renderBlock = entry.compileResult.uniformGroups.find((g: { groupName: string }) => g.groupName === 'render');
            if (renderBlock) {
                // Create a minimal context with time values (no camera for compute)
                const context: RenderUpdateContext = {
                    camera: null as unknown as Camera, // Compute shaders don't use camera
                    elapsed: this.elapsed,
                    delta: 0, // Delta not tracked for compute currently
                    width: this.domElement.width || 1,
                    height: this.domElement.height || 1,
                };
                invokeUniformGroupCallbacks(renderBlock, context);

                const data = packUniformGroup(renderBlock);
                const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
                buffers.uploadRaw(this.buffers, this._computeRenderGroupKey, data, U);

                const renderBuf = buffers.getRaw(this.buffers, this._computeRenderGroupKey);
                if (renderBuf) {
                    const gpuBindGroup = buildRenderGroupGPUBindGroup(
                        this.device,
                        renderBindGroup,
                        renderBuf,
                    );
                    computePass.setBindGroup(renderBindGroup.index, gpuBindGroup);
                }
            }
        }

        const [dx, dy, dz] = node.dispatch;
        computePass.dispatchWorkgroups(dx, dy, dz);
        computePass.end();
        this.inspector.finishCompute(node.id, this.frameId);
    }

    /**
     * Render a scene with a camera to the current render target.
     *
     * When `setRenderTarget()` has been called, renders to that target.
     * When `setMRT()` has been called, uses MRT output mapping.
     * Otherwise renders to the swapchain (canvas).
     *
     * @param scene The scene to render.
     * @param camera The camera to render with.
     * @param encoder Optional command encoder. If not provided, a new one is created and submitted.
     * @param passId Optional pass ID for inspector tracking.
     */
    renderScene(
        scene: Scene,
        camera: Camera,
        encoder?: GPUCommandEncoder,
        passId = 'scene',
    ): void {
        if (this._isDeviceLost) return;

        if (!this._initialized) {
            throw new Error('[WebGPURenderer] renderScene() called before init().');
        }

        const renderTarget = this._renderTarget;
        const mrt = this._mrt;

        // Setup MRT if active - resolve output names to texture indices
        if (mrt && renderTarget) {
            mrt.setup((name: string) => renderTarget.getTextureIndex(name));
        }

        const ownEncoder = !encoder;
        if (!encoder) {
            encoder = this.device.createCommandEncoder();
        }

        // Determine render target parameters
        const samples = renderTarget?.samples ?? this._samples;
        const colorFormat = renderTarget?.colorFormat ?? 'rgba8unorm';

        // Notify inspector of this scene render (before beginRender so scene data is
        // available when the frame is sealed in finish()).
        this.inspector.beginRenderScene(passId, scene, samples, colorFormat, this.frameId);
        this.inspector.beginRender(passId, this.frameId);
        const depthFormat = this.pipelines.depthFormat;
        const width = this.domElement.width || 1;
        const height = this.domElement.height || 1;
        const delta = this.lastTimestamp === 0 ? 0 : performance.now() / 1000 - this.lastTimestamp;
        const [cr, cg, cb, ca] = this.clearColor;

        // Increment call ID for attribute deduplication
        incrementCallId(this._attributes);

        // ---------------------------------------------------------------------
        // Step 1: Get/create RenderContext for this pass
        // ---------------------------------------------------------------------
        const renderContext = getRenderContext(this._renderContexts, renderTarget, mrt, 0);
        // Update RenderContext with current pass configuration
        renderContext.sampleCount = samples;
        renderContext.width = width;
        renderContext.height = height;
        renderContext.camera = camera;
        renderContext.clearColorValue = { r: cr, g: cg, b: cb, a: ca };

        // ---------------------------------------------------------------------
        // Step 2: Collect visible meshes using new RenderLists system
        // ---------------------------------------------------------------------
        const renderList = collectRenderList(this._renderLists, scene, camera);

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

        const gpuPass = encoder.beginRenderPass({
            colorAttachments,
            depthStencilAttachment: depthAttachment,
        });

        // ---------------------------------------------------------------------
        // Step 4: Render items using RenderObjects system
        // ---------------------------------------------------------------------
        let currentPipeline: GPURenderPipeline | null = null;

        const issueDrawsForItems = (items: RenderItem[]) => {
            for (const item of items) {
                if (!item.mesh || !item.material || !item.geometry) continue;

                const mesh = item.mesh;
                const material = item.material;
                const geometry = item.geometry;

                // Get or create RenderObject for this (mesh, material, renderContext)
                const renderObject = getRenderObject(
                    this._renderObjects,
                    mesh,
                    material,
                    scene,
                    camera,
                    renderContext,
                    passId,
                    item.group,
                );

                // Initialize RenderObject (compile shaders, create pipeline, bindings)
                const initialized = initRenderObject(
                    this._renderObjects,
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

                // Note: Texture upload is now handled by the Bindings system (Three.js aligned)
                // See bindings.ts rebuildBindGroups() - it calls updateTexture/getSampler

                // Update RenderObject (uniforms, bind groups)
                updateRenderObject(
                    this._renderObjects,
                    renderObject,
                    camera,
                    this.elapsed,
                    delta,
                    width,
                    height,
                );

                // Set pipeline if changed
                if (renderObject.pipeline !== currentPipeline) {
                    gpuPass.setPipeline(renderObject.pipeline);
                    currentPipeline = renderObject.pipeline;
                }

                // Set bind groups
                const bindGroups = renderObject.bindGroups;
                if (bindGroups) {
                    for (let i = 0; i < bindGroups.length; i++) {
                        gpuPass.setBindGroup(i, bindGroups[i]);
                    }
                }

                // Set vertex buffers based on nodeBuilderState.attributes
                let slot = 0;
                for (const attrEntry of nodeState.attributes) {
                    if (attrEntry.kind === 'geometry') {
                        const bufAttr = geometry.attributes.get(attrEntry.name);
                        if (!bufAttr) { slot++; continue; }
                        const gpuBuf = buffers.uploadVertex(this.buffers, bufAttr);
                        gpuPass.setVertexBuffer(slot++, gpuBuf);
                    } else {
                        const node = attrEntry.node;
                        const arr = node.attribute.array;
                        if (!arr) {
                            throw new Error(`[gpucat] BufferAttributeNode array is null for ${attrEntry.name}`);
                        }
                        const gpuBuf = buffers.uploadRaw(
                            this.buffers,
                            node,
                            arr,
                            GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                        );
                        gpuPass.setVertexBuffer(slot++, gpuBuf);
                    }
                }

                // Issue draw call
                if (geometry.index) {
                    const idxBuf = buffers.uploadIndex(this.buffers, geometry.index);
                    gpuPass.setIndexBuffer(idxBuf, geometry.index.format);
                    if (geometry.indirect) {
                        const indirect = geometry.indirect;
                        const indBuf = buffers.uploadIndirect(this.buffers, indirect);
                        const byteStride = indirect.indirectStride * 4;
                        for (let d = 0; d < indirect.drawCount; d++) {
                            gpuPass.drawIndexedIndirect(indBuf, d * byteStride);
                        }
                    } else {
                        gpuPass.drawIndexed(geometry.index.array.length, mesh.count);
                    }
                } else {
                    if (geometry.indirect) {
                        const indirect = geometry.indirect;
                        const indBuf = buffers.uploadIndirect(this.buffers, indirect);
                        const byteStride = indirect.indirectStride * 4;
                        for (let d = 0; d < indirect.drawCount; d++) {
                            gpuPass.drawIndirect(indBuf, d * byteStride);
                        }
                    } else {
                        gpuPass.draw(geometry.vertexCount, mesh.count);
                    }
                }
            }
        };

        // Render opaque items first, then transparent
        issueDrawsForItems(renderList.opaque);
        issueDrawsForItems(renderList.transparent);

        gpuPass.end();
        this.inspector.finishRender(passId, this.frameId);

        // If we created the encoder ourselves, submit it now
        if (ownEncoder) {
            this.device.queue.submit([encoder.finish()]);
        }

        this.device.popErrorScope().then((err) => {
            if (err) console.error('[WebGPU renderScene validation error]', err.message);
        });
    }

    /**
     * Render a fullscreen quad using a RenderObject.
     * 
     * This is the new Three.js-aligned implementation that uses the RenderObjects system.
     * The RenderObject already has its pipeline and bind groups initialized.
     *
     * @param _outputNode - The output node (unused, for debugging)
     * @param encoder - The GPU command encoder
     * @param renderObject - The RenderObject for the fullscreen quad
     */
    private _renderOutputNodeWithRenderObject(
        _outputNode: Node<WgslType>,
        encoder: GPUCommandEncoder,
        renderObject: import('./render-object').RenderObject,
    ): void {
        this.inspector.beginRender('composite', this.frameId);

        // Three.js aligned: _canvasTarget is always non-null. Get the GPU context
        // from the current canvas target — this is the key to the swap pattern.
        // When the inspector viewer calls setCanvasTarget(previewTarget), render()
        // will write to the preview canvas instead of the main canvas.
        const canvasTarget = this._canvasTarget;
        const isDefault = canvasTarget.isDefaultCanvasTarget;

        const ctx = canvasTarget.getContext(this.device, this.format, 'opaque');
        const targetTexture = ctx.getCurrentTexture();
        const useMsaa = isDefault && this._samples > 1 && this.msaaTexture !== null;

        const [cr, cg, cb, ca] = this.clearColor;
        let colorAttachment: GPURenderPassColorAttachment;

        if (useMsaa && this.msaaTexture) {
            colorAttachment = {
                view: this.msaaTexture.createView(),
                resolveTarget: targetTexture.createView(),
                clearValue: { r: cr, g: cg, b: cb, a: ca },
                loadOp: 'clear',
                storeOp: 'discard',
            };
        } else {
            colorAttachment = {
                view: targetTexture.createView(),
                clearValue: { r: cr, g: cg, b: cb, a: ca },
                loadOp: 'clear',
                storeOp: 'store',
            };
        }

        // Depth attachment only for the default (main) canvas — preview canvases
        // render a fullscreen quad with no depth test needed.
        const depthAttachment = isDefault ? {
            view: this.depthTexture.createView(),
            depthClearValue: 1.0,
            depthLoadOp: 'clear' as const,
            depthStoreOp: 'store' as const,
        } : undefined;

        const gpuPass = encoder.beginRenderPass({
            colorAttachments: [colorAttachment],
            depthStencilAttachment: depthAttachment,
        });

        // Set pipeline from RenderObject
        gpuPass.setPipeline(renderObject.pipeline!);

        // Set bind groups from RenderObject
        const bindGroups = renderObject.bindGroups;
        if (bindGroups) {
            for (let i = 0; i < bindGroups.length; i++) {
                gpuPass.setBindGroup(i, bindGroups[i]);
            }
        }

        // Draw fullscreen triangle (3 vertices, 1 instance)
        gpuPass.draw(3, 1);

        gpuPass.end();
        this.inspector.finishRender('composite', this.frameId);
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

    private _getFullscreenGeometry(): Geometry {
        if (!this._fullscreenGeometry) {
            const geom = new Geometry();
            geom.vertexCount = 3;
            this._fullscreenGeometry = geom;
        }
        return this._fullscreenGeometry;
    }

    /**
     * Get the fullscreen quad mesh, creating it if necessary.
     * The mesh wraps the fullscreen geometry and is used with the RenderObjects system.
     * 
     * @param material - The material to use for the fullscreen quad
     */
    private _getFullscreenMesh(material: Material): Mesh {
        if (!this._fullscreenMesh) {
            const geom = this._getFullscreenGeometry();
            this._fullscreenMesh = new Mesh(geom, material);
            this._fullscreenMesh.name = '__fullscreenQuad__';
        } else {
            // Update material reference (it may change per output node)
            this._fullscreenMesh.material = material;
        }
        return this._fullscreenMesh;
    }

    /**
     * Get the dummy scene for fullscreen quad rendering, creating it if necessary.
     */
    private _getFullscreenScene(): Scene {
        if (!this._fullscreenScene) {
            this._fullscreenScene = new Scene();
            this._fullscreenScene.name = '__fullscreenScene__';
        }
        return this._fullscreenScene;
    }

    /**
     * Get the dummy camera for fullscreen quad rendering, creating it if necessary.
     */
    private _getFullscreenCamera(): Camera {
        if (!this._fullscreenCamera) {
            this._fullscreenCamera = new Camera();
            this._fullscreenCamera.name = '__fullscreenCamera__';
        }
        return this._fullscreenCamera;
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

    /**
     * Constructs the synthetic fullscreen Material used for compositing
     * `outputNode` to the swapchain. Factored out so it can be called both
     * from _renderOutputNode (at draw time) and from compile() (pre-warm).
     *
     * Returns the Material and its stable pipeline cache key.
     * The fullscreen geometry is always this._getFullscreenGeometry().
     *
     * @param outputNode - The node expression to render.
     * @param format - Target format (defaults to main swapchain format).
     * @param samples - MSAA sample count (defaults to renderer's sample count).
     */
    private _makeOutputMaterial(
        outputNode: Node<WgslType>,
        format: GPUTextureFormat = this.format,
        samples: number = this._samples,
        depthFormat: GPUTextureFormat | undefined = this.pipelines.depthFormat,
    ): { mat: Material; pipelineKey: string } {
        const cacheKey = `${outputNode.id}:${format}:${samples}:${depthFormat ?? 'none'}`;
        const cached = this._outputMaterialCache.get(cacheKey);
        if (cached) return cached;

        // Build the internal fullscreen material:
        //   position = fullscreenPosition() (uses @builtin(vertex_index))
        //   color    = outputNode wrapped to also include the UV varying in the graph
        //
        // The UV varying makes `in.uv` available in the fragment shader so that
        // textureSample(..., in.uv) calls in PassColorTextureNode work correctly.
        const posNode = _makeFullscreenPositionNode();
        const uvVarying = _makeFullscreenUVVarying();

        // Wrap outputNode so the UV varying is reachable from the color graph.
        const colorNode = wgsl(d.vec4f)`${ outputNode }`.with(uvVarying);
        const mat = new Material({ vertex: posNode, fragment: colorNode, depthWrite: false, depthTest: false });
        const pipelineKey = pipelines.makeRenderPipelineKey(mat, samples, format, depthFormat);
        const result = { mat, pipelineKey };
        this._outputMaterialCache.set(cacheKey, result);
        return result;
    }

}

/**
 * Position node for the fullscreen triangle.
 * Uses @builtin(vertex_index) to generate three clip-space positions.
 *
 * The oversized-triangle trick: three vertices whose clip-space positions cover
 * the entire viewport. Positions are derived from vertex_index via bitmasking
 * so no vertex buffer is needed.
 *
 *   vi=0 → (-1, -1)   vi=1 → (3, -1)   vi=2 → (-1, 3)
 *
 * WGSL does not support anonymous IIFEs, so the logic is expressed as a
 * named helper function emitted via FnNode, then called with CallNode.
 */
function _makeFullscreenPositionNode(): Node<'vec4f'> {
    const vi = builtin('vertex_index', 'u32');
    return wgsl(d.vec4f)`vec4f(f32((${ vi } & 1u) * 2u) * 2.0 - 1.0, f32(${ vi } & 2u) * 2.0 - 1.0, 0.0, 1.0)`;
}

/**
 * Returns a VaryingNode<'vec2f'> named 'uv' whose source computes UV from vertex_index.
 * Including this varying in the color graph ensures `in.uv` is available in the fragment
 * shader for textureSample(..., in.uv) calls.
 *
 * Standard over-sized-triangle UV: x = clip.x * 0.5 + 0.5, y = 0.5 - clip.y * 0.5
 * Inlined as a single expression — WGSL IIFEs are not valid.
 */
function _makeFullscreenUVVarying(): VaryingNode<'vec2f'> {
    const vi = builtin('vertex_index', 'u32');
    const uvSource = wgsl(d.vec2f)`vec2f((f32((${ vi } & 1u) * 2u) * 2.0 - 1.0) * 0.5 + 0.5, 0.5 - (f32(${ vi } & 2u) * 2.0 - 1.0) * 0.5)`;
    return new VaryingNode('vec2f', 'uv', uvSource);
}


/**
 * Pack uniform values from a UniformGroupBlock into a Float32Array.
 * Reads node.value for each member, handling number, number[], and Float32Array.
 * Uses the std140 byte offsets from the block's members.
 *
 * mat3x3f is handled specially: in WGSL uniform address space, each column is
 * padded to vec4 (16 bytes), so mat3x3f occupies 48 bytes (3 × 16).
 */
function packUniformGroup(block: UniformGroupBlock): Float32Array {
    const buf = new Float32Array(Math.ceil(block.totalBytes / 4));
    const bytes = new Uint8Array(buf.buffer);

    for (const member of block.members) {
        const value = member.node.value;
        if (value === null || value === undefined) continue;

        const offset = member.offset;

        if (member.type === 'mat3x3f') {
            // mat3x3f in uniform space: 3 columns × vec4 (padded) = 48 bytes
            // Input is a flat mat3 (9 floats), output is 12 floats with padding
            const src = value instanceof Float32Array ? value : new Float32Array(value as number[]);
            const f32Offset = offset / 4;
            // Column 0
            buf[f32Offset + 0] = src[0]; buf[f32Offset + 1] = src[1]; buf[f32Offset + 2] = src[2]; buf[f32Offset + 3] = 0;
            // Column 1
            buf[f32Offset + 4] = src[3]; buf[f32Offset + 5] = src[4]; buf[f32Offset + 6] = src[5]; buf[f32Offset + 7] = 0;
            // Column 2
            buf[f32Offset + 8] = src[6]; buf[f32Offset + 9] = src[7]; buf[f32Offset + 10] = src[8]; buf[f32Offset + 11] = 0;
        } else if (typeof value === 'number') {
            new DataView(bytes.buffer).setFloat32(offset, value, true);
        } else if (value instanceof Float32Array) {
            bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), offset);
        } else if (Array.isArray(value)) {
            const fa = new Float32Array(value);
            bytes.set(new Uint8Array(fa.buffer), offset);
        }
    }

    return buf;
}

/**
 * Invoke update callbacks on all UniformNodes in a uniform group block.
 * - For renderGroup uniforms: pass RenderUpdateContext { camera, elapsed, delta }
 * - For objectGroup uniforms: pass ObjectUpdateContext { object }
 *
 * Each callback returns the value to assign to node.value.
 */
function invokeUniformGroupCallbacks(
    block: UniformGroupBlock,
    context: RenderUpdateContext | ObjectUpdateContext,
): void {
    for (const member of block.members) {
        const node = member.node;
        if (node.update) {
            const result = node.update(context);
            if (result !== undefined) {
                node.value = result as typeof node.value;
                node.version++;
            }
        }
    }
}
