import type { GpuBuffer } from '../../core/gpu-buffer';
import type { GpuTexture } from '../../core/gpu-texture';
import { type TextureViewRange, WHOLE_TEXTURE } from '../../core/gpu-texture-view';
import type { Material } from '../../material/material';
import type { MaterialParameters } from '../../material/parameters';
import type { Any } from '../../schema/schema';
import type {
    BindGroup,
    SamplerBinding,
    StorageBinding,
    StorageTextureBinding,
    TextureBinding,
    UniformBinding,
} from '../core/bind-group';
import { invokeUniformGroupCallbacks } from '../core/bind-group';
import type { DispatchOptions } from '../core/frame';
import type { StateInfo } from '../core/info';
import type { NodeBuilderState } from '../core/node-builder-state';
import type { NodeFrame } from '../core/node-frame';
import type { RenderObject } from '../core/render-object';
import { getBindings as getRenderObjectBindings } from '../core/render-object';
import { formatHasStencil } from '../core/render-types';
import { syncSharedBlock } from '../core/shared-blocks';
import {
    checkUniformStamp,
    commitUniformStamp,
    packAndCompare,
    packUniformMembers,
    resolvedThisScope,
    type StampCheck,
} from '../core/uniform-use';
import { type BindGroupCache, type CachedGroup, cachedGroup } from './bind-group-cache';
import {
    type BindGroupLayoutCache,
    fillEmptyLayouts,
    getBindGroupLayout,
    holdBindGroupLayout,
    releaseBindGroupLayout,
    samplerBindingType,
    textureBindingLayout,
    usesDynamicOffset,
} from './bind-group-layout';
import type { BufferCache } from './buffers';
import {
    allocDynamicUniform,
    dynamicUniformBuffer,
    ensureUploaded,
    getRaw,
    getUploaded,
    resolveStorageBuffer,
    ringGroup,
    uploadSharedBlock,
    uploadUniformBlock,
} from './buffers';
import { type ArenaSlot, arenaSlot, inDrawArena, pageGroup, takeSlot, writeSlot } from './draw-arena';
import { ensureRenderTargetTexturesAllocated } from './render-target';
import { getSampler, peekSampler, type SamplerCache } from './samplers';
import type { TextureCache } from './textures';
import { getTextureData, rangeView, type TextureData, updateTexture } from './textures';
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
export function createBindingsState(layoutCache: BindGroupLayoutCache, cache: BindGroupCache): BindingsState {
    return {
        layoutCache,
        data: new WeakMap(),
        objectIds: new WeakMap(),
        nextObjectId: 1,
        cache,
    };
}

/** Map a storage texture WGSL dimension tag to a GPU view dimension. */
function storageViewDimension(dim: '1d' | '2d' | '2d_array' | '3d'): GPUTextureViewDimension {
    switch (dim) {
        case '1d':
            return '1d';
        case '2d_array':
            return '2d-array';
        case '3d':
            return '3d';
        default:
            return '2d';
    }
}

/** Map a WGSL storage access keyword to the bind-group-layout access enum. */
function storageLayoutAccess(access: 'read' | 'write' | 'read_write'): GPUStorageTextureAccess {
    switch (access) {
        case 'write':
            return 'write-only';
        case 'read_write':
            return 'read-write';
        default:
            return 'read-only';
    }
}

/**
 * Get or create BindGroupData for a BindGroup.
 * This is the DataMap pattern - auto-creates data on first access.
 */
function getData(state: BindingsState, bindGroup: BindGroup): BindGroupData {
    let data = state.data.get(bindGroup);
    if (!data) {
        data = {
            current: null,
            bindGroupLayout: null,
            slot: null,
            needsUpdate: true,
            resolvedScope: -1,
            resolvedGroup: null,
            resolvedOffset: -1,
            storageGpuBuffers: new Map(),
        };
        state.data.set(bindGroup, data);
    }
    return data;
}

/**
 * What one recorded draw or dispatch binds, in @group order: its bind groups and the dynamic offset each is
 * bound at (-1 for a group without one). Per draw rather than per RenderObject, since one object drawn twice
 * in a pass with different values binds different allocations each time.
 */
export type DrawBindings = { groups: (GPUBindGroup | undefined)[]; offsets: number[] };

/** @group indices a draw's bindings keep a slot for: WebGPU's default `maxBindGroups` */
const GROUP_SLOTS = 4;

/** Bindings with a slot for each @group, none bound: packed from the start, so writing a later index first leaves no hole
 *  for the draw loop to step around. */
export function createDrawBindings(): DrawBindings {
    const out: DrawBindings = { groups: [], offsets: [] };
    for (let index = 0; index < GROUP_SLOTS; index++) {
        out.groups.push(undefined);
        out.offsets.push(-1);
    }
    return out;
}

/** Every slot of `out` emptied in place, its length and packing kept */
function clearDrawBindings(out: DrawBindings): void {
    for (let index = 0; index < out.groups.length; index++) {
        out.groups[index] = undefined;
        out.offsets[index] = -1;
    }
}

