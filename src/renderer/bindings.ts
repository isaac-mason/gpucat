import type { UniformGroupBlock } from '../nodes/builder';
import type { GpuBuffer } from '../core/gpu-buffer';
import type { Geometry } from '../geometry/geometry';
import type { Material } from '../material/material';
import type { Any } from '../schema/schema';
import type {
    BindGroup,
    SamplerBinding,
    StorageBinding,
    StorageTextureBinding,
    TextureBinding,
    UniformBinding,
} from './bind-group';
import {
    createBindGroupLayoutCache,
    getBindGroupLayout,
    type BindGroupLayoutCache,
} from './bind-group-layout';
import type { BufferCache } from './buffers';
import { getRaw, uploadRaw, ensureUploaded, getUploaded, resolveStorageBuffer } from './buffers';
import type { NodeBuilderState } from './node-builder-state';
import type { NodeFrame } from './node-frame';
import type { RenderObject } from './render-object';
import { getBindings as getRenderObjectBindings } from './render-object';
import type { TextureCache } from './textures';
import { getSampler, updateTexture, getTextureData, ensureRenderTargetTexturesAllocated } from './textures';
import { packToView } from '../schema/pack';

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
export function createBindingsState(): BindingsState {
    return {
        layoutCache: createBindGroupLayoutCache(),
        data: new WeakMap(),
    };
}

/**
 * Derive GPUTextureBindingLayout from the WGSL type string.
 * Maps texture type names to the correct sampleType and viewDimension.
 */
function getTextureLayoutFromType(wgslType: string): GPUTextureBindingLayout {
    const layout: GPUTextureBindingLayout = {};

    // View dimension
    if (wgslType.includes('cube_array')) {
        layout.viewDimension = 'cube-array';
    } else if (wgslType.includes('cube')) {
        layout.viewDimension = 'cube';
    } else if (wgslType.includes('2d_array')) {
        layout.viewDimension = '2d-array';
    } else if (wgslType.includes('3d')) {
        layout.viewDimension = '3d';
    }
    // default is '2d'

    // Sample type
    if (wgslType.startsWith('texture_depth')) {
        layout.sampleType = 'depth';
    }
    // default is 'float'

    return layout;
}

/** Map a storage texture WGSL dimension tag to a GPU view dimension. */
function storageViewDimension(dim: '1d' | '2d' | '2d_array' | '3d'): GPUTextureViewDimension {
    switch (dim) {
        case '1d': return '1d';
        case '2d_array': return '2d-array';
        case '3d': return '3d';
        default: return '2d';
    }
}

/** Map a WGSL storage access keyword to the bind-group-layout access enum. */
function storageLayoutAccess(access: 'read' | 'write' | 'read_write'): GPUStorageTextureAccess {
    switch (access) {
        case 'write': return 'write-only';
        case 'read_write': return 'read-write';
        default: return 'read-only';
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
            bindGroup: null,
            bindGroupLayout: null,
            needsUpdate: true,
        };
        state.data.set(bindGroup, data);
    }
    return data;
}

/** Update all bindings for a RenderObject. */
export function updateRenderBindings(
    state: BindingsState,
    renderObject: RenderObject,
    frame: NodeFrame,
    device: GPUDevice,
    bufferCache: BufferCache,
    textureCache: TextureCache,
): void {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) return;

    // Get BindGroups for this RenderObject (shared groups reused, non-shared cloned)
    const bindGroups = getRenderObjectBindings(renderObject);

    // Update each BindGroup
    const gpuBindGroups: GPUBindGroup[] = [];

    for (const bindGroup of bindGroups) {
        // Initialize bind group layout if needed
        initBindGroup(state, bindGroup, device, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT);

        // Update uniforms and check if bind group needs rebuild
        const data = getData(state, bindGroup);
        updateRenderBindGroup(data, bindGroup, renderObject, frame, device, bufferCache, textureCache);
        if (data.needsUpdate || !data.bindGroup) {
            rebuildGPUBindGroup(device, bufferCache, textureCache, bindGroup, data, renderObject.geometry, null);
            data.needsUpdate = false;
        }

        if (data.bindGroup) {
            gpuBindGroups.push(data.bindGroup);
        }
    }

    // Store on RenderObject
    renderObject.bindGroups = gpuBindGroups;
}

