import { CoordinateSystem } from '../../core/coordinate-system';
import type { GpuBuffer } from '../../core/gpu-buffer';
import type { GpuTexture } from '../../core/gpu-texture';
import type { RenderTarget } from '../../core/render-target';
import type { ComputeNode } from '../../nodes/nodes';
import type * as d from '../../schema/schema';
import type { CanvasTarget } from '../core/canvas-target';
import type { DeviceBackend } from '../core/device-backend';
import type { ComputePassDesc, DispatchRecord, DrawOptions, DrawRecord, PassDesc, PassEntry, RenderBundle } from '../core/frame';
import { aimNodeFrame } from '../core/node-frame';
import type { RenderContext } from '../core/pass-context';
import {
    alignCameraToBackend,
    applyViewRecord,
    isViewRecord,
    resolvePassContext,
    resolvePassParams,
    setPassCamera,
} from '../core/pass-desc';
import {
    addBin,
    addBinDraw,
    addBundle,
    addPassDraw,
    createPassOrder,
    markViewChanged,
    orderBins,
    type PassOrder,
    resetPassOrder,
} from '../core/pass-order';
import { createPassParams, type PreparedRenderObject, type RenderPassParams } from '../core/render-types';
import type { Renderer } from '../core/renderer';
import { drawsNothing, prepareRecordedDraw } from '../core/renderer-ops';
import { renderTargetOf } from '../core/target';
import { createDrawBindings, type DrawBindings } from './bindings';
import * as Buffers from './buffers';
import * as Compute from './compute';
import { flushDrawArena, releaseEmptyPages } from './draw-arena';
import * as Prepare from './prepare';
import * as RenderObjectGpu from './render-object-gpu';
import * as RenderPass from './render-pass';
import * as Textures from './textures';
import type { WebGPUBackend } from './webgpu-backend';

export type WebGPUFrameBackendState = {
    /** Neutral state: node graph, render objects, pass contexts, inspector, info. */
    renderer: Renderer<DeviceBackend>;
    /** Device state: the GPU device, the frame encoder and every resource cache. */
    backend: WebGPUBackend;
    /** Render passes begun and not yet encoded, pooled per nesting depth: a nested pass opens inside an outer one. */
    openByDepth: OpenRenderPass[];
    encodeContextsByDepth: RenderPass.EncodeContext[];
    /** How many of `openByDepth` are open. */
    depth: number;
    /** Compute passes begun and not yet encoded; a nested render pass may open one while resolving. */
    openComputeByDepth: OpenComputePass[];
    computeDepth: number;
    /** Targets written this frame whose chain is stale; drained onto the frame encoder before submit. */
    mipTargets: Set<RenderTarget>;
    /** The compute-pass equivalent: storage textures written this frame that opted into mips. */
    mipTextures: Set<GpuTexture<d.StorageTexture>>;
};

/** A render pass between `beginPass` and `encodePass`, holding what its draws resolved to as they were recorded. */
type OpenRenderPass = {
    desc: PassDesc;
    ctx: RenderContext;
    params: RenderPassParams;
    /** Nothing resolves or encodes: a hidden or minimized canvas, or a lost device. */
    skipped: boolean;
    /** The render scope this pass opened, restored when it is encoded. */
    previousRenderId: number;
    prepared: PreparedRenderObject[];
    preparedOpts: (DrawOptions | null)[];
    bindings: DrawBindings[];
    count: number;
    /** The order the draws encode in, and the view each was recorded under. */
    order: PassOrder;
};

/** A compute pass between `beginComputePass` and `encodeComputePass`, holding its dispatches as they resolved. */
type OpenComputePass = {
    desc: ComputePassDesc;
    /** Nothing resolves or encodes: a lost device. */
    skipped: boolean;
    resolved: Compute.ResolvedDispatch[];
    count: number;
    /** the render scope a pass with a `view` opened inside, restored when it closes */
    previousRenderId: number;
};

export function createWebGPUFrameBackendState(
    renderer: Renderer<DeviceBackend>,
    backend: WebGPUBackend,
): WebGPUFrameBackendState {
    return {
        renderer,
        backend,
        openByDepth: [],
        openComputeByDepth: [],
        computeDepth: 0,
        encodeContextsByDepth: [],
        depth: 0,
        mipTargets: new Set(),
        mipTextures: new Set(),
    };
}

