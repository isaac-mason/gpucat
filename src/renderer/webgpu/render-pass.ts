import type { CubeRenderTarget } from '../../core/cube-render-target';
import { getIndexFormat } from '../../core/gpu-buffer';
import type { RenderTarget } from '../../core/render-target';
import type { InspectorBase } from '../../inspector/inspector-base';
import type { IndexedMeshDraw, NonIndexedMeshDraw } from '../../objects/mesh';
import type { CanvasTarget } from '../core/canvas-target';
import type { NodeManagerState } from '../core/node-manager';
import * as NodeManager from '../core/node-manager';
import type { RenderContext } from '../core/pass-context';
import type { PreparedRenderObject, RenderPassParams } from '../core/render-types';
import type { BindGroupLayoutCache } from './bind-group-layout';
import * as Bindings from './bindings';
import * as Buffers from './buffers';
import * as Geometries from './geometries';
import { disposeMipmapState } from './mipmap-utils';
import { DEPTH_FORMAT, formatHasStencil } from './pipelines';
import type * as Pipelines from './pipelines';
import * as RenderObjectGpu from './render-object-gpu';
import * as RenderObjects from './render-objects';
import * as Textures from './textures';

// ---------------------------------------------------------------------------
// Canvas context — the renderer owns the WebGPU canvas context.
// ---------------------------------------------------------------------------

/**
 * Get (or lazily create + configure) the WebGPU canvas context for a canvas target. Safe to call
 * repeatedly; the context is cached per canvas target after first acquisition. The context is
 * acquired from `canvasTarget.domElement.getContext('webgpu')` and configured against `device` with
 * the given `format` and alpha mode (defaults to the canvas target's `alphaMode`).
 */
export function getContext(
    contexts: WeakMap<CanvasTarget, GPUCanvasContext>,
    device: GPUDevice,
    canvasTarget: CanvasTarget,
    format: GPUTextureFormat,
    alphaMode?: GPUCanvasAlphaMode,
): GPUCanvasContext {
    let ctx = contexts.get(canvasTarget);
    if (!ctx) {
        const acquired = canvasTarget.domElement.getContext('webgpu');
        if (!acquired) {
            throw new Error('[WebGPURenderer] Failed to get WebGPU context from canvas.');
        }
        acquired.configure({ device, format, alphaMode: alphaMode ?? canvasTarget.alphaMode });
        ctx = acquired;
        contexts.set(canvasTarget, ctx);
    }
    return ctx;
}

/**
 * Re-`configure()` the cached WebGPU context for a canvas target against the current device/format.
 * Safari/WebKit clears a context's configuration whenever the canvas backing store is resized (any
 * `canvas.width`/`canvas.height` write), so the next `getCurrentTexture()` throws "canvas is not
 * configured". Called from the resize path to restore it. No-op when the context hasn't been acquired
 * yet (`getContext()` will configure on first use) and a portable no-op on Chrome, which keeps the
 * configuration across resizes.
 */
export function reconfigureContext(
    contexts: WeakMap<CanvasTarget, GPUCanvasContext>,
    device: GPUDevice,
    canvasTarget: CanvasTarget,
    format: GPUTextureFormat,
    alphaMode?: GPUCanvasAlphaMode,
): void {
    const ctx = contexts.get(canvasTarget);
    if (!ctx) return;
    ctx.configure({ device, format, alphaMode: alphaMode ?? canvasTarget.alphaMode });
}

/**
 * Unconfigure and release the WebGPU context for a canvas target. Called from `dispose()` for the
 * swapchain canvas target. After this, `getContext()` creates a fresh context.
 */
export function releaseContext(contexts: WeakMap<CanvasTarget, GPUCanvasContext>, canvasTarget: CanvasTarget): void {
    const ctx = contexts.get(canvasTarget);
    if (ctx) {
        ctx.unconfigure();
        contexts.delete(canvasTarget);
    }
}

// ---------------------------------------------------------------------------
// Swapchain textures.
// ---------------------------------------------------------------------------

/**
 * Swapchain state owned by the renderer: the canvas target, sample count, depth format, and the
 * depth/msaa attachment textures (+ their cached views). Read when resolving swapchain
 * (renderTarget === null) attachments and recreated on `resize`.
 */
