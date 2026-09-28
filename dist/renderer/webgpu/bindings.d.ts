import type { GpuBuffer } from '../../core/gpu-buffer';
import type { Any } from '../../schema/schema';
import type { BindGroup } from '../core/bind-group';
import type { NodeBuilderState } from '../core/node-builder-state';
import type { NodeFrame } from '../core/node-frame';
import type { RenderObject } from '../core/render-object';
import { type BindGroupLayoutCache } from './bind-group-layout';
import type { WebGPUBackend } from './webgpu-backend';
/**
 * Per-BindGroup data (GPU resources).
 * Keyed by BindGroup object identity in a WeakMap.
 */
export type BindGroupData = {
    /** GPU bind group (recreated when resources change). */
    bindGroup: GPUBindGroup | null;
    /**
     * For a group whose uniform block binds at a dynamic offset: one GPU bind group per dynamic uniform
     * buffer a use has been allocated from, by buffer id. Those buffers are pooled, never replaced, so each
     * stays valid. `bindGroup` is the one over the block's own buffer.
     */
    dynamicBindGroups: (GPUBindGroup | undefined)[];
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
};
/**
 * Create a new Bindings state. The shared bind group layout cache is owned by the backend and passed
 * in so the bindings and pipelines layers hit a single value-keyed layout cache.
 */
export declare function createBindingsState(layoutCache: BindGroupLayoutCache): BindingsState;
/**
 * What one recorded draw or dispatch binds, in @group order: its bind groups and the dynamic offset each is
 * bound at (-1 for a group without one). Per draw rather than per RenderObject, since one object drawn twice
 * in a pass with different values binds different allocations each time.
 */
export type DrawBindings = {
    groups: GPUBindGroup[];
    offsets: number[];
};
/** Update all bindings for one draw of a RenderObject, into `out`. */
export declare function updateRenderBindings(b: WebGPUBackend, renderObject: RenderObject, frame: NodeFrame, out: DrawBindings): void;
/** Update all bindings for one compute dispatch, into `out`. */
export declare function updateComputeBindings(b: WebGPUBackend, nodeBuilderState: NodeBuilderState, frame: NodeFrame, buffers: Record<string, GpuBuffer<Any>> | null, out: DrawBindings): void;
/** Initialize bindings for a RenderObject. */
export declare function initRenderBindings(state: BindingsState, renderObject: RenderObject, device: GPUDevice): void;
/** Get the bind group layouts for a RenderObject. Used for pipeline creation. */
export declare function getRenderBindGroupLayouts(state: BindingsState, renderObject: RenderObject): GPUBindGroupLayout[];