/** A lost device is torn down; every frame phase becomes a no-op rather than touching it. */
function usable(s: WebGPUFrameBackendState): boolean {
    return !s.renderer._isDeviceLost;
}

export function beginFrame(s: WebGPUFrameBackendState): void {
    if (!usable(s)) return;
    const { renderer, backend } = s;
    const frame = renderer._nodes.nodeFrame;
    frame.frameId++;
    renderer._beginInfoFrame();
    renderer.inspector?.begin(frame.frameId);
    backend._currentEncoder = backend.device.createCommandEncoder();
}

/** Opens a render pass: its context and render scope are fixed here, before its first draw resolves. */
export function beginPass(s: WebGPUFrameBackendState, desc: PassDesc): void {
    const { renderer, backend } = s;
    // Everything that can throw runs before the pass takes its slot, so a refused pass leaves none behind.
    if (usable(s)) {
        alignCameraToBackend(desc.camera, CoordinateSystem.WEBGPU);
        if (desc.mrt !== undefined) {
            const mrtTarget = renderTargetOf(desc.target);
            if (mrtTarget === null) {
                throw new Error('[frame] a pass with `mrt` needs a RenderTarget; the swapchain has one attachment');
            }
            // Output names resolve against the target's texture names, which is the MRT contract.
            desc.mrt.resolveOutputs(
                (name: string) => mrtTarget.getTextureIndex(name),
                mrtTarget.textures.map((t) => t.name),
            );
        }

        const canvasTarget = renderTargetOf(desc.target) === null ? (desc.target as CanvasTarget) : null;
        if (canvasTarget?.autoResize) canvasTarget.syncToClientSize();
    }

    const open = openAt(s.openByDepth, s.depth++, desc, resolvePassContext(renderer._renderContexts, desc));
    if (!usable(s)) {
        renderer.inspector?.skipRecordedPass('device lost');
        return;
    }

    open.params = resolvePassParams(desc, open.params);
    if (open.params.width === 0 || open.params.height === 0) {
        renderer.inspector?.skipRecordedPass('zero-size target, a hidden or minimized canvas');
        return;
    }
    open.skipped = false;

    renderer.info.render.calls++;
    renderer.info.render.frameCalls++;
    // Fresh per pass, so RENDER-scope node updates run once per pass rather than once per frame.
    open.previousRenderId = renderer._nodes.nodeFrame.beginRender();
    aimNodeFrame(renderer, desc.camera ?? null, open.params.width, open.params.height);
    renderer.inspector?.beginRender(open.params.passId);
    backend._openValidationScope();
}

/** Resolves a recorded draw, or every draw of a replayed bundle, into the pass being recorded, in the place in its
 *  order the draw or bundle takes; a camera or rect change applies to the draws recorded after it. */
export function recordEntry(s: WebGPUFrameBackendState, entry: PassEntry): void {
    const depth = s.depth;
    const open = s.openByDepth[depth - 1];
    if (open.skipped) return;
    if (isViewRecord(entry)) {
        markViewChanged(open.order);
        applyViewRecord(s.renderer, open.params, entry, CoordinateSystem.WEBGPU);
        return;
    }
    if (entry.kind === 'bin') {
        addBin(open.order, entry.bin);
        return;
    }
    try {
        if (entry.kind === 'draw') {
            const index = resolveDraw(s, open, entry);
            if (index < 0) return;
            const bin = entry.bin;
            if (bin === null) addPassDraw(open.order, index, open.params);
            else {
                const renderObject = open.prepared[index]!;
                const gpu = RenderObjectGpu.getRenderObjectGpu(s.backend.renderObjectGpu, renderObject);
                addBinDraw(
                    open.order,
                    index,
                    bin,
                    gpu.pipeline!,
                    renderObject.material,
                    renderObject.geometry,
                    entry.sortKey,
                    renderObject.mesh,
                    open.params,
                );
            }
            return;
        }
        resolveBundle(s, open, entry.bundle);
    } catch (error) {
        // A throw inside a nested pass (a render texture's contents) left it begun; this pass records on.
        unwindTo(s, depth);
        throw error;
    }
}

/**
 * A bundle's draws, resolved from the bundle's camera in a scope of their own with its view uniforms packing into the
 * bundle's slot, then the pass's camera back for the draws after it.
 */
