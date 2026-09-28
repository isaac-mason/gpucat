import type { GpuBuffer } from '../../core/gpu-buffer';
import type { GpuTexture } from '../../core/gpu-texture';
import type { InspectorBase } from '../../inspector/inspector-base';
import type { ComputeNode } from '../../nodes/nodes';
import type * as d from '../../schema/schema';
import type { DispatchRecord } from '../core/frame';
import type { NodeManagerState } from '../core/node-manager';
import type { ComputeContext } from '../core/pass-context';
import type { DrawBindings } from './bindings';
import * as Pipelines from './pipelines';
import * as Textures from './textures';
import type { WebGPUBackend } from './webgpu-backend';
/**
 * Pre-compile a compute pipeline for the renderer's `compileCompute()`: build (or fetch) the compute
 * pipeline for `computeNode`, pushing any async compilation promise onto `promises`.
 */
export declare function compileComputePipeline(device: GPUDevice, pipelines: Pipelines.PipelinesState, nodes: NodeManagerState, computeNode: ComputeNode, computeContext: ComputeContext, promises: Promise<void>[]): void;
/** A recorded dispatch as it resolved when recorded: what it runs, what it binds, and how many workgroups. */
export type ResolvedDispatch = {
    node: ComputeNode;
    pipeline: GPUComputePipeline | null;
    bindings: DrawBindings;
    /** Copied at the call, so a counts array changed after `dispatch()` does not reach this dispatch. */
    workgroups: [number, number, number];
    /** Null for a direct dispatch. */
    indirect: GpuBuffer<d.Any> | null;
    indirectOffset: number;
};
export declare function createResolvedDispatch(node: ComputeNode): ResolvedDispatch;
/**
 * Resolves a dispatch at the call that recorded it: its pipeline, its node updates, and its uniforms
 * and bind groups, so it runs with the values set before that call.
 */
export declare function resolveDispatch(b: WebGPUBackend, nodes: NodeManagerState, computeContext: ComputeContext, entry: DispatchRecord, out: ResolvedDispatch, inspector: InspectorBase | null, mipDirty: Set<GpuTexture<d.StorageTexture>>): void;
/** An inspector splits the batch one pass per entry: `timestampWrites` is a pass-descriptor field. */
export declare function encodeDispatches(b: WebGPUBackend, encoder: GPUCommandEncoder, resolved: readonly ResolvedDispatch[], count: number, label: string, inspector: InspectorBase | null): void;
export declare function regenerateComputeMips(device: GPUDevice, textures: Textures.TextureCache, mipDirty: Set<GpuTexture<d.StorageTexture>>, encoder: GPUCommandEncoder): void;