export type SwapchainState = {
    canvasTarget: CanvasTarget | null;
    samples: number;
    depthFormat: GPUTextureFormat;
    /** Swapchain depth texture (recreated on resize). */
    depthTexture: GPUTexture | null;
    depthTextureView: GPUTextureView | null;
    /** MSAA color texture (null when samples <= 1). */
    msaaTexture: GPUTexture | null;
    msaaTextureView: GPUTextureView | null;
};

/** Create the initial (empty) swapchain state for the given sample count + depth format. */
export function createSwapchainState(samples: number, depthFormat: GPUTextureFormat): SwapchainState {
    return {
        canvasTarget: null,
        samples: samples <= 1 ? 0 : samples,
        depthFormat: depthFormat ?? DEPTH_FORMAT,
        depthTexture: null,
        depthTextureView: null,
        msaaTexture: null,
        msaaTextureView: null,
    };
}

/**
 * (Re)create the swapchain depth and (optional) MSAA textures and cache their views. The views
 * are stable until the next resize, so attachment resolution reuses them rather than calling
 * createView() every frame.
 */
export function recreateSwapchainTextures(
    device: GPUDevice,
    sc: SwapchainState,
    format: GPUTextureFormat,
    width: number,
    height: number,
): void {
    const sampleCount = sc.samples > 1 ? sc.samples : 1;

    sc.depthTexture?.destroy();
    sc.depthTexture = Textures.createSwapchainDepthTexture(device, width, height, sampleCount, sc.depthFormat);
    sc.depthTextureView = sc.depthTexture.createView();

    if (sc.samples > 1) {
        sc.msaaTexture?.destroy();
        sc.msaaTexture = Textures.createSwapchainMsaaTexture(device, width, height, format, sc.samples);
        sc.msaaTextureView = sc.msaaTexture.createView();
    }
}

// ---------------------------------------------------------------------------
// Attachment resolution — builds GPU color/depth attachments per target kind.
// ---------------------------------------------------------------------------

type ResolvedAttachments = {
    colorAttachments: GPURenderPassColorAttachment[];
    depthAttachment: GPURenderPassDepthStencilAttachment | undefined;
};

/**
 * Stencil load/store/clear ops for a depth attachment, or undefined when the format has no stencil
 * aspect. WebGPU requires stencil ops on any combined depth-stencil attachment, so this is driven by
 * the texture format, not by whether a material uses stencil. Spread into the depth attachment.
 */
function stencilAttachmentOps(
    format: GPUTextureFormat,
    autoClearing: boolean,
    params: RenderPassParams,
): Pick<GPURenderPassDepthStencilAttachment, 'stencilLoadOp' | 'stencilStoreOp' | 'stencilClearValue'> | undefined {
    if (!formatHasStencil(format)) return undefined;
    return {
        stencilLoadOp: autoClearing && params.autoClearStencil ? 'clear' : 'load',
        stencilStoreOp: 'store',
        stencilClearValue: params.clearStencilValue,
    };
}

/** Attachments for a 2D render target (one color per attachment, MRT supported). */
function resolveRenderTargetAttachments(
    device: GPUDevice,
    textures: Textures.TextureCache,
    renderTarget: RenderTarget,
    clearColor: GPUColorDict,
    params: RenderPassParams,
): ResolvedAttachments {
    Textures.ensureRenderTargetTexturesAllocated(textures, device, renderTarget);

    // autoClear=false preserves prior contents so several viewport/scissor views can composite
    // into one render target (e.g. a grid of previews + one FXAA pass). MSAA can't 'load' a
    // resolve-only target, so it always clears.
    const loadOp: GPULoadOp = params.autoClear ? 'clear' : 'load';
    const colorAttachments: GPURenderPassColorAttachment[] = [];
    for (const tex of renderTarget.textures) {
        const textureData = Textures.getTextureData(textures, tex._gpuTexture);
        if (!textureData) {
            throw new Error('[WebGPURenderer] Render target texture not found in cache');
        }
        // MSAA: render into the multisampled texture and resolve into the sampled
        // single-sample texture. Otherwise render directly into the single texture.
        const msaaView = Textures.getRenderTargetMsaaView(textureData);
        colorAttachments.push(
            msaaView
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
                      loadOp,
                      storeOp: 'store',
                  },
        );
    }

    let depthAttachment: GPURenderPassDepthStencilAttachment | undefined;
    if (renderTarget.depthTexture) {
        const depthTextureData = Textures.getTextureData(textures, renderTarget.depthTexture._gpuTexture);
        if (depthTextureData) {
            depthAttachment = {
                view: Textures.getRenderTargetView(depthTextureData),
                depthClearValue: 1.0,
                depthLoadOp: loadOp,
                depthStoreOp: 'store',
                ...stencilAttachmentOps(renderTarget.depthTexture.format, params.autoClear, params),
            };
        }
    }

    return { colorAttachments, depthAttachment };
}

