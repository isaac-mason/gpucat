import type { UniformGroupBlock } from 'gpucat/dist/nodes/builder';
import type { GpuBuffer } from 'gpucat/dist/core/gpu-buffer';
import type { Any } from 'gpucat/dist/schema/schema';
import type { BindGroup } from 'gpucat/dist/renderer/bind-group';
import { type BindGroupLayoutCache } from 'gpucat/dist/renderer/bind-group-layout';
import type { BufferCache } from 'gpucat/dist/renderer/buffers';
import type { NodeBuilderState } from 'gpucat/dist/renderer/node-builder-state';
import type { NodeFrame } from 'gpucat/dist/renderer/node-frame';
import type { RenderObject } from 'gpucat/dist/renderer/render-object';
import type { TextureCache } from 'gpucat/dist/renderer/textures';
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
    /** Bind group layout cache (shared across all bind groups). */
    layoutCache: BindGroupLayoutCache;
    /**
     * Per-BindGroup data.
     * Keyed by BindGroup object identity - shared groups share data.
     */
    data: WeakMap<BindGroup, BindGroupData>;
};
/** Create a new Bindings state */
export declare function createBindingsState(): BindingsState;
/** Update all bindings for a RenderObject. */
export declare function updateRenderBindings(state: BindingsState, renderObject: RenderObject, frame: NodeFrame, device: GPUDevice, bufferCache: BufferCache, textureCache: TextureCache): void;
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
export declare function deleteRenderBindings(_state: BindingsState, renderObject: RenderObject): void;
/** Mark a RenderObject's bindings as needing rebuild. */
export declare function invalidateRenderBindings(state: BindingsState, renderObject: RenderObject): void;
/** Invoke update callbacks on uniform nodes in a group. */
export declare function invokeUniformGroupCallbacks(block: UniformGroupBlock, frame: NodeFrame): void;
