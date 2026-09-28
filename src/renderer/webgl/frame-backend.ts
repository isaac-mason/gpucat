import { CoordinateSystem } from '../../core/coordinate-system';
import type { CanvasTarget } from '../core/canvas-target';
import type { DeviceBackend } from '../core/device-backend';
import type {
    DrawOptions,
    DrawRecord,
    PassDesc,
    PassEntry,
    TransformFeedbackPassDesc,
    TransformFeedbackRecord,
} from '../core/frame';
import { aimNodeFrame } from '../core/node-frame';
import type { RenderContext } from '../core/pass-context';
import { alignCameraToBackend, resolvePassContext, resolvePassParams } from '../core/pass-desc';
import { createPassParams, type PreparedRenderObject, type RenderPassParams } from '../core/render-types';
import type { Renderer } from '../core/renderer';
import { drawsNothing, prepareRecordedDraw } from '../core/renderer-ops';
import { renderTargetOf } from '../core/target';
import * as Bindings from './bindings';
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
    /** Render passes begun and not yet encoded, pooled per nesting depth: a nested pass opens inside an outer one. */
    openByDepth: OpenRenderPass[];
    /** How many of `openByDepth` are open. */
    depth: number;
    /** Transform-feedback passes begun and not yet encoded; a nested render pass may open one while resolving. */
    openTransformFeedbackByDepth: OpenTransformFeedbackPass[];
    transformFeedbackDepth: number;
};

/** A transform-feedback pass between its begin and encode, holding its dispatches as they were captured. */
type OpenTransformFeedbackPass = {
    /** Nothing captures or runs: a lost context. */
    skipped: boolean;
    /** Each dispatch's node, buffers and count, copied at the call: the frame reuses its record for the next. */
    dispatches: TransformFeedbackRecord[];
    captures: Bindings.RecordCapture[];
    count: number;
};

/** A render pass between `beginPass` and `encodePass`, holding what its draws captured as they were recorded. */
type OpenRenderPass = {
    desc: PassDesc;
    ctx: RenderContext;
    params: RenderPassParams;
    /** Nothing resolves or encodes: a hidden or minimized canvas, or a lost context. */
    skipped: boolean;
    /** The render scope this pass opened, restored when it is encoded. */
    previousRenderId: number;
    prepared: PreparedRenderObject[];
    preparedOpts: (DrawOptions | null)[];
    captures: Bindings.RecordCapture[];
    count: number;
};