/** Update all bindings for one draw of a RenderObject, into `out`. */
export function updateRenderBindings(b: WebGPUBackend, renderObject: RenderObject, frame: NodeFrame, out: DrawBindings): void {
    const { bindings: state, device, buffers: bufferCache } = b;
    const { textures: textureCache, samplers: samplerCache } = b;
    clearDrawBindings(out);
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) return;

    // Get BindGroups for this RenderObject (shared groups reused, non-shared cloned)
    const bindGroups = getRenderObjectBindings(renderObject);
    const info = b.renderer.info.state;

    for (const bindGroup of bindGroups) {
        // Initialize bind group layout if needed
        initBindGroup(state, bindGroup, device, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT);

        const data = getData(state, bindGroup);
        const scope = sharedScope(bindGroup, frame);
        if (scope >= 0 && data.resolvedScope === scope && data.resolvedGroup !== null && !sharedBlockMoved(bindGroup)) {
            out.groups[bindGroup.groupIndex] = data.resolvedGroup;
            out.offsets[bindGroup.groupIndex] = data.resolvedOffset;
            continue;
        }

        // Update uniforms, which decides where this use of each uniform block reads from
        updateRenderBindGroup(data, bindGroup, renderObject, frame, device, bufferCache, textureCache, samplerCache, info);

        const gpuBindGroup = currentGPUBindGroup(
            state,
            device,
            bufferCache,
            textureCache,
            samplerCache,
            bindGroup,
            data,
            renderObject.material.parameters,
            null,
            info,
        );
        if (gpuBindGroup) {
            out.groups[bindGroup.groupIndex] = gpuBindGroup;
            out.offsets[bindGroup.groupIndex] = dynamicOffsetOf(data, bindGroup);
            if (scope >= 0) keepResolved(data, scope, gpuBindGroup, out.offsets[bindGroup.groupIndex]!);
        }
    }
}

/** Update all bindings for one compute dispatch, into `out`. */
export function updateComputeBindings(
    b: WebGPUBackend,
    nodeBuilderState: NodeBuilderState,
    frame: NodeFrame,
    inputs: DispatchInputs | null,
    out: DrawBindings,
): void {
    const { bindings: state, device, buffers: bufferCache, textures: textureCache, samplers: samplerCache } = b;
    clearDrawBindings(out);

    const info = b.renderer.info.state;
    for (const bindGroup of nodeBuilderState.bindings) {
        // Initialize bind group layout if needed
        initBindGroup(state, bindGroup, device, GPUShaderStage.COMPUTE);

        const data = getData(state, bindGroup);
        const scope = sharedScope(bindGroup, frame);
        if (scope >= 0 && data.resolvedScope === scope && data.resolvedGroup !== null && !sharedBlockMoved(bindGroup)) {
            out.groups[bindGroup.groupIndex] = data.resolvedGroup;
            out.offsets[bindGroup.groupIndex] = data.resolvedOffset;
            continue;
        }

        // Update bindings
        updateComputeBindGroup(data, bufferCache, textureCache, samplerCache, device, bindGroup, frame, inputs, info);

        const gpuBindGroup = currentGPUBindGroup(
            state,
            device,
            bufferCache,
            textureCache,
            samplerCache,
            bindGroup,
            data,
            null,
            inputs,
            info,
        );
        if (gpuBindGroup) {
            out.groups[bindGroup.groupIndex] = gpuBindGroup;
            out.offsets[bindGroup.groupIndex] = dynamicOffsetOf(data, bindGroup);
            if (scope >= 0) keepResolved(data, scope, gpuBindGroup, out.offsets[bindGroup.groupIndex]!);
        }
    }
}

/**
 * The scope a shared uniform-only group holds for, in which every use binds the same: its frame for a per-frame block,
 * its render scope (a pass, or a camera set in one) for a per-render one. -1 for any other group, resolved at each use.
 */
function sharedScope(bindGroup: BindGroup, frame: NodeFrame): number {
    if (!bindGroup.shared || bindGroup.bindings.length !== 1) return -1;
    const binding = bindGroup.bindings[0]!;
    if (binding.kind !== 'uniform') return -1;
    const updateType = binding.block.group.updateType;
    if (updateType === 'frame') return frame.frameId;
    if (updateType === 'render') return frame.renderId;
    return -1;
}

/** Whether the shared block `bindGroup` reads gained or lost a member since it last synced: its buffer may have grown. */
function sharedBlockMoved(bindGroup: BindGroup): boolean {
    const sharedBlock = (bindGroup.bindings[0] as UniformBinding).sharedBlock;
    return sharedBlock !== null && sharedBlock.syncedVersion !== sharedBlock.version;
}

function keepResolved(data: BindGroupData, scope: number, group: GPUBindGroup, offset: number): void {
    data.resolvedScope = scope;
    data.resolvedGroup = group;
    data.resolvedOffset = offset;
}

