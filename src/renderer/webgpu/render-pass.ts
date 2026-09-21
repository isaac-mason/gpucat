import type { CubeRenderTarget } from '../../core/cube-render-target';
import { getIndexFormat } from '../../core/gpu-buffer';
import type { RenderTarget } from '../../core/render-target';
import type { InspectorBase } from '../../inspector/inspector-base';
import type { IndexedMeshDraw, NonIndexedMeshDraw } from '../../objects/mesh';
import type { CanvasTarget } from '../core/canvas-target';
import { resolveIndexedDrawRange, resolveVertexDrawRange } from '../core/draw-range';
import type { DrawOptions, RenderBundle } from '../core/frame';
import type { RendererInfo } from '../core/info';
import type { NodeManagerState } from '../core/node-manager';
import * as NodeManager from '../core/node-manager';
import type { RenderContext } from '../core/pass-context';
import { pipelineLabel } from '../core/render-object';
import type { PreparedRenderObject, PreparedSegment, RenderPassParams } from '../core/render-types';
import type { BackendState } from './backend-state';
import { disposeBindGroupLayoutCache } from './bind-group-layout';
import * as Buffers from './buffers';
import * as Pipelines from './pipelines';
import { formatHasStencil } from './pipelines';
import * as RenderObjectGpu from './render-object-gpu';
import * as RenderObjects from './render-objects';
import * as RenderTargets from './render-target';
import * as Samplers from './samplers';
import * as Textures from './textures';

// Canvas context — the renderer owns the WebGPU canvas context.

/**
 * Get (or lazily create + configure) the WebGPU canvas context for a canvas target. Safe to call
 * repeatedly; the context is cached per canvas target after first acquisition. The context is
 * acquired from `canvasTarget.canvas.getContext('webgpu')` and configured against `device` with
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
        const acquired = canvasTarget.canvas.getContext('webgpu');
        if (!acquired) {
            throw new Error('[webgpu] Failed to get WebGPU context from canvas.');
        }
        acquired.configure({ device, format, alphaMode: alphaMode ?? canvasTarget.alphaMode });
        canvasTarget.colorFormat = format;
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
    canvasTarget.colorFormat = format;
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

// Swapchain textures.

/**
 * Swapchain state owned by the renderer: the canvas target, sample count, depth format, and the
 * depth/msaa attachment textures (+ their cached views). Read when resolving swapchain
 * (renderTarget === null) attachments and recreated on `resize`.
 */
/** One canvas target's own depth and MSAA attachments, sized and sampled to that target. */
export type CanvasAttachments = {
    /** Backing-store size this target's context was last configured against. */
    configuredWidth: number;
    configuredHeight: number;
    /** Swapchain depth texture (recreated on resize). */
    depthTexture: GPUTexture | null;
    depthTextureView: GPUTextureView | null;
    /** MSAA color texture (null when samples <= 1). */
    msaaTexture: GPUTexture | null;
    msaaTextureView: GPUTextureView | null;
};

export type SwapchainState = {
    /** Every canvas this renderer has allocated attachments for, so `dispose` can reach all of them. */
    targets: Set<CanvasTarget>;
    /** Per-target attachments, because a frame may draw to several canvases of differing size. */
    byTarget: WeakMap<CanvasTarget, CanvasAttachments>;
};

/**
 * The swapchain's own depth and MSAA attachments. These belong to the swapchain, not to any
 * `RenderTarget`, so they live beside `SwapchainState` rather than in `render-target.ts`.
 */
export function createSwapchainDepthTexture(
    device: GPUDevice,
    width: number,
    height: number,
    sampleCount: number,
    format: GPUTextureFormat = 'depth24plus',
): GPUTexture {
    return device.createTexture({
        size: [width, height],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        sampleCount,
    });
}

export function createSwapchainMsaaTexture(
    device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat,
    sampleCount: number,
): GPUTexture {
    return device.createTexture({
        size: [width, height],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
        sampleCount,
    });
}

export function createSwapchainState(): SwapchainState {
    return {
        targets: new Set(),
        byTarget: new WeakMap(),
    };
}