export function createWebGLFrameBackendState(renderer: Renderer<DeviceBackend>, backend: WebGLBackend): WebGLFrameBackendState {
    return {
        renderer,
        backend,
        openByDepth: [],
        depth: 0,
        openTransformFeedbackByDepth: [],
        transformFeedbackDepth: 0,
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

/** Opens a render pass: its context and render scope are fixed here, before its first draw resolves. */
export function beginPass(s: WebGLFrameBackendState, desc: PassDesc): void {
    const { renderer } = s;
    // Everything that can throw runs before the pass takes its slot, so a refused pass leaves none behind.
    if (usable(s)) {
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
    }

    const open = openAt(s.openByDepth, s.depth++, desc, resolvePassContext(renderer._renderContexts, desc));
    if (!usable(s)) {
        renderer.inspector?.skipRecordedPass('context lost');
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
}

/** Resolves a recorded draw, or every draw of a replayed bundle, into the pass being recorded. */
export function recordEntry(s: WebGLFrameBackendState, entry: PassEntry): void {
    const depth = s.depth;
    const open = s.openByDepth[depth - 1];
    if (open.skipped) return;
    try {
        if (entry.kind !== 'bundle') {
            resolveDraw(s, open, entry);
            return;
        }
        // WebGL has no device bundles: a bundle's records replay as the draws they always were.
        const { records, count } = entry.bundle;
        for (let index = 0; index < count; index++) resolveDraw(s, open, records[index] as DrawRecord);
    } catch (error) {
        // A throw inside a nested pass (a render texture's contents) left it begun; this pass records on.
        unwindTo(s, depth);
        throw error;
    }
}

function resolveDraw(s: WebGLFrameBackendState, open: OpenRenderPass, entry: DrawRecord): void {
    const { renderer, backend } = s;
    const renderObject = prepareRecordedDraw(renderer, entry, open.params.camera!, open.ctx, (nodes, object) =>
        Prepare.prepareRenderObject(backend.gl!, backend, nodes, object, {
            precision: backend._opts.precision,
            maxTextureSize: backend._maxTextureSize,
        }),
    );
    if (drawsNothing(renderObject, entry.opts)) {
        renderer.inspector?.resolvedDraw(renderObject, true);
        return;
    }

    // A nested pass recorded by `updateBefore` aimed the frame at its own target.
    aimNodeFrame(renderer, open.desc.camera ?? null, open.params.width, open.params.height);
    const index = open.count++;
    open.prepared[index] = renderObject;
    open.preparedOpts[index] = entry.opts;
    let capture = open.captures[index];
    if (capture === undefined) {
        capture = Bindings.createRecordCapture();
        open.captures[index] = capture;
    }
    RenderPass.captureDraw(backend, renderer._nodes, renderObject, capture);
    renderer.inspector?.resolvedDraw(renderObject, false);
}

/** Encodes what the pass captured, then closes the scopes `beginPass` opened. */
export function encodePass(s: WebGLFrameBackendState, desc: PassDesc): void {
    const open = s.openByDepth[--s.depth];
    if (open.skipped) return;
    const { renderer, backend } = s;
    const { ctx, params } = open;

    try {
        aimNodeFrame(renderer, desc.camera ?? null, params.width, params.height);

        // The pass's own GL work starts here, after everything that prepared it: `beginPass` clears,
        // `endPass` resolves, and the mip chains below are the last of it. Preparing uploads and compiles
        // shaders, which is the frame's cost rather than this pass's — and is outside what WebGPU's
        // timestamps cover, so leaving it out is what makes the two backends' numbers mean one thing.
        renderer.inspector?.beginGpuWork(params.passId);
        try {
            const scope = RenderPass.beginPass(backend, ctx, params);
            try {
                if (open.count > 0) {
                    RenderPass.encodeDraws(
                        backend.gl!,
                        backend,
                        renderer._nodes,
                        ctx,
                        params,
                        open.prepared,
                        open.preparedOpts,
                        open.captures,
                        open.count,
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
        } finally {
            renderer.inspector?.endGpuWork(params.passId);
        }
    } finally {
        closePassScopes(s, open);
    }
}

/** Closes the inspector bracket and render scope an unskipped `beginPass` opened. */
function closePassScopes(s: WebGLFrameBackendState, open: OpenRenderPass): void {
    s.renderer.inspector?.finishRender(open.params.passId);
    s.renderer._nodes.nodeFrame.endRender(open.previousRenderId);
}

/** Closes every pass begun above `depth` and not ended, so none holds its scopes past a throw. */
function unwindTo(s: WebGLFrameBackendState, depth: number): void {
    while (s.depth > depth) {
        const open = s.openByDepth[--s.depth];
        if (!open.skipped) closePassScopes(s, open);
    }
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
            captures: [],
            count: 0,
        };
        pool[depth] = open;
    }
    open.desc = desc;
    open.ctx = ctx;
    open.skipped = true;
    open.count = 0;
    return open;
}

export function beginTransformFeedbackPass(s: WebGLFrameBackendState, _desc: TransformFeedbackPassDesc): void {
    let open = s.openTransformFeedbackByDepth[s.transformFeedbackDepth];
    if (open === undefined) {
        open = { skipped: true, dispatches: [], captures: [], count: 0 };
        s.openTransformFeedbackByDepth[s.transformFeedbackDepth] = open;
    }
    s.transformFeedbackDepth++;
    open.count = 0;
    open.skipped = !usable(s);
    if (open.skipped) s.renderer.inspector?.skipRecordedPass('context lost');
}

/** Captures a recorded dispatch's uniforms and textures, so it runs with the values set before the call. */
export function recordTransformFeedback(s: WebGLFrameBackendState, record: TransformFeedbackRecord): void {
    const open = s.openTransformFeedbackByDepth[s.transformFeedbackDepth - 1];
    if (open.skipped) return;
    const { renderer, backend } = s;
    let capture = open.captures[open.count];
    if (capture === undefined) {
        capture = Bindings.createRecordCapture();
        open.captures[open.count] = capture;
    }
    const dispatch = open.dispatches[open.count];
    if (dispatch === undefined) {
        open.dispatches[open.count] = { ...record };
    } else {
        dispatch.node = record.node;
        dispatch.inputs = record.inputs;
        dispatch.outputs = record.outputs;
        dispatch.count = record.count;
        dispatch.instanceCount = record.instanceCount;
    }
    TransformFeedback.captureTransformFeedback(
        backend.gl!,
        backend,
        backend._transformFeedback,
        record.node,
        backend._opts.precision,
        renderer._nodes.nodeFrame,
        capture,
    );
    open.count++;
}

export function encodeTransformFeedbackPass(s: WebGLFrameBackendState, desc: TransformFeedbackPassDesc): void {
    const open = s.openTransformFeedbackByDepth[--s.transformFeedbackDepth];
    if (open.count === 0 || open.skipped || !usable(s)) return;
    const { renderer, backend } = s;
    const label = desc.label ?? 'transform-feedback';

    renderer.info.compute.calls++;
    renderer.info.compute.frameCalls++;
    renderer.inspector?.perf.start(label);

    const inspector = renderer.inspector;
    try {
        for (let i = 0; i < open.count; i++) {
            const record = open.dispatches[i];
            // One entry per node, as `encodeDispatches` opens one per compute node — a kernel entry
            // rather than a marker, so the dispatch carries a GPU time and counts toward the frame's.
            const name = `transform-feedback: ${record.node.name ?? record.node.id}`;
            inspector?.beginKernel(name);
            try {
                TransformFeedback.runTransformFeedback(
                    backend.gl!,
                    backend,
                    backend._transformFeedback,
                    record.node,
                    record,
                    backend._opts.precision,
                    open.captures[i],
                    inspector,
                    name,
                );
            } finally {
                inspector?.finishKernel(name);
            }
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
    // A pass begun and never ended still holds its scopes; close them so none outlives the frame.
    unwindTo(s, 0);
    s.transformFeedbackDepth = 0;
    if (!usable(s)) return;
    s.renderer.inspector?.finish(s.renderer._nodes.nodeFrame.frameId);
}
