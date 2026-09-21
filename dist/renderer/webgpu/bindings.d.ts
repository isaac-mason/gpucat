import type { GpuBuffer } from '../../core/gpu-buffer';
import type { Any } from '../../schema/schema';
import type { BindGroup } from '../core/bind-group';
import type { NodeBuilderState } from '../core/node-builder-state';
import type { NodeFrame } from '../core/node-frame';
import type { RenderObject } from '../core/render-object';
import type { BackendState } from './backend-state';
import { type BindGroupLayoutCache } from './bind-group-layout';
/**
 * Per-BindGroup data (GPU resources).
 * Keyed by BindGroup object identity in a WeakMap.
 */
export type BindGroupData = {
    /** GPU bind group (recreated when resources change). */
    bindGroup: GPUBindGroup | null;
    /** GPU bind group layout. */
    bindGroupLayout: GPUBindGroupLayout | null;
    /** Whether the bind group needs to be rebuilt. */
    needsUpdate: boolean;
};
/** Bindings state - manages per-BindGroup GPU resources */
export type BindingsState = {
    /**
     * Bind group layout cache. Owned by the backend and injected at creation; the same cache
     * instance backs the pipelines layer, so a given entry shape yields exactly one GPU layout
     * shared across all bind groups and pipelines.
     */
    layoutCache: BindGroupLayoutCache;
    /**
     * Per-BindGroup data.
     * Keyed by BindGroup object identity - shared groups share data.
     */
    data: WeakMap<BindGroup, BindGroupData>;
    /**
     * Render bind groups rebuilt since creation. A rebuild replaces the `GPUBindGroup` object, which
     * a recorded render bundle has already baked in, so a bundle compares this to know it is stale.
     */
    bindGroupRebuilds: number;
};
/**
 * Create a new Bindings state. The shared bind group layout cache is owned by the backend and passed
 * in so the bindings and pipelines layers hit a single value-keyed layout cache.
 */
export declare function createBindingsState(layoutCache: BindGroupLayoutCache): BindingsState;
/** Update all bindings for a RenderObject. */
export declare function updateRenderBindings(b: BackendState, renderObject: RenderObject, frame: NodeFrame): void;
/** Update all bindings for a compute pass and return GPUBindGroups. */
export declare function updateComputeBindings(b: BackendState, nodeBuilderState: NodeBuilderState, frame: NodeFrame, buffers: Record<string, GpuBuffer<Any>> | null): GPUBindGroup[];
/** Initialize bindings for a RenderObject. */
export declare function initRenderBindings(state: BindingsState, renderObject: RenderObject, device: GPUDevice): void;
/** Get the bind group layouts for a RenderObject. Used for pipeline creation. */
export declare function getRenderBindGroupLayouts(state: BindingsState, renderObject: RenderObject): GPUBindGroupLayout[];
