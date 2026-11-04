import type { RenderTarget } from '../../core/render-target';
import type { InspectorBase } from '../../inspector/inspector-base';
import type { IndexedMeshDraw, NonIndexedMeshDraw } from '../../objects/mesh';
import type { CanvasTarget } from '../core/canvas-target';
import { resolveIndexedDrawRange, resolveVertexDrawRange } from '../core/draw-range';
import type { DrawOptions, RenderBundle } from '../core/frame';
import {
    type Allocation,
    clearAllocation,
    createAllocation,
    type MemoryTally,
    type RendererInfo,
    type StateInfo,
    setAllocation,
} from '../core/info';
import type { NodeManagerState } from '../core/node-manager';
import * as NodeManager from '../core/node-manager';
import type { RenderContext, ScissorValue, ViewportValue } from '../core/pass-context';
import type { PassOrder } from '../core/pass-order';
import { pipelineLabel } from '../core/render-object';
import { formatHasStencil, type PreparedRenderObject, type RenderPassParams } from '../core/render-types';
import type { View } from '../core/view';
import { type DrawBindings, updateRenderBindings } from './bindings';
import * as Buffers from './buffers';
import * as Geometries from './geometries';
import { createPassState, type PassState, resetPassState, setBindGroups, takesPipeline } from './pass-state';
import * as Pipelines from './pipelines';
import * as RenderObjectGpu from './render-object-gpu';
import * as RenderTargets from './render-target';
import * as Textures from './textures';
import type { WebGPUBackend } from './webgpu-backend';

// Canvas context — the renderer owns the WebGPU canvas context.

/**
 * Get (or lazily create + configure) the WebGPU canvas context for a canvas target. Safe to call
 * repeatedly; the context is cached per canvas target after first acquisition. The context is
 * acquired from `canvasTarget.canvas.getContext('webgpu')` and configured against `device` with
 * the given `format` and alpha mode (defaults to the canvas target's `alphaMode`).
 */
export function getContext(
    contexts: WeakMap<CanvasTarget, GPUCanvasContext>,
    sc: SwapchainState,
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
        canvasTarget.disposed = false;
        canvasTarget._onDispose = () => releaseCanvasTarget(contexts, sc, canvasTarget);
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

/** Unconfigure and release the WebGPU context for a canvas target. After this, `getContext()` creates a fresh context. */
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
    depthAllocation: Allocation;
    msaaAllocation: Allocation;
};

