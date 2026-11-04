import type { GpuTexture } from '../../core/gpu-texture';
import { type TextureViewRange } from '../../core/gpu-texture-view';
import type { BindGroup, StorageBinding, StorageTextureBinding, TextureBinding } from '../core/bind-group';
import type { DispatchOptions } from '../core/frame';
import type { NodeBuilderState } from '../core/node-builder-state';
import type { NodeFrame } from '../core/node-frame';
import type { RenderObject } from '../core/render-object';
import { type BindGroupCache, type CachedGroup } from './bind-group-cache';
import { type BindGroupLayoutCache } from './bind-group-layout';
import { type ArenaSlot } from './draw-arena';
import type { WebGPUBackend } from './webgpu-backend';
/**
 * Per-BindGroup data (GPU resources).
 * Keyed by BindGroup object identity in a WeakMap.
 */
export type BindGroupData = {
    /** the cached groups over the resources bound now; null until resolved, or after a texture it bound was disposed */
    current: CachedGroup | null;
    /** GPU bind group layout. */
    bindGroupLayout: GPUBindGroupLayout | null;
    /** Whether a binding's resource changed since the variant was picked. */
    needsUpdate: boolean;
    /** The draw arena slot the group's uniform block lives in, once placed: looked up at every draw, so kept here. */
    slot: ArenaSlot | null;
    /**
     * A shared group's resolution for the scope it holds for (its frame for a per-frame block, its render scope for a
     * per-camera one): every draw and dispatch in the scope binds the same, so the first resolves it and the rest take
     * it as it is, as a pass owns its view group in Babylon Lite. -1 until resolved.
     */
    resolvedScope: number;
    resolvedGroup: GPUBindGroup | null;
    resolvedOffset: number;
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
    /** a number for each GPU object a cache key names, held weakly so no key keeps one alive */
    objectIds: WeakMap<object, number>;
    nextObjectId: number;
    /** every GPU bind group, by layout and resources bound, shared with the caches that destroy what they bind */
    cache: BindGroupCache;
};
/**
 * Create a new Bindings state. The shared bind group layout cache is owned by the backend and passed
 * in so the bindings and pipelines layers hit a single value-keyed layout cache.
 */
export declare function createBindingsState(layoutCache: BindGroupLayoutCache, cache: BindGroupCache): BindingsState;
/**
 * What one recorded draw or dispatch binds, in @group order: its bind groups and the dynamic offset each is
 * bound at (-1 for a group without one). Per draw rather than per RenderObject, since one object drawn twice
 * in a pass with different values binds different allocations each time.
 */
export type DrawBindings = {
    groups: (GPUBindGroup | undefined)[];
    offsets: number[];
};
/** Bindings with a slot for each @group, none bound: packed from the start, so writing a later index first leaves no hole
 *  for the draw loop to step around. */
export declare function createDrawBindings(): DrawBindings;
/** Update all bindings for one draw of a RenderObject, into `out`. */
export declare function updateRenderBindings(b: WebGPUBackend, renderObject: RenderObject, frame: NodeFrame, out: DrawBindings): void;
/** Update all bindings for one compute dispatch, into `out`. */
export declare function updateComputeBindings(b: WebGPUBackend, nodeBuilderState: NodeBuilderState, frame: NodeFrame, inputs: DispatchInputs | null, out: DrawBindings): void;
/** A group that bound a texture since disposed resolves again: no group may bind it again. */
export declare function clearBindGroupVariants(data: BindGroupData): void;
/** what a dispatch fills its node's named slots with: its `buffers` and `textures` */
type DispatchInputs = DispatchOptions;
type TextureBindingNodes = TextureBinding['entry']['node'] | StorageTextureBinding['entry']['node'];
/** What a texture binding binds: written by {@link resolveTextureBinding}, read before the next call. */
export type ResolvedTexture = {
    texture: GpuTexture | null;
    range: TextureViewRange;
};
/**
 * The texture and range `node` binds: its own, or for a named binding what the dispatch's `textures` fills its slot
 * with. The result is shared: read it before the next call.
 */
export declare function resolveTextureBinding(node: TextureBindingNodes, inputs: DispatchInputs | null): ResolvedTexture;
/** Initialize bindings for a RenderObject. */
export declare function initRenderBindings(state: BindingsState, renderObject: RenderObject, device: GPUDevice): void;
/** Get the bind group layouts for a RenderObject. Used for pipeline creation. */
export declare function getRenderBindGroupLayouts(state: BindingsState, renderObject: RenderObject, device: GPUDevice): GPUBindGroupLayout[];
export {};