export function attachmentsFor(sc: SwapchainState, target: CanvasTarget): CanvasAttachments {
    let entry = sc.byTarget.get(target);
    if (entry === undefined) {
        sc.targets.add(target);
        entry = {
            configuredWidth: 0,
            configuredHeight: 0,
            depthTexture: null,
            depthTextureView: null,
            msaaTexture: null,
            msaaTextureView: null,
        };
        sc.byTarget.set(target, entry);
    }
    return entry;
}

export function samplesFor(target: CanvasTarget): number {
    return target.samples <= 1 ? 0 : target.samples;
}

export function depthFormatFor(target: CanvasTarget): GPUTextureFormat {
    return target.depthFormat as GPUTextureFormat;
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
    target: CanvasTarget,
): void {
    const entry = attachmentsFor(sc, target);
    const samples = samplesFor(target);
    const sampleCount = samples > 1 ? samples : 1;

    entry.depthTexture?.destroy();
    entry.depthTexture = createSwapchainDepthTexture(device, width, height, sampleCount, depthFormatFor(target));
    entry.depthTextureView = entry.depthTexture.createView();

    if (samples > 1) {
        entry.msaaTexture?.destroy();
        entry.msaaTexture = createSwapchainMsaaTexture(device, width, height, format, samples);
        entry.msaaTextureView = entry.msaaTexture.createView();
    }
}