/**
 * The GPU bind group for the current use of `bindGroup`: its own when the uniform block reads its own
 * buffer (or it has no such block), else the one addressing the dynamic uniform buffer this use was
 * allocated from. Built on first need, for the set of resources bound: a resource change (`needsUpdate`) picks the
 * variant over the set now bound, built before or new.
 */
function currentGPUBindGroup(
    state: BindingsState,
    device: GPUDevice,
    bufferCache: BufferCache,
    textureCache: TextureCache,
    samplerCache: SamplerCache,
    bindGroup: BindGroup,
    data: BindGroupData,
    parameters: MaterialParameters | null,
    inputs: DispatchInputs | null,
    info: StateInfo,
): GPUBindGroup | null {
    if (data.needsUpdate || data.current === null || data.current.released) {
        const resources = resourceKey(state, bufferCache, textureCache, bindGroup, parameters, inputs, _keyObjects);
        data.current = groupFor(state, data, resources, _keyObjects);
        data.needsUpdate = false;
    }
    const variant = data.current;
    info.held = state.cache.groups.size;

    const uniform = dynamicUniformBinding(bindGroup);
    if (uniform !== null && bindGroup.bindings.length === 1 && data.bindGroupLayout !== null) {
        // the block is all the group binds: every block of its layout and size in the same buffer shares one group
        const block = uniform.block;
        if (uniform.sliceBufferId >= 0) {
            return ringGroup(bufferCache, device, uniform.sliceBufferId, data.bindGroupLayout, block.binding, block.totalBytes);
        }
        if (data.slot !== null) return pageGroup(device, data.slot, data.bindGroupLayout, block.binding, block.totalBytes);
    }

    if (uniform === null || uniform.sliceBufferId < 0) {
        if (variant.bindGroup !== null) return variant.bindGroup;
        info.created++;
        variant.bindGroup = buildGPUBindGroup(
            device,
            bufferCache,
            textureCache,
            samplerCache,
            bindGroup,
            data,
            parameters,
            inputs,
            data.slot?.page.buffer ?? null,
        );
        return variant.bindGroup;
    }

    const bufferId = uniform.sliceBufferId;
    const cached = variant.dynamicBindGroups[bufferId];
    if (cached !== undefined) return cached;
    info.created++;
    const built = buildGPUBindGroup(
        device,
        bufferCache,
        textureCache,
        samplerCache,
        bindGroup,
        data,
        parameters,
        inputs,
        dynamicUniformBuffer(bufferCache, bufferId),
    );
    if (built !== null) variant.dynamicBindGroups[bufferId] = built;
    return built;
}

/** The cache entry over `data`'s layout and the resources `resources` names, its GPU objects being `objects`: filed
 *  under the layout as well, so it goes when the layout's last holder does. */
function groupFor(state: BindingsState, data: BindGroupData, resources: string, objects: object[]): CachedGroup {
    const key = `${data.bindGroupLayout === null ? 0 : objectId(state, data.bindGroupLayout)}|${resources}`;
    if (data.bindGroupLayout !== null) objects.push(data.bindGroupLayout);
    return cachedGroup(state.cache, key, objects);
}

/** `bindGroup` ended with its owner (a render object, a shared group's last compiled state, a compute node): its data
 *  goes, and with it its hold on its layout. */
export function releaseBindGroup(state: BindingsState, bindGroup: BindGroup): void {
    const data = state.data.get(bindGroup);
    if (data === undefined) return;
    state.data.delete(bindGroup);
    if (data.bindGroupLayout !== null) releaseBindGroupLayout(state.layoutCache, data.bindGroupLayout);
}

/** A group that bound a texture since disposed resolves again: no group may bind it again. */
export function clearBindGroupVariants(data: BindGroupData): void {
    data.current = null;
    data.needsUpdate = true;
}

/** what a dispatch fills its node's named slots with: its `buffers` and `textures` */
type DispatchInputs = DispatchOptions;

type TextureBindingNodes = TextureBinding['entry']['node'] | StorageTextureBinding['entry']['node'];

/** What a texture binding binds: written by {@link resolveTextureBinding}, read before the next call. */
export type ResolvedTexture = { texture: GpuTexture | null; range: TextureViewRange };
const _resolved: ResolvedTexture = { texture: null, range: null! };
/** The GPU objects the last `resourceKey` named, read before the next one. */
const _keyObjects: object[] = [];

/**
 * The texture and range `node` binds: its own, or for a named binding what the dispatch's `textures` fills its slot
 * with. The result is shared: read it before the next call.
 */
export function resolveTextureBinding(
    node: TextureBindingNodes,
    parameters: MaterialParameters | null,
    inputs: DispatchInputs | null,
): ResolvedTexture {
    if (node.slot === null) {
        _resolved.texture = node.value;
        _resolved.range = node.range;
        return _resolved;
    }
    const source = inputs?.textures?.[node.slot] ?? parameters?.texture(node.slot);
    if (source === undefined) {
        throw new Error(
            `[gpucat] texture '${node.slot}' is unfilled: set it with material.parameters.setTexture('${node.slot}', …), ` +
                "or pass it in the dispatch's `textures`.",
        );
    }
    if ('isGpuTextureView' in source) {
        _resolved.texture = source.texture;
        _resolved.range = source.range;
    } else if ('_gpuTexture' in source) {
        _resolved.texture = source._gpuTexture;
        _resolved.range = WHOLE_TEXTURE;
    } else {
        _resolved.texture = source;
        _resolved.range = WHOLE_TEXTURE;
    }
    return _resolved;
}

