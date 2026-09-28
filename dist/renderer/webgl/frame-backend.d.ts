import type { DeviceBackend } from '../core/device-backend';
import type { DrawOptions, PassDesc, PassEntry, TransformFeedbackPassDesc, TransformFeedbackRecord } from '../core/frame';
import type { RenderContext } from '../core/pass-context';
import { type PreparedRenderObject, type RenderPassParams } from '../core/render-types';
import type { Renderer } from '../core/renderer';
import * as Bindings from './bindings';
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
export declare function createWebGLFrameBackendState(renderer: Renderer<DeviceBackend>, backend: WebGLBackend): WebGLFrameBackendState;
export declare function beginFrame(s: WebGLFrameBackendState): void;
/** Opens a render pass: its context and render scope are fixed here, before its first draw resolves. */
export declare function beginPass(s: WebGLFrameBackendState, desc: PassDesc): void;
/** Resolves a recorded draw, or every draw of a replayed bundle, into the pass being recorded. */
export declare function recordEntry(s: WebGLFrameBackendState, entry: PassEntry): void;
/** Encodes what the pass captured, then closes the scopes `beginPass` opened. */
export declare function encodePass(s: WebGLFrameBackendState, desc: PassDesc): void;
export declare function beginTransformFeedbackPass(s: WebGLFrameBackendState, _desc: TransformFeedbackPassDesc): void;
/** Captures a recorded dispatch's uniforms and textures, so it runs with the values set before the call. */
export declare function recordTransformFeedback(s: WebGLFrameBackendState, record: TransformFeedbackRecord): void;
export declare function encodeTransformFeedbackPass(s: WebGLFrameBackendState, desc: TransformFeedbackPassDesc): void;
/** WebGL2 is immediate mode: the work reached the driver as each pass ended, so neither can undo it. */
export declare function submitFrame(s: WebGLFrameBackendState): void;
export declare function discardFrame(s: WebGLFrameBackendState): void;
export {};
