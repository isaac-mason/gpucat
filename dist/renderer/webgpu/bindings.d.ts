import type { GpuBuffer } from '../../core/gpu-buffer';
import type { Any } from '../../schema/schema';
import type { BindGroup, StorageBinding } from '../core/bind-group';
import type { NodeBuilderState } from '../core/node-builder-state';
import type { NodeFrame } from '../core/node-frame';
import type { RenderObject } from '../core/render-object';
import { type BindGroupLayoutCache } from './bind-group-layout';
import type { WebGPUBackend } from './webgpu-backend';
/** The GPU bind groups over one set of resources a BindGroup binds. */
export type BindGroupVariant = {
    /** over the uniform block's own buffer, or for a group with none; built on first need */
    bindGroup: GPUBindGroup | null;
    /**
     * For a group whose uniform block binds at a dynamic offset: one GPU bind group per dynamic uniform
     * buffer a use has been allocated from, by buffer id. Those buffers are pooled, never replaced, so each
     * stays valid.
     */
    dynamicBindGroups: (GPUBindGroup | undefined)[];
};
/**
 * Per-BindGroup data (GPU resources).
 * Keyed by BindGroup object identity in a WeakMap.
 */
export type BindGroupData = {
    /** the variant over the resources bound now */
    current: BindGroupVariant;
    /**
     * A variant over each set of resources bound, by the GPU objects in it, as three.js keeps them: one BindGroup fed a
     * few sets in turn (a compute node dispatched over several views' buffers) builds each set's once. A reallocated
     * buffer or texture is a new GPU object, so it is a new set; a disposed texture clears every variant of a group
     * that bound it.
     */
    variants: Map<string, BindGroupVariant>;
    /** GPU bind group layout. */
    bindGroupLayout: GPUBindGroupLayout | null;
    /** Whether a binding's resource changed since the variant was picked. */
    needsUpdate: boolean;
    /** the GPU buffer each storage binding last bound: one a buffer reallocates (grown) is a resource change too */
    storageGpuBuffers: Map<StorageBinding, GPUBuffer>;
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
    /** a number for each GPU object a variant's key names, held weakly so no key keeps one alive */
    objectIds: WeakMap<object, number>;
    nextObjectId: number;
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
/** drops every variant `data` keeps, for a group that bound a texture since disposed: none may bind it again */
export declare function clearBindGroupVariants(data: BindGroupData): void;
/** Initialize bindings for a RenderObject. */
export declare function initRenderBindings(state: BindingsState, renderObject: RenderObject, device: GPUDevice): void;
/** Get the bind group layouts for a RenderObject. Used for pipeline creation. */
export declare function getRenderBindGroupLayouts(state: BindingsState, renderObject: RenderObject): GPUBindGroupLayout[];
