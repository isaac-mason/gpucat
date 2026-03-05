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

import type { Mesh } from '../scene/mesh';
import { BufferCache } from './buffers';
import { PipelineCache, makePipelineKey, type PipelineEntry } from './pipeline';
import {
    buildRenderGroupGPUBindGroup,
    buildObjectGroupGPUBindGroup,
} from './bindgroups';
import { collectDraws, type DrawCall } from './collect';
import { Material } from '../scene/material';
import { Geometry } from '../scene/geometry';
import { raw, builtin, type Node, type WgslType, VaryingNode, RawNode } from '../nodes/nodes';

import { ComputeNode } from '../nodes/nodes';
import { ComputePipelineCache, type ComputePipelineEntry } from './compute-pipeline';
import type { CompileResult, UpdateBeforeNode, UpdateAfterNode, UpdateNode, UniformGroupBlock } from '../nodes/compile';
import type { RenderFrame, RenderUpdateContext, ObjectUpdateContext } from './render-frame';
import type { Scene } from '../scene/scene';
import type { Camera } from '../scene/camera';
import { InspectorBase } from '../inspector/inspector-base';

// ---------------------------------------------------------------------------
// Uniform group packing helpers (Phase 3d)
// ---------------------------------------------------------------------------

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

export class WebGPURenderer {
    /** The canvas element managed by this renderer. Append to the DOM yourself. */
    readonly domElement: HTMLCanvasElement;

    /** The GPUAdapter, available after init(). */
    adapter!: GPUAdapter;

    /** The GPUDevice, available after init(). */
    device!: GPUDevice;

    private context!: GPUCanvasContext;
    private format!: GPUTextureFormat;

    private readonly _samples: number;
    private readonly _adapterOptions: GPURequestAdapterOptions | undefined;
    private readonly _deviceDescriptor: GPUDeviceDescriptor | undefined;

    /** @internal */ buffers!: BufferCache;
    /** @internal */ pipelines!: PipelineCache;
    /** @internal */ computePipelines!: ComputePipelineCache;

    /** Inspector hook. Replace with a RendererInspector or Inspector instance to enable profiling. */
    public inspector: InspectorBase = new InspectorBase();

    private _initialized = false;

    /** Swapchain depth texture (recreated on resize). */
    private depthTexture!: GPUTexture;
    /** MSAA color texture (null when samples <= 1). Only used for swapchain passes. */
    private msaaTexture: GPUTexture | null = null;

    // -----------------------------------------------------------------------
    // New uniform group buffer state (Phase 3d)
    // -----------------------------------------------------------------------

    /**
     * GPU buffer key for the shared renderGroup struct UBO.
     * All camera + time uniforms are packed into a single buffer.
     */
    private readonly _renderGroupKey: object = {};

    /**
     * GPU buffer key for compute shader renderGroup struct UBO.
     * Separate from render because compute shaders don't have camera.
     */
    private readonly _computeRenderGroupKey: object = {};

    /**
     * Last-uploaded version sum for the renderGroup dirty check.
     * Key: groupName. Value: sum of member.node.version at last upload.
     */
    private _renderGroupVersionSum: number = 0;

    /**
     * Per-mesh GPU buffer key for the objectGroup struct UBO.
     * Contains modelWorldMatrix, modelNormalMatrix, and user material uniforms.
     */
    private readonly _objectGroupKeys: WeakMap<Mesh, object> = new WeakMap();

    /**
     * Per-mesh last-uploaded version sum for objectGroup dirty check.
     */
    private readonly _objectGroupVersionSums: WeakMap<Mesh, number> = new WeakMap();


    /** Elapsed time in seconds. */
    private elapsed = 0;
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

    /**
     * Per-frame/render deduplication map for updateBefore() calls.
     * Mirrors three NodeFrame.updateBeforeMap (WeakMap<node, {frameId, renderId}>).
     */
    private _updateBeforeMap: WeakMap<object, { frameId: number; renderId: number }> = new WeakMap();

    /**
     * Per-frame/render deduplication map for updateAfter() calls.
     * Mirrors three NodeFrame.updateAfterMap.
     */
    private _updateAfterMap: WeakMap<object, { frameId: number; renderId: number }> = new WeakMap();

    /**
     * Per-frame/render deduplication map for update() calls.
     * Mirrors three NodeFrame.updateMap.
     */
    private _updateMap: WeakMap<object, { frameId: number; renderId: number }> = new WeakMap();

