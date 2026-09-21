import { CoordinateSystem } from '../../core/coordinate-system';
import type { GpuTexture } from '../../core/gpu-texture';
import type { RenderTarget } from '../../core/render-target';
import type * as d from '../../schema/schema';
import type { CanvasTarget } from '../core/canvas-target';
import type { DeviceBackend } from '../core/device-backend';
import type { ComputePassDesc, DispatchRecord, DrawOptions, PassDesc, PassEntry } from '../core/frame';
import { aimNodeFrame } from '../core/node-frame';
import type { RenderContext } from '../core/pass-context';
import { alignCameraToBackend, resolvePassContext, resolvePassParams } from '../core/pass-desc';
import { createPassParams, type PreparedRenderObject, type PreparedSegment, type RenderPassParams } from '../core/render-types';
import type { Renderer } from '../core/renderer';
import { preparedAt, prepareRecordedDraws } from '../core/renderer-ops';
import { renderTargetOf } from '../core/target';
import * as Compute from './compute';
import * as Geometries from './geometries';
import * as Prepare from './prepare';
import * as RenderPass from './render-pass';
import * as Textures from './textures';
import type { WebGPUBackend } from './webgpu-backend';

export type WebGPUFrameBackendState = {
    /** Neutral state: node graph, render objects, pass contexts, inspector, info. */
    renderer: Renderer<DeviceBackend>;
    /** Device state: the GPU device, the frame encoder and every resource cache. */
    backend: WebGPUBackend;
    /** One prepared list per nesting depth, since a nested pass prepares while an outer list is live. */
    preparedByDepth: PreparedRenderObject[][];
    /** Each prepared object's per-submission overrides, same index, same depth. */
    preparedOptsByDepth: (DrawOptions | null)[][];
    segmentsByDepth: PreparedSegment[][];
    /** One per nesting depth: a nested pass resolves its own while the outer one is still in use. */
    paramsByDepth: RenderPassParams[];
    encodeContextsByDepth: RenderPass.EncodeContext[];
    depth: number;
    /** Targets written this frame whose mips are filled after submit, since generation owns an encoder. */
    /** The compute-pass equivalent: storage textures written this frame that opted into mips. */
    /** Targets written this frame whose chain is stale; drained onto the frame encoder before submit. */
    mipTargets: Set<RenderTarget>;
    mipTextures: Set<GpuTexture<d.StorageTexture>>;
};