export type SwapchainState = {
    /** The backend's memory tally: the attachments are gpucat's, even though the canvas texture is not. */
    tally: MemoryTally;
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

export function createSwapchainState(tally: MemoryTally): SwapchainState {
    return {
        tally,
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
            depthAllocation: createAllocation('texture', 'depth', target.label ?? 'canvas'),
            msaaAllocation: createAllocation('texture', 'msaa', target.label ?? 'canvas'),
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
    setAllocation(
        sc.tally,
        entry.depthAllocation,
        RenderTargets.allocatedBytes(entry.depthTexture),
        'depth',
        entry.depthTexture.format,
    );

    entry.msaaTexture?.destroy();
    if (samples > 1) {
        entry.msaaTexture = createSwapchainMsaaTexture(device, width, height, format, samples);
        entry.msaaTextureView = entry.msaaTexture.createView();
        setAllocation(sc.tally, entry.msaaAllocation, RenderTargets.allocatedBytes(entry.msaaTexture), 'msaa', format);
    } else {
        entry.msaaTexture = null;
        entry.msaaTextureView = null;
        clearAllocation(sc.tally, entry.msaaAllocation);
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
        stencilLoadOp: params.clearsStencil ? 'clear' : 'load',
        stencilStoreOp: params.storesStencil ? 'store' : 'discard',
        stencilClearValue: params.clearStencilValue,
    };
}

/**
 * Attachments for a render target: each of its colour textures (MRT) and its depth, at the pass's mip and layer. A
 * multisampled target draws into that layer's multisampled textures and resolves the colour into the layer. A 3D
 * target's colour attachment is its mip, and the pass's layer is the slice drawn.
 */
function resolveRenderTargetAttachments(
    device: GPUDevice,
    textures: Textures.TextureCache,
    renderTarget: RenderTarget,
    clearColor: GPUColorDict,
    params: RenderPassParams,
): ResolvedAttachments {
    RenderTargets.ensureRenderTargetTexturesAllocated(textures, device, renderTarget);

    const { layer, mipLevel } = params;
    const is3d = renderTarget.dimension === '3d';
    // `clear: false` loads, which is how several viewport/scissor passes composite into one target.
    const loadOp: GPULoadOp = params.clearsColor ? 'clear' : 'load';
    const colorAttachments: GPURenderPassColorAttachment[] = [];
    for (const tex of renderTarget.textures) {
        const textureData = Textures.getTextureData(textures, tex._gpuTexture);
        if (!textureData) {
            throw new Error('[webgpu] Render target texture not found in cache');
        }
        const view = Textures.attachmentView(textureData, mipLevel, layer, is3d);
        const msaaView = RenderTargets.getRenderTargetMsaaView(textureData, layer);
        colorAttachments.push(
            msaaView
                ? { view: msaaView, resolveTarget: view, clearValue: clearColor, loadOp, storeOp: 'store' }
                : { view, depthSlice: is3d ? layer : undefined, clearValue: clearColor, loadOp, storeOp: 'store' },
        );
    }

    let depthAttachment: GPURenderPassDepthStencilAttachment | undefined;
    if (renderTarget._depthAttachment) {
        const depthTextureData = Textures.getTextureData(textures, renderTarget._depthAttachment._gpuTexture);
        if (!depthTextureData) {
            // Omitting it instead turns the depth test off for the pass, which reads as a sorting bug.
            throw new Error('[webgpu] this render target has a depth attachment that was never allocated.');
        }
        const view =
            RenderTargets.getRenderTargetMsaaView(depthTextureData, layer) ??
            Textures.attachmentView(depthTextureData, mipLevel, layer, false);
        // a read-only aspect takes no load or store op
        depthAttachment = params.readOnlyDepth
            ? {
                  view,
                  depthReadOnly: true,
                  ...(formatHasStencil(renderTarget._depthAttachment.format) ? { stencilReadOnly: true } : {}),
              }
            : {
                  view,
                  depthClearValue: params.clearDepthValue,
                  depthLoadOp: params.clearsDepth ? 'clear' : 'load',
                  depthStoreOp: params.storesDepth ? 'store' : 'discard',
                  ...stencilAttachmentOps(renderTarget._depthAttachment.format, params),
              };
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
    const ctx = getContext(contexts, sc, device, target, format);
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
    const loadOp: GPULoadOp = params.clearsColor ? 'clear' : 'load';
    const colorAttachments: GPURenderPassColorAttachment[] = [];
    if (samples > 1 && entry.msaaTextureView) {
        colorAttachments.push({
            view: entry.msaaTextureView,
            resolveTarget: swapchainView,
            clearValue: clearColor,
            // Discarded at pass end, so there is never anything to load and `clear: false` cannot apply.
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
            depthLoadOp: params.clearsDepth ? 'clear' : 'load',
            depthStoreOp: params.storesDepth ? 'store' : 'discard',
            ...stencilAttachmentOps(depthFormatFor(target), params),
        },
    };
}

/** Build GPU color and depth attachments, dispatching on the target kind. */
export function resolveAttachments(b: WebGPUBackend, params: RenderPassParams): ResolvedAttachments {
    const { device, textures } = b;
    const { renderTarget, clearColor } = params;
    if (renderTarget) return resolveRenderTargetAttachments(device, textures, renderTarget, clearColor, params);
    return resolveSwapchainAttachments(b.canvasContexts, device, b.swapchain, b.format, clearColor, params);
}

/** What the draw loop needs: a bundle encoder offers the same surface as a pass encoder. */
export type DrawEncoder = GPURenderPassEncoder | GPURenderBundleEncoder;

/** The encoder and what it has set: bindings, and the viewport and scissor it last set, the whole target at first. */
export type PassScope = {
    gpuPass: GPURenderPassEncoder;
    currentSets: CurrentSets;
    viewport: ViewportValue;
    scissor: ScissorValue;
    /** The pass order's view the rects were last set from, -1 before the first. */
    view: number;
};

/** The draw loop's own scope, which a bundle recording satisfies with a bundle encoder. */
export type DrawScope = { gpuPass: DrawEncoder; currentSets: CurrentSets };

export function beginPass(b: WebGPUBackend, params: RenderPassParams): PassScope {
    const { colorAttachments, depthAttachment } = resolveAttachments(b, params);
    const inspector = b.renderer.inspector;
    const gpuPass = b._currentEncoder!.beginRenderPass({
        label: params.passId,
        colorAttachments,
        depthStencilAttachment: depthAttachment,
        timestampWrites: inspector ? inspector.getTimestampWrites(params.passId) : undefined,
    });

    // Fresh per pass: a pooled one needs resetting at the top of every pass, where this starts empty. A GPU pass
    // starts with the whole target as both its viewport and scissor; each view sets its own when they differ.
    return {
        gpuPass,
        currentSets: createCurrentSets(b.renderer.info.state),
        viewport: { x: 0, y: 0, width: params.width, height: params.height, minDepth: 0, maxDepth: 1 },
        scissor: { x: 0, y: 0, width: params.width, height: params.height },
        view: -1,
    };
}

/** Sets the viewport and scissor of the pass order's view `index` where they differ from what the encoder has. A
 *  bundle keeps them: they are pass state, which `executeBundles` leaves alone. */
function applyView(scope: PassScope, order: PassOrder, index: number, width: number, height: number): void {
    if (scope.view === index) return;
    scope.view = index;
    const view = order.views[index]!;
    const want = view.viewport ? view.viewportValue : null;
    const x = want?.x ?? 0;
    const y = want?.y ?? 0;
    const w = want?.width ?? width;
    const h = want?.height ?? height;
    const minDepth = want?.minDepth ?? 0;
    const maxDepth = want?.maxDepth ?? 1;
    const viewport = scope.viewport;
    if (
        viewport.x !== x ||
        viewport.y !== y ||
        viewport.width !== w ||
        viewport.height !== h ||
        viewport.minDepth !== minDepth ||
        viewport.maxDepth !== maxDepth
    ) {
        scope.gpuPass.setViewport(x, y, w, h, minDepth, maxDepth);
        viewport.x = x;
        viewport.y = y;
        viewport.width = w;
        viewport.height = h;
        viewport.minDepth = minDepth;
        viewport.maxDepth = maxDepth;
    }

    const clip = view.scissor ? view.scissorValue : null;
    const sx = clip?.x ?? 0;
    const sy = clip?.y ?? 0;
    const sw = clip?.width ?? width;
    const sh = clip?.height ?? height;
    const scissor = scope.scissor;
    if (scissor.x !== sx || scissor.y !== sy || scissor.width !== sw || scissor.height !== sh) {
        scope.gpuPass.setScissorRect(sx, sy, sw, sh);
        scissor.x = sx;
        scissor.y = sy;
        scissor.width = sw;
        scissor.height = sh;
    }
}

export function endPass(scope: PassScope): void {
    scope.gpuPass.end();
}

/** Everything a draw needs that is fixed for the whole pass, so only a range and an encoder vary. */
export type EncodeContext = {
    b: WebGPUBackend;
    nodes: NodeManagerState;
    passCtx: RenderContext;
    params: RenderPassParams;
    preparedObjects: readonly PreparedRenderObject[];
    preparedOpts: readonly (DrawOptions | null)[];
    /** What each prepared draw binds, resolved when it was recorded. */
    bindings: readonly DrawBindings[];
    /** The order the draws encode in, and the view each was recorded under. */
    order: PassOrder;
    inspector: InspectorBase | null;
    info: RendererInfo;
};

/** Encodes the pass's blocks in order, each draw under the viewport and scissor it was recorded with. */
export function encodeDraws(ctx: EncodeContext, scope: PassScope): void {
    const inspector = ctx.inspector;
    if (inspector) inspector.perf.start('drawCalls');

    const order = ctx.order;
    for (let index = 0; index < order.blockCount; index++) {
        const block = order.blocks[index]!;
        const bundle = block.bundle;
        if (bundle === null) {
            encodeDrawList(ctx, block.draws, block.count, scope);
            continue;
        }
        const from = block.draws[0]!;
        const view = order.drawViews[from]!;
        applyView(scope, order, view, ctx.params.width, ctx.params.height);
        scope.gpuPass.executeBundles([getOrRecordBundle(ctx, from, from + block.count, bundle, order.views[view]!.camera)]);
        // A bundle sets its own pipeline and bindings, so what the pass had set no longer holds.
        resetCurrentSets(scope.currentSets);
    }

    if (inspector) inspector.perf.end('drawCalls');
}

/** A pass with no camera still needs a key at the camera level, and every such pass shares this one. */
const CAMERALESS: object = {};

/** A device bundle and the bind groups and dynamic offsets it baked, in draw then @group order. */
export type RecordedBundle = { gpu: GPURenderBundle; version: number; bakedGroups: GPUBindGroup[]; bakedOffsets: number[] };

/**
 * The recordings of one bundle under one camera and render context, one per replay in a frame. A camera
 * moved between two passes replaying the same bundle binds different allocations in each, so the two
 * need a recording apiece; keyed by occurrence, each holds frame to frame.
 */
export type BundleRecordings = { frameId: number; replays: number; recordings: RecordedBundle[] };

/**
 * Re-recorded on a miss, a version change, or when what it baked no longer matches this frame's bindings.
 * A dynamic uniform allocation follows the frame's order of draws, so a recording holds while that order does. Camera and occurrence are in the key so a bundle replayed under several cameras, or
 * more than once under one, keeps a recording for each rather than overwriting a shared one.
 */
function getOrRecordBundle(
    ctx: EncodeContext,
    from: number,
    to: number,
    bundle: RenderBundle,
    camera: View | null,
): GPURenderBundle {
    const { b, passCtx } = ctx;
    let byCamera = b.renderBundles.get(bundle);
    if (byCamera === undefined) {
        byCamera = new WeakMap();
        b.renderBundles.set(bundle, byCamera);
    }
    const cameraKey = camera ?? CAMERALESS;
    let byContext = byCamera.get(cameraKey);
    if (byContext === undefined) {
        byContext = new Map();
        byCamera.set(cameraKey, byContext);
    }

    let slots = byContext.get(passCtx.id);
    if (slots === undefined) {
        slots = { frameId: -1, replays: 0, recordings: [] };
        byContext.set(passCtx.id, slots);
    }
    const frameId = ctx.nodes.nodeFrame.frameId;
    if (slots.frameId !== frameId) {
        slots.frameId = frameId;
        slots.replays = 0;
    }
    const occurrence = slots.replays++;

    const cached = slots.recordings[occurrence];
    if (cached !== undefined && cached.version === bundle.version && bakedBindingsMatch(ctx, from, to, cached)) return cached.gpu;

    const encoder = b.device.createRenderBundleEncoder({
        label: bundle.label,
        colorFormats: Pipelines.getRenderContextColorFormats(passCtx, b.format),
        depthStencilFormat: Pipelines.getRenderContextDepthFormat(passCtx) ?? undefined,
        sampleCount: passCtx.sampleCount,
    });
    encodeDrawRange(ctx, from, to, { gpuPass: encoder, currentSets: createCurrentSets(ctx.info.state) });
    const recorded: RecordedBundle = {
        gpu: encoder.finish({ label: bundle.label }),
        version: bundle.version,
        bakedGroups: [],
        bakedOffsets: [],
    };
    forEachDrawnBinding(ctx, from, to, (group, offset) => {
        recorded.bakedGroups.push(group);
        recorded.bakedOffsets.push(offset);
    });

    slots.recordings[occurrence] = recorded;
    return recorded.gpu;
}

function bakedBindingsMatch(ctx: EncodeContext, from: number, to: number, recorded: RecordedBundle): boolean {
    let index = 0;
    let matches = true;
    forEachDrawnBinding(ctx, from, to, (group, offset) => {
        if (recorded.bakedGroups[index] !== group || recorded.bakedOffsets[index] !== offset) matches = false;
        index++;
    });
    return matches && index === recorded.bakedGroups.length;
}

/** Every bind group and dynamic offset the draws in the range set, in draw then @group order. */
function forEachDrawnBinding(
    ctx: EncodeContext,
    from: number,
    to: number,
    visit: (group: GPUBindGroup, offset: number) => void,
): void {
    for (let index = from; index < to; index++) {
        const { groups, offsets } = ctx.bindings[index];
        for (let group = 0; group < groups.length; group++) {
            const bound = groups[group];
            if (bound !== undefined) visit(bound, offsets[group]!);
        }
    }
}

/**
 * Runs a draw's node updates and resolves its uniforms and bind groups into `out`, at the call that
 * recorded it, so the draw uses the values set before that call. A replayed bundle's draws resolve the
 * same way when the bundle is executed: a replay saves the encoding, not this.
 */
export function resolveDrawBindings(
    b: WebGPUBackend,
    nodes: NodeManagerState,
    renderObject: PreparedRenderObject,
    out: DrawBindings,
    inspector: InspectorBase | null,
): void {
    const frame = nodes.nodeFrame;
    frame.object = renderObject.mesh;
    frame.material = renderObject.material;
    frame.camera = renderObject.camera;

    NodeManager.updateForRender(nodes, renderObject);

    if (inspector) inspector.perf.start('updateForRender');
    updateRenderBindings(b, renderObject, frame, out);
    if (inspector) inspector.perf.end('updateForRender');
}

/** A bundle's draws, `from` to `to`: a contiguous slice of the pass's, recorded against its own encoder. */
function encodeDrawRange(ctx: EncodeContext, from: number, to: number, scope: DrawScope): void {
    for (let index = from; index < to; index++) encodeDraw(ctx, index, scope);
}

/** A block's `count` draws, by index, each under the viewport and scissor it was recorded with. */
function encodeDrawList(ctx: EncodeContext, draws: readonly number[], count: number, scope: PassScope): void {
    const { order, params } = ctx;
    for (let at = 0; at < count; at++) {
        const index = draws[at]!;
        applyView(scope, order, order.drawViews[index]!, params.width, params.height);
        encodeDraw(ctx, index, scope);
    }
}

function encodeDraw(ctx: EncodeContext, index: number, { gpuPass, currentSets }: DrawScope): void {
    const { b, nodes, passCtx, preparedObjects, preparedOpts, inspector, info } = ctx;
    const renderObject = preparedObjects[index];
    const { mesh, material, geometry } = renderObject;

    const opts = preparedOpts[index];
    const draws = opts?.draws ?? mesh.draws;
    const instances = opts?.instances ?? mesh.count;
    const range = opts?.range;

    const gpu = RenderObjectGpu.getRenderObjectGpu(b.renderObjectGpu, renderObject);

    if (takesPipeline(currentSets.pass, gpu.pipeline!)) {
        passSetPipeline(gpuPass, inspector, gpu.pipeline!, pipelineLabel(mesh, material));
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

    const { groups: bindGroups, offsets: dynamicOffsets } = ctx.bindings[index];
    setBindGroups(
        currentSets.pass,
        gpuPass,
        bindGroups,
        dynamicOffsets,
        inspector === null ? null : (groupIndex) => inspector.setBindGroup(groupIndex, mesh.name || ''),
    );

    Geometries.resolveVertexBuffers(b.geometries, gpu, renderObject);
    const { vertexBuffers, vertexBufferNames } = gpu;
    for (let slot = 0; slot < vertexBuffers.length; slot++) {
        const gpuBuf = Buffers.ensureUploaded(b.buffers, b.device, vertexBuffers[slot], vertexBufferNames[slot]);
        if (currentSets.attributes[slot] !== gpuBuf) {
            passSetVertexBuffer(gpuPass, inspector, slot, gpuBuf);
            currentSets.attributes[slot] = gpuBuf;
        }
    }

    if (geometry.index) {
        const idxBuf = Buffers.ensureUploaded(b.buffers, b.device, geometry.index, 'index');
        if (currentSets.index !== idxBuf) {
            passSetIndexBuffer(gpuPass, inspector, idxBuf, geometry.index.indexFormat!);
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

// Teardown — release every device resource the renderer owns.

/**
 * Release all device resources: the canvas context, swapchain textures, default placeholder
 * textures + samplers, mipmap state, pipeline caches, and (unless the device was pre-created) the
 * device itself. After this the renderer is unusable.
 */
/** The per-canvas attachments this module allocated; the caches are each module's own to tear down. */
export function disposeSwapchain(b: WebGPUBackend): void {
    const { canvasContexts: contexts, swapchain: sc } = b;
    for (const target of sc.targets) releaseCanvasTarget(contexts, sc, target);
}

/** What `CanvasTarget.dispose()` runs: the canvas's context and attachments go, and a later draw re-acquires them. */
function releaseCanvasTarget(contexts: WeakMap<CanvasTarget, GPUCanvasContext>, sc: SwapchainState, target: CanvasTarget): void {
    releaseContext(contexts, target);
    target._onDispose = null;
    const entry = sc.byTarget.get(target);
    if (entry) {
        entry.depthTexture?.destroy();
        entry.msaaTexture?.destroy();
        clearAllocation(sc.tally, entry.depthAllocation);
        clearAllocation(sc.tally, entry.msaaAllocation);
        sc.byTarget.delete(target);
    }
    sc.targets.delete(target);
}

/** what the encoder has set, so a draw sets only what changed: the pipeline and bind groups as every pass keeps
 *  them, and a render pass's vertex and index buffers and stencil reference */
function createCurrentSets(info: StateInfo): CurrentSets {
    return { pass: createPassState(info), attributes: [], index: null, stencilRef: null };
}

/** After a bundle replays, nothing the pass had set still holds. */
function resetCurrentSets(sets: CurrentSets): void {
    resetPassState(sets.pass);
    sets.attributes.length = 0;
    sets.index = null;
    sets.stencilRef = null;
}

type CurrentSets = {
    pass: PassState;
    attributes: (GPUBuffer | null)[];
    index: GPUBuffer | null;
    stencilRef: number | null;
};

// Pass-command helpers, issue the real GPU encoder call AND the inspector hook
// in one place so neither call sites nor the inspector interface accumulate
// per-command boilerplate.

function passSetPipeline(pass: DrawEncoder, inspector: InspectorBase | null, pipeline: GPURenderPipeline, label: string): void {
    pass.setPipeline(pipeline);
    if (inspector) inspector.setPipeline(label);
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
