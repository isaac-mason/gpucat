import type { GpuTexture } from '../../core/gpu-texture';
import type { RenderTarget } from '../../core/render-target';
import type * as d from '../../schema/schema';
import type { DeviceBackend } from '../core/device-backend';
import type { ComputePassDesc, DispatchRecord, DrawOptions, PassDesc, PassEntry } from '../core/frame';
import { type PreparedRenderObject, type PreparedSegment, type RenderPassParams } from '../core/render-types';
import type { Renderer } from '../core/renderer';
import * as RenderPass from './render-pass';
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
export declare function createWebGPUFrameBackendState(renderer: Renderer<DeviceBackend>, backend: WebGPUBackend): WebGPUFrameBackendState;
export declare function beginFrame(s: WebGPUFrameBackendState): void;
export declare function encodePass(s: WebGPUFrameBackendState, desc: PassDesc, records: readonly PassEntry[], count: number): void;
export declare function encodeComputePass(s: WebGPUFrameBackendState, desc: ComputePassDesc, records: readonly DispatchRecord[], count: number): void;
export declare function submitFrame(s: WebGPUFrameBackendState): void;
export declare function discardFrame(s: WebGPUFrameBackendState): void;
