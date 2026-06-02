import type { BindGroup as NodeBindGroup } from 'gpucat/dist/renderer/bind-group';
export type BindGroupLayoutCache = {
    cache: Map<string, GPUBindGroupLayout>;
};
/** create a bind group layout cache */
export declare function createBindGroupLayoutCache(): BindGroupLayoutCache;
/**
 * Get or create a bind group layout for the given entries.
 * Uses a stable hash of the entries as the cache key.
 */
export declare function getBindGroupLayout(cache: BindGroupLayoutCache, device: GPUDevice, entries: GPUBindGroupLayoutEntry[]): GPUBindGroupLayout;
/**
 * Build bind group layouts from NodeBuilderState bindings for compute pipelines.
 *
 * @param device - The GPU device
 * @param bindings - The bindings from NodeBuilderState
 * @param layoutCache - Cache for bind group layouts
 * @returns Array of GPUBindGroupLayout in group index order
 */
export declare function buildComputeBindGroupLayouts(device: GPUDevice, bindings: NodeBindGroup[], layoutCache: BindGroupLayoutCache): GPUBindGroupLayout[];
