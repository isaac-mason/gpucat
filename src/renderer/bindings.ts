/**
 * bindings.ts - Per-RenderObject bind group management.
 *
 * Aligned with Three.js Bindings class:
 * - Creates and caches GPUBindGroups per RenderObject
 * - Manages uniform buffers with version-based dirty tracking
 * - Handles storage buffers, textures, and samplers
 *
 * This system replaces the ad-hoc _renderGroupKeys and _objectGroupKeys
 * in the current renderer with a unified per-RenderObject approach.
 */

import type { RenderObject } from './render-object';
import type { NodeBuilderState } from './node-builder-state';
import type { BufferCache } from './buffers';
import type { TextureCache } from './textures';
import type { RenderUpdateContext, ObjectUpdateContext } from './render-frame';
import type { UniformGroupBlock } from '../nodes/compile';
import type { Camera } from '../camera/camera';
import { uploadStorage, uploadRaw, getRaw } from './buffers';
import {
    createBindGroupLayoutCache,
    getBindGroupLayout,
    type BindGroupLayoutCache,
} from './bindgroups';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-RenderObject binding data.
 */
export type BindingData = {
    /** GPU bind groups [render, object, ...]. */
    bindGroups: GPUBindGroup[];

    /** Bind group layouts for pipeline creation. */
    bindGroupLayouts: GPUBindGroupLayout[];

    /** Uniform buffer keys (for version tracking). */
    renderBufferKey: object | null;
    objectBufferKey: object | null;

    /** Version sums for dirty checking. */
    renderVersionSum: number;
    objectVersionSum: number;

    /** Whether bindings need rebuilding (textures changed, etc.). */
    needsBindGroupUpdate: boolean;
};

/**
 * Bindings state - manages per-RenderObject bind groups.
 */
export type BindingsState = {
    /** GPU device reference. */
    device: GPUDevice;

    /** Buffer cache for uniform buffer uploads. */
    bufferCache: BufferCache;

    /** Texture cache for texture/sampler access. */
    textureCache: TextureCache;

    /** Bind group layout cache (shared across all RenderObjects). */
    layoutCache: BindGroupLayoutCache;

    /** Per-RenderObject binding data. */
    data: WeakMap<RenderObject, BindingData>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new Bindings state.
 */
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

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize bindings for a RenderObject.
 *
 * This creates bind group layouts and initial bind groups based on the
 * NodeBuilderState. Must be called after the RenderObject has a NodeBuilderState.
 *
 * @param state - The Bindings state
 * @param renderObject - The RenderObject to initialize
 */
export function initBindings(
    state: BindingsState,
    renderObject: RenderObject,
): void {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) {
        throw new Error('[Bindings] Cannot init bindings without NodeBuilderState');
    }

    const data: BindingData = {
        bindGroups: [],
        bindGroupLayouts: [],
        renderBufferKey: null,
        objectBufferKey: null,
        renderVersionSum: -1,
        objectVersionSum: -1,
        needsBindGroupUpdate: true,
    };

    // Build bind group layouts
    buildBindGroupLayouts(state, nodeState, data);

    state.data.set(renderObject, data);
}

/**
 * Build bind group layouts from NodeBuilderState.
 */
function buildBindGroupLayouts(
    state: BindingsState,
    nodeState: NodeBuilderState,
    data: BindingData,
): void {
    const vis = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;

    // Group entries by group index
    const groupEntriesMap = new Map<number, GPUBindGroupLayoutEntry[]>();

    // Add uniform group entries
    for (const ug of nodeState.uniformGroups) {
        if (ug.members.length === 0) continue;
        groupEntriesMap.set(ug.groupIndex, [
            {
                binding: 0,
                visibility: vis,
                buffer: { type: 'uniform' },
            },
        ]);
    }

    // Add storage entries
    for (const s of nodeState.storage) {
        let entries = groupEntriesMap.get(s.group);
        if (!entries) {
            entries = [];
            groupEntriesMap.set(s.group, entries);
        }
        entries.push({
            binding: s.binding,
            visibility: vis,
            buffer: { type: 'read-only-storage' },
        });
    }

    // Add texture entries
    for (const t of nodeState.textures) {
        let entries = groupEntriesMap.get(t.group);
        if (!entries) {
            entries = [];
            groupEntriesMap.set(t.group, entries);
        }
        entries.push({
            binding: t.binding,
            visibility: GPUShaderStage.FRAGMENT,
            texture: {},
        });
    }

    // Add sampler entries
    for (const s of nodeState.samplers) {
        let entries = groupEntriesMap.get(s.group);
        if (!entries) {
            entries = [];
            groupEntriesMap.set(s.group, entries);
        }
        entries.push({
            binding: s.binding,
            visibility: GPUShaderStage.FRAGMENT,
            sampler: {},
        });
    }

    // Create layouts in sorted order
    const sortedIndices = [...groupEntriesMap.keys()].sort((a, b) => a - b);
    for (const groupIdx of sortedIndices) {
        const entries = groupEntriesMap.get(groupIdx)!;
        entries.sort((a, b) => a.binding - b.binding);
        const layout = getBindGroupLayout(state.layoutCache, state.device, entries);
        data.bindGroupLayouts.push(layout);
    }
}

