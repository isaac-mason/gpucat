import type { GpuTexture } from '../../core/gpu-texture';
import type { RenderTarget } from '../../core/render-target';
import type * as d from '../../schema/schema';
import type { DeviceBackend } from '../core/device-backend';
import type { ComputePassDesc, DispatchRecord, DrawOptions, PassDesc, PassEntry } from '../core/frame';
import type { PreparedRenderObject, PreparedSegment } from '../core/render-types';
import type { Renderer } from '../core/renderer';
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
export declare function createWebGPUFrameBackendState(renderer: Renderer<DeviceBackend>, backend: WebGPUBackend): WebGPUFrameBackendState;
export declare function beginFrame(s: WebGPUFrameBackendState): void;
export declare function encodePass(s: WebGPUFrameBackendState, desc: PassDesc, records: readonly PassEntry[], count: number): void;
export declare function encodeComputePass(s: WebGPUFrameBackendState, desc: ComputePassDesc, records: readonly DispatchRecord[], count: number): void;
export declare function submitFrame(s: WebGPUFrameBackendState): void;
export declare function discardFrame(s: WebGPUFrameBackendState): void;
