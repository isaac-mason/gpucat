import type { GpuTexture } from '../../core/gpu-texture';
import type { InspectorBase } from '../../inspector/inspector-base';
import type { ComputeNode } from '../../nodes/nodes';
import type * as d from '../../schema/schema';
import type { DispatchRecord } from '../core/frame';
import type { NodeManagerState } from '../core/node-manager';
import type { ComputeContext } from '../core/pass-context';
import * as Pipelines from './pipelines';
import * as Textures from './textures';
import type { WebGPUBackend } from './webgpu-backend';
/**
 * Pre-compile a compute pipeline for the renderer's `compileCompute()`: build (or fetch) the compute
 * pipeline for `computeNode`, pushing any async compilation promise onto `promises`.
 */
export declare function compileComputePipeline(device: GPUDevice, pipelines: Pipelines.PipelinesState, nodes: NodeManagerState, computeNode: ComputeNode, computeContext: ComputeContext, promises: Promise<void>[]): void;
/** An inspector splits the batch one pass per entry: `timestampWrites` is a pass-descriptor field. */
export declare function encodeDispatches(b: WebGPUBackend, nodes: NodeManagerState, computeContext: ComputeContext, encoder: GPUCommandEncoder, entries: readonly DispatchRecord[], count: number, label: string, inspector: InspectorBase | null, mipDirty: Set<GpuTexture<d.StorageTexture>>): void;
export declare function regenerateComputeMips(device: GPUDevice, textures: Textures.TextureCache, mipDirty: Set<GpuTexture<d.StorageTexture>>, encoder: GPUCommandEncoder): void;