/** the GPU objects `bindGroup` binds now, as the numbers `state` gives them: what tells one resource set from another */
function resourceKey(
    state: BindingsState,
    bufferCache: BufferCache,
    textureCache: TextureCache,
    bindGroup: BindGroup,
    parameters: MaterialParameters | null,
    inputs: DispatchInputs | null,
    objects: object[],
): string {
    objects.length = 0;
    const id = (object: object | null | undefined): number => {
        if (!object) return 0;
        objects.push(object);
        return objectId(state, object);
    };
    let key = '';
    for (const binding of bindGroup.bindings) {
        switch (binding.kind) {
            case 'uniform':
                key += `${binding.bufferKey ? id(uniformBuffer(bufferCache, binding.bufferKey)) : 0},`;
                break;
            case 'storage':
                key += `${id(getUploaded(bufferCache, resolveStorageBuffer(binding.entry.node, parameters, inputs?.buffers ?? null)))},`;
                break;
            case 'texture':
            case 'storageTexture': {
                const { texture, range } = resolveTextureBinding(binding.entry.node, parameters, inputs);
                key += `${texture ? id(getTextureData(textureCache, texture)?.texture) : 0}@${range.key},`;
                break;
            }
            case 'sampler':
                key += `${binding.entry.samplerNode.value?.settingsKey ?? ''},`;
                break;
        }
    }
    return key;
}

/** The number `state` gives a GPU object for cache keys, the same for the object's life. */
function objectId(state: BindingsState, object: object): number {
    let found = state.objectIds.get(object);
    if (found === undefined) {
        found = state.nextObjectId++;
        state.objectIds.set(object, found);
    }
    return found;
}

/** The buffer `key`'s block is read from: its draw arena page, or its own. */
function uniformBuffer(bufferCache: BufferCache, key: object): GPUBuffer | undefined {
    return arenaSlot(bufferCache.drawArena, key)?.page.buffer ?? getRaw(bufferCache, key);
}

/**
 * The dynamic offset the current use binds at: -1 for a group without one, its slot's for a block in the draw arena, 0
 * for a block's own buffer.
 */
function dynamicOffsetOf(data: BindGroupData, bindGroup: BindGroup): number {
    const uniform = dynamicUniformBinding(bindGroup);
    if (uniform === null) return -1;
    if (uniform.sliceBufferId >= 0) return uniform.sliceOffset;
    return data.slot?.offset ?? 0;
}

/** Initialize bindings for a RenderObject. */
export function initRenderBindings(state: BindingsState, renderObject: RenderObject, device: GPUDevice): void {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) return;

    // Get BindGroups for this RenderObject
    const bindGroups = getRenderObjectBindings(renderObject);

    // Initialize each BindGroup
    for (const bindGroup of bindGroups) {
        initBindGroup(state, bindGroup, device, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT);
    }
}

/** Get the bind group layouts for a RenderObject. Used for pipeline creation. */
export function getRenderBindGroupLayouts(
    state: BindingsState,
    renderObject: RenderObject,
    device: GPUDevice,
): GPUBindGroupLayout[] {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) return [];

    // Get BindGroups for this RenderObject
    const bindGroups = getRenderObjectBindings(renderObject);

    // each layout at its @group(N), the indices the shader skips empty
    const layouts: GPUBindGroupLayout[] = [];
    for (const bindGroup of bindGroups) {
        const data = getData(state, bindGroup);
        if (data.bindGroupLayout) layouts[bindGroup.groupIndex] = data.bindGroupLayout;
    }
    return fillEmptyLayouts(state.layoutCache, device, layouts);
}

/** Initialize a BindGroup (create layout). Called once per BindGroup. `uniformVisibility` is the stages a uniform
 *  block is visible to; every other binding is visible to the stages its compile found reading it. */
function initBindGroup(
    state: BindingsState,
    bindGroup: BindGroup,
    device: GPUDevice,
    uniformVisibility: GPUShaderStageFlags,
): void {
    const data = getData(state, bindGroup);

    // already initialized
    if (data.bindGroupLayout) return;

    // build bind group layout entries
    const entries = buildLayoutEntries(bindGroup, uniformVisibility, device);

    // get or create the layout, held for as long as the group is
    data.bindGroupLayout = getBindGroupLayout(state.layoutCache, device, entries);
    holdBindGroupLayout(state.layoutCache, data.bindGroupLayout);
}

/**
 * Build bind group layout entries for a BindGroup. A uniform block is shared by every stage, as three.js does; any
 * other binding is visible only to the stages that read it, since WebGPU counts a binding against each stage's limit
 * (8 storage buffers by default) for every stage it is visible to.
 */
