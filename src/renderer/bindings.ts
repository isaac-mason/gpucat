import type { UniformGroupBlock } from '../nodes/builder';
import type { Geometry } from '../geometry/geometry';
import type { Material } from '../material/material';
import type { Texture } from '../texture/texture';
import type {
    BindGroup,
    SamplerBinding,
    StorageBinding,
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
import { getSampler, updateTexture } from './textures';

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

// ---------------------------------------------------------------------------
// Main API (Three.js aligned)
// ---------------------------------------------------------------------------

/**
 * Update all bindings for a RenderObject.
 *
 * Three.js pattern (Bindings.getForRender):
 * - Gets BindGroups from RenderObject.getBindings()
 * - For each BindGroup, calls _init() then _update()
 * - Builds GPU bind groups and stores them on RenderObject
 */
export function updateBindings(
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
        initBindGroup(state, bindGroup, device);

        // Update uniforms and check if bind group needs rebuild
        const data = getData(state, bindGroup);
        updateBindGroupForRender(data, bindGroup, renderObject, frame, device, bufferCache, textureCache);
        if (data.needsUpdate || !data.bindGroup) {
            rebuildGPUBindGroup(device, bufferCache, bindGroup, data, renderObject.geometry);
            data.needsUpdate = false;
        }

        if (data.bindGroup) {
            gpuBindGroups.push(data.bindGroup);
        }
    }

    // Store on RenderObject
    renderObject.bindGroups = gpuBindGroups;
}

/**
 * Initialize bindings for a RenderObject.
 */
export function initBindings(
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
        initBindGroup(state, bindGroup, device);
    }
}

