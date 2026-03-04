/**
 * renderer.ts — WebGPU renderer. Drives pass execution for RenderPipeline.
 *
 * Usage:
 *   const renderer = new WebGPURenderer({ antialias: true });
 *   await renderer.init();
 *   document.body.appendChild(renderer.domElement);
 *   renderer.setSize(window.innerWidth, window.innerHeight);
 *
 *   const scenePass = pass(scene, camera);
 *   const pipeline = new RenderPipeline();
 *   pipeline.outputNode = scenePass.getTextureNode();
 *
 *   function frame() {
 *       pipeline.render(renderer);
 *       requestAnimationFrame(frame);
 *   }
 *   requestAnimationFrame(frame);
 *
 * Frame loop (inside RenderPipeline.render → renderer._executePipeline()):
 *   1. Advance time, upload Time UBO (group 0)
 *   2. Collect all PassNodes from outputNode graph (BFS via collectPassNodes)
 *   3. For each PassNode:
 *      a. _ensureTarget(device, w, h) — lazy texture allocation
 *      b. scene.updateWorldMatrices(), camera.updateViewMatrix()
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
import { buildFrameBindGroup, buildMeshBindGroup, packMaterialUBO } from './bindgroups.js';
import { collectDraws, type DrawCall } from './collect.js';
import { Material } from '../scene/material.js';
import { Geometry } from '../scene/geometry.js';
import { raw, builtin, type Node, type WgslType, VaryingNode, RawNode } from '../nodes/nodes.js';
import { collectPassNodes, type PassNode } from '../nodes/pass-node.js';
import type { RenderPipeline } from './render-pipeline.js';
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

    private _initialized = false;

    /** Swapchain depth texture (recreated on resize). */
    private depthTexture!: GPUTexture;
    /** MSAA color texture (null when samples <= 1). Only used for swapchain passes. */
    private msaaTexture: GPUTexture | null = null;

    /** Reusable CPU buffer for Camera UBO. */
    private readonly cameraUBOData: Float32Array = new Float32Array(40);

    /** Fixed object keys used as WeakMap identities for the Camera/Time GPU buffers. */
    private readonly cameraUBOKey: object = {};
    private readonly timeUBOKey: object = {};

    /** Per-mesh GPU buffer keys — keyed by Mesh object identity. */
    private readonly meshUBOKeys: WeakMap<Mesh, object> = new WeakMap();
    private readonly materialUBOKeys: WeakMap<Mesh, object> = new WeakMap();

    /** Reusable CPU buffer for Mesh UBO: 16 f32 (modelMatrix) + 12 f32 (normalMatrix padded) = 28 f32. */
    private readonly meshUBOData: Float32Array = new Float32Array(28);

    /**
     * Per-CompileResult last-packed version sum for the material UBO dirty check.
     * Key: CompileResult object. Value: sum of member.node.version at last pack.
     */
    private readonly _uboVersionSums: WeakMap<CompileResult, number> = new WeakMap();

    /** Elapsed time in seconds. */
    private elapsed = 0;
    private lastTimestamp = 0;

    // -----------------------------------------------------------------------
    // Internal fullscreen quad state
    // -----------------------------------------------------------------------

    /** Geometry for the internal fullscreen triangle. Created once on first use. */
    private _fullscreenGeometry: Geometry | null = null;

    /**
     * Per-RenderPipeline keys for the internal fullscreen material UBO and dummy mesh UBO.
     * Keyed by RenderPipeline object identity.
     */
    private readonly _pipelineMatUBOKeys: WeakMap<RenderPipeline, object> = new WeakMap();
    private readonly _pipelineDummyMeshKeys: WeakMap<RenderPipeline, object> = new WeakMap();

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
        this.device = await adapter.requestDevice(this._deviceDescriptor);

        const context = this.domElement.getContext('webgpu');
        if (!context) throw new Error('[WebGPURenderer] Failed to get WebGPU canvas context.');
        this.context = context;

        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });

        this.buffers = new BufferCache(this.device);
        this.pipelines = new PipelineCache(this.device, this.format);

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
    // _executePipeline — called by RenderPipeline.render()
    // -----------------------------------------------------------------------

    /** @internal — called by RenderPipeline, not intended for direct use. */
    _executePipeline(pipeline: RenderPipeline): void {
        if (!this._initialized) {
            throw new Error('[WebGPURenderer] render() called before init(). Await renderer.init() first.');
        }
        if (!pipeline.outputNode) {
            throw new Error('[WebGPURenderer] RenderPipeline.outputNode is null. Set it before calling render().');
        }

        // Advance time.
        const now = performance.now() / 1000;
        const delta = this.lastTimestamp === 0 ? 0 : now - this.lastTimestamp;
        this.lastTimestamp = now;
        this.elapsed += delta;

        // Upload shared per-frame Time UBO.
        const timeData = new Float32Array([this.elapsed, delta]);
        const timeBuf = this.buffers.uploadRaw(
            this.timeUBOKey,
            timeData,
            GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        );

        // Single command encoder for the entire pipeline.
        const encoder = this.device.createCommandEncoder();

        const w = this.domElement.width || 1;
        const h = this.domElement.height || 1;

        // 1. Render each PassNode's scene into its off-screen render target.
        const passNodes = collectPassNodes(pipeline.outputNode);
        for (const passNode of passNodes) {
            this._renderPassNode(passNode, encoder, timeBuf, w, h);
        }

        // 2. Render the outputNode expression as a fullscreen quad to the swapchain.
        this._renderOutputNode(pipeline, pipeline.outputNode, encoder, passNodes);

        this.device.queue.submit([encoder.finish()]);
    }

    // -----------------------------------------------------------------------
    // _renderPassNode — render a scene into a PassNode's off-screen textures
    // -----------------------------------------------------------------------

    private _renderPassNode(
        passNode: PassNode,
        encoder: GPUCommandEncoder,
        timeBuf: GPUBuffer,
        width: number,
        height: number,
    ): void {
        // Ensure the render target textures exist at the current canvas size.
        passNode._ensureTarget(this.device, width, height);

        const { scene, camera } = passNode;

        // Update transforms.
        scene.updateWorldMatrices();
        camera.updateViewMatrix();

        // Upload Camera UBO for this pass's camera.
        packCameraUBO(camera, this.cameraUBOData);
        const cameraBuf = this.buffers.uploadRaw(
            this.cameraUBOKey,
            this.cameraUBOData,
            GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        );

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
        const colorAttachment: GPURenderPassColorAttachment = {
            view: passNode._colorTexture!.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
        };
        const depthAttachment: GPURenderPassDepthStencilAttachment = {
            view: passNode._depthTexture!.createView(),
            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
        };

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
                            cameraBuf,
                            timeBuf,
                        );
                        gpuPass.setBindGroup(0, currentFrameBindGroup);
                    }
                }

                const meshUboBuf = this.buffers.getRaw(this._getMeshUBOKey(mesh))!;
                const materialUboBuf = this.buffers.getRaw(this._getMaterialUBOKey(mesh)) ?? null;
                const meshBindGroup = buildMeshBindGroup(
                    this.device,
                    entry.layout1,
                    entry.compileResult,
                    mesh,
                    meshUboBuf,
                    materialUboBuf,
                    this.buffers,
                );
                gpuPass.setBindGroup(1, meshBindGroup);

                let slot = 0;
                for (const attrEntry of entry.compileResult.attributes) {
                    if (attrEntry.kind === 'geometry') {
                        const bufAttr = mesh.geometry.attributes.get(attrEntry.name);
                        if (!bufAttr) continue;
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
                    gpuPass.drawIndexed(mesh.geometry.index.data.length, mesh.count);
                } else {
                    gpuPass.draw(mesh.geometry.vertexCount, mesh.count);
                }
            }
        };

        issueDraws(opaque);
        issueDraws(transparent);

        gpuPass.end();
    }

    // -----------------------------------------------------------------------
    // _renderOutputNode — render the outputNode expression as a fullscreen quad
    // -----------------------------------------------------------------------

    private _renderOutputNode(
        pipeline: RenderPipeline,
        outputNode: Node<WgslType>,
        encoder: GPUCommandEncoder,
        passNodes: PassNode[],
    ): void {
        // Build the internal fullscreen material:
        //   position = fullscreenPosition() (uses @builtin(vertex_index))
        //   color    = outputNode wrapped to also include the UV varying in the graph
        //
        // The UV varying makes `in.uv` available in the fragment shader so that
        // textureSample(..., in.uv) calls in PassColorTextureNode work correctly.
        const posNode = _makeFullscreenPositionNode();
        const uvVarying = _makeFullscreenUVVarying();

        // Wrap outputNode so the UV varying is reachable from the color graph.
        // We use a RawNode<'vec4f'> with wgsl='$0' that has both outputNode and uvVarying
        // as deps — the compiler sees the VaryingNode and emits in.uv in FragmentInput,
        // then the actual color expression (outputNode) can reference in.uv.
        const colorNode = new RawNode<'vec4f'>('vec4f', '$0', [outputNode, uvVarying]);

        const mat = new Material({ position: posNode, color: colorNode, depthWrite: false, depthTest: false });

        // Register passNode textures + samplers directly on the node objects.
        for (const passNode of passNodes) {
            const { colorTexNode, samplerNode, depthTexNode } = passNode._getResourceNodes();
            if (passNode._colorTexture) colorTexNode.resource = passNode._colorTexture;
            if (passNode._sampler)       samplerNode.resource  = passNode._sampler;
            if (passNode._depthTexture)  depthTexNode.resource = passNode._depthTexture;
        }

        const fullscreenGeom = this._getFullscreenGeometry();
        // sampleCount and format must match the swapchain render pass.
        const pipelineKey = makePipelineKey(mat, this._samples, this.format);
        const entry = this.pipelines.get(pipelineKey, mat, fullscreenGeom, this._samples, this.format);

        // Build the swapchain render pass.
        const swapchainView = this.context.getCurrentTexture().createView();
        let colorAttachment: GPURenderPassColorAttachment;
        if (this._samples > 1 && this.msaaTexture) {
            colorAttachment = {
                view: this.msaaTexture.createView(),
                resolveTarget: swapchainView,
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'discard',
            };
        } else {
            colorAttachment = {
                view: swapchainView,
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
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
            const matUBOKey = this._getPipelineMatUBOKey(pipeline);
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

            const cameraBuf = this.buffers.getRaw(this.cameraUBOKey);
            const timeBuf   = this.buffers.getRaw(this.timeUBOKey);
            const matUboBuf = this.buffers.getRaw(matUBOKey) ?? null;

            if (cameraBuf && timeBuf) {
                const frameBindGroup = buildFrameBindGroup(
                    this.device, entry.layout0, cameraBuf, timeBuf,
                );
                gpuPass.setBindGroup(0, frameBindGroup);
            }

            // Dummy mesh UBO (identity matrices — fullscreen quad has no mesh transform).
            const dummyMeshKey = this._getPipelineDummyMeshKey(pipeline);
            const meshUboBuf = this.buffers.ensureRaw(
                dummyMeshKey,
                112, // 28 × f32
                GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            );

            const meshBindGroup = buildMeshBindGroup(
                this.device,
                entry.layout1,
                entry.compileResult,
                null,
                meshUboBuf,
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

        const meshUBOKey = this._getMeshUBOKey(mesh);
        const ubo = this.meshUBOData;
        ubo.set(mesh._worldMatrix, 0);
        packMat3IntoVec4Columns(
            mat3.normalFromMat4(_normalMatrix, mesh._worldMatrix) ?? mat3.identity(_normalMatrix),
            ubo,
            16,
        );
        this.buffers.uploadRaw(meshUBOKey, ubo, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);

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

    private _getMeshUBOKey(mesh: Mesh): object {
        let k = this.meshUBOKeys.get(mesh);
        if (!k) { k = {}; this.meshUBOKeys.set(mesh, k); }
        return k;
    }

    private _getMaterialUBOKey(mesh: Mesh): object {
        let k = this.materialUBOKeys.get(mesh);
        if (!k) { k = {}; this.materialUBOKeys.set(mesh, k); }
        return k;
    }

    private _getPipelineMatUBOKey(pipeline: RenderPipeline): object {
        let k = this._pipelineMatUBOKeys.get(pipeline);
        if (!k) { k = {}; this._pipelineMatUBOKeys.set(pipeline, k); }
        return k;
    }

    private _getPipelineDummyMeshKey(pipeline: RenderPipeline): object {
        let k = this._pipelineDummyMeshKeys.get(pipeline);
        if (!k) { k = {}; this._pipelineDummyMeshKeys.set(pipeline, k); }
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

function packCameraUBO(camera: import('../scene/camera.js').Camera, out: Float32Array): void {
    for (let i = 0; i < 16; i++) out[i]      = camera.projectionMatrix[i];
    for (let i = 0; i < 16; i++) out[16 + i] = camera._viewMatrix[i];
    out[32] = camera._worldMatrix[12];
    out[33] = camera._worldMatrix[13];
    out[34] = camera._worldMatrix[14];
    out[35] = camera.near;
    out[36] = camera.far;
}

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
