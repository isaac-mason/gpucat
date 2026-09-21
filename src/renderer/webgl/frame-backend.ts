import { CoordinateSystem } from '../../core/coordinate-system';
import type { CanvasTarget } from '../core/canvas-target';
import type { DeviceBackend } from '../core/device-backend';
import type { DrawOptions, PassDesc, PassEntry } from '../core/frame';
import type { RenderContext } from '../core/pass-context';
import { alignCameraToBackend, resolvePassContext, resolvePassParams } from '../core/pass-desc';
import type { PreparedRenderObject, PreparedSegment, RenderPassParams } from '../core/render-types';
import type { Renderer } from '../core/renderer';
import { preparedAt, prepareRecordedDraws } from '../core/renderer-ops';
import { renderTargetOf } from '../core/target';
import * as Prepare from './prepare';
import * as RenderPass from './render-pass';
import * as Textures from './textures';
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
    depth: number;
};

export function createWebGLFrameBackendState(renderer: Renderer<DeviceBackend>, backend: WebGLBackend): WebGLFrameBackendState {
    return {
        renderer,
        backend,
        preparedByDepth: [],
        preparedOptsByDepth: [],
        segmentsByDepth: [],
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
    if (ctx.width === 0 || ctx.height === 0) return; // hidden or minimized canvas
    const params = resolvePassParams(desc);

    renderer.info.render.calls++;
    renderer.info.render.frameCalls++;
    // Fresh per pass, so RENDER-scope node updates run once per pass rather than once per frame.
    const previousRenderId = nodeFrame.beginRender();

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
            ctx.camera!,
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
    setNodeFrame(s, desc, ctx);

    const scope = RenderPass.beginPass(backend.gl!, backend, ctx, params);
    try {
        if (preparedCount > 0) {
            RenderPass.encodeDraws(
                backend.gl!,
                backend,
                renderer._nodes,
                ctx,
                prepared,
                preparedOpts,
                preparedCount,
                renderer.inspector,
                renderer.info,
                scope,
            );
        }
    } finally {
        RenderPass.endPass(backend.gl!, backend);
    }

    const renderTarget = renderTargetOf(desc.target);
    if (renderTarget) {
        for (const tex of renderTarget.textures) {
            if (tex.generateMipmaps) Textures.generateTextureMipmaps(backend.gl!, backend.textures, tex._gpuTexture);
        }
    }
}

function setNodeFrame(s: WebGLFrameBackendState, desc: PassDesc, ctx: RenderContext): void {
    const frame = s.renderer._nodes.nodeFrame;
    frame.renderer = s.renderer;
    frame.camera = desc.camera ?? null;
    frame.width = ctx.width;
    frame.height = ctx.height;
}

/** Unreachable: `beginComputePass` rejects this backend by name before any dispatch is recorded. */
export function encodeComputePass(): never {
    throw new Error('[frame] compute passes need the webgpu backend; WebGL2 has no compute shaders');
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
