import type { InspectorBase } from '../../inspector/inspector-base';
import type { ComputeNode } from '../../nodes/nodes';
import type { NodeManagerState } from '../core/node-manager';
import type { ComputeContext } from '../core/pass-context';
import type { BackendComputeEntry } from '../core/render-types';
import * as Bindings from './bindings';
import * as Buffers from './buffers';
import * as Pipelines from './pipelines';
import * as Textures from './textures';
/**
 * Pre-compile a compute pipeline for the renderer's `compileCompute()`: build (or fetch) the compute
 * pipeline for `computeNode`, pushing any async compilation promise onto `promises`.
 */
export declare function compileComputePipeline(device: GPUDevice, pipelines: Pipelines.PipelinesState, nodes: NodeManagerState, computeNode: ComputeNode, computeContext: ComputeContext, promises: Promise<void>[]): void;
/**
 * Encode and submit a batch of compute dispatches in one command encoder + one submit, then
 * regenerate mips for any written storage textures that opted in. Each entry gets its own compute
 * pass so per-node inspector hooks still work. Compute is a self-contained top-level op — it owns
 * a local encoder rather than the render-frame encoder, so it never interferes with an in-flight
 * render.
 */
export declare function dispatchCompute(device: GPUDevice, bindings: Bindings.BindingsState, buffers: Buffers.BufferCache, textures: Textures.TextureCache, pipelines: Pipelines.PipelinesState, nodes: NodeManagerState, computeContext: ComputeContext, entries: BackendComputeEntry[], inspector: InspectorBase | null): void;