function buildLayoutEntries(
    bindGroup: BindGroup,
    uniformVisibility: GPUShaderStageFlags,
    device: GPUDevice,
): GPUBindGroupLayoutEntry[] {
    const float32Filterable = device.features.has('float32-filterable');
    const entries: GPUBindGroupLayoutEntry[] = [];

    for (const binding of bindGroup.bindings) {
        switch (binding.kind) {
            case 'uniform':
                entries.push({
                    binding: binding.block.binding,
                    visibility: uniformVisibility,
                    buffer: { type: 'uniform', hasDynamicOffset: usesDynamicOffset(binding.block) },
                });
                break;

            case 'storage':
                entries.push({
                    binding: binding.entry.binding,
                    visibility: binding.entry.visibility,
                    buffer: {
                        type: binding.entry.access === 'read_write' ? 'storage' : 'read-only-storage',
                    },
                });
                break;

            case 'texture': {
                entries.push({
                    binding: binding.entry.binding,
                    visibility: binding.entry.visibility,
                    texture: textureBindingLayout(binding.entry, float32Filterable),
                });
                break;
            }

            case 'storageTexture': {
                entries.push({
                    binding: binding.entry.binding,
                    visibility: binding.entry.visibility,
                    storageTexture: {
                        access: storageLayoutAccess(binding.entry.access),
                        format: binding.entry.format as GPUTextureFormat,
                        viewDimension: storageViewDimension(binding.entry.dim),
                    },
                });
                break;
            }

            case 'sampler':
                entries.push({
                    binding: binding.entry.binding,
                    visibility: binding.entry.visibility,
                    sampler: {
                        type: samplerBindingType(binding.entry),
                    },
                });
                break;
        }
    }

    // Sort by binding index
    entries.sort((a, b) => a.binding - b.binding);

    return entries;
}

/** Update a BindGroup (uniforms, textures, etc.).  Called every frame */
function updateRenderBindGroup(
    data: BindGroupData,
    bindGroup: BindGroup,
    renderObject: RenderObject,
    frame: NodeFrame,
    device: GPUDevice,
    bufferCache: BufferCache,
    textureCache: TextureCache,
    samplerCache: SamplerCache,
    info: StateInfo,
): void {
    for (const binding of bindGroup.bindings) {
        switch (binding.kind) {
            case 'uniform':
                updateUniformBinding(
                    bufferCache,
                    device,
                    binding,
                    frame,
                    data,
                    renderObject.material,
                    usesDynamicOffset(binding.block),
                    info,
                );
                break;

            case 'texture':
                updateTextureBinding(textureCache, device, binding, data, renderObject.material.parameters, null);
                break;

            case 'storageTexture':
                updateStorageTextureBinding(textureCache, device, binding, data, renderObject.material.parameters, null);
                break;

            case 'sampler':
                updateSamplerBinding(samplerCache, device, binding, data);
                break;

            case 'storage':
                updateStorageBinding(bufferCache, device, binding, data, renderObject.material.parameters, null);
                break;
        }
    }
}

/** The group's uniform binding when it binds at a dynamic offset. A group holds at most one uniform block. */
function dynamicUniformBinding(bindGroup: BindGroup): UniformBinding | null {
    const binding = bindGroup.bindings[0];
    return binding?.kind === 'uniform' && usesDynamicOffset(binding.block) ? binding : null;
}

/**
 * Update a uniform binding for one use (a draw, or a compute dispatch). `perUse` marks a block bound at a dynamic
 * offset. A shared one is packed into a ring allocation at every use; a render object's or dispatch's own lives in a
 * draw arena slot; a per-frame block has its own buffer, written when its bytes change.
 */
