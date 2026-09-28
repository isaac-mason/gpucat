import type { GpuTexture } from '../../core/gpu-texture';
import type { RenderTarget } from '../../core/render-target';
import type * as d from '../../schema/schema';
import type { DeviceBackend } from '../core/device-backend';
import type { ComputePassDesc, DispatchRecord, DrawOptions, PassDesc, PassEntry } from '../core/frame';
import type { RenderContext } from '../core/pass-context';
import { type PreparedRenderObject, type PreparedSegment, type RenderPassParams } from '../core/render-types';
import type { Renderer } from '../core/renderer';
import type { DrawBindings } from './bindings';
import * as Compute from './compute';
import * as RenderPass from './render-pass';
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
    /** Runs of `prepared`, one per bundle plus the direct draws between them. */
    segments: PreparedSegment[];
    segmentCount: number;
    runStart: number;
};
/** A compute pass between `beginComputePass` and `encodeComputePass`, holding its dispatches as they resolved. */
type OpenComputePass = {
    desc: ComputePassDesc;
    /** Nothing resolves or encodes: a lost device. */
    skipped: boolean;
    resolved: Compute.ResolvedDispatch[];
    count: number;
};
export declare function createWebGPUFrameBackendState(renderer: Renderer<DeviceBackend>, backend: WebGPUBackend): WebGPUFrameBackendState;
export declare function beginFrame(s: WebGPUFrameBackendState): void;
/** Opens a render pass: its context and render scope are fixed here, before its first draw resolves. */
export declare function beginPass(s: WebGPUFrameBackendState, desc: PassDesc): void;
/** Resolves a recorded draw, or every draw of a replayed bundle, into the pass being recorded. */
export declare function recordEntry(s: WebGPUFrameBackendState, entry: PassEntry): void;
/** Encodes what the pass resolved, then closes the scopes `beginPass` opened. */
export declare function encodePass(s: WebGPUFrameBackendState, desc: PassDesc): void;
/** Opens a compute pass; its validation scope covers the dispatches as they resolve. */
export declare function beginComputePass(s: WebGPUFrameBackendState, desc: ComputePassDesc): void;
/** Resolves a recorded dispatch into the compute pass being recorded. */
export declare function recordDispatch(s: WebGPUFrameBackendState, record: DispatchRecord): void;
/** Encodes what the pass resolved, then closes the scope `beginComputePass` opened. */
export declare function encodeComputePass(s: WebGPUFrameBackendState, desc: ComputePassDesc): void;
export declare function submitFrame(s: WebGPUFrameBackendState): void;
export declare function discardFrame(s: WebGPUFrameBackendState): void;
export {};
