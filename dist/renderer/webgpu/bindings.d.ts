import type { GpuBuffer } from '../../core/gpu-buffer';
import type { UniformGroupBlock } from '../../nodes/builder';
import type { Any } from '../../schema/schema';
import type { BindGroup } from '../core/bind-group';
import type { NodeBuilderState } from '../core/node-builder-state';
import type { NodeFrame } from '../core/node-frame';
import type { RenderObject } from '../core/render-object';
import { type BindGroupLayoutCache } from './bind-group-layout';
import type { BufferCache } from './buffers';
import type { RenderObjectGpuCache } from './render-object-gpu';
import type { TextureCache } from './textures';
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
};
/**
 * Create a new Bindings state. The shared bind group layout cache is owned by the backend and passed
 * in so the bindings and pipelines layers hit a single value-keyed layout cache.
 */
export declare function createBindingsState(layoutCache: BindGroupLayoutCache): BindingsState;
/** Update all bindings for a RenderObject. */
export declare function updateRenderBindings(state: BindingsState, renderObject: RenderObject, frame: NodeFrame, device: GPUDevice, bufferCache: BufferCache, textureCache: TextureCache, renderObjectGpuCache: RenderObjectGpuCache): void;
/** Update all bindings for a compute pass and return GPUBindGroups. */
export declare function updateComputeBindings(state: BindingsState, nodeBuilderState: NodeBuilderState, frame: NodeFrame, device: GPUDevice, bufferCache: BufferCache, textureCache: TextureCache, buffers: Record<string, GpuBuffer<Any>> | null): GPUBindGroup[];
/** Initialize bindings for a RenderObject. */
export declare function initRenderBindings(state: BindingsState, renderObject: RenderObject, device: GPUDevice): void;
/** Get the bind group layouts for a RenderObject. Used for pipeline creation. */
export declare function getRenderBindGroupLayouts(state: BindingsState, renderObject: RenderObject): GPUBindGroupLayout[];
/** Get bind group layouts for a compute pass. Used for pipeline creation. */
export declare function getComputeBindGroupLayouts(state: BindingsState, nodeBuilderState: NodeBuilderState, device: GPUDevice): GPUBindGroupLayout[];
/** Get the bind groups for a RenderObject. */
export declare function getRenderBindGroups(state: BindingsState, renderObject: RenderObject): GPUBindGroup[];
/** Delete bindings for a RenderObject. */
export declare function deleteRenderBindings(_state: BindingsState, renderObject: RenderObject, renderObjectGpuCache: RenderObjectGpuCache): void;
/** Mark a RenderObject's bindings as needing rebuild. */
export declare function invalidateRenderBindings(state: BindingsState, renderObject: RenderObject): void;
/** Invoke update callbacks on uniform nodes in a group. */
export declare function invokeUniformGroupCallbacks(block: UniformGroupBlock, frame: NodeFrame): void;
