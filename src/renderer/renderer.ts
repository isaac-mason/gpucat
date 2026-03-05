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
 *   1. Advance time, upload Time UBO (group 0)
 *   2. Collect all PassNodes from outputNode graph (BFS via collectPassNodes)
 *   3. For each PassNode:
 *      a. _ensureTarget(device, w, h) — lazy texture allocation
 *      b. (transforms must be updated by the caller before renderer.render())
 *      c. collectDraws — opaque sorted by pipeline key, transparent back-to-front
 *      d. Per-mesh: upload vertex/index buffers, Mesh UBO, material UBO
 *      e. Begin render pass into passNode's color+depth textures, issue draws, end pass
 *   4. _renderOutputNode — compile outputNode as fullscreen quad color, render to swapchain
 *   5. queue.submit([encoder.finish()]) — one submit per frame
 */

import type { Mesh } from '../scene/mesh.js';
import { mat3 } from 'mathcat';
import { BufferCache } from './buffers.js';
import { PipelineCache, makePipelineKey } from './pipeline.js';
import { buildFrameBindGroup, buildMeshBindGroup, packMaterialUBO, type FrameBuffers } from './bindgroups.js';
import { collectDraws, type DrawCall } from './collect.js';
import { Material } from '../scene/material.js';
import { Geometry } from '../scene/geometry.js';
import { raw, builtin, type Node, type WgslType, VaryingNode, RawNode } from '../nodes/nodes.js';
import { collectPassNodes, type PassNode } from '../nodes/pass-node.js';
import { ComputeNode } from '../nodes/nodes.js';
import { ComputePipelineCache, type ComputePipelineEntry } from './compute-pipeline.js';
import type { CompileResult } from '../nodes/compile.js';