function updateUniformBinding(
    bufferCache: BufferCache,
    device: GPUDevice,
    binding: UniformBinding,
    frame: NodeFrame,
    data: BindGroupData,
    material: Material | null,
    perUse: boolean,
    info: StateInfo,
): void {
    const block = binding.block;

    // A shared block's members are synced by the block itself, once a frame and again after one joins, and only what
    // moved uploads: every shader's draws bind its one buffer whole
    const sharedBlock = binding.sharedBlock;
    if (sharedBlock !== null) {
        syncSharedBlock(sharedBlock, frame);
        if (uploadSharedBlock(bufferCache, device, sharedBlock)) data.needsUpdate = true;
        binding.sliceBufferId = -1;
        return;
    }

    // a shared frame or render block already resolved in this scope: this use reads what that one wrote
    if (resolvedThisScope(binding, frame)) return;

    // A shared block bound at a dynamic offset (the view block) is packed at every use, straight into a ring
    // allocation: it has no buffer of its own, as PlayCanvas's view uniform buffers are not persistent
    if (block.group.shared && perUse) {
        invokeUniformGroupCallbacks(block, frame);
        const offset = allocDynamicUniform(bufferCache, device, block.totalBytes);
        const active = bufferCache.dynamicUniforms.active!;
        packUniformMembers(block, new DataView(active.staging.view.buffer, offset, block.totalBytes), material, 'wgsl-uniform');
        binding.sliceBufferId = active.gpuBuffer.id;
        binding.sliceOffset = offset;
        info.packed++;
        return;
    }

    // A per-object block whose versions all hold has the bytes it last packed, which its slot holds: nothing to pack
    const inArena = inDrawArena(block.group);
    // a stamp is committed only once the slot holds the bytes it names, so a kept block always has its slot
    const stamp: StampCheck = inArena ? checkUniformStamp(binding, frame, material, info) : 'unstamped';
    if (stamp === 'kept') {
        binding.lastUseFrameId = frame.frameId;
        binding.sliceBufferId = -1;
        return;
    }

    // invoke update callbacks with the NodeFrame
    invokeUniformGroupCallbacks(block, frame);

    // create buffer key if needed
    if (!binding.bufferKey) {
        binding.bufferKey = {};
    }

    // Ensure we have preallocated double buffers
    const requiredBytes = block.totalBytes;
    if (!binding.currentBuffer || binding.currentBuffer.byteLength !== requiredBytes) {
        binding.currentBuffer = new ArrayBuffer(requiredBytes);
        binding.scratchBuffer = new ArrayBuffer(requiredBytes);
    }

    // Pack into scratch buffer, then compare with what the block's own buffer holds
    const changedBytes = packAndCompare(block, binding.currentBuffer, binding.scratchBuffer!, material, 'wgsl-uniform');
    const changed = changedBytes > 0;

    info.packed++;
    if (inArena) {
        // the stamp names what the slot holds, which a use reading a dynamic allocation leaves as it was
        if (updateArenaBlock(bufferCache, device, binding, frame, data, changed)) commitUniformStamp(binding, stamp);
        return;
    }

    // A per-frame block: one use a frame, so its own buffer always holds the bytes this use reads
    binding.sliceBufferId = -1;
    const uploaded = !!getRaw(bufferCache, binding.bufferKey);
    if (changed || !uploaded) {
        if (changed) {
            // Swap buffers: scratch becomes current
            const temp = binding.currentBuffer;
            binding.currentBuffer = binding.scratchBuffer!;
            binding.scratchBuffer = temp;
        }

        const result = uploadUniformBlock(bufferCache, device, binding.bufferKey, binding.currentBuffer, {
            material: material?.name,
            updateType: block.group?.updateType,
            changedBytes,
        });

        // Only rebuild bind group if buffer was created/resized (not just written to)
        if (result.created) {
            data.needsUpdate = true;
        }
    }
}

/**
 * A render object's or dispatch's own block, after packing: its bytes live in a draw arena slot, rewritten when they
 * change. A later use this frame with other bytes reads a dynamic allocation instead, since a write to the slot
 * would land before the frame's submit and the earlier use would read it.
 * Whether this use reads the slot (so the slot holds the bytes packed), not a dynamic allocation.
 */
function updateArenaBlock(
    bufferCache: BufferCache,
    device: GPUDevice,
    binding: UniformBinding,
    frame: NodeFrame,
    data: BindGroupData,
    changed: boolean,
): boolean {
    const key = binding.bufferKey!;
    const requiredBytes = binding.block.totalBytes;
    let slot = data.slot;
    const placed = slot === null || slot.bytes < requiredBytes;
    if (placed) {
        slot = takeSlot(bufferCache.drawArena, device, key, requiredBytes);
        data.slot = slot;
        data.needsUpdate = true;
    }
    const readThisFrame = binding.lastUseFrameId === frame.frameId;
    binding.lastUseFrameId = frame.frameId;

    if (changed && !placed && readThisFrame) {
        const offset = allocDynamicUniform(bufferCache, device, requiredBytes);
        const active = bufferCache.dynamicUniforms.active!;
        new Uint8Array(active.staging.view.buffer, offset, requiredBytes).set(new Uint8Array(binding.scratchBuffer!));
        binding.sliceBufferId = active.gpuBuffer.id;
        binding.sliceOffset = offset;
        return false;
    }
    binding.sliceBufferId = -1;

    if (changed) {
        const temp = binding.currentBuffer!;
        binding.currentBuffer = binding.scratchBuffer!;
        binding.scratchBuffer = temp;
    }
    if (changed || placed) writeSlot(slot!, binding.currentBuffer!);
    return true;
}