function resolveBundle(s: WebGPUFrameBackendState, open: OpenRenderPass, bundle: RenderBundle): void {
    const passCamera = open.params.camera;
    const buffers = s.backend.buffers;
    markViewChanged(open.order);
    setPassCamera(s.renderer, open.params, bundle.camera, CoordinateSystem.WEBGPU);
    buffers.bundleView = RenderPass.bundleState(s.backend, bundle).view;
    const start = open.count;
    try {
        const { records, count } = bundle;
        for (let index = 0; index < count; index++) resolveDraw(s, open, records[index] as DrawRecord);
    } finally {
        buffers.bundleView = null;
    }
    addBundle(open.order, bundle, start, open.count - start, open.params);
    markViewChanged(open.order);
    setPassCamera(s.renderer, open.params, passCamera, CoordinateSystem.WEBGPU);
}

/** Closes every pass begun above `depth` and not ended, so none holds its scopes past a throw. */
function unwindTo(s: WebGPUFrameBackendState, depth: number): void {
    while (s.depth > depth) {
        const open = s.openByDepth[--s.depth];
        if (!open.skipped && usable(s)) closePassScopes(s, open, open.params.passId);
    }
}

/** Resolves `entry` into the pass's prepared arrays: the index it took, or -1 when it draws nothing. */
function resolveDraw(s: WebGPUFrameBackendState, open: OpenRenderPass, entry: DrawRecord): number {
    const { renderer, backend } = s;
    const renderObject = prepareRecordedDraw(renderer, entry, open.params.camera!, open.ctx, (nodes, object) =>
        Prepare.prepareRenderObject(backend, nodes, object),
    );
    if (drawsNothing(renderObject, entry.opts)) {
        renderer.inspector?.resolvedDraw(renderObject, true);
        return -1;
    }

    // A nested pass recorded by `updateBefore` aimed the frame at its own target.
    aimNodeFrame(renderer, open.params.camera, open.params.width, open.params.height);
    const index = open.count++;
    open.prepared[index] = renderObject;
    open.preparedOpts[index] = entry.opts;
    const bindings = bindingsAt(open.bindings, index);
    RenderPass.resolveDrawBindings(backend, renderer._nodes, renderObject, bindings, renderer.inspector);
    if (renderer.inspector !== null) {
        keepProbeBindings(backend.renderObjectGpu, renderObject, bindings);
        renderer.inspector.resolvedDraw(renderObject, false);
    }
    return index;
}

function keepProbeBindings(
    cache: RenderObjectGpu.RenderObjectGpuCache,
    renderObject: PreparedRenderObject,
    bindings: DrawBindings,
): void {
    const gpu = RenderObjectGpu.getRenderObjectGpu(cache, renderObject);
    gpu.probeBindings ??= { groups: [], offsets: [] };
    gpu.probeBindings.groups.length = 0;
    gpu.probeBindings.offsets.length = 0;
    gpu.probeBindings.groups.push(...bindings.groups);
    gpu.probeBindings.offsets.push(...bindings.offsets);
}

/** Encodes what the pass resolved, then closes the scopes `beginPass` opened. */
export function encodePass(s: WebGPUFrameBackendState, desc: PassDesc): void {
    const open = s.openByDepth[--s.depth];
    if (open.skipped) return;
    const { renderer, backend } = s;
    // Read now: the params struct is pooled per depth, so a later pass owns it by the time this settles.
    const passId = open.params.passId;

    try {
        orderBins(open.order, passId);
        aimNodeFrame(renderer, desc.camera ?? null, open.params.width, open.params.height);

        const scope = RenderPass.beginPass(backend, open.params);
        try {
            if (open.count > 0) RenderPass.encodeDraws(contextAt(s, open), scope);
        } finally {
            RenderPass.endPass(scope);
        }
    } finally {
        closePassScopes(s, open, passId);
    }

    const renderTarget = renderTargetOf(desc.target);
    if (renderTarget?.textures.some((tex) => tex.generateMipmaps)) s.mipTargets.add(renderTarget);
}

/** Pops the validation scope, inspector bracket and render scope an unskipped `beginPass` pushed. */
function closePassScopes(s: WebGPUFrameBackendState, open: OpenRenderPass, passId: string): void {
    const { renderer, backend } = s;
    backend._closeValidationScope('render', passId);
    renderer.inspector?.finishRender(passId);
    renderer._nodes.nodeFrame.endRender(open.previousRenderId);
}