// ---------------------------------------------------------------------------
// Uniform Updates
// ---------------------------------------------------------------------------

/**
 * Invoke update callbacks on uniform nodes in a group.
 */
function invokeUniformGroupCallbacks(
    block: UniformGroupBlock,
    context: RenderUpdateContext | ObjectUpdateContext,
): void {
    for (const m of block.members) {
        const node = m.node;
        if (node.update) {
            const result = node.update(context);
            // If callback returns a value, assign it to the node and bump version
            if (result !== undefined) {
                node.value = result as typeof node.value;
                node.version++;
            }
        }
    }
}

/**
 * Pack a uniform group into a typed array.
 *
 * mat3x3f is handled specially: in WGSL uniform address space, each column is
 * padded to vec4 (16 bytes), so mat3x3f occupies 48 bytes (3 × 16).
 */
function packUniformGroup(block: UniformGroupBlock): Float32Array {
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

/**
 * Update uniform buffers for a RenderObject.
 *
 * This is called each frame to:
 * 1. Invoke update callbacks on uniform nodes
 * 2. Pack and upload changed uniform data
 *
 * @param state - The Bindings state
 * @param renderObject - The RenderObject
 * @param camera - Current camera (for render group)
 * @param elapsed - Elapsed time
 * @param delta - Delta time
 * @param width - Render width
 * @param height - Render height
 */
export function updateBindings(
    state: BindingsState,
    renderObject: RenderObject,
    camera: Camera,
    elapsed: number,
    delta: number,
    width: number,
    height: number,
): void {
    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) return;

    let data = state.data.get(renderObject);
    if (!data) {
        initBindings(state, renderObject);
        data = state.data.get(renderObject)!;
    }

    const mesh = renderObject.mesh;

    // Update render group uniforms
    const renderBlock = nodeState.uniformGroups.find((g) => g.groupName === 'render');
    if (renderBlock && renderBlock.members.length > 0) {
        const context: RenderUpdateContext = { camera, elapsed, delta, width, height };
        invokeUniformGroupCallbacks(renderBlock, context);

        // Compute version sum
        let versionSum = 0;
        for (const m of renderBlock.members) {
            versionSum += m.node.version;
        }

        // Upload if changed
        if (versionSum !== data.renderVersionSum) {
            if (!data.renderBufferKey) {
                data.renderBufferKey = {};
            }
            const packed = packUniformGroup(renderBlock);
            const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
            uploadRaw(state.bufferCache, data.renderBufferKey, packed, U);
            data.renderVersionSum = versionSum;
            data.needsBindGroupUpdate = true;
        }
    }

    // Update object group uniforms
    const objectBlock = nodeState.uniformGroups.find((g) => g.groupName === 'object');
    if (objectBlock && objectBlock.members.length > 0) {
        const context: ObjectUpdateContext = { object: mesh };
        invokeUniformGroupCallbacks(objectBlock, context);

        // Compute version sum (include mesh matrix version if mesh has a matrix)
        // For fullscreen quads, mesh.matrixVersion is 0 (no matrix tracking)
        let versionSum = mesh.matrixVersion ?? 0;
        for (const m of objectBlock.members) {
            versionSum += m.node.version;
        }

        // Upload if changed
        if (versionSum !== data.objectVersionSum) {
            if (!data.objectBufferKey) {
                data.objectBufferKey = {};
            }
            const packed = packUniformGroup(objectBlock);
            const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
            uploadRaw(state.bufferCache, data.objectBufferKey, packed, U);
            data.objectVersionSum = versionSum;
            data.needsBindGroupUpdate = true;
        }
    }

    // Rebuild bind groups if needed
    if (data.needsBindGroupUpdate) {
        rebuildBindGroups(state, renderObject, data, nodeState);
        data.needsBindGroupUpdate = false;
    }
}