/** Update a texture binding. */
function updateTextureBinding(
    textureCache: TextureCache,
    device: GPUDevice,
    binding: TextureBinding,
    data: BindGroupData,
    parameters: MaterialParameters | null,
    inputs: DispatchInputs | null,
): void {
    const { texture: gpuTexture, range } = resolveTextureBinding(binding.entry.node, parameters, inputs);

    if (gpuTexture === null) return;

    if (range.key !== binding.lastRangeKey) {
        binding.lastRangeKey = range.key;
        data.needsUpdate = true;
    }

    // Texture SWAP: the node was rebound to a different GpuTexture (e.g. an atlas
    // reload allocating a fresh texture, or a placeholder->real swap). Generation
    // only tracks in-place uploads to one texture, so a swap to a fresh texture
    // (whose generation can coincide with the stale one) would slip through and
    // leave the bind group pointing at the old — now disposed — texture, faulting
    // the next submit. Mirror updateStorageBinding's lastBuffer identity check.
    if (gpuTexture !== binding.lastTexture) {
        binding.lastTexture = gpuTexture;
        data.needsUpdate = true;
    }

    // For render target textures, the GPU resource is set externally via setRenderTargetTexture().
    // For regular textures, updateTexture() handles upload.
    // Both cases: check generation to detect changes.
    if (!gpuTexture.isRenderTargetTexture) {
        // Regular texture - upload source data
        const texData = updateTexture(textureCache, device, gpuTexture);

        if (binding.generation !== texData.generation) {
            binding.generation = texData.generation;
            data.needsUpdate = true;
        }
        if (data.needsUpdate) (texData.bindGroups ??= new Set()).add(data);
    } else {
        // Render target texture - the GPU resource is created/resized by the owning
        // render target's pass. If that pass hasn't run this frame (e.g. the target
        // was resized between renders), lazily (re)allocate it here so we never sample
        // a stale or destroyed texture. ensure...Allocated is idempotent and bumps
        // generation on realloc, which the check below turns into a bind-group rebuild.
        if (gpuTexture.renderTarget) {
            ensureRenderTargetTexturesAllocated(textureCache, device, gpuTexture.renderTarget);
        }

        const texData = getTextureData(textureCache, gpuTexture);
        if (texData) {
            if (binding.generation !== texData.generation) {
                binding.generation = texData.generation;
                data.needsUpdate = true;
            }
            if (data.needsUpdate) (texData.bindGroups ??= new Set()).add(data);
        }
    }
}

/** Update a storage texture binding: ensure GPU texture exists, detect changes. */
function updateStorageTextureBinding(
    textureCache: TextureCache,
    device: GPUDevice,
    binding: StorageTextureBinding,
    data: BindGroupData,
    parameters: MaterialParameters | null,
    inputs: DispatchInputs | null,
): void {
    const { texture: gpuTexture, range } = resolveTextureBinding(binding.entry.node, parameters, inputs);
    if (gpuTexture === null) return;

    if (range.key !== binding.lastRangeKey) {
        binding.lastRangeKey = range.key;
        data.needsUpdate = true;
    }

    // Swap detection: same rationale as updateTextureBinding — a rebound node
    // pointing at a fresh GpuTexture must rebuild the bind group.
    if (gpuTexture !== binding.lastTexture) {
        binding.lastTexture = gpuTexture;
        data.needsUpdate = true;
    }

    // A render target's attachment is allocated by its target, in the format a storage binding takes
    // (`RenderTargetOptions.storage`), whichever binds it first. Other storage textures hold no source data;
    // updateTexture just ensures the GPU texture exists and returns its cache entry (with a generation counter).
    let texData: TextureData | null;
    if (gpuTexture.isRenderTargetTexture) {
        if (gpuTexture.renderTarget) ensureRenderTargetTexturesAllocated(textureCache, device, gpuTexture.renderTarget);
        texData = getTextureData(textureCache, gpuTexture);
        if (texData === null) return;
    } else {
        texData = updateTexture(textureCache, device, gpuTexture);
    }
    if (binding.generation !== texData.generation) {
        binding.generation = texData.generation;
        data.needsUpdate = true;
    }
    if (data.needsUpdate) (texData.bindGroups ??= new Set()).add(data);
}

/** Update a sampler binding. */
function updateSamplerBinding(samplerCache: SamplerCache, device: GPUDevice, binding: SamplerBinding, data: BindGroupData): void {
    const samplerNode = binding.entry.samplerNode;
    const gpuSampler = samplerNode.value;

    // Create/get sampler from GpuSampler settings (this caches by settingsKey)
    getSampler(device, samplerCache, gpuSampler);

    // Check for sampler changes using settingsKey
    const samplerKey = gpuSampler.settingsKey;
    if (binding.samplerKey !== samplerKey) {
        binding.samplerKey = samplerKey;
        data.needsUpdate = true;
    }
}

/** Update a storage binding - detect buffer swaps and flush data to GPU. */
function updateStorageBinding(
    bufferCache: BufferCache,
    device: GPUDevice,
    binding: StorageBinding,
    data: BindGroupData,
    parameters: MaterialParameters | null,
    buffers: Record<string, GpuBuffer<Any>> | null,
): void {
    const node = binding.entry.node;
    const buffer = resolveStorageBuffer(node, parameters, buffers);

    // If buffer identity changed, need to rebuild bind group
    if (buffer !== binding.lastBuffer) {
        binding.lastBuffer = buffer;
        data.needsUpdate = true;
    }

    // Flush pending data to GPU (version check / partial ranges handled inside); a grown buffer is a new GPU buffer
    const gpuBuffer = ensureUploaded(bufferCache, device, buffer, binding.entry.name);
    if (data.storageGpuBuffers.get(binding) !== gpuBuffer) {
        data.storageGpuBuffers.set(binding, gpuBuffer);
        data.needsUpdate = true;
    }
}

