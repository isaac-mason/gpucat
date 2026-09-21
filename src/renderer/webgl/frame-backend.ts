import { CoordinateSystem } from '../../core/coordinate-system';
import type { CanvasTarget } from '../core/canvas-target';
import type { DeviceBackend } from '../core/device-backend';
import type { DrawOptions, PassDesc, PassEntry, TransformFeedbackPassDesc, TransformFeedbackRecord } from '../core/frame';
import { aimNodeFrame } from '../core/node-frame';
import type { RenderContext } from '../core/pass-context';
import { alignCameraToBackend, resolvePassContext, resolvePassParams } from '../core/pass-desc';
import { createPassParams, type PreparedRenderObject, type PreparedSegment, type RenderPassParams } from '../core/render-types';
import type { Renderer } from '../core/renderer';
import { preparedAt, prepareRecordedDraws } from '../core/renderer-ops';
import { renderTargetOf } from '../core/target';
import * as Prepare from './prepare';
import * as RenderPass from './render-pass';
import * as Textures from './textures';
import * as TransformFeedback from './transform-feedback';
import type { WebGLBackend } from './webgl-backend';

export type WebGLFrameBackendState = {
    /** Neutral state: node graph, render objects, pass contexts, inspector, info. */
    renderer: Renderer<DeviceBackend>;
    /** Device state: the GL context, the canvas it lives on and every resource cache. */
    backend: WebGLBackend;
    /** One prepared list per nesting depth, since a nested pass prepares while an outer list is live. */
    preparedByDepth: PreparedRenderObject[][];
    /** Each prepared object's per-submission overrides, same index, same depth. */
    preparedOptsByDepth: (DrawOptions | null)[][];
    segmentsByDepth: PreparedSegment[][];
    /** One per nesting depth: a nested pass resolves its own while the outer one is still in use. */
    paramsByDepth: RenderPassParams[];
    depth: number;
};

export function createWebGLFrameBackendState(renderer: Renderer<DeviceBackend>, backend: WebGLBackend): WebGLFrameBackendState {
    return {
        renderer,
        backend,
        preparedByDepth: [],
        preparedOptsByDepth: [],
        segmentsByDepth: [],
        paramsByDepth: [],
        depth: 0,
    };
}

/** A lost context cannot be drawn to; every frame phase becomes a no-op rather than touching it. */
function usable(s: WebGLFrameBackendState): boolean {
    return !s.renderer._isDeviceLost && s.backend.gl !== null;
}

export function beginFrame(s: WebGLFrameBackendState): void {
    if (!usable(s)) return;
    const frame = s.renderer._nodes.nodeFrame;
    frame.frameId++;
    s.renderer._beginInfoFrame();
    s.renderer.inspector?.begin(frame.frameId);
}

export function encodePass(s: WebGLFrameBackendState, desc: PassDesc, records: readonly PassEntry[], count: number): void {
    if (!usable(s)) return;
    const { renderer } = s;
    const nodeFrame = renderer._nodes.nodeFrame;

    alignCameraToBackend(desc.camera, CoordinateSystem.WEBGL);
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
    s: WebGLFrameBackendState,
    desc: PassDesc,
    ctx: RenderContext,
    params: RenderPassParams,
    records: readonly PassEntry[],
    count: number,
): void {
    const { renderer, backend } = s;

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
            (nodes, renderObject) =>
                Prepare.prepareRenderObject(backend.gl!, backend, nodes, renderObject, {
                    precision: backend._opts.precision,
                    maxTextureSize: backend._maxTextureSize,
                }),
            prepared,
            preparedOpts,
            segments,
        );
    } finally {
        s.depth--;
    }

    // A nested pass prepared against its own target, so restore this one's view of the frame.
    aimNodeFrame(s.renderer, desc.camera ?? null, params.width, params.height);

    const scope = RenderPass.beginPass(backend, ctx, params);
    try {
        if (preparedCount > 0) {
            RenderPass.encodeDraws(
                backend.gl!,
                backend,
                renderer._nodes,
                ctx,
                params,
                prepared,
                preparedOpts,
                preparedCount,
                renderer.inspector,
                renderer.info,
                scope,
            );
        }
    } finally {
        RenderPass.endPass(backend);
    }

    const renderTarget = renderTargetOf(desc.target);
    if (renderTarget) {
        for (const tex of renderTarget.textures) {
            if (tex.generateMipmaps) Textures.generateTextureMipmaps(backend.gl!, backend.textures, tex._gpuTexture);
        }
    }
}

/** The other kernel pass, counted and timed like `encodeComputePass` is on WebGPU. */
export function encodeTransformFeedbackPass(
    s: WebGLFrameBackendState,
    desc: TransformFeedbackPassDesc,
    records: readonly TransformFeedbackRecord[],
    count: number,
): void {
    if (count === 0 || !usable(s)) return;
    const { renderer, backend } = s;
    const label = desc.label ?? 'transform-feedback';

    renderer.info.compute.calls++;
    renderer.info.compute.frameCalls++;
    renderer.inspector?.perf.start(label);

    const inspector = renderer.inspector;
    try {
        for (let i = 0; i < count; i++) {
            const record = records[i]!;
            // Per node, as `encodeDispatches` marks each compute node; the timeline has no entry kind
            // for a kernel that is not a compute pass, so this is the timing it can have.
            const marker = `transform-feedback: ${record.node.name ?? record.node.id}`;
            inspector?.perf.start(marker);
            TransformFeedback.runTransformFeedback(
                backend.gl!,
                backend,
                backend._transformFeedback,
                record.node,
                record,
                backend._opts.precision,
                renderer._nodes.nodeFrame,
            );
            inspector?.perf.end(marker);
        }
    } finally {
        inspector?.perf.end(label);
    }
}

/** WebGL2 is immediate mode: the work reached the driver as each pass ended, so neither can undo it. */
export function submitFrame(s: WebGLFrameBackendState): void {
    if (!usable(s)) return;
    s.renderer.inspector?.finish(s.renderer._nodes.nodeFrame.frameId);
}

export function discardFrame(s: WebGLFrameBackendState): void {
    if (!usable(s)) return;
    s.renderer.inspector?.finish(s.renderer._nodes.nodeFrame.frameId);
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