export function createWebGPUFrameBackendState(
    renderer: Renderer<DeviceBackend>,
    backend: WebGPUBackend,
): WebGPUFrameBackendState {
    return {
        renderer,
        backend,
        preparedByDepth: [],
        preparedOptsByDepth: [],
        segmentsByDepth: [],
        paramsByDepth: [],
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

export function encodePass(s: WebGPUFrameBackendState, desc: PassDesc, records: readonly PassEntry[], count: number): void {
    if (!usable(s)) return;
    const { renderer, backend } = s;
    const nodeFrame = renderer._nodes.nodeFrame;

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

    const ctx = resolvePassContext(renderer._renderContexts, desc);
    const params = resolvePassParams(desc, paramsAt(s.paramsByDepth, s.depth));
    if (params.width === 0 || params.height === 0) return; // hidden or minimized canvas

    renderer.info.render.calls++;
    renderer.info.render.frameCalls++;
    // Fresh per pass, so RENDER-scope node updates run once per pass rather than once per frame.
    const previousRenderId = nodeFrame.beginRender();
    Geometries.incrementCallId(backend.geometries);

    aimNodeFrame(s.renderer, desc.camera ?? null, params.width, params.height);
    renderer.inspector?.beginRender(params.passId);
    try {
        encodeOpenPass(s, desc, ctx, params, records, count);
    } finally {
        // One bracket for the pass, so a throw anywhere inside it still closes the render scope and
        // the inspector's pass rather than leaving both open for the rest of the frame.
        renderer.inspector?.finishRender(params.passId);
        nodeFrame.endRender(previousRenderId);
    }
}

function encodeOpenPass(
    s: WebGPUFrameBackendState,
    desc: PassDesc,
    ctx: RenderContext,
    params: RenderPassParams,
    records: readonly PassEntry[],
    count: number,
): void {
    const { renderer, backend } = s;
    // Read now: the params struct is pooled per depth, so a later pass owns it by the time this settles.
    const passId = params.passId;

    backend.device.pushErrorScope('validation');
    try {
        const prepared = preparedAt(s.preparedByDepth, s.depth);
        const preparedOpts = preparedAt(s.preparedOptsByDepth, s.depth);
        const segments = preparedAt(s.segmentsByDepth, s.depth);
        s.depth++;
        let preparedCount = 0;
        try {
            preparedCount = prepareRecordedDraws(
                renderer,
                records,
                count,
                params.camera!,
                ctx,
                renderer.inspector === null ? null : params.passId,
                (nodes, renderObject) => Prepare.prepareRenderObject(backend, nodes, renderObject),
                prepared,
                preparedOpts,
                segments,
            );
        } finally {
            s.depth--;
        }

        // A nested pass prepared against its own target, so restore this one's view of the frame.
        aimNodeFrame(s.renderer, desc.camera ?? null, params.width, params.height);

        const scope = RenderPass.beginPass(backend, params);

        try {
            if (preparedCount > 0) {
                const encodeContext = contextAt(s, ctx, params, prepared, preparedOpts);
                RenderPass.encodeDraws(encodeContext, preparedCount, scope, segments);
            }
        } finally {
            RenderPass.endPass(scope);
        }
    } finally {
        backend._pendingValidation.push(
            backend.device.popErrorScope().then((err) => {
                if (err) {
                    const message = `[WebGPU render validation error] pass '${passId}': ${err.message}`;
                    console.error(message);
                    backend._validationErrors.push(message);
                }
            }),
        );
    }

    const renderTarget = renderTargetOf(desc.target);
    if (renderTarget?.textures.some((tex) => tex.generateMipmaps)) s.mipTargets.add(renderTarget);
}

export function encodeComputePass(
    s: WebGPUFrameBackendState,
    desc: ComputePassDesc,
    records: readonly DispatchRecord[],
    count: number,
): void {
    if (count === 0 || !usable(s)) return;
    const { renderer, backend } = s;
    const label = desc.label ?? 'compute';

    renderer.info.compute.calls++;
    renderer.info.compute.frameCalls++;
    renderer.inspector?.perf.start(label);
    backend.device.pushErrorScope('validation');

    try {
        Compute.encodeDispatches(
            backend,
            renderer._nodes,
            renderer._computeContext,
            backend._currentEncoder!,
            records,
            count,
            label,
            renderer.inspector,
            s.mipTextures,
        );
    } finally {
        backend._pendingValidation.push(
            backend.device.popErrorScope().then((err) => {
                if (err) {
                    const message = `[WebGPU compute validation error] pass '${label}': ${err.message}`;
                    console.error(message);
                    backend._validationErrors.push(message);
                }
            }),
        );
        renderer.inspector?.perf.end(label);
    }
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

    backend.device.pushErrorScope('validation');
    try {
        backend.device.queue.submit([backend._currentEncoder!.finish()]);
    } finally {
        backend._pendingValidation.push(
            backend.device.popErrorScope().then((err) => {
                if (err) {
                    const message = `[WebGPU submit validation error] ${err.message}`;
                    console.error(message);
                    backend._validationErrors.push(message);
                }
            }),
        );
    }
    backend._currentEncoder = null;

    renderer.inspector?.finish(renderer._nodes.nodeFrame.frameId);
}

export function discardFrame(s: WebGPUFrameBackendState): void {
    if (!usable(s)) return;
    const { renderer, backend } = s;
    backend._currentEncoder = null;
    s.mipTargets.clear();
    s.mipTextures.clear();
    renderer.inspector?.finish(renderer._nodes.nodeFrame.frameId);
}

/** Grows to the nesting depth in use and never shrinks, like the prepared lists beside it. */
function paramsAt(pool: RenderPassParams[], depth: number): RenderPassParams {
    let params = pool[depth];
    if (params === undefined) {
        params = createPassParams();
        pool[depth] = params;
    }
    return params;
}

/** The draw loop's fixed half, pooled per nesting depth and refilled: a nested pass has its own. */
function contextAt(
    s: WebGPUFrameBackendState,
    passCtx: RenderContext,
    params: RenderPassParams,
    preparedObjects: readonly PreparedRenderObject[],
    preparedOpts: readonly (DrawOptions | null)[],
): RenderPass.EncodeContext {
    const { renderer, backend } = s;
    let ctx = s.encodeContextsByDepth[s.depth];
    if (ctx === undefined) {
        ctx = {
            b: backend,
            nodes: renderer._nodes,
            passCtx,
            params,
            preparedObjects,
            preparedOpts,
            inspector: null,
            info: renderer.info,
        };
        s.encodeContextsByDepth[s.depth] = ctx;
    }
    ctx.b = backend;
    ctx.nodes = renderer._nodes;
    ctx.passCtx = passCtx;
    ctx.params = params;
    ctx.preparedObjects = preparedObjects;
    ctx.preparedOpts = preparedOpts;
    ctx.inspector = renderer.inspector;
    ctx.info = renderer.info;
    return ctx;
}