/** Update all bindings for a compute pass and return GPUBindGroups. */
export function updateComputeBindings(
    state: BindingsState,
    nodeBuilderState: NodeBuilderState,
    frame: NodeFrame,
    device: GPUDevice,
    bufferCache: BufferCache,
    textureCache: TextureCache,
    buffers: Record<string, GpuBuffer<Any>> | null,
): GPUBindGroup[] {
    const gpuBindGroups: GPUBindGroup[] = [];

    for (const bindGroup of nodeBuilderState.bindings) {
        // Initialize bind group layout if needed
        initBindGroup(state, bindGroup, device, GPUShaderStage.COMPUTE);

        // Update bindings
        const data = getData(state, bindGroup);
        updateComputeBindGroup(data, bufferCache, textureCache, device, bindGroup, frame, buffers);

        // Rebuild GPU bind group if needed
        if (data.needsUpdate || !data.bindGroup) {
            rebuildGPUBindGroup(device, bufferCache, textureCache, bindGroup, data, null, buffers);
            data.needsUpdate = false;
        }

        if (data.bindGroup) {
            gpuBindGroups.push(data.bindGroup);
        }
    }

    return gpuBindGroups;
}

/** Initialize bindings for a RenderObject. */
export function initRenderBindings(
    state: BindingsState,
    renderObject: RenderObject,
    device: GPUDevice,
): void {
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
): GPUBindGroupLayout[] {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) return [];

    // Get BindGroups for this RenderObject
    const bindGroups = getRenderObjectBindings(renderObject);

    // Build layouts array - array index matches @group(N) since groups are sorted
    const layouts: GPUBindGroupLayout[] = [];
    for (const bindGroup of bindGroups) {
        const data = getData(state, bindGroup);
        if (data.bindGroupLayout) {
            layouts.push(data.bindGroupLayout);
        }
    }

    return layouts;
}

/** Get bind group layouts for a compute pass. Used for pipeline creation. */
export function getComputeBindGroupLayouts(
    state: BindingsState,
    nodeBuilderState: NodeBuilderState,
    device: GPUDevice,
): GPUBindGroupLayout[] {
    const layouts: GPUBindGroupLayout[] = [];

    for (const bindGroup of nodeBuilderState.bindings) {
        // Initialize bind group layout if needed
        initBindGroup(state, bindGroup, device, GPUShaderStage.COMPUTE);

        const data = getData(state, bindGroup);
        if (data.bindGroupLayout) {
            layouts.push(data.bindGroupLayout);
        }
    }

    return layouts;
}

/** Get the bind groups for a RenderObject. */
export function getRenderBindGroups(
    state: BindingsState,
    renderObject: RenderObject,
): GPUBindGroup[] {
    const bindGroups = getRenderObjectBindings(renderObject);

    const gpuBindGroups: GPUBindGroup[] = [];
    for (const bindGroup of bindGroups) {
        const data = state.data.get(bindGroup);
        if (data?.bindGroup) {
            gpuBindGroups.push(data.bindGroup);
        }
    }

    return gpuBindGroups;
}

/** Delete bindings for a RenderObject. */
export function deleteRenderBindings(
    _state: BindingsState,
    renderObject: RenderObject,
): void {
    // Note: We don't need to explicitly delete from WeakMap - GC handles it.
    // When the BindGroup objects are GC'd, the WeakMap entries are removed.
    // We just clear the RenderObject's reference.
    renderObject.bindGroups = null;
    renderObject._bindings = null;
}