// Attachment resolution — builds GPU color/depth attachments per target kind.

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
    params: RenderPassParams,
): Pick<GPURenderPassDepthStencilAttachment, 'stencilLoadOp' | 'stencilStoreOp' | 'stencilClearValue'> | undefined {
    if (!formatHasStencil(format)) return undefined;
    return {
        stencilLoadOp: params.autoClearStencil ? 'clear' : 'load',
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
    RenderTargets.ensureRenderTargetTexturesAllocated(textures, device, renderTarget);

    // `clear: false` loads, which is how several viewport/scissor passes composite into one target.
    // MSAA cannot 'load' a resolve-only target, so it always clears.
    const loadOp: GPULoadOp = params.autoClear ? 'clear' : 'load';
    const colorAttachments: GPURenderPassColorAttachment[] = [];
    for (const tex of renderTarget.textures) {
        const textureData = Textures.getTextureData(textures, tex._gpuTexture);
        if (!textureData) {
            throw new Error('[webgpu] Render target texture not found in cache');
        }
        // MSAA: render into the multisampled texture and resolve into the sampled
        // single-sample texture. Otherwise render directly into the single texture.
        const msaaView = RenderTargets.getRenderTargetMsaaView(textureData);
        colorAttachments.push(
            msaaView
                ? {
                      view: msaaView,
                      resolveTarget: RenderTargets.getRenderTargetView(textureData),
                      clearValue: clearColor,
                      loadOp: 'clear',
                      storeOp: 'store',
                  }
                : {
                      view: RenderTargets.getRenderTargetView(textureData),
                      clearValue: clearColor,
                      loadOp,
                      storeOp: 'store',
                  },
        );
    }

    let depthAttachment: GPURenderPassDepthStencilAttachment | undefined;
    if (renderTarget._depthAttachment) {
        const depthTextureData = Textures.getTextureData(textures, renderTarget._depthAttachment._gpuTexture);
        if (depthTextureData) {
            depthAttachment = {
                view: RenderTargets.getRenderTargetView(depthTextureData),
                depthClearValue: params.clearDepthValue,
                depthLoadOp: params.autoClearDepth ? 'clear' : 'load',
                depthStoreOp: 'store',
                ...stencilAttachmentOps(renderTarget._depthAttachment.format, params),
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
    const target = params.canvasTarget!;
    const ctx = getContext(contexts, device, target, format);
    const entry = attachmentsFor(sc, target);

    // Safari drops the context's configuration on every backing-store resize, and getCurrentTexture()
    // on an unconfigured context throws, so reconfigure before touching it rather than after.
    const size = target.getDrawingBufferSize();
    if (entry.configuredWidth !== size.width || entry.configuredHeight !== size.height) {
        reconfigureContext(contexts, device, target, format);
        entry.configuredWidth = size.width;
        entry.configuredHeight = size.height;
    }

    const currentTexture = ctx.getCurrentTexture();
    const samples = samplesFor(target);

    // The current swapchain texture is the size authority for this pass: it's what the MSAA resolve
    // target (and the non-MSAA color view) is created from. Reconcile the target's cached depth/MSAA
    // pair against the live texture, since a resize can leave it a frame stale — WebGPU rejects a
    // render pass whose attachments differ in size ("resolve target size ... does not match").
    if (
        !entry.depthTexture ||
        entry.depthTexture.width !== currentTexture.width ||
        entry.depthTexture.height !== currentTexture.height
    ) {
        recreateSwapchainTextures(device, sc, format, currentTexture.width, currentTexture.height, target);
    }

    const swapchainView = currentTexture.createView();

    // `clear: false` loads, which is how several viewport/scissor passes composite into one canvas.
    // MSAA cannot 'load' a resolve-only target, so it always clears.
    const loadOp: GPULoadOp = params.autoClear ? 'clear' : 'load';
    const colorAttachments: GPURenderPassColorAttachment[] = [];
    if (samples > 1 && entry.msaaTextureView) {
        colorAttachments.push({
            view: entry.msaaTextureView,
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
            view: entry.depthTextureView!,
            depthClearValue: params.clearDepthValue,
            depthLoadOp: params.autoClearDepth ? 'clear' : 'load',
            depthStoreOp: 'store',
            ...stencilAttachmentOps(depthFormatFor(target), params),
        },
    };
}

/** Build the color/depth attachments for a cube render target's active face. */
function resolveCubeAttachments(
    device: GPUDevice,
    textures: Textures.TextureCache,
    renderTarget: CubeRenderTarget,
    clearColor: GPUColorDict,
    params: RenderPassParams,
): ResolvedAttachments {
    RenderTargets.ensureRenderTargetTexturesAllocated(textures, device, renderTarget);

    const cubeData = Textures.getTextureData(textures, renderTarget.texture._gpuTexture);
    if (!cubeData) {
        throw new Error('[webgpu] Cube render target texture not found in cache');
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
    if (renderTarget._depthAttachment) {
        const depthData = Textures.getTextureData(textures, renderTarget._depthAttachment._gpuTexture);
        if (depthData) {
            depthAttachment = {
                view: RenderTargets.getRenderTargetView(depthData),
                depthClearValue: params.clearDepthValue,
                depthLoadOp: params.autoClearDepth ? 'clear' : 'load',
                depthStoreOp: 'store',
                ...stencilAttachmentOps(renderTarget._depthAttachment.format, params),
            };
        }
    }

    return { colorAttachments, depthAttachment };
}

/**
 * Build GPU color and depth attachments, dispatching on the target kind. Shared by `executeRenderPass`
 * and `clear()` (which then overrides the load ops for the manual clear).
 */
export function resolveAttachments(b: BackendState, params: RenderPassParams): ResolvedAttachments {
    const { device, textures } = b;
    const { renderTarget, clearColor } = params;
    if (renderTarget?.isCubeRenderTarget) {
        return resolveCubeAttachments(device, textures, renderTarget as CubeRenderTarget, clearColor, params);
    }
    if (renderTarget) return resolveRenderTargetAttachments(device, textures, renderTarget, clearColor, params);
    return resolveSwapchainAttachments(b.canvasContexts, device, b.swapchain, b.format, clearColor, params);
}

// Manual clear — a clear-only render pass honoring the clear flags.

// Render pass — attachment resolution + inner draw loop.

/** Begin the GPU render pass, issue all draw calls, and end the pass. */
/** What the draw loop needs: a bundle encoder offers the same surface as a pass encoder. */
export type DrawEncoder = GPURenderPassEncoder | GPURenderBundleEncoder;

export type PassScope = { gpuPass: GPURenderPassEncoder; currentSets: CurrentSets };

/** The draw loop's own scope, which a bundle recording satisfies with a bundle encoder. */
export type DrawScope = { gpuPass: DrawEncoder; currentSets: CurrentSets };

export function beginPass(
    encoder: GPUCommandEncoder,
    passCtx: RenderContext,
    colorAttachments: GPURenderPassColorAttachment[],
    depthAttachment: GPURenderPassDepthStencilAttachment | undefined,
    passId: string,
    inspector: InspectorBase | null,
): PassScope {
    const gpuPass = encoder.beginRenderPass({
        label: passId,
        colorAttachments,
        depthStencilAttachment: depthAttachment,
        timestampWrites: inspector ? inspector.getTimestampWrites(passId) : undefined,
    });

    // Physical-pixel, framebuffer-clamped rects, already resolved onto the pass context.
    if (passCtx.viewport) {
        const v = passCtx.viewportValue;
        gpuPass.setViewport(v.x, v.y, v.width, v.height, v.minDepth, v.maxDepth);
    }
    if (passCtx.scissor) {
        const s = passCtx.scissorValue;
        gpuPass.setScissorRect(s.x, s.y, s.width, s.height);
    }

    return {
        gpuPass,
        currentSets: createCurrentSets(),
    };
}

export function endPass(scope: PassScope): void {
    scope.gpuPass.end();
}

/** Everything a draw needs that is fixed for the whole pass, so only a range and an encoder vary. */
type EncodeContext = {
    b: BackendState;
    nodes: NodeManagerState;
    passCtx: RenderContext;
    preparedObjects: readonly PreparedRenderObject[];
    preparedOpts: readonly (DrawOptions | null)[];
    inspector: InspectorBase | null;
    info: RendererInfo;
};

export function encodeDraws(
    b: BackendState,
    nodes: NodeManagerState,
    passCtx: RenderContext,
    preparedObjects: readonly PreparedRenderObject[],
    preparedOpts: readonly (DrawOptions | null)[],
    count: number,
    inspector: InspectorBase | null,
    info: RendererInfo,
    scope: PassScope,
    segments: readonly PreparedSegment[],
): void {
    if (inspector) inspector.perf.start('drawCalls');

    const ctx: EncodeContext = { b, nodes, passCtx, preparedObjects, preparedOpts, inspector, info };

    if (segments.length === 0) {
        encodeDrawRange(ctx, 0, count, scope);
    } else {
        for (const segment of segments) {
            const { bundle, start } = segment;
            const end = start + segment.count;
            if (bundle === null) {
                encodeDrawRange(ctx, start, end, scope);
                continue;
            }
            // Before the cache check: the refresh is what discovers a rebuilt bind group.
            refreshBundledRange(ctx, start, end);
            scope.gpuPass.executeBundles([getOrRecordBundle(ctx, start, end, bundle)]);
            // A bundle sets its own pipeline and bindings, so what the pass had set no longer holds.
            resetCurrentSets(scope.currentSets);
        }
    }

    if (inspector) inspector.perf.end('drawCalls');
}

/** A pass with no camera still needs a key at the camera level, and every such pass shares this one. */
const CAMERALESS: object = {};

/** Re-recorded on a miss or a version change. Camera is in the key because a recording bakes its view bindings in. */
function getOrRecordBundle(ctx: EncodeContext, from: number, to: number, bundle: RenderBundle): GPURenderBundle {
    const { b, passCtx } = ctx;
    let byCamera = b.renderBundles.get(bundle);
    if (byCamera === undefined) {
        byCamera = new WeakMap();
        b.renderBundles.set(bundle, byCamera);
    }
    const cameraKey = passCtx.camera ?? CAMERALESS;
    let byContext = byCamera.get(cameraKey);
    if (byContext === undefined) {
        byContext = new Map();
        byCamera.set(cameraKey, byContext);
    }

    const cached = byContext.get(passCtx.id);
    const rebuilds = b.bindings.bindGroupRebuilds;
    if (cached !== undefined && cached.version === bundle.version && cached.rebuilds === rebuilds) return cached.gpu;

    const encoder = b.device.createRenderBundleEncoder({
        label: bundle.label,
        colorFormats: Pipelines.getRenderContextColorFormats(passCtx, b.format),
        depthStencilFormat: Pipelines.getRenderContextDepthFormat(passCtx) ?? undefined,
        sampleCount: passCtx.sampleCount,
    });
    encodeDrawRange(ctx, from, to, { gpuPass: encoder, currentSets: createCurrentSets() });
    const gpu = encoder.finish({ label: bundle.label });

    byContext.set(passCtx.id, { gpu, version: bundle.version, rebuilds: b.bindings.bindGroupRebuilds });
    return gpu;
}

/** Replaying a bundle saves the encoding and not this, so both paths run it and it has one implementation. */
function refreshDraw(ctx: EncodeContext, index: number): boolean {
    const { b, nodes, preparedObjects, preparedOpts, inspector } = ctx;
    const renderObject = preparedObjects[index];
    const { mesh, material } = renderObject;

    const opts = preparedOpts[index];
    if ((opts?.instances ?? mesh.count) === 0 && (opts?.draws ?? mesh.draws) === undefined) return false;

    const frame = nodes.nodeFrame;
    frame.object = mesh;
    frame.material = material;
    frame.camera = renderObject.camera;

    NodeManager.updateForRender(nodes, renderObject);

    if (inspector) inspector.perf.start('updateForRender');
    RenderObjects.updateRenderObject(b, renderObject, frame);
    if (inspector) inspector.perf.end('updateForRender');
    return true;
}

/** What a replayed bundle still owes its draws, since `executeBundles` runs none of their update. */
function refreshBundledRange(ctx: EncodeContext, from: number, to: number): void {
    for (let index = from; index < to; index++) refreshDraw(ctx, index);
}

/** A range, not the whole array, because a bundle is a contiguous slice of it recorded against its own encoder. */
function encodeDrawRange(ctx: EncodeContext, from: number, to: number, { gpuPass, currentSets }: DrawScope): void {
    const { b, nodes, passCtx, preparedObjects, preparedOpts, inspector, info } = ctx;
    for (let index = from; index < to; index++) {
        const renderObject = preparedObjects[index];
        const { mesh, material, geometry } = renderObject;
        const nodeState = renderObject.nodeBuilderState!;

        const opts = preparedOpts[index];
        const draws = opts?.draws ?? mesh.draws;
        const instances = opts?.instances ?? mesh.count;
        const range = opts?.range;

        if (!refreshDraw(ctx, index)) continue;

        const gpu = RenderObjectGpu.getRenderObjectGpu(b.renderObjectGpu, renderObject);

        if (gpu.pipeline !== currentSets.pipeline) {
            passSetPipeline(gpuPass, inspector, gpu.pipeline!, pipelineLabel(mesh, material));
            currentSets.pipeline = gpu.pipeline;
        }

        // The stencil reference is dynamic pass state (not baked into the pipeline); set it when a
        // stencil-testing material's ref changes. Only meaningful on a stencil-capable attachment.
        // A bundle encoder rejects it, which is why a stencil-ref material cannot be bundled.
        if (passCtx.stencil && material.stencilTest && currentSets.stencilRef !== material.stencilRef) {
            if (!('setStencilReference' in gpuPass)) {
                throw new Error(`[bundle] "${mesh.name || 'mesh'}" sets a stencil reference, which a render bundle cannot`);
            }
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
                gpuBuf = Buffers.ensureUploaded(b.buffers, b.device, bufAttr, group.name);
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
                gpuBuf = Buffers.ensureUploaded(b.buffers, b.device, gpuBuffer, group.name ?? 'vertex');
            }
            if (currentSets.attributes[slot] !== gpuBuf) {
                passSetVertexBuffer(gpuPass, inspector, slot, gpuBuf);
                currentSets.attributes[slot] = gpuBuf;
            }
            slot++;
        }

        if (geometry.index) {
            const idxBuf = Buffers.ensureUploaded(b.buffers, b.device, geometry.index, 'index');
            if (currentSets.index !== idxBuf) {
                passSetIndexBuffer(gpuPass, inspector, idxBuf, getIndexFormat(geometry.index.array)!);
                currentSets.index = idxBuf;
            }
            if (draws !== undefined) {
                // Batched: one instanced drawIndexed per entry, each carrying its own firstInstance
                // (native — instance_index is base-inclusive on WebGPU).
                for (const d of draws as IndexedMeshDraw[]) {
                    if (d.instanceCount <= 0) continue;
                    passDrawIndexed(
                        gpuPass,
                        inspector,
                        info,
                        d.indexCount,
                        d.instanceCount,
                        d.firstIndex,
                        d.firstInstance,
                        d.baseVertex ?? 0,
                    );
                }
            } else if (geometry.indirect) {
                const indirect = geometry.indirect;
                const indBuf = Buffers.ensureUploaded(b.buffers, b.device, indirect, 'indirect');
                const byteStride = indirect.itemSize * 4;
                const baseOffset = geometry.indirectOffset;
                const drawCount = geometry.indirectDrawCount ?? indirect.count;
                for (let d = 0; d < drawCount; d++) {
                    passDrawIndexedIndirect(gpuPass, inspector, info, indBuf, baseOffset + d * byteStride);
                }
            } else {
                const { first, count } = resolveIndexedDrawRange(geometry, range);
                passDrawIndexed(gpuPass, inspector, info, count, instances, first);
            }
        } else {
            if (draws !== undefined) {
                // Batched non-indexed: one instanced draw per entry, each carrying its own firstInstance.
                for (const d of draws as NonIndexedMeshDraw[]) {
                    if (d.instanceCount <= 0) continue;
                    passDraw(gpuPass, inspector, info, d.vertexCount, d.instanceCount, d.firstVertex, d.firstInstance);
                }
            } else if (geometry.indirect) {
                const indirect = geometry.indirect;
                const indBuf = Buffers.ensureUploaded(b.buffers, b.device, indirect, 'indirect');
                const byteStride = indirect.itemSize * 4;
                const baseOffset = geometry.indirectOffset;
                const drawCount = geometry.indirectDrawCount ?? indirect.count;
                for (let d = 0; d < drawCount; d++) {
                    passDrawIndirect(gpuPass, inspector, info, indBuf, baseOffset + d * byteStride);
                }
            } else {
                const { first, count } = resolveVertexDrawRange(geometry, range);
                passDraw(gpuPass, inspector, info, count, instances, first);
            }
        }

        if (inspector) inspector.perf.start('updateAfter');
        NodeManager.updateAfter(nodes, renderObject);
        if (inspector) inspector.perf.end('updateAfter');
    }
}

// Teardown — release every device resource the renderer owns.

/**
 * Release all device resources: the canvas context, swapchain textures, default placeholder
 * textures + samplers, mipmap state, pipeline caches, and (unless the device was pre-created) the
 * device itself. After this the renderer is unusable.
 */
export function disposeDevice(b: BackendState, deviceProvided: boolean): void {
    const { canvasContexts: contexts, device, textures, samplers, buffers, pipelines, bindGroupLayoutCache, swapchain: sc } = b;
    for (const target of sc.targets) {
        releaseContext(contexts, target);
        const entry = attachmentsFor(sc, target);
        entry.depthTexture?.destroy();
        entry.msaaTexture?.destroy();
        entry.depthTexture = null;
        entry.depthTextureView = null;
        entry.msaaTexture = null;
        entry.msaaTextureView = null;
    }
    sc.targets.clear();

    // Each cache tears itself down: whoever owns a cache owns its teardown, so this function sequences
    // them rather than reaching into their internals.
    Textures.disposeTextureCache(textures);
    Samplers.disposeSamplerCache(samplers);
    Buffers.disposeBufferCache(buffers);
    Pipelines.disposePipelines(pipelines);
    disposeBindGroupLayoutCache(bindGroupLayoutCache);

    // Destroy the device unless it was externally provided
    if (!deviceProvided && device) {
        device.destroy();
    }
}

/** tracks currently set GPU state to avoid redundant setBindGroup/setVertexBuffer/setIndexBuffer calls */
function createCurrentSets(): CurrentSets {
    return { bindingGroups: [], attributes: [], index: null, pipeline: null, stencilRef: null };
}

/** After a bundle replays, nothing the pass had set still holds. */
function resetCurrentSets(sets: CurrentSets): void {
    sets.bindingGroups.length = 0;
    sets.attributes.length = 0;
    sets.index = null;
    sets.pipeline = null;
    sets.stencilRef = null;
}

type CurrentSets = {
    bindingGroups: number[];
    attributes: (GPUBuffer | null)[];
    index: GPUBuffer | null;
    pipeline: GPURenderPipeline | null;
    stencilRef: number | null;
};

// Pass-command helpers, issue the real GPU encoder call AND the inspector hook
// in one place so neither call sites nor the inspector interface accumulate
// per-command boilerplate.

function passSetPipeline(pass: DrawEncoder, inspector: InspectorBase | null, pipeline: GPURenderPipeline, label: string): void {
    pass.setPipeline(pipeline);
    if (inspector) inspector.setPipeline(label);
}

function passSetBindGroup(
    pass: DrawEncoder,
    inspector: InspectorBase | null,
    index: number,
    bindGroup: GPUBindGroup,
    label: string,
): void {
    pass.setBindGroup(index, bindGroup);
    if (inspector) inspector.setBindGroup(index, label);
}

function passSetVertexBuffer(pass: DrawEncoder, inspector: InspectorBase | null, slot: number, buffer: GPUBuffer): void {
    pass.setVertexBuffer(slot, buffer);
    if (inspector) inspector.setVertexBuffer(slot);
}

function passSetIndexBuffer(pass: DrawEncoder, inspector: InspectorBase | null, buffer: GPUBuffer, format: GPUIndexFormat): void {
    pass.setIndexBuffer(buffer, format);
    if (inspector) inspector.setIndexBuffer();
}

function passDraw(
    pass: DrawEncoder,
    inspector: InspectorBase | null,
    info: RendererInfo,
    vertexCount: number,
    instanceCount: number,
    firstVertex: number,
    firstInstance = 0,
): void {
    pass.draw(vertexCount, instanceCount, firstVertex, firstInstance);
    info.render.drawCalls++;
    info.render.triangles += (instanceCount * vertexCount) / 3;
    if (inspector) inspector.draw(vertexCount, instanceCount);
}

function passDrawIndexed(
    pass: DrawEncoder,
    inspector: InspectorBase | null,
    info: RendererInfo,
    indexCount: number,
    instanceCount: number,
    firstIndex: number,
    firstInstance = 0,
    baseVertex = 0,
): void {
    pass.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
    info.render.drawCalls++;
    info.render.triangles += (instanceCount * indexCount) / 3;
    if (inspector) inspector.drawIndexed(indexCount, instanceCount);
}

// Indirect draws count the CALL but not the triangles: the vertex/instance counts live in a GPU
// buffer the CPU never reads back, so `info.render.triangles` is a floor rather than a guess.
function passDrawIndirect(
    pass: DrawEncoder,
    inspector: InspectorBase | null,
    info: RendererInfo,
    indirectBuffer: GPUBuffer,
    indirectOffset: number,
): void {
    pass.drawIndirect(indirectBuffer, indirectOffset);
    info.render.drawCalls++;
    if (inspector) inspector.drawIndirect();
}

function passDrawIndexedIndirect(
    pass: DrawEncoder,
    inspector: InspectorBase | null,
    info: RendererInfo,
    indirectBuffer: GPUBuffer,
    indirectOffset: number,
): void {
    pass.drawIndexedIndirect(indirectBuffer, indirectOffset);
    info.render.drawCalls++;
    if (inspector) inspector.drawIndexedIndirect();
}