/**
 * Rebuild GPU bind groups for a RenderObject.
 *
 * This builds bind groups dynamically based on the actual group indices
 * present in the NodeBuilderState. It handles:
 * - Uniform groups (render @group(0), object @group(1))
 * - Storage buffers (can be in any group)
 * - Textures (can be in any group)
 * - Samplers (can be in any group)
 */
function rebuildBindGroups(
    state: BindingsState,
    renderObject: RenderObject,
    data: BindingData,
    nodeState: NodeBuilderState,
): void {
    data.bindGroups = [];

    // Collect all unique group indices
    const groupIndices = new Set<number>();

    for (const ug of nodeState.uniformGroups) {
        if (ug.members.length > 0) {
            groupIndices.add(ug.groupIndex);
        }
    }
    for (const s of nodeState.storage) {
        groupIndices.add(s.group);
    }
    for (const t of nodeState.textures) {
        groupIndices.add(t.group);
    }
    for (const s of nodeState.samplers) {
        groupIndices.add(s.group);
    }

    // Build bind groups in sorted order
    const sortedIndices = [...groupIndices].sort((a, b) => a - b);

    for (let i = 0; i < sortedIndices.length; i++) {
        const groupIdx = sortedIndices[i];
        const entries: GPUBindGroupEntry[] = [];

        // Find uniform group for this index
        const uniformBlock = nodeState.uniformGroups.find((g) => g.groupIndex === groupIdx);
        if (uniformBlock && uniformBlock.members.length > 0) {
            // Determine which buffer key to use based on group name
            const bufferKey = uniformBlock.groupName === 'render'
                ? data.renderBufferKey
                : data.objectBufferKey;

            if (bufferKey) {
                const buffer = getRaw(state.bufferCache, bufferKey);
                if (buffer) {
                    entries.push({ binding: 0, resource: { buffer } });
                }
            }
        }

        // Storage buffers in this group
        for (const s of nodeState.storage) {
            if (s.group !== groupIdx) continue;
            const buf = uploadStorage(state.bufferCache, s.node);
            entries.push({ binding: s.binding, resource: { buffer: buf } });
        }

        // Textures in this group
        for (const t of nodeState.textures) {
            if (t.group !== groupIdx) continue;
            let res = t.node.resource;
            if (res === null && t.node.value) {
                res = t.node.value.gpuTexture ?? null;
            }
            if (res) {
                const view = res instanceof GPUTextureView ? res : (res as GPUTexture).createView();
                entries.push({ binding: t.binding, resource: view });
            }
        }

        // Samplers in this group
        for (const s of nodeState.samplers) {
            if (s.group !== groupIdx) continue;
            let samp = s.textureNode.gpuSampler;
            if (samp === null && s.textureNode.value) {
                samp = s.textureNode.value.gpuSampler ?? null;
            }
            if (samp) {
                entries.push({ binding: s.binding, resource: samp });
            }
        }

        // Sort entries by binding
        entries.sort((a, b) => a.binding - b.binding);

        if (entries.length > 0 && i < data.bindGroupLayouts.length) {
            const bindGroup = state.device.createBindGroup({
                layout: data.bindGroupLayouts[i],
                entries,
            });
            data.bindGroups.push(bindGroup);
        }
    }

    // Store on RenderObject
    renderObject.bindGroups = data.bindGroups;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * Get the bind groups for a RenderObject.
 */
export function getBindGroups(
    state: BindingsState,
    renderObject: RenderObject,
): GPUBindGroup[] {
    const data = state.data.get(renderObject);
    return data?.bindGroups ?? [];
}

/**
 * Get the bind group layouts for a RenderObject.
 * Used for pipeline creation.
 */
export function getBindGroupLayouts(
    state: BindingsState,
    renderObject: RenderObject,
): GPUBindGroupLayout[] {
    const data = state.data.get(renderObject);
    return data?.bindGroupLayouts ?? [];
}

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

/**
 * Delete bindings for a RenderObject.
 */
export function deleteBindings(
    state: BindingsState,
    renderObject: RenderObject,
): void {
    // Note: We don't destroy GPU resources here - they're managed by WeakMaps
    // in the buffer cache. When the RenderObject is GC'd, resources are released.
    state.data.delete(renderObject);
    renderObject.bindGroups = null;
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

/**
 * Mark a RenderObject's bindings as needing rebuild.
 *
 * Call this when textures or other resources change.
 */
export function invalidateBindings(
    state: BindingsState,
    renderObject: RenderObject,
): void {
    const data = state.data.get(renderObject);
    if (data) {
        data.needsBindGroupUpdate = true;
    }
}
