import type { UniformGroupBlock } from '../nodes/builder';
import type { Texture } from '../texture/texture';
import type {
    BindGroup,
    SamplerBinding,
    TextureBinding,
    UniformBinding,
} from './bind-group';
import {
    createBindGroupLayoutCache,
    getBindGroupLayout,
    type BindGroupLayoutCache,
} from './bindgroups';
import type { BufferCache } from './buffers';
import { getRaw, uploadRaw, uploadStorage } from './buffers';
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
    /** GPU device reference. */
    device: GPUDevice;

    /** Buffer cache for uniform buffer uploads. */
    bufferCache: BufferCache;

    /** Texture cache for texture/sampler access. */
    textureCache: TextureCache;

    /** Bind group layout cache (shared across all bind groups). */
    layoutCache: BindGroupLayoutCache;

    /**
     * Per-BindGroup data.
     * Keyed by BindGroup object identity - shared groups share data.
     */
    data: WeakMap<BindGroup, BindGroupData>;
};

/** Create a new Bindings state */
export function createBindingsState(
    device: GPUDevice,
    bufferCache: BufferCache,
    textureCache: TextureCache,
): BindingsState {
    return {
        device,
        bufferCache,
        textureCache,
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
 *
 * @param state - The Bindings state
 * @param renderObject - The RenderObject to update
 * @param frame - NodeFrame with camera, time, object, etc.
 */
export function updateBindings(
    state: BindingsState,
    renderObject: RenderObject,
    frame: NodeFrame,
): void {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) return;

    // Get BindGroups for this RenderObject (shared groups reused, non-shared cloned)
    const bindGroups = getRenderObjectBindings(renderObject);

    // Update each BindGroup
    const gpuBindGroups: GPUBindGroup[] = [];

    for (const bindGroup of bindGroups) {
        // Initialize bind group layout if needed
        initBindGroup(state, bindGroup, nodeState);

        // Update uniforms and check if bind group needs rebuild
        updateBindGroup(state, bindGroup, renderObject, frame);

        // Rebuild GPU bind group if needed
        const data = getData(state, bindGroup);
        if (data.needsUpdate || !data.bindGroup) {
            rebuildGPUBindGroup(state, bindGroup, data);
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
 * @param state - The Bindings state
 * @param renderObject - The RenderObject to initialize
 */
export function initBindings(
    state: BindingsState,
    renderObject: RenderObject,
): void {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) return;

    // Get BindGroups for this RenderObject
    const bindGroups = getRenderObjectBindings(renderObject);

    // Initialize each BindGroup
    for (const bindGroup of bindGroups) {
        initBindGroup(state, bindGroup, nodeState);
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
    _nodeState: NodeBuilderState,
): void {
    const data = getData(state, bindGroup);

    // already initialized
    if (data.bindGroupLayout) return;

    // build bind group layout entries
    const entries = buildLayoutEntries(bindGroup);

    // get or create the layout
    data.bindGroupLayout = getBindGroupLayout(state.layoutCache, state.device, entries);
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
function updateBindGroup(
    state: BindingsState,
    bindGroup: BindGroup,
    _renderObject: RenderObject,
    frame: NodeFrame,
): void {
    const data = getData(state, bindGroup);

    for (const binding of bindGroup.bindings) {
        switch (binding.kind) {
            case 'uniform':
                updateUniformBinding(state, binding, bindGroup, frame, data);
                break;

            case 'texture':
                updateTextureBinding(state, binding, data);
                break;

            case 'sampler':
                updateSamplerBinding(state, binding, data);
                break;

            case 'storage':
                // NOTE: storage buffers are uploaded via uploadStorage in rebuildGPUBindGroup
                break;
        }
    }
}

/** Update a uniform binding */
function updateUniformBinding(
    state: BindingsState,
    binding: UniformBinding,
    _bindGroup: BindGroup,
    frame: NodeFrame,
    data: BindGroupData,
): void {
    const block = binding.block;

    // Version gate: skip if this binding was already processed at the current group version.
    // Only applies to shared groups (renderGroup, frameGroup) where all RenderObjects share
    // the same binding object - the first one to process it sets lastProcessedVersion and
    // all others skip. Per-object groups are processed every time since their content
    // changes per-mesh (matrix, material uniforms).
    if (block.groupNode.shared) {
        const groupVersion = block.groupNode.version;
        if (binding.lastProcessedVersion === groupVersion) {
            return;
        }
        binding.lastProcessedVersion = groupVersion;
    }

    // invoke update callbacks with the NodeFrame
    invokeUniformGroupCallbacks(block, frame);

    // compute version sum
    let versionSum = 0;
    if (block.groupName === 'object') {
        // include mesh matrix version for object group
        versionSum = frame.object?.matrixVersion ?? 0;
    }
    for (const m of block.members) {
        versionSum += m.node.version;
    }

    // upload if changed
    if (versionSum !== binding.versionSum) {
        // create buffer key if needed
        if (!binding.bufferKey) {
            binding.bufferKey = {};
        }

        const packed = packUniformGroup(block);
        const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
        uploadRaw(state.bufferCache, binding.bufferKey, packed, U);

        binding.versionSum = versionSum;
        data.needsUpdate = true;
    }
}

/** Update a texture binding. */
function updateTextureBinding(
    state: BindingsState,
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
        const texData = updateTexture(state.textureCache, texture);

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
    state: BindingsState,
    binding: SamplerBinding,
    data: BindGroupData,
): void {
    const textureNode = binding.entry.textureNode;
    const value = textureNode.value;

    if (value === null) return;

    if (!value.isRenderTargetTexture && !value.isDepthTexture) {
        // It's a user Texture - get/create sampler via texture cache
        const texture = value as Texture;
        const sampler = getSampler(state.textureCache, texture);

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

/** Rebuild the GPU bind group for a BindGroup */
function rebuildGPUBindGroup(
    state: BindingsState,
    bindGroup: BindGroup,
    data: BindGroupData,
): void {
    if (!data.bindGroupLayout) return;

    const entries: GPUBindGroupEntry[] = [];

    for (const binding of bindGroup.bindings) {
        switch (binding.kind) {
            case 'uniform': {
                if (binding.bufferKey) {
                    const buffer = getRaw(state.bufferCache, binding.bufferKey);
                    if (buffer) {
                        entries.push({ binding: binding.block.binding, resource: { buffer } });
                    }
                }
                break;
            }

            case 'storage': {
                const buf = uploadStorage(state.bufferCache, binding.entry.node);
                entries.push({ binding: binding.entry.binding, resource: { buffer: buf } });
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
        data.bindGroup = state.device.createBindGroup({
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
 */
export function packUniformGroup(block: UniformGroupBlock): Float32Array {
    const buf = new Float32Array(Math.ceil(block.totalBytes / 4));
    const bytes = new Uint8Array(buf.buffer);

    for (const m of block.members) {
        const value = m.node.value;
        if (value === null || value === undefined) continue;

        const offset = m.offset;

        if (m.type === 'mat3x3f') {
            // mat3x3f in uniform space: 3 columns × vec4 (padded) = 48 bytes
            // Input is a flat mat3 (9 floats), output is 12 floats with padding
            const src = value instanceof Float32Array ? value : new Float32Array(value as number[]);
            const f32Offset = offset / 4;
            // Column 0
            buf[f32Offset + 0] = src[0]; buf[f32Offset + 1] = src[1]; buf[f32Offset + 2] = src[2]; buf[f32Offset + 3] = 0;
            // Column 1
            buf[f32Offset + 4] = src[3]; buf[f32Offset + 5] = src[4]; buf[f32Offset + 6] = src[5]; buf[f32Offset + 7] = 0;
            // Column 2
            buf[f32Offset + 8] = src[6]; buf[f32Offset + 9] = src[7]; buf[f32Offset + 10] = src[8]; buf[f32Offset + 11] = 0;
        } else if (typeof value === 'number') {
            new DataView(bytes.buffer).setFloat32(offset, value, true);
        } else if (value instanceof Float32Array) {
            bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), offset);
        } else if (Array.isArray(value)) {
            const fa = new Float32Array(value);
            bytes.set(new Uint8Array(fa.buffer), offset);
        }
    }

    return buf;
}