    /**
     * Pending command encoder shared between compute() and render() within a single frame.
     * Created lazily by compute() and consumed (submitted + nulled) by render().
     */
    private _frameEncoder: GPUCommandEncoder | null = null;

    /** Clear color for the final swapchain composite pass. Defaults to opaque black. */
    clearColor: [number, number, number, number] = [0, 0, 0, 1];

    // -----------------------------------------------------------------------
    // Internal fullscreen quad state
    // -----------------------------------------------------------------------

    /** Geometry for the internal fullscreen triangle. Created once on first use. */
    private _fullscreenGeometry: Geometry | null = null;

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

        this.domElement = document.createElement('canvas');
        this.domElement.style.display = 'block';
    }

    get samples(): number {
        return this._samples;
    }

    // -----------------------------------------------------------------------
    // init()
    // -----------------------------------------------------------------------

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

        // Request optional features that gpucat relies on when available.
        // 'indirect-first-instance': allows firstInstance > 0 inside indirect draw
        // buffers (drawIndirect / drawIndexedIndirect). Without this feature the
        // GPU silently drops any indirect draw whose firstInstance field is non-zero,
        // which breaks multi-shape batching patterns that split instance ranges.
        const wantedFeatures: GPUFeatureName[] = ['indirect-first-instance', 'timestamp-query'];
        const requiredFeatures: GPUFeatureName[] = wantedFeatures.filter(
            (f) => adapter.features.has(f),
        );

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

        const context = this.domElement.getContext('webgpu');
        if (!context) throw new Error('[WebGPURenderer] Failed to get WebGPU canvas context.');
        this.context = context;

        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });

        this.buffers = new BufferCache(this.device);
        this.pipelines = new PipelineCache(this.device, this.format);
        this.computePipelines = new ComputePipelineCache(this.device);

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

    // -----------------------------------------------------------------------
    // setSize()
    // -----------------------------------------------------------------------

    /**
     * Resize the canvas and recreate swapchain depth/MSAA textures.
     *
     * The caller is responsible for updating camera.aspect and calling
     * camera.updateProjectionMatrix() if applicable.
     */
    setSize(width: number, height: number): void {
        this.domElement.width = width;
        this.domElement.height = height;

        if (!this._initialized) return;

        this.depthTexture?.destroy();
        this.depthTexture = this._createDepthTexture(width, height);

        if (this._samples > 1) {
            this.msaaTexture?.destroy();
            this.msaaTexture = this._createMsaaTexture(width, height);
        }
    }

    // -----------------------------------------------------------------------
    // render() — public entry point
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // compile() — pre-warm pipelines before the render loop
    // -----------------------------------------------------------------------

    /**
     * Pre-compile all WebGPU render pipelines for a scene before the render
     * loop starts. This is optional — pipelines are compiled on-demand during
     * the first render if not pre-warmed.
     *
     * Mirrors Three.js `renderer.compileAsync(scene, camera)`.
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

        const promises: Promise<unknown>[] = [];
        const { opaque, transparent } = collectDraws(scene, camera, samples, format);

        for (const draw of [...opaque, ...transparent]) {
            const { mesh } = draw;
            const key = makePipelineKey(mesh.material, samples, format);
            promises.push(
                this.pipelines.getAsync(key, mesh.material, mesh.geometry, samples, format),
            );
        }

        await Promise.all(promises);
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
        await this.computePipelines.getAsync(computeNode.id, computeNode);
    }

    // -----------------------------------------------------------------------
    // compute() — encode a single compute dispatch into the current frame
    // -----------------------------------------------------------------------

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
        if (!this._initialized) {
            throw new Error('[WebGPURenderer] compute() called before init(). Await renderer.init() first.');
        }
        const entry = this.computePipelines.get(node.id, node);
        if (!entry) {
            throw new Error(
                `[WebGPURenderer] compute() called for node "${node.id}" before its pipeline was compiled. ` +
                'Await renderer.compile(node) before entering the frame loop.',
            );
        }
        // Lazily create the per-frame encoder if it does not exist yet.
        if (!this._frameEncoder) {
            this._frameEncoder = this.device.createCommandEncoder();
        }
        this._dispatchComputeNode(node, this._frameEncoder);
    }

    // -----------------------------------------------------------------------
    // render() — public entry point
    // -----------------------------------------------------------------------

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
        if (!this._initialized) {
            throw new Error('[WebGPURenderer] render() called before init(). Await renderer.init() first.');
        }

        const now = performance.now() / 1000;
        const delta = this.lastTimestamp === 0 ? 0 : now - this.lastTimestamp;
        this.lastTimestamp = now;
        this.elapsed += delta;

        // Increment frame/render counters (mirrors three NodeFrame.update()).
        this.frameId++;
        this.renderId++;

        this.inspector.begin(this.frameId);

        // Time uniforms are now uploaded via _uploadRenderGroup() per compile result.

        // Reuse the frame encoder if compute() was called this frame; otherwise create fresh.
        const encoder = this._frameEncoder ?? this.device.createCommandEncoder();
        this._frameEncoder = null;

        const w = this.domElement.width || 1;
        const h = this.domElement.height || 1;

        // 1. Ensure pipeline is compiled first, so we have CompileResult for callbacks.
        //    This is a synchronous call that compiles on first invocation.
        const { mat, pipelineKey } = this._makeOutputMaterial(outputNode);
        const fullscreenGeom = this._getFullscreenGeometry();
        const entry = this.pipelines.get(pipelineKey, mat, fullscreenGeom, this._samples, this.format);
        
        if (!entry) {
            // Pipeline compilation failed or is still pending async
            this.device.queue.submit([encoder.finish()]);
            this.inspector.finish(this.frameId);
            return;
        }

        const cr = entry.compileResult;

        // 2. Run update lifecycle callbacks for all nodes discovered at compile time.
        //    Mirrors three NodeFrame.updateBeforeNode / updateAfterNode / updateNode
        //    dedup logic: FRAME nodes fire once per frameId, RENDER nodes fire once per
        //    renderId, OBJECT nodes fire unconditionally.
        const frame: RenderFrame = { renderer: this, encoder, width: w, height: h };

        // Notify inspector of any inspectable nodes in the compiled graph.
        for (const node of cr.inspectableNodes) {
            this.inspector.inspect(node);
        }

        // update() — push CPU→GPU uniform data (before draw)
        for (const node of cr.updateNodes) {
            this._callUpdateNode(node, frame);
        }

        // updateBefore() — off-screen passes, pre-frame GPU work
        for (const node of cr.updateBeforeNodes) {
            this._callUpdateBeforeNode(node, frame);
        }

        // 3. Render the outputNode expression as a fullscreen quad to the swapchain.
        this._renderOutputNodeWithEntry(outputNode, encoder, entry);

        // 4. updateAfter() — post-draw cleanup (mirrors three _renderObjectDirect updateAfter)
        for (const node of cr.updateAfterNodes) {
            this._callUpdateAfterNode(node, frame);
        }

        this.device.queue.submit([encoder.finish()]);
        this.inspector.finish(this.frameId);
    }

    // -----------------------------------------------------------------------
    // NodeFrame-mirroring update dispatch helpers
    // -----------------------------------------------------------------------

    /**
     * Dispatch updateBefore() for a node, deduplicating by frameId or renderId.
     * Mirrors three NodeFrame.updateBeforeNode().
     */
    private _callUpdateBeforeNode(node: UpdateBeforeNode, frame: RenderFrame): void {
        const type = node.updateBeforeType;
        if (type === 'none') return;

        const maps = this._getUpdateMaps(this._updateBeforeMap, node);

        if (type === 'frame') {
            if (maps.frameId !== this.frameId) {
                const prev = maps.frameId;
                maps.frameId = this.frameId;
                if (node.updateBefore(frame) === false) {
                    maps.frameId = prev;
                }
            }
        } else if (type === 'render') {
            if (maps.renderId !== this.renderId) {
                const prev = maps.renderId;
                maps.renderId = this.renderId;
                if (node.updateBefore(frame) === false) {
                    maps.renderId = prev;
                }
            }
        } else if (type === 'object') {
            node.updateBefore(frame);
        }
    }

    /**
     * Dispatch updateAfter() for a node, deduplicating by frameId or renderId.
     * Mirrors three NodeFrame.updateAfterNode().
     */
    private _callUpdateAfterNode(node: UpdateAfterNode, frame: RenderFrame): void {
        const type = node.updateAfterType;
        if (type === 'none') return;

        const maps = this._getUpdateMaps(this._updateAfterMap, node);

        if (type === 'frame') {
            if (maps.frameId !== this.frameId) {
                if (node.updateAfter(frame) !== false) {
                    maps.frameId = this.frameId;
                }
            }
        } else if (type === 'render') {
            if (maps.renderId !== this.renderId) {
                if (node.updateAfter(frame) !== false) {
                    maps.renderId = this.renderId;
                }
            }
        } else if (type === 'object') {
            node.updateAfter(frame);
        }
    }

    /**
     * Dispatch update() for a node, deduplicating by frameId or renderId.
     * Mirrors three NodeFrame.updateNode().
     */
    private _callUpdateNode(node: UpdateNode, frame: RenderFrame): void {
        const type = node.updateType;
        if (type === 'none') return;

        const maps = this._getUpdateMaps(this._updateMap, node);

        if (type === 'frame') {
            if (maps.frameId !== this.frameId) {
                if (node.update(frame) !== false) {
                    maps.frameId = this.frameId;
                }
            }
        } else if (type === 'render') {
            if (maps.renderId !== this.renderId) {
                if (node.update(frame) !== false) {
                    maps.renderId = this.renderId;
                }
            }
        } else if (type === 'object') {
            node.update(frame);
        }
    }

    /**
     * Get or create the {frameId, renderId} tracking record for a node in the given map.
     * Mirrors three NodeFrame._getMaps().
     */
    private _getUpdateMaps(
        map: WeakMap<object, { frameId: number; renderId: number }>,
        node: object,
    ): { frameId: number; renderId: number } {
        let maps = map.get(node);
        if (maps === undefined) {
            maps = { frameId: 0, renderId: 0 };
            map.set(node, maps);
        }
        return maps;
    }

    // -----------------------------------------------------------------------
    // _dispatchComputeNode — encode a single compute dispatch
    // -----------------------------------------------------------------------

    private _dispatchComputeNode(
        node: ComputeNode,
        encoder: GPUCommandEncoder,
    ): void {
        const key = node.id;
        const entry: ComputePipelineEntry | undefined = this.computePipelines.get(key, node);
        if (!entry) return; // Pipeline not ready yet — skip this frame (will compile async)

        const { bindGroupInfo } = entry;

        // Upload / ensure storage buffers for all outputs.
        const gpuBuffers: GPUBuffer[] = entry.compileResult.storage.map((s) =>
            this.buffers.uploadStorage(s.node),
        );

        // Encode the compute pass.
        const computePass = encoder.beginComputePass();
        this.inspector.beginCompute(node.id, this.frameId);
        computePass.setPipeline(entry.pipeline);

        // Build and set bind groups using dynamic indices (Three.js aligned)
        // Storage bind group
        const storageBindGroup = bindGroupInfo.bindGroups.find(bg => bg.name === 'storage');
        if (storageBindGroup && entry.compileResult.storage.length > 0) {
            const gpuBindGroup = this.device.createBindGroup({
                layout: storageBindGroup.layout,
                entries: entry.compileResult.storage.map((s, i) => ({
                    binding: s.binding,
                    resource: { buffer: gpuBuffers[i] },
                })),
            });
            computePass.setBindGroup(storageBindGroup.index, gpuBindGroup);
        }

        // Render (time) bind group
        const renderBindGroup = bindGroupInfo.bindGroups.find(bg => bg.name === 'render');
        if (renderBindGroup) {
            const renderBlock = entry.compileResult.uniformGroups.find(g => g.groupName === 'render');
            if (renderBlock) {
                // Create a minimal context with time values (no camera for compute)
                const context: RenderUpdateContext = {
                    camera: null as unknown as Camera, // Compute shaders don't use camera
                    elapsed: this.elapsed,
                    delta: 0, // Delta not tracked for compute currently
                };
                invokeUniformGroupCallbacks(renderBlock, context);

                const data = packUniformGroup(renderBlock);
                const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
                this.buffers.uploadRaw(this._computeRenderGroupKey, data, U);

                const renderBuf = this.buffers.getRaw(this._computeRenderGroupKey);
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

    // -----------------------------------------------------------------------
    // renderScene() — public entry point called by PassNode.updateBefore()
    // -----------------------------------------------------------------------

    /**
     * Render a scene + camera into caller-supplied color + depth textures.
     * Called by PassNode.updateBefore(frame) via frame.renderer.renderScene(...).
     *
     * This is the same logic as the old _renderPassNode() but exposed publicly
     * so PassNode can drive it without needing access to renderer internals.
     */
    renderScene(
        scene: Scene,
        camera: Camera,
        encoder: GPUCommandEncoder,
        colorTex: GPUTexture,
        depthTex: GPUTexture,
        clearColor: [number, number, number, number],
        colorFormat: GPUTextureFormat,
    ): void {
        const PASS_SAMPLES = 1;

        const { opaque, transparent } = collectDraws(scene, camera, PASS_SAMPLES, colorFormat);
        const allDraws = [...opaque, ...transparent];

        for (const draw of allDraws) {
            this._prepareMesh(draw.mesh);
        }

        const [cr, cg, cb, ca] = clearColor;
        const colorAttachment: GPURenderPassColorAttachment = {
            view: colorTex.createView(),
            clearValue: { r: cr, g: cg, b: cb, a: ca },
            loadOp: 'clear',
            storeOp: 'store',
        };
        const depthAttachment: GPURenderPassDepthStencilAttachment = {
            view: depthTex.createView(),
            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
        };

        this.device.pushErrorScope('validation');

        const gpuPass = encoder.beginRenderPass({
            colorAttachments: [colorAttachment],
            depthStencilAttachment: depthAttachment,
        });

        let currentPipelineKey: string | null = null;
        let currentRenderBindGroupIndex: number = -1;

        const issueDraws = (draws: DrawCall[]) => {
            for (const draw of draws) {
                const { mesh } = draw;
                const entry = this.pipelines.get(
                    draw.pipelineKey,
                    mesh.material,
                    mesh.geometry,
                    PASS_SAMPLES,
                    colorFormat,
                );
                if (!entry) continue;

                const { bindGroupInfo } = entry;

                if (draw.pipelineKey !== currentPipelineKey) {
                    gpuPass.setPipeline(entry.pipeline);
                    currentPipelineKey = draw.pipelineKey;

                    // Set render bind group if present (Three.js aligned - use dynamic index)
                    const renderBg = bindGroupInfo.bindGroups.find(bg => bg.name === 'render');
                    if (renderBg && renderBg.index !== currentRenderBindGroupIndex) {
                        currentRenderBindGroupIndex = renderBg.index;
                        // Upload render group (camera + time) uniforms using new struct-based approach
                        this._uploadRenderGroup(entry.compileResult, camera, this.elapsed, this.lastTimestamp === 0 ? 0 : performance.now() / 1000 - this.lastTimestamp);
                        const renderBuf = this._getRenderGroupBuffer();
                        if (renderBuf) {
                            const gpuBindGroup = buildRenderGroupGPUBindGroup(
                                this.device,
                                renderBg,
                                renderBuf,
                            );
                            gpuPass.setBindGroup(renderBg.index, gpuBindGroup);
                        }
                    }
                }

                // Upload object group (mesh matrices + material) uniforms using new struct-based approach
                // Set object bind group if present (Three.js aligned - use dynamic index)
                const objectBg = bindGroupInfo.bindGroups.find(bg => bg.name === 'object');
                if (objectBg) {
                    this._uploadObjectGroup(entry.compileResult, mesh);
                    const objectBuf = this._getObjectGroupBuffer(mesh);
                    const gpuBindGroup = buildObjectGroupGPUBindGroup(
                        this.device,
                        objectBg,
                        entry.compileResult,
                        objectBuf,
                        this.buffers,
                    );
                    gpuPass.setBindGroup(objectBg.index, gpuBindGroup);
                }

                let slot = 0;
                for (const attrEntry of entry.compileResult.attributes) {
                    if (attrEntry.kind === 'geometry') {
                        const bufAttr = mesh.geometry.attributes.get(attrEntry.name);
                        if (!bufAttr) { slot++; continue; }
                        const gpuBuf = this.buffers.uploadVertex(bufAttr);
                        gpuPass.setVertexBuffer(slot++, gpuBuf);
                    } else {
                        const node = attrEntry.node;
                        const arr = node.attribute.array;
                        if (!arr) {
                            throw new Error(`[gpucat] BufferAttributeNode array is null for ${attrEntry.name}`);
                        }
                        const gpuBuf = this.buffers.uploadRaw(
                            node,
                            arr,
                            GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                        );
                        gpuPass.setVertexBuffer(slot++, gpuBuf);
                    }
                }

                if (mesh.geometry.index) {
                    const idxBuf = this.buffers.uploadIndex(mesh.geometry.index);
                    gpuPass.setIndexBuffer(idxBuf, mesh.geometry.index.format);
                    if (mesh.geometry.indirect) {
                        const indirect = mesh.geometry.indirect;
                        const indBuf   = this.buffers.uploadIndirect(indirect);
                        const byteStride = indirect.stride * 4;
                        for (let d = 0; d < indirect.drawCount; d++) {
                            gpuPass.drawIndexedIndirect(indBuf, d * byteStride);
                        }
                    } else {
                        gpuPass.drawIndexed(mesh.geometry.index.data.length, mesh.count);
                    }
                } else {
                    if (mesh.geometry.indirect) {
                        const indirect = mesh.geometry.indirect;
                        const indBuf   = this.buffers.uploadIndirect(indirect);
                        const byteStride = indirect.stride * 4;
                        for (let d = 0; d < indirect.drawCount; d++) {
                            gpuPass.drawIndirect(indBuf, d * byteStride);
                        }
                    } else {
                        gpuPass.draw(mesh.geometry.vertexCount, mesh.count);
                    }
                }
            }
        };

        issueDraws(opaque);
        issueDraws(transparent);

        gpuPass.end();

        this.device.popErrorScope().then((err) => {
            if (err) console.error('[WebGPU renderScene validation error]', err.message);
        });
    }

    // -----------------------------------------------------------------------
    // _renderOutputNodeWithEntry — render the outputNode expression as a fullscreen quad
    // -----------------------------------------------------------------------

    private _renderOutputNodeWithEntry(
        _outputNode: Node<WgslType>,
        encoder: GPUCommandEncoder,
        entry: PipelineEntry,
    ): void {
        // Build the swapchain render pass.
        const swapchainView = this.context.getCurrentTexture().createView();
        const [cr, cg, cb, ca] = this.clearColor;
        let colorAttachment: GPURenderPassColorAttachment;
        if (this._samples > 1 && this.msaaTexture) {
            colorAttachment = {
                view: this.msaaTexture.createView(),
                resolveTarget: swapchainView,
                clearValue: { r: cr, g: cg, b: cb, a: ca },
                loadOp: 'clear',
                storeOp: 'discard',
            };
        } else {
            colorAttachment = {
                view: swapchainView,
                clearValue: { r: cr, g: cg, b: cb, a: ca },
                loadOp: 'clear',
                storeOp: 'store',
            };
        }

        const gpuPass = encoder.beginRenderPass({
            colorAttachments: [colorAttachment],
            depthStencilAttachment: {
                view: this.depthTexture.createView(),
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        });

        const { compileResult, bindGroupInfo } = entry;

        // Upload render group (time uniforms) using new struct-based approach
        // Fullscreen quads typically don't have a camera, but may use time
        // We pass a dummy camera context — the callbacks will only be invoked
        // if the render group exists
        this._uploadRenderGroup(compileResult, null as unknown as Camera, this.elapsed, this.lastTimestamp === 0 ? 0 : performance.now() / 1000 - this.lastTimestamp);
        
        // Set render bind group if present (Three.js aligned - use dynamic index)
        const renderBg = bindGroupInfo.bindGroups.find(bg => bg.name === 'render');
        if (renderBg) {
            const renderBuf = this._getRenderGroupBuffer();
            if (renderBuf) {
                const gpuBindGroup = buildRenderGroupGPUBindGroup(
                    this.device,
                    renderBg,
                    renderBuf,
                );
                gpuPass.setBindGroup(renderBg.index, gpuBindGroup);
            }
        }

        // Set object bind group if present (Three.js aligned - use dynamic index)
        const objectBg = bindGroupInfo.bindGroups.find(bg => bg.name === 'object');
        if (objectBg) {
            // For fullscreen quads, use _uploadFullscreenObjectGroup which handles the case
            // where there's no mesh but there may be textures/samplers
            this._uploadFullscreenObjectGroup(compileResult);
            const objectBuf = this._getFullscreenObjectGroupBuffer();
            const gpuBindGroup = buildObjectGroupGPUBindGroup(
                this.device,
                objectBg,
                compileResult,
                objectBuf,
                this.buffers,
            );
            gpuPass.setBindGroup(objectBg.index, gpuBindGroup);
        }

        gpuPass.setPipeline(entry.pipeline);
        gpuPass.draw(3, 1);

        gpuPass.end();
    }

    // -----------------------------------------------------------------------
    // _prepareMesh — upload geometry buffers only
    // Mesh matrices and material uniforms are handled by _uploadObjectGroup
    // -----------------------------------------------------------------------

    private _prepareMesh(mesh: Mesh): void {
        for (const attr of mesh.geometry.attributes.values()) {
            if (attr.needsUpdate) this.buffers.uploadVertex(attr);
        }
        if (mesh.geometry.index?.needsUpdate) {
            this.buffers.uploadIndex(mesh.geometry.index);
        }
    }

    // -----------------------------------------------------------------------
    // Fullscreen geometry
    // -----------------------------------------------------------------------

    private _getFullscreenGeometry(): Geometry {
        if (!this._fullscreenGeometry) {
            const geom = new Geometry();
            geom.vertexCount = 3;
            this._fullscreenGeometry = geom;
        }
        return this._fullscreenGeometry;
    }

    // -----------------------------------------------------------------------
    // GPU texture helpers
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // _makeOutputMaterial — build the fullscreen composite Material + pipeline key
    // -----------------------------------------------------------------------

    /**
     * Constructs the synthetic fullscreen Material used for compositing
     * `outputNode` to the swapchain. Factored out so it can be called both
     * from _renderOutputNode (at draw time) and from compile() (pre-warm).
     *
     * Returns the Material and its stable pipeline cache key.
     * The fullscreen geometry is always this._getFullscreenGeometry().
     */
    private _makeOutputMaterial(outputNode: Node<WgslType>): { mat: Material; pipelineKey: string } {
        // Build the internal fullscreen material:
        //   position = fullscreenPosition() (uses @builtin(vertex_index))
        //   color    = outputNode wrapped to also include the UV varying in the graph
        //
        // The UV varying makes `in.uv` available in the fragment shader so that
        // textureSample(..., in.uv) calls in PassColorTextureNode work correctly.
        const posNode = _makeFullscreenPositionNode();
        const uvVarying = _makeFullscreenUVVarying();

        // Wrap outputNode so the UV varying is reachable from the color graph.
        const colorNode = new RawNode<'vec4f'>('vec4f', '$0', [outputNode, uvVarying]);
        const mat = new Material({ position: posNode, color: colorNode, depthWrite: false, depthTest: false });
        const pipelineKey = makePipelineKey(mat, this._samples, this.format);
        return { mat, pipelineKey };
    }

    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // New uniform group upload methods (Phase 3d)
    // -----------------------------------------------------------------------

    /**
     * Upload the renderGroup struct UBO (camera + time uniforms).
     * Invokes update callbacks, packs all values, and uploads to a single buffer.
     *
     * @param cr The CompileResult containing uniformGroups
     * @param camera The current camera
     * @param elapsed Elapsed time in seconds
     * @param delta Delta time in seconds
     */
    _uploadRenderGroup(cr: CompileResult, camera: Camera, elapsed: number, delta: number): void {
        const renderBlock = cr.uniformGroups.find(g => g.groupName === 'render');
        if (!renderBlock) return;

        const context: RenderUpdateContext = { camera, elapsed, delta };

        // Invoke update callbacks on all uniforms in the render group
        invokeUniformGroupCallbacks(renderBlock, context);

        // Compute version sum for dirty check
        let versionSum = 0;
        for (const m of renderBlock.members) {
            versionSum += m.node.version;
        }

        // Skip upload if nothing changed
        if (versionSum === this._renderGroupVersionSum) return;

        // Pack and upload
        const data = packUniformGroup(renderBlock);
        const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
        this.buffers.uploadRaw(this._renderGroupKey, data, U);
        this._renderGroupVersionSum = versionSum;
    }

    /**
     * Get the GPU buffer for the renderGroup struct UBO.
     */
    _getRenderGroupBuffer(): GPUBuffer | null {
        return this.buffers.getRaw(this._renderGroupKey) ?? null;
    }

    /**
     * Upload the objectGroup struct UBO for a specific mesh.
     * Invokes update callbacks, packs all values, and uploads to a per-mesh buffer.
     *
     * @param cr The CompileResult containing uniformGroups
     * @param mesh The mesh being rendered
     */
    _uploadObjectGroup(cr: CompileResult, mesh: Mesh): void {
        const objectBlock = cr.uniformGroups.find(g => g.groupName === 'object');
        if (!objectBlock) return;

        const context: ObjectUpdateContext = { object: mesh };

        // Invoke update callbacks on all uniforms in the object group
        invokeUniformGroupCallbacks(objectBlock, context);

        // Compute version sum for dirty check (include mesh.matrixVersion)
        let versionSum = mesh.matrixVersion;
        for (const m of objectBlock.members) {
            versionSum += m.node.version;
        }

        // Get or create buffer key for this mesh
        let key = this._objectGroupKeys.get(mesh);
        if (!key) {
            key = {};
            this._objectGroupKeys.set(mesh, key);
        }

        // Skip upload if nothing changed
        if (this._objectGroupVersionSums.get(mesh) === versionSum) return;

        // Pack and upload
        const data = packUniformGroup(objectBlock);
        const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
        this.buffers.uploadRaw(key, data, U);
        this._objectGroupVersionSums.set(mesh, versionSum);
    }

    /**
     * Get the GPU buffer for the objectGroup struct UBO for a specific mesh.
     */
    _getObjectGroupBuffer(mesh: Mesh): GPUBuffer | null {
        const key = this._objectGroupKeys.get(mesh);
        return key ? (this.buffers.getRaw(key) ?? null) : null;
    }

    /**
     * GPU buffer key for fullscreen quad object group.
     * Fullscreen quads have no mesh but may have material uniforms.
     */
    private readonly _fullscreenObjectGroupKey: object = {};

    /**
     * Last-uploaded version sum for fullscreen object group dirty check.
     */
    private _fullscreenObjectGroupVersionSum: number = 0;

    /**
     * Upload the objectGroup struct UBO for the fullscreen quad.
     * Fullscreen quads have no mesh matrices but may have user material uniforms.
     *
     * @param cr The CompileResult containing uniformGroups
     */
    _uploadFullscreenObjectGroup(cr: CompileResult): void {
        const objectBlock = cr.uniformGroups.find(g => g.groupName === 'object');
        if (!objectBlock || objectBlock.members.length === 0) return;

        // Invoke update callbacks (no mesh context for fullscreen quads)
        // Note: fullscreen quads shouldn't have mesh-dependent uniforms
        // invokeUniformGroupCallbacks would need a context, so we skip it for fullscreen
        // User uniforms should have their values set directly

        // Compute version sum for dirty check
        let versionSum = 0;
        for (const m of objectBlock.members) {
            versionSum += m.node.version;
        }

        // Skip upload if nothing changed
        if (versionSum === this._fullscreenObjectGroupVersionSum) return;

        // Pack and upload
        const data = packUniformGroup(objectBlock);
        const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
        this.buffers.uploadRaw(this._fullscreenObjectGroupKey, data, U);
        this._fullscreenObjectGroupVersionSum = versionSum;
    }

    /**
     * Get the GPU buffer for the fullscreen quad's objectGroup struct UBO.
     */
    _getFullscreenObjectGroupBuffer(): GPUBuffer | null {
        return this.buffers.getRaw(this._fullscreenObjectGroupKey) ?? null;
    }

}

// ---------------------------------------------------------------------------
// Internal fullscreen quad helpers
// ---------------------------------------------------------------------------

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
    // Inline: vec4f(f32((vi & 1u) * 2u) * 2.0 - 1.0,  f32(vi & 2u) * 2.0 - 1.0,  0.0, 1.0)
    // Using raw with $0 substituted for vertex_index — single expression, no let needed.
    return raw(
        'vec4f',
        'vec4f(f32(($0 & 1u) * 2u) * 2.0 - 1.0, f32($0 & 2u) * 2.0 - 1.0, 0.0, 1.0)',
        vi,
    );
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
    // cx = f32((vi & 1u) * 2u) * 2.0 - 1.0
    // cy = f32(vi & 2u) * 2.0 - 1.0
    // uv = vec2f(cx * 0.5 + 0.5, 0.5 - cy * 0.5)
    const uvSource = raw(
        'vec2f',
        [
            'vec2f(',
            '  (f32(($0 & 1u) * 2u) * 2.0 - 1.0) * 0.5 + 0.5,',
            '  0.5 - (f32($0 & 2u) * 2.0 - 1.0) * 0.5',
            ')',
        ].join(' '),
        vi,
    );
    return new VaryingNode('vec2f', 'uv', uvSource);
}