const _normalMatrix = mat3.create();

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

    private _initialized = false;

    /** Swapchain depth texture (recreated on resize). */
    private depthTexture!: GPUTexture;
    /** MSAA color texture (null when samples <= 1). Only used for swapchain passes. */
    private msaaTexture: GPUTexture | null = null;

    /** Reusable CPU-side Float32Arrays for per-field camera/time uploads. */
    private readonly _camProjData:    Float32Array = new Float32Array(16);
    private readonly _camViewData:    Float32Array = new Float32Array(16);
    private readonly _camPosData:     Float32Array = new Float32Array(4);  // vec3f padded to 16B
    private readonly _camNearData:    Float32Array = new Float32Array(1);
    private readonly _camFarData:     Float32Array = new Float32Array(1);
    private readonly _timeElapsedData: Float32Array = new Float32Array(1);
    private readonly _timeDeltaData:   Float32Array = new Float32Array(1);

    /** Stable object keys used as WeakMap identities for per-field GPU buffers. */
    private readonly _camProjKey:     object = {};
    private readonly _camViewKey:     object = {};
    private readonly _camPosKey:      object = {};
    private readonly _camNearKey:     object = {};
    private readonly _camFarKey:      object = {};
    private readonly _timeElapsedKey: object = {};
    private readonly _timeDeltaKey:   object = {};

    /** Last-uploaded values for per-field dirty checking. */
    private _lastCamProj:     Float32Array | null = null;
    private _lastCamView:     Float32Array | null = null;
    private _lastCamPos:      Float32Array | null = null;
    private _lastCamNear:     number | null = null;
    private _lastCamFar:      number | null = null;
    private _lastTimeElapsed: number | null = null;
    private _lastTimeDelta:   number | null = null;

    /** Per-mesh GPU buffer keys — keyed by Mesh object identity. */
    private readonly meshModelMatrixKeys: WeakMap<Mesh, object> = new WeakMap();
    private readonly meshNormalMatrixKeys: WeakMap<Mesh, object> = new WeakMap();
    private readonly materialUBOKeys: WeakMap<Mesh, object> = new WeakMap();

    /** Reusable CPU buffers for per-field mesh uploads. */
    private readonly _meshModelMatrixData: Float32Array = new Float32Array(16);
    /** mat3x3f in uniform address space: each column padded to vec4, 3×4 = 12 f32 (48 bytes). */
    private readonly _meshNormalMatrixData: Float32Array = new Float32Array(12);

    /**
     * Per-CompileResult last-packed version sum for the material UBO dirty check.
     * Key: CompileResult object. Value: sum of member.node.version at last pack.
     */
    private readonly _uboVersionSums: WeakMap<CompileResult, number> = new WeakMap();

    /**
     * Per-mesh last-uploaded matrixVersion for the mesh UBO dirty check.
     * Key: Mesh object. Value: mesh.matrixVersion at last upload.
     */
    private readonly _meshMatrixVersions: WeakMap<Mesh, number> = new WeakMap();

    /** Elapsed time in seconds. */
    private elapsed = 0;
    private lastTimestamp = 0;

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

    /** Stable key for the internal fullscreen material UBO. */
    private readonly _fsQuadMatUBOKey: object = {};

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
        const wantedFeatures: GPUFeatureName[] = ['indirect-first-instance'];
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
     * Pre-compile all WebGPU pipelines reachable from `target` before the
     * render loop starts.
     *
     * - Pass a `Node` (the same node you will give `renderer.render()`) to
     *   pre-warm every render pipeline in the scene graph — it walks
     *   PassNodes → scenes → meshes and also compiles the fullscreen
     *   composite pipeline.
     * - Pass a `ComputeNode` to pre-warm its compute pipeline.
     *
     * Awaiting the returned Promise guarantees the first render/compute call
     * will not skip a frame waiting for pipeline compilation.
     * No-op for any pipeline that is already compiled.
     *
     * @throws if the renderer has not been initialised yet (call await renderer.init() first).
     */
    async compile(target: Node<WgslType> | ComputeNode): Promise<void> {
        if (!this._initialized) {
            throw new Error('[WebGPURenderer] compile() called before init(). Await renderer.init() first.');
        }

        // ComputeNode: pre-warm the compute pipeline.
        if (target instanceof ComputeNode) {
            await this.computePipelines.getAsync(target.id, target);
            return;
        }

        // Node<WgslType>: walk the graph, pre-warm all render pipelines.
        const outputNode = target as Node<WgslType>;
        const promises: Promise<unknown>[] = [];

        // 1. Find all PassNodes and pre-warm their scene meshes.
        const passNodes = collectPassNodes(outputNode);
        const PASS_SAMPLES = 1;
        const PASS_FORMAT: GPUTextureFormat = 'rgba8unorm';
        const fullscreenGeom = this._getFullscreenGeometry();

        for (const passNode of passNodes) {
            const { scene, camera } = passNode;
            const { opaque, transparent } = collectDraws(scene, camera, PASS_SAMPLES, PASS_FORMAT);
            for (const draw of [...opaque, ...transparent]) {
                const { mesh } = draw;
                const key = makePipelineKey(mesh.material, PASS_SAMPLES, PASS_FORMAT);
                promises.push(
                    this.pipelines.getAsync(key, mesh.material, mesh.geometry, PASS_SAMPLES, PASS_FORMAT),
                );
            }
        }

        // 2. Pre-warm the fullscreen composite pipeline.
        const { mat, pipelineKey } = this._makeOutputMaterial(outputNode);
        promises.push(this.pipelines.getAsync(pipelineKey, mat, fullscreenGeom, this._samples, this.format));

        await Promise.all(promises);
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
     * Collects all PassNodes reachable from outputNode (BFS), renders each
     * scene into its off-screen render target, then composites the expression
     * to the canvas.
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

        // Upload per-frame Time uniforms (dirty-checked per field).
        this._uploadTimeFields(this.elapsed, delta);

        // Reuse the frame encoder if compute() was called this frame; otherwise create fresh.
        const encoder = this._frameEncoder ?? this.device.createCommandEncoder();
        this._frameEncoder = null;

        const w = this.domElement.width || 1;
        const h = this.domElement.height || 1;

        // 1. Render each PassNode's scene into its off-screen render target.
        const passNodes = collectPassNodes(outputNode);
        for (const passNode of passNodes) {
            this._renderPassNode(passNode, encoder, w, h);
        }

        // 2. Render the outputNode expression as a fullscreen quad to the swapchain.
        this._renderOutputNode(outputNode, encoder, passNodes);

        this.device.queue.submit([encoder.finish()]);
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

        // Upload / ensure storage buffers for all outputs.
        const gpuBuffers: GPUBuffer[] = entry.compileResult.storage.map((s) =>
            this.buffers.uploadStorage(s.node),
        );

        // Build the bind group for group 0 (storage outputs).
        const bindGroup = this.device.createBindGroup({
            layout: entry.layout0,
            entries: entry.compileResult.storage.map((s, i) => ({
                binding: s.binding,
                resource: { buffer: gpuBuffers[i] },
            })),
        });

        // Encode the compute pass.
        const computePass = encoder.beginComputePass();
        computePass.setPipeline(entry.pipeline);
        computePass.setBindGroup(0, bindGroup);
        const [dx, dy, dz] = node.dispatch;
        computePass.dispatchWorkgroups(dx, dy, dz);
        computePass.end();
    }

    // -----------------------------------------------------------------------
    // _renderPassNode — render a scene into a PassNode's off-screen textures
    // -----------------------------------------------------------------------

    private _renderPassNode(
        passNode: PassNode,
        encoder: GPUCommandEncoder,
        width: number,
        height: number,
    ): void {
        // Ensure the render target textures exist at the current canvas size.
        passNode._ensureTarget(this.device, width, height);

        const { scene, camera } = passNode;

        // Upload Camera per-field uniforms (dirty-checked).
        this._uploadCameraFields(camera);
        // Collect draws.
        // PassNode render targets are always sampleCount=1 (no MSAA off-screen) and rgba8unorm.
        const PASS_SAMPLES = 1;
        const PASS_FORMAT: GPUTextureFormat = 'rgba8unorm';
        const { opaque, transparent } = collectDraws(scene, camera, PASS_SAMPLES, PASS_FORMAT);
        const allDraws = [...opaque, ...transparent];

        // Per-mesh: upload geometry + UBOs.
        for (const draw of allDraws) {
            this._prepareMesh(draw.mesh, PASS_SAMPLES, PASS_FORMAT);
        }

        // Build render pass descriptor targeting the passNode's off-screen textures.
        const [cr, cg, cb, ca] = passNode.clearColor;
        const colorAttachment: GPURenderPassColorAttachment = {
            view: passNode._colorTexture!.createView(),
            clearValue: { r: cr, g: cg, b: cb, a: ca },
            loadOp: 'clear',
            storeOp: 'store',
        };
        const depthAttachment: GPURenderPassDepthStencilAttachment = {
            view: passNode._depthTexture!.createView(),
            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
        };

        // DEBUG: capture any WebGPU validation errors from this pass
        this.device.pushErrorScope('validation');

        const gpuPass = encoder.beginRenderPass({
            colorAttachments: [colorAttachment],
            depthStencilAttachment: depthAttachment,
        });

        // Issue draws.
        let currentPipelineKey: string | null = null;
        let currentFrameBindGroup: GPUBindGroup | null = null;
        let currentLayout0: GPUBindGroupLayout | null = null;

        const issueDraws = (draws: DrawCall[]) => {
            for (const draw of draws) {
                const { mesh } = draw;
                const entry = this.pipelines.get(
                    draw.pipelineKey,
                    mesh.material,
                    mesh.geometry,
                    PASS_SAMPLES,
                    PASS_FORMAT,
                );
                if (!entry) continue;

                if (draw.pipelineKey !== currentPipelineKey) {
                    gpuPass.setPipeline(entry.pipeline);
                    currentPipelineKey = draw.pipelineKey;

                    if (entry.layout0 !== currentLayout0) {
                        currentLayout0 = entry.layout0;
                        currentFrameBindGroup = buildFrameBindGroup(
                            this.device,
                            entry.layout0,
                            entry.compileResult,
                            this._makeFrameBuffers(),
                        );
                        gpuPass.setBindGroup(0, currentFrameBindGroup);
                    }
                }

                const meshModelMatrixBuf = this.buffers.getRaw(this._getMeshModelMatrixKey(mesh)) ?? null;
                const meshNormalMatrixBuf = this.buffers.getRaw(this._getMeshNormalMatrixKey(mesh)) ?? null;
                const materialUboBuf = this.buffers.getRaw(this._getMaterialUBOKey(mesh)) ?? null;
                const meshBindGroup = buildMeshBindGroup(
                    this.device,
                    entry.layout1,
                    entry.compileResult,
                    mesh,
                    meshModelMatrixBuf,
                    meshNormalMatrixBuf,
                    materialUboBuf,
                    this.buffers,
                );
                gpuPass.setBindGroup(1, meshBindGroup);

                let slot = 0;
                for (const attrEntry of entry.compileResult.attributes) {
                    if (attrEntry.kind === 'geometry') {
                        const bufAttr = mesh.geometry.attributes.get(attrEntry.name);
                        if (!bufAttr) { slot++; continue; }
                        const gpuBuf = this.buffers.uploadVertex(bufAttr);
                        gpuPass.setVertexBuffer(slot++, gpuBuf);
                    } else {
                        const node = attrEntry.node;
                        const gpuBuf = this.buffers.uploadRaw(
                            node,
                            node.data,
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
                        const byteStride = indirect.stride * 4; // stride u32s × 4 bytes
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
                        const byteStride = indirect.stride * 4; // stride u32s × 4 bytes
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

        // DEBUG: report any validation errors from this pass
        this.device.popErrorScope().then((err) => {
            if (err) console.error('[WebGPU pass validation error]', err.message);
        });
    }

    // -----------------------------------------------------------------------
    // _renderOutputNode — render the outputNode expression as a fullscreen quad
    // -----------------------------------------------------------------------

    private _renderOutputNode(
        outputNode: Node<WgslType>,
        encoder: GPUCommandEncoder,
        passNodes: PassNode[],
    ): void {
        const { mat, pipelineKey } = this._makeOutputMaterial(outputNode);

        // Register passNode textures + samplers directly on the node objects.
        for (const passNode of passNodes) {
            const { colorTexNode, samplerNode, depthTexNode } = passNode._getResourceNodes();
            if (passNode._colorTexture) colorTexNode.resource = passNode._colorTexture;
            if (passNode._sampler)       samplerNode.resource  = passNode._sampler;
            if (passNode._depthTexture)  depthTexNode.resource = passNode._depthTexture;
        }

        const fullscreenGeom = this._getFullscreenGeometry();
        // sampleCount and format must match the swapchain render pass.
        const entry = this.pipelines.get(pipelineKey, mat, fullscreenGeom, this._samples, this.format);

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

        if (entry) {
            // Upload material UBO if needed (version-sum dirty check).
            const matUBOKey = this._fsQuadMatUBOKey;
            const cr = entry.compileResult;
            const versionSum = _uniformVersionSum(cr);
            if (this._uboVersionSums.get(cr) !== versionSum) {
                const uboData = packMaterialUBO(cr);
                if (uboData) {
                    this.buffers.uploadRaw(
                        matUBOKey,
                        uboData,
                        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                    );
                }
                this._uboVersionSums.set(cr, versionSum);
            }

            const matUboBuf = this.buffers.getRaw(matUBOKey) ?? null;

            const frameBindGroup = buildFrameBindGroup(
                this.device, entry.layout0, entry.compileResult,
                this._makeFrameBuffers(),
            );
            gpuPass.setBindGroup(0, frameBindGroup);

            const meshBindGroup = buildMeshBindGroup(
                this.device,
                entry.layout1,
                entry.compileResult,
                null,
                null, // meshModelMatrix — not used by fullscreen quad
                null, // meshNormalMatrix — not used by fullscreen quad
                matUboBuf,
                this.buffers,
            );
            gpuPass.setBindGroup(1, meshBindGroup);

            gpuPass.setPipeline(entry.pipeline);
            gpuPass.draw(3, 1);
        }

        gpuPass.end();
    }

    // -----------------------------------------------------------------------
    // _prepareMesh
    // -----------------------------------------------------------------------

    private _prepareMesh(mesh: Mesh, samples: number = this._samples, format: GPUTextureFormat = this.format): void {
        for (const attr of mesh.geometry.attributes.values()) {
            if (attr.needsUpdate) this.buffers.uploadVertex(attr);
        }
        if (mesh.geometry.index?.needsUpdate) {
            this.buffers.uploadIndex(mesh.geometry.index);
        }

        const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
        if (this._meshMatrixVersions.get(mesh) !== mesh.matrixVersion) {
            // meshModelMatrix — 16 f32, 64 bytes
            this._meshModelMatrixData.set(mesh._worldMatrix);
            this.buffers.uploadRaw(this._getMeshModelMatrixKey(mesh), this._meshModelMatrixData, U);

            // meshNormalMatrix — mat3x3f padded to 12 f32 (48 bytes, 3 × vec4 columns)
            packMat3IntoVec4Columns(
                mat3.normalFromMat4(_normalMatrix, mesh._worldMatrix) ?? mat3.identity(_normalMatrix),
                this._meshNormalMatrixData,
                0,
            );
            this.buffers.uploadRaw(this._getMeshNormalMatrixKey(mesh), this._meshNormalMatrixData, U);

            this._meshMatrixVersions.set(mesh, mesh.matrixVersion);
        }

        const pipelineKey = makePipelineKey(mesh.material, samples, format);
        const entry = this.pipelines.get(pipelineKey, mesh.material, mesh.geometry, samples, format);
        if (entry) {
            const cr = entry.compileResult;
            const versionSum = _uniformVersionSum(cr);
            if (this._uboVersionSums.get(cr) !== versionSum) {
                const uboData = packMaterialUBO(cr);
                if (uboData) {
                    this.buffers.uploadRaw(
                        this._getMaterialUBOKey(mesh),
                        uboData,
                        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                    );
                }
                this._uboVersionSums.set(cr, versionSum);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Per-object buffer key accessors
    // -----------------------------------------------------------------------

    private _getMeshModelMatrixKey(mesh: Mesh): object {
        let k = this.meshModelMatrixKeys.get(mesh);
        if (!k) { k = {}; this.meshModelMatrixKeys.set(mesh, k); }
        return k;
    }

    private _getMeshNormalMatrixKey(mesh: Mesh): object {
        let k = this.meshNormalMatrixKeys.get(mesh);
        if (!k) { k = {}; this.meshNormalMatrixKeys.set(mesh, k); }
        return k;
    }

    private _getMaterialUBOKey(mesh: Mesh): object {
        let k = this.materialUBOKeys.get(mesh);
        if (!k) { k = {}; this.materialUBOKeys.set(mesh, k); }
        return k;
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
    // Per-field camera/time upload helpers
    // -----------------------------------------------------------------------

    /**
     * Upload all 5 camera fields to their individual GPU buffers, dirty-checking each.
     * Reuses pre-allocated Float32Arrays; only calls uploadRaw when the value changed.
     */
    private _uploadCameraFields(camera: import('../scene/camera.js').Camera): void {
        const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;

        // projectionMatrix (16 f32, 64B)
        const proj = camera.projectionMatrix;
        let projDirty = this._lastCamProj === null;
        if (!projDirty) { for (let i = 0; i < 16; i++) if (proj[i] !== this._lastCamProj![i]) { projDirty = true; break; } }
        if (projDirty) {
            for (let i = 0; i < 16; i++) this._camProjData[i] = proj[i];
            this.buffers.uploadRaw(this._camProjKey, this._camProjData, U);
            if (!this._lastCamProj) this._lastCamProj = new Float32Array(16);
            this._lastCamProj.set(this._camProjData);
        }

        // viewMatrix (16 f32, 64B)
        const view = camera._viewMatrix;
        let viewDirty = this._lastCamView === null;
        if (!viewDirty) { for (let i = 0; i < 16; i++) if (view[i] !== this._lastCamView![i]) { viewDirty = true; break; } }
        if (viewDirty) {
            for (let i = 0; i < 16; i++) this._camViewData[i] = view[i];
            this.buffers.uploadRaw(this._camViewKey, this._camViewData, U);
            if (!this._lastCamView) this._lastCamView = new Float32Array(16);
            this._lastCamView.set(this._camViewData);
        }

        // position (vec3f, padded to 16B)
        const wx = camera._worldMatrix[12];
        const wy = camera._worldMatrix[13];
        const wz = camera._worldMatrix[14];
        if (this._lastCamPos === null || this._lastCamPos[0] !== wx || this._lastCamPos[1] !== wy || this._lastCamPos[2] !== wz) {
            this._camPosData[0] = wx; this._camPosData[1] = wy; this._camPosData[2] = wz; this._camPosData[3] = 0;
            this.buffers.uploadRaw(this._camPosKey, this._camPosData, U);
            if (!this._lastCamPos) this._lastCamPos = new Float32Array(3);
            this._lastCamPos[0] = wx; this._lastCamPos[1] = wy; this._lastCamPos[2] = wz;
        }

        // near (f32, min 16B — uploadRaw pads)
        if (camera.near !== this._lastCamNear) {
            this._camNearData[0] = camera.near;
            this.buffers.uploadRaw(this._camNearKey, this._camNearData, U);
            this._lastCamNear = camera.near;
        }

        // far (f32)
        if (camera.far !== this._lastCamFar) {
            this._camFarData[0] = camera.far;
            this.buffers.uploadRaw(this._camFarKey, this._camFarData, U);
            this._lastCamFar = camera.far;
        }
    }

    /**
     * Upload elapsed and delta time to their individual GPU buffers, dirty-checking each.
     */
    private _uploadTimeFields(elapsed: number, delta: number): void {
        const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
        if (elapsed !== this._lastTimeElapsed) {
            this._timeElapsedData[0] = elapsed;
            this.buffers.uploadRaw(this._timeElapsedKey, this._timeElapsedData, U);
            this._lastTimeElapsed = elapsed;
        }
        if (delta !== this._lastTimeDelta) {
            this._timeDeltaData[0] = delta;
            this.buffers.uploadRaw(this._timeDeltaKey, this._timeDeltaData, U);
            this._lastTimeDelta = delta;
        }
    }

    /**
     * Collect the current per-field GPU buffers into a FrameBuffers bag.
     * Returns null for fields not yet uploaded (buffers will be allocated on first use).
     */
    private _makeFrameBuffers(): FrameBuffers {
        return {
            camProj:     this.buffers.getRaw(this._camProjKey)     ?? null,
            camView:     this.buffers.getRaw(this._camViewKey)     ?? null,
            camPos:      this.buffers.getRaw(this._camPosKey)      ?? null,
            camNear:     this.buffers.getRaw(this._camNearKey)     ?? null,
            camFar:      this.buffers.getRaw(this._camFarKey)      ?? null,
            timeElapsed: this.buffers.getRaw(this._timeElapsedKey) ?? null,
            timeDelta:   this.buffers.getRaw(this._timeDeltaKey)   ?? null,
        };
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

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function packMat3IntoVec4Columns(m: ArrayLike<number>, out: Float32Array, offset: number): void {
    out[offset + 0] = m[0]; out[offset + 1] = m[1]; out[offset + 2] = m[2]; out[offset + 3] = 0;
    out[offset + 4] = m[3]; out[offset + 5] = m[4]; out[offset + 6] = m[5]; out[offset + 7] = 0;
    out[offset + 8] = m[6]; out[offset + 9] = m[7]; out[offset + 10] = m[8]; out[offset + 11] = 0;
}

/**
 * Returns the sum of node.version across all uniform members in the group-1 block.
 * Used as a cheap dirty-check: if the sum changes, the UBO needs re-packing.
 */
function _uniformVersionSum(cr: CompileResult): number {
    const ub = cr.uniforms.find((u) => u.group === 1);
    if (!ub) return 0;
    let sum = 0;
    for (const m of ub.members) sum += m.node.version;
    return sum;
}