/** Attachments for the swapchain (canvas), resolving MSAA when enabled. */
function resolveSwapchainAttachments(
    contexts: WeakMap<CanvasTarget, GPUCanvasContext>,
    device: GPUDevice,
    sc: SwapchainState,
    format: GPUTextureFormat,
    clearColor: GPUColorDict,
    params: RenderPassParams,
): ResolvedAttachments {
    const ctx = getContext(contexts, device, sc.canvasTarget!, format);
    const currentTexture = ctx.getCurrentTexture();

    // The current swapchain texture is the size authority for this pass: it's what the MSAA resolve
    // target (and the non-MSAA color view) is created from. The cached depth/MSAA textures are a single
    // shared pair, but the renderer can drive multiple canvas targets of differing size/pixelRatio, so a
    // target swap or resize race can leave them a frame stale. Reconcile against the live texture here so
    // the color/depth attachments always match — WebGPU rejects a render pass whose attachments differ in
    // size (the failure this guards against: "resolve target size … does not match the other attachments").
    if (
        !sc.depthTexture ||
        sc.depthTexture.width !== currentTexture.width ||
        sc.depthTexture.height !== currentTexture.height
    ) {
        recreateSwapchainTextures(device, sc, format, currentTexture.width, currentTexture.height);
    }

    const swapchainView = currentTexture.createView();

    // autoClear=false preserves prior contents so several viewport/scissor views can composite
    // into one canvas. (MSAA can't 'load' a resolve-only target, so it always clears.)
    const loadOp: GPULoadOp = params.autoClear ? 'clear' : 'load';
    const colorAttachments: GPURenderPassColorAttachment[] = [];
    if (sc.samples > 1 && sc.msaaTextureView) {
        colorAttachments.push({
            view: sc.msaaTextureView,
            resolveTarget: swapchainView,
            clearValue: clearColor,
            loadOp: 'clear',
            storeOp: 'discard',
        });
    } else {
        colorAttachments.push({
            view: swapchainView,
            clearValue: clearColor,
            loadOp,
            storeOp: 'store',
        });
    }

    return {
        colorAttachments,
        depthAttachment: {
            view: sc.depthTextureView!,
            depthClearValue: 1.0,
            depthLoadOp: loadOp,
            depthStoreOp: 'store',
            ...stencilAttachmentOps(sc.depthFormat, params.autoClear, params),
        },
    };
}

/** Build the color/depth attachments for a cube render target's active face. */
function resolveCubeAttachments(
    device: GPUDevice,
    textures: Textures.TextureCache,
    renderTarget: CubeRenderTarget,
    clearColor: GPUColorDict,
): ResolvedAttachments {
    Textures.ensureRenderTargetTexturesAllocated(textures, device, renderTarget);

    const cubeData = Textures.getTextureData(textures, renderTarget.texture._gpuTexture);
    if (!cubeData) {
        throw new Error('[WebGPURenderer] Cube render target texture not found in cache');
    }

    // A 2D view of the single selected face (layer) of the cube texture.
    const colorAttachments: GPURenderPassColorAttachment[] = [
        {
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
        },
    ];

    let depthAttachment: GPURenderPassDepthStencilAttachment | undefined;
    if (renderTarget.depthTexture) {
        const depthData = Textures.getTextureData(textures, renderTarget.depthTexture._gpuTexture);
        if (depthData) {
            depthAttachment = {
                view: Textures.getRenderTargetView(depthData),
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
                ...stencilAttachmentOps(renderTarget.depthTexture.format, true, {
                    autoClearStencil: true,
                    clearStencilValue: 0,
                } as RenderPassParams),
            };
        }
    }

    return { colorAttachments, depthAttachment };
}