/** Mark a RenderObject's bindings as needing rebuild. */
export function invalidateRenderBindings(
    state: BindingsState,
    renderObject: RenderObject,
): void {
    const bindings = renderObject._bindings;
    if (!bindings) return;

    for (const bindGroup of bindings) {
        const data = state.data.get(bindGroup);
        if (data) {
            data.needsUpdate = true;
        }
    }
}

/** Initialize a BindGroup (create layout). Called once per BindGroup. */
function initBindGroup(
    state: BindingsState,
    bindGroup: BindGroup,
    device: GPUDevice,
    visibility: GPUShaderStageFlags,
): void {
    const data = getData(state, bindGroup);

    // already initialized
    if (data.bindGroupLayout) return;

    // build bind group layout entries
    const entries = buildLayoutEntries(bindGroup, visibility);

    // get or create the layout
    data.bindGroupLayout = getBindGroupLayout(state.layoutCache, device, entries);
}

/** Build bind group layout entries for a BindGroup. */
function buildLayoutEntries(
    bindGroup: BindGroup,
    visibility: GPUShaderStageFlags,
): GPUBindGroupLayoutEntry[] {
    const entries: GPUBindGroupLayoutEntry[] = [];

    for (const binding of bindGroup.bindings) {
        switch (binding.kind) {
            case 'uniform':
                entries.push({
                    binding: binding.block.binding,
                    visibility,
                    buffer: { type: 'uniform' },
                });
                break;

            case 'storage':
                entries.push({
                    binding: binding.entry.binding,
                    visibility,
                    buffer: {
                        type: binding.entry.access === 'read_write'
                            ? 'storage'
                            : 'read-only-storage',
                    },
                });
                break;

            case 'texture': {
                const texLayout = getTextureLayoutFromType(binding.entry.type);
                entries.push({
                    binding: binding.entry.binding,
                    visibility,
                    texture: texLayout,
                });
                break;
            }

            case 'storageTexture': {
                entries.push({
                    binding: binding.entry.binding,
                    visibility,
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
                    visibility,
                    sampler: {
                        type: binding.entry.type === 'sampler_comparison' ? 'comparison' : 'filtering',
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
): void {
    for (const binding of bindGroup.bindings) {
        switch (binding.kind) {
            case 'uniform':
                updateUniformBinding(bufferCache, device, binding, frame, data, renderObject.material);
                break;

            case 'texture':
                updateTextureBinding(textureCache, device, binding, data);
                break;

            case 'storageTexture':
                updateStorageTextureBinding(textureCache, device, binding, data);
                break;

            case 'sampler':
                updateSamplerBinding(textureCache, device, binding, data);
                break;

            case 'storage':
                updateStorageBinding(bufferCache, device, binding, data, renderObject.geometry, null);
                break;
        }
    }
}

/** Update a uniform binding */
function updateUniformBinding(
    bufferCache: BufferCache,
    device: GPUDevice,
    binding: UniformBinding,
    frame: NodeFrame,
    data: BindGroupData,
    material: Material | null = null,
): void {
    const block = binding.block;

    // Deduplication gate: skip if this binding was already processed at the current frame/render ID.
    // Based on group.updateType:
    //   'frame'  - check frameId (once per animation frame)
    //   'render' - check renderId (once per render() call)
    //   'object' - always process (content changes per-mesh)
    //   'none'   - always process
    if (block.group.shared) {
        const updateType = block.group.updateType;
        if (updateType === 'frame') {
            if (binding.lastFrameId === frame.frameId) return;
            binding.lastFrameId = frame.frameId;
        } else if (updateType === 'render') {
            if (binding.lastRenderId === frame.renderId) return;
            binding.lastRenderId = frame.renderId;
        }
        // 'object' and 'none' always process
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

    // Pack into scratch buffer, then compare with current
    const changed = packAndCompare(block, binding.currentBuffer, binding.scratchBuffer!, material);
    const uploaded = !!getRaw(bufferCache, binding.bufferKey);

    if (changed || !uploaded) {
        if (changed) {
            // Swap buffers: scratch becomes current
            const temp = binding.currentBuffer;
            binding.currentBuffer = binding.scratchBuffer!;
            binding.scratchBuffer = temp;
        }

        const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
        const f32View = new Float32Array(binding.currentBuffer);
        const result = uploadRaw(bufferCache, device, binding.bufferKey, f32View, U);

        // Only rebuild bind group if buffer was created/resized (not just written to)
        if (result.created) {
            data.needsUpdate = true;
        }
    }
}

/**
 * Pack uniforms into scratch buffer and compare against current buffer.
 * Uses compiled layout for correct WGSL alignment.
 * Returns true if any values changed.
 */
function packAndCompare(
    block: UniformGroupBlock,
    currentBuffer: ArrayBuffer,
    scratchBuffer: ArrayBuffer,
    material: Material | null,
): boolean {
    const view = new DataView(scratchBuffer);

    // Pack each uniform member using compiled layout
    for (const m of block.members) {
        let value = m.node.uniform.value;
        if (value === null && material) {
            const matUniform = material.uniforms.get(m.node.name);
            if (matUniform) {
                value = matUniform.value;
            }
        }
        if (value === null || value === undefined) continue;

        // Cast needed: UniformValue is broader than Infer<schema> but matches at runtime
        packToView(m.schema, view, m.offset, value as never, 'uniform');
    }

    // Compare buffers byte-by-byte using typed arrays
    const current = new Uint32Array(currentBuffer);
    const scratch = new Uint32Array(scratchBuffer);
    const len = current.length;
    for (let i = 0; i < len; i++) {
        if (current[i] !== scratch[i]) {
            return true;
        }
    }
    return false;
}

/** Update a texture binding. */
function updateTextureBinding(
    textureCache: TextureCache,
    device: GPUDevice,
    binding: TextureBinding,
    data: BindGroupData,
): void {
    const textureNode = binding.entry.node;
    const gpuTexture = textureNode.value;

    if (gpuTexture === null) return;

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
        }
    }
}

/** Update a storage texture binding — ensure GPU texture exists, detect changes. */
function updateStorageTextureBinding(
    textureCache: TextureCache,
    device: GPUDevice,
    binding: StorageTextureBinding,
    data: BindGroupData,
): void {
    const gpuTexture = binding.entry.node.value;
    if (gpuTexture === null) return;

    // Storage textures hold no source data; updateTexture just ensures the GPU
    // texture exists and returns its cache entry (with a generation counter).
    const texData = updateTexture(textureCache, device, gpuTexture);
    if (binding.generation !== texData.generation) {
        binding.generation = texData.generation;
        data.needsUpdate = true;
    }
}

/** Update a sampler binding. */
function updateSamplerBinding(
    textureCache: TextureCache,
    device: GPUDevice,
    binding: SamplerBinding,
    data: BindGroupData,
): void {
    const samplerNode = binding.entry.samplerNode;
    const gpuSampler = samplerNode.value;
    
    // Create/get sampler from GpuSampler settings (this caches by settingsKey)
    getSampler(textureCache, device, gpuSampler);
    
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
    geometry: Geometry | null,
    buffers: Record<string, GpuBuffer<Any>> | null,
): void {
    const node = binding.entry.node;
    const buffer = resolveStorageBuffer(node, geometry, buffers);

    // If buffer identity changed, need to rebuild bind group
    if (buffer !== binding.lastBuffer) {
        binding.lastBuffer = buffer;
        data.needsUpdate = true;
    }

    // Flush pending data to GPU (version check / partial ranges handled inside)
    ensureUploaded(bufferCache, device, buffer);
}

/** Rebuild the GPU bind group for a BindGroup */
function rebuildGPUBindGroup(
    device: GPUDevice,
    bufferCache: BufferCache,
    textureCache: TextureCache,
    bindGroup: BindGroup,
    data: BindGroupData,
    geometry: Geometry | null,
    buffers: Record<string, GpuBuffer<Any>> | null,
): void {
    if (!data.bindGroupLayout) return;

    const entries: GPUBindGroupEntry[] = [];

    for (const binding of bindGroup.bindings) {
        switch (binding.kind) {
            case 'uniform': {
                if (binding.bufferKey) {
                    const buffer = getRaw(bufferCache, binding.bufferKey);
                    if (buffer) {
                        entries.push({ binding: binding.block.binding, resource: { buffer } });
                    }
                }
                break;
            }

            case 'storage': {
                const buffer = resolveStorageBuffer(binding.entry.node, geometry, buffers);
                const buf = getUploaded(bufferCache, buffer);
                if (buf) {
                    entries.push({ binding: binding.entry.binding, resource: { buffer: buf } });
                }
                break;
            }

            case 'texture': {
                const textureNode = binding.entry.node;
                const gpuTexture = textureNode.value;
                if (!gpuTexture) break;
                
                // Get GPU texture from cache
                const texData = getTextureData(textureCache, gpuTexture);
                if (texData) {
                    const view = texData.texture.createView({ dimension: gpuTexture.viewDimension });
                    entries.push({ binding: binding.entry.binding, resource: view });
                }
                break;
            }

            case 'storageTexture': {
                const gpuTexture = binding.entry.node.value;
                if (!gpuTexture) break;

                const texData = getTextureData(textureCache, gpuTexture);
                if (texData) {
                    // Storage views target a single mip level at the node's chosen baseMipLevel.
                    const view = texData.texture.createView({
                        dimension: storageViewDimension(binding.entry.dim),
                        baseMipLevel: binding.entry.node.mipLevel,
                        mipLevelCount: 1,
                    });
                    entries.push({ binding: binding.entry.binding, resource: view });
                }
                break;
            }

            case 'sampler': {
                const samplerNode = binding.entry.samplerNode;
                const gpuSampler = samplerNode.value;
                if (!gpuSampler) break;
                
                // Get GPU sampler from cache using settingsKey
                const samplerData = textureCache.samplerCache.get(gpuSampler.settingsKey);
                if (samplerData) {
                    entries.push({ binding: binding.entry.binding, resource: samplerData.sampler });
                }
                break;
            }
        }
    }

    // Sort entries by binding
    entries.sort((a, b) => a.binding - b.binding);

    if (entries.length > 0) {
        data.bindGroup = device.createBindGroup({
            layout: data.bindGroupLayout,
            entries,
        });
    }
}

/** Invoke update callbacks on uniform nodes in a group. */
export function invokeUniformGroupCallbacks(
    block: UniformGroupBlock,
    frame: NodeFrame,
): void {
    for (const m of block.members) {
        const node = m.node;
        if (node.update) {
            // Use NodeFrame's updateNode which respects updateType and deduplicates:
            // - FRAME: runs once per frameId
            // - RENDER: runs once per renderId  
            // - OBJECT: runs every time (per mesh)
            // The callback itself assigns node.value and bumps node.version (see UniformNode.onUpdate)
            frame.updateNode(node as unknown as Parameters<typeof frame.updateNode>[0]);
        }
    }
}

/** Update a compute BindGroup (uniforms, textures, samplers, storage). */
function updateComputeBindGroup(
    data: BindGroupData,
    bufferCache: BufferCache,
    textureCache: TextureCache,
    device: GPUDevice,
    bindGroup: BindGroup,
    frame: NodeFrame,
    buffers: Record<string, GpuBuffer<Any>> | null,
): void {
    for (const binding of bindGroup.bindings) {
        switch (binding.kind) {
            case 'uniform':
                updateUniformBinding(bufferCache, device, binding, frame, data);
                break;

            case 'storage':
                updateStorageBinding(bufferCache, device, binding, data, null, buffers);
                break;

            case 'texture':
                updateTextureBinding(textureCache, device, binding, data);
                break;

            case 'storageTexture':
                updateStorageTextureBinding(textureCache, device, binding, data);
                break;

            case 'sampler':
                updateSamplerBinding(textureCache, device, binding, data);
                break;
        }
    }
}