/** Rebuild the GPU bind group for a BindGroup */
/**
 * Builds the GPU bind group for `bindGroup`. `dynamicBuffer` is the dynamic uniform buffer a transient
 * uniform block is bound from, one block's size at a time, at the dynamic offset given when drawing.
 */
function buildGPUBindGroup(
    device: GPUDevice,
    bufferCache: BufferCache,
    textureCache: TextureCache,
    samplerCache: SamplerCache,
    bindGroup: BindGroup,
    data: BindGroupData,
    parameters: MaterialParameters | null,
    inputs: DispatchInputs | null,
    dynamicBuffer: GPUBuffer | null,
): GPUBindGroup | null {
    if (!data.bindGroupLayout) return null;

    const entries: GPUBindGroupEntry[] = [];

    for (const binding of bindGroup.bindings) {
        switch (binding.kind) {
            case 'uniform': {
                if (dynamicBuffer !== null) {
                    entries.push({
                        binding: binding.block.binding,
                        resource: { buffer: dynamicBuffer, size: binding.block.totalBytes },
                    });
                } else if (binding.bufferKey) {
                    const buffer = getRaw(bufferCache, binding.bufferKey);
                    if (buffer) {
                        entries.push({ binding: binding.block.binding, resource: { buffer } });
                    }
                }
                break;
            }

            case 'storage': {
                const buffer = resolveStorageBuffer(binding.entry.node, parameters, inputs?.buffers ?? null);
                const buf = getUploaded(bufferCache, buffer);
                if (buf) {
                    entries.push({ binding: binding.entry.binding, resource: { buffer: buf } });
                }
                break;
            }

            case 'texture': {
                const { texture: gpuTexture, range } = resolveTextureBinding(binding.entry.node, parameters, inputs);
                if (!gpuTexture) break;

                const texData = getTextureData(textureCache, gpuTexture);
                if (texData) {
                    // A combined depth-stencil texture carries two aspects, and a view may expose only one of them to
                    // a binding. Sampling sees the depth: the stencil would need a `texture_2d<u32>` binding, which
                    // nothing declares.
                    const view = rangeView(texData, range, gpuTexture.viewDimension, formatHasStencil(texData.texture.format));
                    entries.push({ binding: binding.entry.binding, resource: view });
                }
                break;
            }

            case 'storageTexture': {
                const { texture: gpuTexture, range } = resolveTextureBinding(binding.entry.node, parameters, inputs);
                if (!gpuTexture) break;

                const texData = getTextureData(textureCache, gpuTexture);
                if (texData) {
                    const mips = range.mipLevelCount ?? gpuTexture.mipLevelCount - range.baseMipLevel;
                    if (mips !== 1) {
                        throw new Error(
                            `[gpucat] storage texture '${gpuTexture.label ?? gpuTexture.id}' is bound with ${mips} mips; a storage ` +
                                `binding sees one. Bind a view of one: \`view({ baseMipLevel, mipLevelCount: 1 })\`.`,
                        );
                    }
                    const view = rangeView(texData, range, storageViewDimension(binding.entry.dim), false, true);
                    entries.push({ binding: binding.entry.binding, resource: view });
                }
                break;
            }

            case 'sampler': {
                const samplerNode = binding.entry.samplerNode;
                const gpuSampler = samplerNode.value;
                if (!gpuSampler) break;

                // Get GPU sampler from cache using settingsKey
                const sampler = peekSampler(samplerCache, gpuSampler.settingsKey);
                if (sampler) {
                    entries.push({ binding: binding.entry.binding, resource: sampler });
                }
                break;
            }
        }
    }

    // Sort entries by binding
    entries.sort((a, b) => a.binding - b.binding);

    if (entries.length === 0) return null;
    return device.createBindGroup({ layout: data.bindGroupLayout, entries });
}

/** Update a compute BindGroup (uniforms, textures, samplers, storage). */
function updateComputeBindGroup(
    data: BindGroupData,
    bufferCache: BufferCache,
    textureCache: TextureCache,
    samplerCache: SamplerCache,
    device: GPUDevice,
    bindGroup: BindGroup,
    frame: NodeFrame,
    inputs: DispatchInputs | null,
    info: StateInfo,
): void {
    for (const binding of bindGroup.bindings) {
        switch (binding.kind) {
            case 'uniform':
                updateUniformBinding(bufferCache, device, binding, frame, data, null, usesDynamicOffset(binding.block), info);
                break;

            case 'storage':
                updateStorageBinding(bufferCache, device, binding, data, null, inputs?.buffers ?? null);
                break;

            case 'texture':
                updateTextureBinding(textureCache, device, binding, data, null, inputs);
                break;

            case 'storageTexture':
                updateStorageTextureBinding(textureCache, device, binding, data, null, inputs);
                break;

            case 'sampler':
                updateSamplerBinding(samplerCache, device, binding, data);
                break;
        }
    }
}
