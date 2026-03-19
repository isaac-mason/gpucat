import { type ComputeNode } from '../nodes/nodes';
import type { Material } from '../material/material';
import type { Geometry } from '../geometry/geometry';
import type { RenderObject } from './render-object';
import type { NodeBuilderState } from './node-builder-state';
import type { NodeManagerState } from './node-manager';
import type { ComputeContext } from './pass-context';
import { type BindGroupLayoutCache } from './bind-group-layout';
export type ComputePipelineEntry = {
    pipeline: GPUComputePipeline | null;
    nodeBuilderState: NodeBuilderState;
};
export type RenderPipelineEntry = {
    pipeline: GPURenderPipeline | null;
    cacheKey: string;
};
export type PipelinesStats = {
    renderCount: number;
    computeCount: number;
    bindGroupLayoutCount: number;
};
/**
 * Pipelines state object.
 * Holds all caches for render and compute pipelines.
 */
export type PipelinesState = {
    /** Shared bind group layout cache for all pipelines. */
    bindGroupLayoutCache: BindGroupLayoutCache;
    /** Render pipelines - keyed by cache key. */
    renderPipelines: Map<string, RenderPipelineEntry>;
    /** Compute pipelines - keyed by node id. */
    computePipelines: Map<string, ComputePipelineEntry>;
};
export declare const DEPTH_FORMAT: GPUTextureFormat;
/**
 * Create a pipelines state.
 */
export declare function createPipelinesState(): PipelinesState;
/**
 * Get cache statistics.
 */
export declare function getStats(state: PipelinesState): PipelinesStats;
/**
 * Get or create a render pipeline for a RenderObject.
 *
 * @param state - The pipelines state
 * @param renderObject - The RenderObject (must have nodeBuilderState set)
 * @param bindGroupLayouts - The bind group layouts for the pipeline
 * @param colorFormat - The color texture format
 * @param depthFormat - The depth texture format (null for no depth)
 * @param promises - Optional array to collect async compilation promises (for compileAsync)
 * @returns The render pipeline entry
 */
export declare function getForRender(state: PipelinesState, device: GPUDevice, renderObject: RenderObject, bindGroupLayouts: GPUBindGroupLayout[], colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat | null, promises?: Promise<void>[] | null): RenderPipelineEntry;
/**
 * Check if a render pipeline is ready for rendering.
 */
export declare function isReady(state: PipelinesState, renderObject: RenderObject, colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat | null): boolean;
/**
 * Get or create a compute pipeline for a ComputeNode.
 *
 * @param state - The pipelines state
 * @param node - The ComputeNode
 * @param computeContext - The ComputeContext for bind group caching
 * @param promises - Optional array to collect async compilation promises (for compileAsync)
 * @returns The compute pipeline entry
 */
export declare function getForCompute(state: PipelinesState, device: GPUDevice, nodes: NodeManagerState, node: ComputeNode, computeContext: ComputeContext, promises?: Promise<void>[] | null): ComputePipelineEntry;
/**
 * Check if a compute pipeline is ready.
 */
export declare function isComputeReady(state: PipelinesState, node: ComputeNode): boolean;
/**
 * Look up an existing compute pipeline entry without compiling.
 * Returns null if the pipeline hasn't been created yet.
 *
 * @param state - The pipelines state
 * @param node - The ComputeNode
 * @returns The compute pipeline entry, or null if not compiled yet
 */
export declare function lookupCompute(state: PipelinesState, node: ComputeNode): ComputePipelineEntry | null;
/**
 * Stable cache key for a material + MSAA sample count + color format + optional depth format.
 */
export declare function makeRenderPipelineKey(material: Material, samples: number, format: GPUTextureFormat, depthFormat?: GPUTextureFormat | undefined): string;
/**
 * Build vertex buffer layouts from geometry and NodeBuilderState.
 * Uses vertexBufferGroups to produce one GPUVertexBufferLayout per unique buffer.
 */
export declare function buildVertexBufferLayouts(geometry: Geometry, nodeState: NodeBuilderState): GPUVertexBufferLayout[];