/** Opens a compute pass; its validation scope covers the dispatches as they resolve. */
export function beginComputePass(s: WebGPUFrameBackendState, desc: ComputePassDesc): void {
    const open = openComputeAt(s.openComputeByDepth, s.computeDepth++, desc);
    if (!usable(s)) {
        s.renderer.inspector?.skipRecordedPass('device lost');
        return;
    }
    open.skipped = false;
    const view = desc.view;
    if (view !== undefined) {
        // its own render scope, so render-scope uniforms update for its camera and size as a render pass's would
        alignCameraToBackend(view.camera, CoordinateSystem.WEBGPU);
        open.previousRenderId = s.renderer._nodes.nodeFrame.beginRender();
        aimNodeFrame(s.renderer, view.camera, view.width, view.height);
    }
    s.renderer.inspector?.perf.start(desc.label ?? 'compute');
    s.backend._openValidationScope();
}

/** Resolves a recorded dispatch into the compute pass being recorded. */
export function recordDispatch(s: WebGPUFrameBackendState, record: DispatchRecord): void {
    const open = s.openComputeByDepth[s.computeDepth - 1];
    if (open.skipped) return;
    const { renderer, backend } = s;
    const view = open.desc.view;
    // a pass recorded meanwhile may have aimed the frame at its own
    if (view !== undefined) aimNodeFrame(renderer, view.camera, view.width, view.height);
    const resolved = resolvedAt(open.resolved, open.count, record.node);
    Compute.resolveDispatch(
        backend,
        renderer._nodes,
        renderer._computeContext,
        record,
        resolved,
        renderer.inspector,
        s.mipTextures,
    );
    open.count++;
}

/** Encodes what the pass resolved, then closes the scope `beginComputePass` opened. */
export function encodeComputePass(s: WebGPUFrameBackendState, desc: ComputePassDesc): void {
    const open = s.openComputeByDepth[--s.computeDepth];
    if (open.skipped) return;
    const { renderer, backend } = s;
    const label = desc.label ?? 'compute';

    try {
        if (open.count > 0) {
            renderer.info.compute.calls++;
            renderer.info.compute.frameCalls++;
            Compute.encodeDispatches(backend, backend._currentEncoder!, open.resolved, open.count, label, renderer.inspector);
        }
    } finally {
        closeComputeScopes(s, open, label);
    }
}

function closeComputeScopes(s: WebGPUFrameBackendState, open: OpenComputePass, label: string): void {
    const { renderer, backend } = s;
    if (open.desc.view !== undefined) renderer._nodes.nodeFrame.endRender(open.previousRenderId);
    backend._closeValidationScope('compute', label);
    renderer.inspector?.perf.end(label);
}

/** Zeroes a span of `buffer` on the frame's encoder, between the passes either side of it. */
export function clearBuffer(s: WebGPUFrameBackendState, buffer: GpuBuffer, byteOffset: number, byteSize: number): void {
    if (!usable(s)) return;
    const { backend } = s;
    const gpuBuffer = Buffers.ensureUploaded(backend.buffers, backend.device, buffer, buffer.label ?? 'cleared');
    backend._currentEncoder!.clearBuffer(gpuBuffer, byteOffset, byteSize);
}

export function submitFrame(s: WebGPUFrameBackendState): void {
    if (!usable(s)) return;
    const { renderer, backend } = s;

    // A command buffer Dawn rejects takes the whole frame with it, including the clears, and the
    // per-pass scopes closed before this ran — so without a scope here there is no reason, only pixels.
    // Onto the frame's own encoder, so the chain is one command buffer with the passes that wrote it.
    for (const renderTarget of s.mipTargets) {
        for (const tex of renderTarget.textures) {
            if (tex.generateMipmaps) {
                Textures.generateTextureMipmaps(backend.textures, backend.device, tex._gpuTexture, backend._currentEncoder!);
            }
        }
    }
    s.mipTargets.clear();
    Compute.regenerateComputeMips(backend.device, backend.textures, s.mipTextures, backend._currentEncoder!);
    s.mipTextures.clear();

    // The draw arena's writes and the dynamic uniform copies land ahead of the frame's commands, so every pass reads
    // the bytes it was recorded with.
    flushDrawArena(backend.buffers.drawArena, backend.device);
    const dynamicUniformCopies = Buffers.submitDynamicUniforms(backend.buffers, backend.device);

    backend._openValidationScope();
    try {
        const frameCommands = backend._currentEncoder!.finish();
        backend.device.queue.submit(dynamicUniformCopies === null ? [frameCommands] : [dynamicUniformCopies, frameCommands]);
        Buffers.onDynamicUniformsSubmitted(backend.buffers);
        releaseEmptyPages(backend.buffers.drawArena);
        Buffers.destroyRetiredBuffers(backend.buffers);
    } finally {
        backend._closeValidationScope('submit');
    }
    backend._currentEncoder = null;

    renderer.inspector?.finish(renderer._nodes.nodeFrame.frameId);
}