/** Get the bind group layouts for a RenderObject. Used for pipeline creation */
export function getBindGroupLayouts(
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

/** Get the bind groups for a RenderObject */
export function getBindGroups(
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

/** Delete bindings for a RenderObject */
export function deleteBindings(
    _state: BindingsState,
    renderObject: RenderObject,
): void {
    // Note: We don't need to explicitly delete from WeakMap - GC handles it.
    // When the BindGroup objects are GC'd, the WeakMap entries are removed.
    // We just clear the RenderObject's reference.
    renderObject.bindGroups = null;
    renderObject._bindings = null;
}

/** Mark a RenderObject's bindings as needing rebuild. Call this when textures or other resources change. */
export function invalidateBindings(
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
): void {
    const data = getData(state, bindGroup);

    // already initialized
    if (data.bindGroupLayout) return;

    // build bind group layout entries
    const entries = buildLayoutEntries(bindGroup);

    // get or create the layout
    data.bindGroupLayout = getBindGroupLayout(state.layoutCache, device, entries);
}

/** Build bind group layout entries for a BindGroup. */
function buildLayoutEntries(
    bindGroup: BindGroup,
): GPUBindGroupLayoutEntry[] {
    const vis = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const entries: GPUBindGroupLayoutEntry[] = [];

    for (const binding of bindGroup.bindings) {
        switch (binding.kind) {
            case 'uniform':
                entries.push({
                    binding: binding.block.binding,
                    visibility: vis,
                    buffer: { type: 'uniform' },
                });
                break;

            case 'storage':
                entries.push({
                    binding: binding.entry.binding,
                    visibility: vis,
                    buffer: { type: 'read-only-storage' },
                });
                break;

            case 'texture':
                entries.push({
                    binding: binding.entry.binding,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: {},
                });
                break;

            case 'sampler':
                entries.push({
                    binding: binding.entry.binding,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: {},
                });
                break;
        }
    }

    // Sort by binding index
    entries.sort((a, b) => a.binding - b.binding);

    return entries;
}

/** Update a BindGroup (uniforms, textures, etc.).  Called every frame */
function updateBindGroupForRender(
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

            case 'sampler':
                updateSamplerBinding(textureCache, device, binding, data);
                break;

            case 'storage':
                updateStorageBinding(bufferCache, device, binding, data, renderObject.geometry);
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
    // Based on groupNode.updateType:
    //   'frame'  - check frameId (once per animation frame)
    //   'render' - check renderId (once per render() call)
    //   'object' - always process (content changes per-mesh)
    //   'none'   - always process
    if (block.groupNode.shared) {
        const updateType = block.groupNode.updateType;
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

    // Pack uniforms and compare in a single pass.
    // Returns true if any value changed (needs upload).
    const { buffer, changed } = packAndCompare(block, binding.packedBuffer, material);

    if (changed) {
        binding.packedBuffer = buffer;

        const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
        const result = uploadRaw(bufferCache, device, binding.bufferKey, buffer, U);

        // Only rebuild bind group if buffer was created/resized (not just written to)
        if (result.created) {
            data.needsUpdate = true;
        }
    }
}

/**
 * Check if a WGSL type is a signed integer type.
 */
function isIntType(type: string): boolean {
    return type === 'i32' || type === 'vec2i' || type === 'vec3i' || type === 'vec4i';
}

/**
 * Check if a WGSL type is an unsigned integer type.
 */
function isUintType(type: string): boolean {
    return type === 'u32' || type === 'vec2u' || type === 'vec3u' || type === 'vec4u';
}

/**
 * Pack uniforms and compare against existing buffer in a single pass.
 * Returns the buffer and whether any values changed.
 * 
 * This is an optimization over separate pack + compare steps:
 * - Reuses existing buffer (no allocation if size matches)
 * - Compares while writing (early exit not possible, but avoids second loop)
 * - Single pass over members
 * 
 * Supports all WGSL uniform types: f32, i32, u32, vectors, and matrices.
 * For integer types, we create Int32Array/Uint32Array views over the same
 * ArrayBuffer (Three.js approach).
 */
function packAndCompare(
    block: UniformGroupBlock,
    existingBuffer: Float32Array | null,
    material: Material | null,
): { buffer: Float32Array; changed: boolean } {
    const requiredLength = Math.ceil(block.totalBytes / 4);

    // First frame or size changed - need new buffer, definitely changed
    if (!existingBuffer || existingBuffer.length !== requiredLength) {
        return { buffer: packUniformGroup(block, null, material), changed: true };
    }

    // Create typed views over the same underlying ArrayBuffer for different data types
    const f32 = existingBuffer;
    const i32 = new Int32Array(f32.buffer);
    const u32 = new Uint32Array(f32.buffer);
    let changed = false;

    for (const m of block.members) {
        let value = m.node.uniform.value;
        if (value === null && material) {
            const matUniform = material.uniforms.get(m.node.name);
            if (matUniform) {
                value = matUniform.value;
            }
        }
        if (value === null || value === undefined) continue;

        const idx = m.offset / 4; // All offsets are 4-byte aligned
        const type = m.type;

        if (type === 'mat3x3f') {
            // mat3x3f in uniform space: 3 columns × vec4 (padded) = 48 bytes
            const src = value as Float32Array | number[];
            // Column 0
            if (f32[idx + 0] !== src[0]) { f32[idx + 0] = src[0]; changed = true; }
            if (f32[idx + 1] !== src[1]) { f32[idx + 1] = src[1]; changed = true; }
            if (f32[idx + 2] !== src[2]) { f32[idx + 2] = src[2]; changed = true; }
            if (f32[idx + 3] !== 0) { f32[idx + 3] = 0; changed = true; }
            // Column 1
            if (f32[idx + 4] !== src[3]) { f32[idx + 4] = src[3]; changed = true; }
            if (f32[idx + 5] !== src[4]) { f32[idx + 5] = src[4]; changed = true; }
            if (f32[idx + 6] !== src[5]) { f32[idx + 6] = src[5]; changed = true; }
            if (f32[idx + 7] !== 0) { f32[idx + 7] = 0; changed = true; }
            // Column 2
            if (f32[idx + 8] !== src[6]) { f32[idx + 8] = src[6]; changed = true; }
            if (f32[idx + 9] !== src[7]) { f32[idx + 9] = src[7]; changed = true; }
            if (f32[idx + 10] !== src[8]) { f32[idx + 10] = src[8]; changed = true; }
            if (f32[idx + 11] !== 0) { f32[idx + 11] = 0; changed = true; }
        } else if (isIntType(type)) {
            // Signed integer types: i32, vec2i, vec3i, vec4i
            if (typeof value === 'number') {
                if (i32[idx] !== value) { i32[idx] = value; changed = true; }
            } else {
                const src = value as Int32Array | number[];
                const len = src.length;
                for (let i = 0; i < len; i++) {
                    if (i32[idx + i] !== src[i]) { i32[idx + i] = src[i]; changed = true; }
                }
            }
        } else if (isUintType(type)) {
            // Unsigned integer types: u32, vec2u, vec3u, vec4u
            if (typeof value === 'number') {
                if (u32[idx] !== value) { u32[idx] = value; changed = true; }
            } else {
                const src = value as Uint32Array | number[];
                const len = src.length;
                for (let i = 0; i < len; i++) {
                    if (u32[idx + i] !== src[i]) { u32[idx + i] = src[i]; changed = true; }
                }
            }
        } else {
            // Float types: f32, vec2f, vec3f, vec4f, mat4x4f, etc.
            if (typeof value === 'number') {
                if (f32[idx] !== value) { f32[idx] = value; changed = true; }
            } else {
                const src = value as Float32Array | number[];
                const len = src.length;
                for (let i = 0; i < len; i++) {
                    if (f32[idx + i] !== src[i]) { f32[idx + i] = src[i]; changed = true; }
                }
            }
        }
    }

    return { buffer: f32, changed };
}

/** Update a texture binding. */
function updateTextureBinding(
    textureCache: TextureCache,
    device: GPUDevice,
    binding: TextureBinding,
    data: BindGroupData,
): void {
    const textureNode = binding.entry.node;
    const value = textureNode.value;

    if (value === null) return;

    // Check if it's a RenderTargetTexture or DepthTexture
    // These are handled by the RenderTarget system
    if (!value.isRenderTargetTexture && !value.isDepthTexture) {
        // It's a user Texture with image data
        const texture = value as Texture;
        const texData = updateTexture(textureCache, device, texture);

        // Update the node with GPU resources
        textureNode.resource = texData.texture;

        // Check for texture changes
        if (binding.generation !== texData.generation) {
            binding.generation = texData.generation;
            data.needsUpdate = true;
        }
    } else {
        // Render target textures - check gpuTexture directly
        // When RenderTarget.setSize() is called, it destroys old textures and creates new ones.
        // We detect this by comparing the current gpuTexture to the last one we saw.
        const gpuTexture = value.gpuTexture;
        if (gpuTexture !== binding.lastGpuTexture) {
            binding.lastGpuTexture = gpuTexture;
            data.needsUpdate = true;
        }
    }
}

/** Update a sampler binding. */
function updateSamplerBinding(
    textureCache: TextureCache,
    device: GPUDevice,
    binding: SamplerBinding,
    data: BindGroupData,
): void {
    const textureNode = binding.entry.textureNode;
    const value = textureNode.value;

    if (value === null) return;

    if (!value.isRenderTargetTexture && !value.isDepthTexture) {
        // It's a user Texture - get/create sampler via texture cache
        const texture = value as Texture;
        const sampler = getSampler(textureCache, device, texture);

        // Update the node with GPU sampler
        textureNode.gpuSampler = sampler;

        // Check for sampler changes (simple key based on texture id)
        const samplerKey = `${texture.id}`;
        if (binding.samplerKey !== samplerKey) {
            binding.samplerKey = samplerKey;
            data.needsUpdate = true;
        }
    } else {
        // Render target textures - check gpuSampler directly
        // When RenderTarget.setSize() is called, it may create new samplers.
        // We detect this by comparing the current gpuSampler pointer.
        const gpuSampler = value.gpuSampler;
        const samplerKey = gpuSampler ? `rt_${(gpuSampler as unknown as { label?: string }).label ?? 'sampler'}` : null;
        if (binding.samplerKey !== samplerKey) {
            binding.samplerKey = samplerKey;
            data.needsUpdate = true;
        }
    }
}

/** Update a storage binding - detect buffer swaps and flush data to GPU. */
function updateStorageBinding(
    bufferCache: BufferCache,
    device: GPUDevice,
    binding: StorageBinding,
    data: BindGroupData,
    geometry: Geometry | null,
): void {
    const node = binding.entry.node;
    const buffer = resolveStorageBuffer(node, geometry);

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
    bindGroup: BindGroup,
    data: BindGroupData,
    geometry: Geometry | null,
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
                const buffer = resolveStorageBuffer(binding.entry.node, geometry);
                const buf = getUploaded(bufferCache, buffer);
                if (buf) {
                    entries.push({ binding: binding.entry.binding, resource: { buffer: buf } });
                }
                break;
            }

            case 'texture': {
                const textureNode = binding.entry.node;
                let res = textureNode.resource;
                if (res === null && textureNode.value) {
                    res = textureNode.value.gpuTexture ?? null;
                }
                if (res) {
                    const view = res instanceof GPUTextureView ? res : (res as GPUTexture).createView();
                    entries.push({ binding: binding.entry.binding, resource: view });
                }
                break;
            }

            case 'sampler': {
                const textureNode = binding.entry.textureNode;
                let samp = textureNode.gpuSampler;
                if (samp === null && textureNode.value) {
                    samp = textureNode.value.gpuSampler ?? null;
                }
                if (samp) {
                    entries.push({ binding: binding.entry.binding, resource: samp });
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

/**
 * Pack a uniform group into a typed array.
 *
 * mat3x3f is handled specially: in WGSL uniform address space, each column is
 * padded to vec4 (16 bytes), so mat3x3f occupies 48 bytes (3 × 16).
 *
 * Supports all WGSL uniform types: f32, i32, u32, vectors, and matrices.
 * For integer types, we create Int32Array/Uint32Array views over the same
 * ArrayBuffer (Three.js approach).
 *
 * @param block - The uniform group block to pack
 * @param existingBuffer - Optional existing buffer to reuse (avoids allocation)
 * @param material - Optional material for name-based uniform resolution
 * @returns The packed Float32Array (may be the same as existingBuffer if size matches)
 */
export function packUniformGroup(
    block: UniformGroupBlock,
    existingBuffer: Float32Array | null = null,
    material: Material | null = null,
): Float32Array {
    const requiredLength = Math.ceil(block.totalBytes / 4);

    // Reuse existing buffer if it's the right size, otherwise allocate
    let f32: Float32Array;
    if (existingBuffer && existingBuffer.length === requiredLength) {
        f32 = existingBuffer;
    } else {
        f32 = new Float32Array(requiredLength);
    }

    // Create typed views over the same underlying ArrayBuffer for integer types
    const i32 = new Int32Array(f32.buffer);
    const u32 = new Uint32Array(f32.buffer);

    for (const m of block.members) {
        // Get value: first try direct value, then try name-based resolution from material
        let value = m.node.uniform.value;
        if (value === null && material) {
            const matUniform = material.uniforms.get(m.node.name);
            if (matUniform) {
                value = matUniform.value;
            }
        }
        if (value === null || value === undefined) continue;

        // All offsets are 4-byte aligned, so we can work in element indices
        const idx = m.offset / 4;
        const type = m.type;

        if (type === 'mat3x3f') {
            // mat3x3f in uniform space: 3 columns × vec4 (padded) = 48 bytes
            // Input is a flat mat3 (9 floats), output is 12 floats with padding
            const src = value as Float32Array | number[];
            // Column 0
            f32[idx + 0] = src[0]; f32[idx + 1] = src[1]; f32[idx + 2] = src[2]; f32[idx + 3] = 0;
            // Column 1
            f32[idx + 4] = src[3]; f32[idx + 5] = src[4]; f32[idx + 6] = src[5]; f32[idx + 7] = 0;
            // Column 2
            f32[idx + 8] = src[6]; f32[idx + 9] = src[7]; f32[idx + 10] = src[8]; f32[idx + 11] = 0;
        } else if (isIntType(type)) {
            // Signed integer types: i32, vec2i, vec3i, vec4i
            if (typeof value === 'number') {
                i32[idx] = value;
            } else {
                const src = value as Int32Array | number[];
                const len = src.length;
                for (let i = 0; i < len; i++) {
                    i32[idx + i] = src[i];
                }
            }
        } else if (isUintType(type)) {
            // Unsigned integer types: u32, vec2u, vec3u, vec4u
            if (typeof value === 'number') {
                u32[idx] = value;
            } else {
                const src = value as Uint32Array | number[];
                const len = src.length;
                for (let i = 0; i < len; i++) {
                    u32[idx + i] = src[i];
                }
            }
        } else {
            // Float types: f32, vec2f, vec3f, vec4f, mat4x4f, etc.
            if (typeof value === 'number') {
                f32[idx] = value;
            } else {
                const src = value as Float32Array | number[];
                const len = src.length;
                for (let i = 0; i < len; i++) {
                    f32[idx + i] = src[i];
                }
            }
        }
    }

    return f32;
}

// ---------------------------------------------------------------------------
// Compute Bindings API
// ---------------------------------------------------------------------------

/**
 * Update all bindings for a compute pass and return GPUBindGroups.
 */
export function updateForCompute(
    state: BindingsState,
    nodeBuilderState: NodeBuilderState,
    frame: NodeFrame,
    device: GPUDevice,
    bufferCache: BufferCache,
): GPUBindGroup[] {
    const gpuBindGroups: GPUBindGroup[] = [];

    for (const bindGroup of nodeBuilderState.bindings) {
        // Initialize bind group layout if needed (uses compute visibility)
        initComputeBindGroup(state, bindGroup, device);

        // Update uniforms
        const data = getData(state, bindGroup);
        updateComputeBindGroup(data, bufferCache, device, bindGroup, frame);

        // Rebuild GPU bind group if needed
        if (data.needsUpdate || !data.bindGroup) {
            rebuildGPUBindGroup(device, bufferCache, bindGroup, data, null);
            data.needsUpdate = false;
        }

        if (data.bindGroup) {
            gpuBindGroups.push(data.bindGroup);
        }
    }

    return gpuBindGroups;
}

/**
 * Get bind group layouts for a compute pass (for pipeline creation).
 */
export function getLayoutsForCompute(
    state: BindingsState,
    nodeBuilderState: NodeBuilderState,
    device: GPUDevice,
): GPUBindGroupLayout[] {
    const layouts: GPUBindGroupLayout[] = [];

    for (const bindGroup of nodeBuilderState.bindings) {
        // Initialize bind group layout if needed
        initComputeBindGroup(state, bindGroup, device);

        const data = getData(state, bindGroup);
        if (data.bindGroupLayout) {
            layouts.push(data.bindGroupLayout);
        }
    }

    return layouts;
}

/** Initialize a compute BindGroup (create layout with COMPUTE visibility). */
function initComputeBindGroup(
    state: BindingsState,
    bindGroup: BindGroup,
    device: GPUDevice,
): void {
    const data = getData(state, bindGroup);

    // already initialized
    if (data.bindGroupLayout) return;

    // build bind group layout entries with COMPUTE visibility
    const entries = buildComputeLayoutEntries(bindGroup);

    // get or create the layout
    data.bindGroupLayout = getBindGroupLayout(state.layoutCache, device, entries);
}

/** Build bind group layout entries for a compute BindGroup. */
function buildComputeLayoutEntries(
    bindGroup: BindGroup,
): GPUBindGroupLayoutEntry[] {
    const vis = GPUShaderStage.COMPUTE;
    const entries: GPUBindGroupLayoutEntry[] = [];

    for (const binding of bindGroup.bindings) {
        switch (binding.kind) {
            case 'uniform':
                entries.push({
                    binding: binding.block.binding,
                    visibility: vis,
                    buffer: { type: 'uniform' },
                });
                break;

            case 'storage':
                entries.push({
                    binding: binding.entry.binding,
                    visibility: vis,
                    buffer: {
                        type: binding.entry.access === 'read_write'
                            ? 'storage'
                            : 'read-only-storage',
                    },
                });
                break;

            case 'texture':
                entries.push({
                    binding: binding.entry.binding,
                    visibility: vis,
                    texture: {},
                });
                break;

            case 'sampler':
                entries.push({
                    binding: binding.entry.binding,
                    visibility: vis,
                    sampler: {},
                });
                break;
        }
    }

    // Sort by binding index
    entries.sort((a, b) => a.binding - b.binding);

    return entries;
}

/** Update a compute BindGroup (uniforms). */
function updateComputeBindGroup(
    data: BindGroupData,
    bufferCache: BufferCache,
    device: GPUDevice,
    bindGroup: BindGroup,
    frame: NodeFrame,
): void {
    for (const binding of bindGroup.bindings) {
        switch (binding.kind) {
            case 'uniform':
                updateUniformBinding(bufferCache, device, binding, frame, data);
                break;

            case 'storage':
                updateStorageBinding(bufferCache, device, binding, data, null);
                break;

            case 'texture':
            case 'sampler':
                throw new Error(`Texture/sampler bindings not yet supported for compute shaders`);
        }
    }
}
