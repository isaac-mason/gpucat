import type { Geometry } from '../../geometry/geometry';
import type { Material } from '../../material/material';
import type { MRTNode } from '../../nodes/lib/mrt';
import { type ComputeNode } from '../../nodes/nodes';
import type { NodeBuilderState } from '../core/node-builder-state';
import type { NodeManagerState } from '../core/node-manager';
import type { ComputeContext, RenderContext } from '../core/pass-context';
import type { RenderObject } from '../core/render-object';
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
};
/**
 * Pipelines state object.
 * Holds all caches for render and compute pipelines.
 */
export type PipelinesState = {
    /**
     * Shared bind group layout cache. Owned by the backend and injected at creation so the same
     * value-keyed layouts are shared with the bindings layer (bindings + pipelines never create a
     * duplicate layout for the same entry shape).
     */
    bindGroupLayoutCache: BindGroupLayoutCache;
    /** Render pipelines - keyed by cache key. */
    renderPipelines: Map<string, RenderPipelineEntry>;
    /** Compute pipelines - keyed by node id. */
    computePipelines: Map<string, ComputePipelineEntry>;
    /**
     * Fallback color format used when rendering to the swapchain (renderTarget === null).
     * Set by the renderer once the canvas format is known.
     */
    canvasFormat: GPUTextureFormat;
};
/**
 * Create a pipelines state. The shared bind group layout cache is owned by the backend and passed
 * in so the pipelines and bindings layers hit a single value-keyed layout cache.
 */
export declare function createPipelinesState(bindGroupLayoutCache: BindGroupLayoutCache): PipelinesState;
/**
 * Per-attachment color formats for a render context.
 * Reads each `renderTarget.textures[i].format`; falls back to the canvas format for the swapchain.
 */
export declare function getRenderContextColorFormats(renderContext: {
    renderTarget: {
        textures: {
            format: GPUTextureFormat;
        }[];
    } | null;
}, canvasFormat: GPUTextureFormat): GPUTextureFormat[];
/** The depth ATTACHMENT's format, not the sampling-gated `depthTexture` getter: a pipeline needs it
 *  whether or not the depth is sampled. */
export declare function getRenderContextDepthFormat(renderContext: RenderContext): GPUTextureFormat | null;
/**
 * Get cache statistics.
 */
export declare function getPipelineCacheStats(state: PipelinesState): PipelinesStats;
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
export declare function getForRender(state: PipelinesState, device: GPUDevice, renderObject: RenderObject, bindGroupLayouts: GPUBindGroupLayout[], promises?: Promise<void>[] | null): RenderPipelineEntry;
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
 * Look up an existing compute pipeline entry without compiling.
 * Returns null if the pipeline hasn't been created yet.
 *
 * @param state - The pipelines state
 * @param node - The ComputeNode
 * @returns The compute pipeline entry, or null if not compiled yet
 */
export declare function lookupCompute(state: PipelinesState, node: ComputeNode): ComputePipelineEntry | null;
/** Drop every cached pipeline (called on renderer dispose; `device.destroy()` frees the GPU side). */
export declare function disposePipelines(state: PipelinesState): void;
/**
 * Stable cache key for a material + vertex layout + MSAA sample count + color format + optional depth
 * format. `vertexLayout` comes from {@link vertexLayoutKey}; without it two geometries that supply the
 * same attribute name with different buffer formats share a pipeline whose arrayStride suits only one.
 */
export declare function makeRenderPipelineKey(material: Material, vertexLayout: string, samples: number, formats: GPUTextureFormat[], depthFormat: GPUTextureFormat | null, mrt: MRTNode | null): string;
/** The part of a pipeline's vertex layout that comes from the geometry, not from the node graph. */
export declare function vertexLayoutKey(geometry: Geometry, nodeState: NodeBuilderState): string;
/**
 * Build vertex buffer layouts from geometry and NodeBuilderState.
 * Uses vertexBufferGroups to produce one GPUVertexBufferLayout per unique buffer.
 */
export declare function buildVertexBufferLayouts(geometry: Geometry, nodeState: NodeBuilderState, label?: string): GPUVertexBufferLayout[];
/**
 * Get bytes per element for a vertex format.
 */
export declare function getBytesPerElement(format: GPUVertexFormat): number;
/**
 * Convert WGSL type to GPU vertex format.
 */
export declare function wgslTypeToVertexFormat(type: string): GPUVertexFormat;
/**
 * Get the item size (number of components) for a WGSL type.
 */
export declare function wgslTypeItemSize(type: string): number;