/**
 * Build GPU color and depth attachments, dispatching on the target kind. Shared by `executeRenderPass`
 * and `clear()` (which then overrides the load ops for the manual clear).
 */
function resolveAttachments(
    contexts: WeakMap<CanvasTarget, GPUCanvasContext>,
    device: GPUDevice,
    textures: Textures.TextureCache,
    sc: SwapchainState,
    format: GPUTextureFormat,
    params: RenderPassParams,
): ResolvedAttachments {
    const { renderTarget, clearColor } = params;
    if (renderTarget?.isCubeRenderTarget) {
        return resolveCubeAttachments(device, textures, renderTarget as CubeRenderTarget, clearColor);
    }
    if (renderTarget) return resolveRenderTargetAttachments(device, textures, renderTarget, clearColor, params);
    return resolveSwapchainAttachments(contexts, device, sc, format, clearColor, params);
}

// ---------------------------------------------------------------------------
// Manual clear — a clear-only render pass honoring the clear flags.
// ---------------------------------------------------------------------------

/**
 * Manually clear the current framebuffer (color and/or depth and/or stencil). Resolves the
 * attachments for `params` with autoClear=true so they come back as 'clear', then overrides each
 * load op per the color/depth/stencil flags, and submits a single empty render pass.
 */
export function clear(
    contexts: WeakMap<CanvasTarget, GPUCanvasContext>,
    device: GPUDevice,
    textures: Textures.TextureCache,
    sc: SwapchainState,
    format: GPUTextureFormat,
    params: RenderPassParams,
    color: boolean,
    depth: boolean,
    stencil: boolean,
): void {
    const { colorAttachments, depthAttachment } = resolveAttachments(contexts, device, textures, sc, format, params);
    // honor the color/depth/stencil flags independently.
    for (const a of colorAttachments) a.loadOp = color ? 'clear' : 'load';
    if (depthAttachment) {
        depthAttachment.depthLoadOp = depth ? 'clear' : 'load';
        // stencilLoadOp is only present when the attachment format carries a stencil aspect.
        if (depthAttachment.stencilLoadOp !== undefined) depthAttachment.stencilLoadOp = stencil ? 'clear' : 'load';
    }
    const encoder = device.createCommandEncoder();
    encoder.beginRenderPass({ label: 'clear', colorAttachments, depthStencilAttachment: depthAttachment }).end();
    device.queue.submit([encoder.finish()]);
}

// ---------------------------------------------------------------------------
// Render pass — attachment resolution + inner draw loop.
// ---------------------------------------------------------------------------

/**
 * Resolve attachments and run the whole inner draw loop into the current command stream (created by
 * the top-level frame, reused by nested renders). Calls neutral update helpers per object.
 */
export function executeRenderPass(
    contexts: WeakMap<CanvasTarget, GPUCanvasContext>,
    device: GPUDevice,
    bindings: Bindings.BindingsState,
    geometries: Geometries.GeometriesState,
    buffers: Buffers.BufferCache,
    textures: Textures.TextureCache,
    renderObjectGpu: RenderObjectGpu.RenderObjectGpuCache,
    sc: SwapchainState,
    format: GPUTextureFormat,
    encoder: GPUCommandEncoder,
    nodes: NodeManagerState,
    passCtx: RenderContext,
    prepared: PreparedRenderObject[],
    params: RenderPassParams,
    inspector: InspectorBase | null,
): void {
    const { colorAttachments, depthAttachment } = resolveAttachments(contexts, device, textures, sc, format, params);
    draw(
        device,
        bindings,
        geometries,
        buffers,
        textures,
        renderObjectGpu,
        encoder,
        nodes,
        passCtx,
        prepared,
        colorAttachments,
        depthAttachment,
        params.passId,
        inspector,
    );
}

