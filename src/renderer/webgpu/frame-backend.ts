import { CoordinateSystem } from '../../core/coordinate-system';
import type { GpuTexture } from '../../core/gpu-texture';
import type { RenderTarget } from '../../core/render-target';
import type * as d from '../../schema/schema';
import type { CanvasTarget } from '../core/canvas-target';
import type { DeviceBackend } from '../core/device-backend';
import type { ComputePassDesc, DispatchRecord, DrawOptions, PassDesc, PassEntry } from '../core/frame';
import type { RenderContext } from '../core/pass-context';
import { alignCameraToBackend, resolvePassContext, resolvePassParams } from '../core/pass-desc';
import type { PreparedRenderObject, PreparedSegment, RenderPassParams } from '../core/render-types';
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
    depth: number;
    /** Targets written this frame whose mips are filled after submit, since generation owns an encoder. */
    mipTargets: RenderTarget[];
    /** The compute-pass equivalent: storage textures written this frame that opted into mips. */
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
        depth: 0,
        mipTargets: [],
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
    if (ctx.width === 0 || ctx.height === 0) return; // hidden or minimized canvas
    const params = resolvePassParams(desc);

    renderer.info.render.calls++;
    renderer.info.render.frameCalls++;
    // Fresh per pass, so RENDER-scope node updates run once per pass rather than once per frame.
    const previousRenderId = nodeFrame.beginRender();
    Geometries.incrementCallId(backend.geometries);

    setNodeFrame(s, desc, ctx);
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
                ctx.camera!,
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
        setNodeFrame(s, desc, ctx);

        const { colorAttachments, depthAttachment } = RenderPass.resolveAttachments(backend, params);
        const scope = RenderPass.beginPass(
            backend._currentEncoder!,
            ctx,
            colorAttachments,
            depthAttachment,
            params.passId,
            renderer.inspector,
        );

        try {
            if (preparedCount > 0) {
                RenderPass.encodeDraws(
                    backend,
                    renderer._nodes,
                    ctx,
                    prepared,
                    preparedOpts,
                    preparedCount,
                    renderer.inspector,
                    renderer.info,
                    scope,
                    segments,
                );
            }
        } finally {
            RenderPass.endPass(scope);
        }
    } finally {
        backend._pendingValidation.push(
            backend.device.popErrorScope().then((err) => {
                if (err) {
                    const message = `[WebGPU render validation error] pass '${params.passId}': ${err.message}`;
                    console.error(message);
                    backend._validationErrors.push(message);
                }
            }),
        );
    }

    const renderTarget = renderTargetOf(desc.target);
    if (renderTarget?.textures.some((tex) => tex.generateMipmaps)) s.mipTargets.push(renderTarget);
}

function setNodeFrame(s: WebGPUFrameBackendState, desc: PassDesc, ctx: RenderContext): void {
    const frame = s.renderer._nodes.nodeFrame;
    frame.renderer = s.renderer;
    frame.camera = desc.camera ?? null;
    frame.width = ctx.width;
    frame.height = ctx.height;
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

    for (const renderTarget of s.mipTargets) {
        for (const tex of renderTarget.textures) {
            if (tex.generateMipmaps) Textures.generateTextureMipmaps(backend.textures, backend.device, tex._gpuTexture);
        }
    }
    s.mipTargets.length = 0;

    Compute.regenerateComputeMips(backend.device, backend.textures, s.mipTextures);
    s.mipTextures.clear();

    renderer.inspector?.finish(renderer._nodes.nodeFrame.frameId);
}

export function discardFrame(s: WebGPUFrameBackendState): void {
    if (!usable(s)) return;
    const { renderer, backend } = s;
    backend._currentEncoder = null;
    s.mipTargets.length = 0;
    s.mipTextures.clear();
    renderer.inspector?.finish(renderer._nodes.nodeFrame.frameId);
}