export function discardFrame(s: WebGPUFrameBackendState): void {
    // A pass begun and never ended still holds its scopes; close them so none outlives the frame.
    unwindTo(s, 0);
    while (s.computeDepth > 0) {
        const open = s.openComputeByDepth[--s.computeDepth];
        if (!open.skipped && usable(s)) closeComputeScopes(s, open, open.desc.label ?? 'compute');
    }
    if (!usable(s)) return;
    const { renderer, backend } = s;
    backend._currentEncoder = null;
    Buffers.rewindDynamicUniforms(backend.buffers);
    s.mipTargets.clear();
    s.mipTextures.clear();
    renderer.inspector?.finish(renderer._nodes.nodeFrame.frameId);
}

/** The pass slot at `depth`, reset for `desc`. Grows to the nesting depth in use and never shrinks. */
function openAt(pool: OpenRenderPass[], depth: number, desc: PassDesc, ctx: RenderContext): OpenRenderPass {
    let open = pool[depth];
    if (open === undefined) {
        open = {
            desc,
            ctx,
            params: createPassParams(),
            skipped: true,
            previousRenderId: 0,
            prepared: [],
            preparedOpts: [],
            bindings: [],
            count: 0,
            order: createPassOrder(),
        };
        pool[depth] = open;
    }
    open.desc = desc;
    open.ctx = ctx;
    open.skipped = true;
    open.count = 0;
    resetPassOrder(open.order);
    return open;
}

/** The compute pass slot at `depth`, reset for `desc`. Grows to the nesting depth in use and never shrinks. */
function openComputeAt(pool: OpenComputePass[], depth: number, desc: ComputePassDesc): OpenComputePass {
    let open = pool[depth];
    if (open === undefined) {
        open = { desc, skipped: true, resolved: [], count: 0, previousRenderId: 0 };
        pool[depth] = open;
    }
    open.desc = desc;
    open.skipped = true;
    open.count = 0;
    return open;
}

/** Grows to the dispatches a pass has held and never shrinks, so a steady frame allocates none. */
function resolvedAt(pool: Compute.ResolvedDispatch[], index: number, node: ComputeNode): Compute.ResolvedDispatch {
    let resolved = pool[index];
    if (resolved === undefined) {
        resolved = Compute.createResolvedDispatch(node);
        pool[index] = resolved;
    }
    return resolved;
}

/** Grows to the draws a pass has held and never shrinks, so a steady frame allocates none. */
function bindingsAt(pool: DrawBindings[], index: number): DrawBindings {
    let bindings = pool[index];
    if (bindings === undefined) {
        bindings = createDrawBindings();
        pool[index] = bindings;
    }
    return bindings;
}

/** The draw loop's fixed half, pooled per nesting depth and refilled: a nested pass has its own. */
function contextAt(s: WebGPUFrameBackendState, open: OpenRenderPass): RenderPass.EncodeContext {
    const { renderer, backend } = s;
    let ctx = s.encodeContextsByDepth[s.depth];
    if (ctx === undefined) {
        ctx = {
            b: backend,
            nodes: renderer._nodes,
            passCtx: open.ctx,
            params: open.params,
            preparedObjects: open.prepared,
            preparedOpts: open.preparedOpts,
            bindings: open.bindings,
            order: open.order,
            inspector: null,
            info: renderer.info,
        };
        s.encodeContextsByDepth[s.depth] = ctx;
    }
    ctx.b = backend;
    ctx.nodes = renderer._nodes;
    ctx.passCtx = open.ctx;
    ctx.params = open.params;
    ctx.preparedObjects = open.prepared;
    ctx.preparedOpts = open.preparedOpts;
    ctx.bindings = open.bindings;
    ctx.order = open.order;
    ctx.inspector = renderer.inspector;
    ctx.info = renderer.info;
    return ctx;
}