/** Begin the GPU render pass, issue all draw calls, and end the pass. */
function draw(
    device: GPUDevice,
    bindings: Bindings.BindingsState,
    geometries: Geometries.GeometriesState,
    buffers: Buffers.BufferCache,
    textures: Textures.TextureCache,
    renderObjectGpu: RenderObjectGpu.RenderObjectGpuCache,
    encoder: GPUCommandEncoder,
    nodes: NodeManagerState,
    passCtx: RenderContext,
    preparedObjects: PreparedRenderObject[],
    colorAttachments: GPURenderPassColorAttachment[],
    depthAttachment: GPURenderPassDepthStencilAttachment | undefined,
    passId: string,
    inspector: InspectorBase | null,
): void {
    const timestampWrites = inspector ? inspector.getTimestampWrites(passId) : undefined;
    const gpuPass = encoder.beginRenderPass({
        label: passId,
        colorAttachments,
        depthStencilAttachment: depthAttachment,
        timestampWrites,
    });

    // Optional viewport / scissor for compositing multiple views into one canvas. Resolved into
    // physical-pixel, framebuffer-clamped rects on the pass context by resolveViewportScissor.
    if (passCtx.viewport) {
        const v = passCtx.viewportValue;
        gpuPass.setViewport(v.x, v.y, v.width, v.height, v.minDepth, v.maxDepth);
    }
    if (passCtx.scissor) {
        const s = passCtx.scissorValue;
        gpuPass.setScissorRect(s.x, s.y, s.width, s.height);
    }

    const currentSets: CurrentSets = {
        bindingGroups: [],
        attributes: [],
        index: null,
        pipeline: null,
        stencilRef: null,
    };

    if (inspector) inspector.perf.start('drawCalls');

    for (const { renderObject, item } of preparedObjects) {
        const mesh = item.mesh!;
        const material = item.material!;
        const geometry = item.geometry!;
        const nodeState = renderObject.nodeBuilderState!;

        if (mesh.count === 0 && mesh.draws === undefined) continue;

        const frame = nodes.nodeFrame;
        frame.object = mesh;
        frame.material = material;
        frame.camera = renderObject.camera;
        frame.scene = renderObject.scene;

        NodeManager.updateForRender(nodes, renderObject);

        if (inspector) inspector.perf.start('updateForRender');
        RenderObjects.updateRenderObject(
            bindings,
            geometries,
            device,
            buffers,
            textures,
            renderObjectGpu,
            renderObject,
            frame,
        );
        if (inspector) inspector.perf.end('updateForRender');

        const gpu = RenderObjectGpu.getRenderObjectGpu(renderObjectGpu, renderObject);

        if (gpu.pipeline !== currentSets.pipeline) {
            passSetPipeline(gpuPass, inspector, gpu.pipeline!, mesh.name || material.constructor.name);
            currentSets.pipeline = gpu.pipeline;
        }

        // The stencil reference is dynamic pass state (not baked into the pipeline); set it when a
        // stencil-testing material's ref changes. Only meaningful on a stencil-capable attachment.
        if (passCtx.stencil && material.stencilTest && currentSets.stencilRef !== material.stencilRef) {
            gpuPass.setStencilReference(material.stencilRef);
            currentSets.stencilRef = material.stencilRef;
        }

        const bindGroups = gpu.bindGroups;
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
                gpuBuf = Buffers.ensureUploaded(buffers, device, bufAttr);
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
                    buffers,
                    device,
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
            const idxBuf = Buffers.ensureUploaded(buffers, device, geometry.index);
            if (currentSets.index !== idxBuf) {
                passSetIndexBuffer(gpuPass, inspector, idxBuf, getIndexFormat(geometry.index.array)!);
                currentSets.index = idxBuf;
            }
            if (mesh.draws !== undefined) {
                // Batched: one instanced drawIndexed per entry, each carrying its own firstInstance
                // (native — instance_index is base-inclusive on WebGPU).
                for (const d of mesh.draws as IndexedMeshDraw[]) {
                    if (d.instanceCount <= 0) continue;
                    passDrawIndexed(gpuPass, inspector, d.indexCount, d.instanceCount, d.firstIndex, d.firstInstance, d.baseVertex ?? 0);
                }
            } else if (geometry.indirect) {
                const indirect = geometry.indirect;
                const indBuf = Buffers.ensureUploaded(buffers, device, indirect);
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
            if (mesh.draws !== undefined) {
                // Batched non-indexed: one instanced draw per entry, each carrying its own firstInstance.
                for (const d of mesh.draws as NonIndexedMeshDraw[]) {
                    if (d.instanceCount <= 0) continue;
                    passDraw(gpuPass, inspector, d.vertexCount, d.instanceCount, d.firstVertex, d.firstInstance);
                }
            } else if (geometry.indirect) {
                const indirect = geometry.indirect;
                const indBuf = Buffers.ensureUploaded(buffers, device, indirect);
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
        NodeManager.updateAfter(nodes, renderObject);
        if (inspector) inspector.perf.end('updateAfter');
    }

    if (inspector) inspector.perf.end('drawCalls');

    gpuPass.end();
    if (inspector) inspector.finishRender(passId, nodes.nodeFrame.frameId);
}

// ---------------------------------------------------------------------------
// Teardown — release every device resource the renderer owns.
// ---------------------------------------------------------------------------

/**
 * Release all device resources: the canvas context, swapchain textures, default placeholder
 * textures + samplers, mipmap state, pipeline caches, and (unless the device was pre-created) the
 * device itself. After this the renderer is unusable.
 */
export function disposeDevice(
    contexts: WeakMap<CanvasTarget, GPUCanvasContext>,
    device: GPUDevice | null,
    deviceProvided: boolean,
    textures: Textures.TextureCache,
    pipelines: Pipelines.PipelinesState,
    bindGroupLayoutCache: BindGroupLayoutCache,
    sc: SwapchainState,
): void {
    // Unconfigure and release the swapchain canvas context (no-op in headless mode).
    if (sc.canvasTarget) releaseContext(contexts, sc.canvasTarget);

    // Destroy swapchain textures
    sc.depthTexture?.destroy();
    sc.msaaTexture?.destroy();
    sc.depthTexture = null;
    sc.depthTextureView = null;
    sc.msaaTexture = null;
    sc.msaaTextureView = null;

    // Destroy default placeholder textures
    for (const tex of textures.defaultTextures.values()) {
        tex.destroy();
    }
    textures.defaultTextures.clear();
    textures.samplerCache.clear();

    // Dispose mipmap generation state
    if (textures.mipmapState) {
        disposeMipmapState(textures.mipmapState);
        textures.mipmapState = null;
    }

    // Clear pipeline caches + the shared bind group layout cache (backing both pipelines + bindings)
    pipelines.renderPipelines.clear();
    pipelines.computePipelines.clear();
    bindGroupLayoutCache.cache.clear();

    // Destroy the device unless it was externally provided
    if (!deviceProvided && device) {
        device.destroy();
    }
}

/** tracks currently set GPU state to avoid redundant setBindGroup/setVertexBuffer/setIndexBuffer calls */
type CurrentSets = {
    bindingGroups: number[];
    attributes: (GPUBuffer | null)[];
    index: GPUBuffer | null;
    pipeline: GPURenderPipeline | null;
    stencilRef: number | null;
};

// ---------------------------------------------------------------------------
// Pass-command helpers, issue the real GPU encoder call AND the inspector hook
// in one place so neither call sites nor the inspector interface accumulate
// per-command boilerplate.
// ---------------------------------------------------------------------------

function passSetPipeline(
    pass: GPURenderPassEncoder,
    inspector: InspectorBase | null,
    pipeline: GPURenderPipeline,
    label: string,
): void {
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
    firstInstance = 0,
): void {
    pass.draw(vertexCount, instanceCount, firstVertex, firstInstance);
    if (inspector) inspector.draw(vertexCount, instanceCount);
}

function passDrawIndexed(
    pass: GPURenderPassEncoder,
    inspector: InspectorBase | null,
    indexCount: number,
    instanceCount: number,
    firstIndex: number,
    firstInstance = 0,
    baseVertex = 0,
): void {
    pass.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
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
