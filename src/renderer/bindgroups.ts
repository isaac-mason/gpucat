/**
 * bindgroups.ts — GPUBindGroup construction (Three.js aligned).
 *
 * Following Three.js's pattern:
 * - BindGroup objects are created only for groups with actual bindings
 * - Each BindGroup has a name, index (slot), and layout
 * - The pipeline layout is built from only the non-empty bind groups
 *
 * Group 0 (render): Struct UBO containing camera + time uniforms (optional).
 * Group 1 (object): Struct UBO containing mesh matrices + material uniforms,
 *                   plus textures, samplers, and storage buffers (optional).
 *
 * The renderer calls these once per frame (group 0) and once per draw (group 1).
 */

import type { CompileResult, ComputeCompileResult } from '../nodes/compile';
import type { BufferCache } from './buffers';

// ---------------------------------------------------------------------------
// BindGroup type (Three.js aligned)
// ---------------------------------------------------------------------------

/**
 * A bind group represents a collection of bindings.
 * Following Three.js's BindGroup class pattern.
 */
export type BindGroup = {
    /** The bind group's name (e.g. 'render', 'object'). */
    name: string;
    /** The group index/slot for setBindGroup(). Assigned after sorting. */
    index: number;
    /** The bind group layout for this group. */
    layout: GPUBindGroupLayout;
    /** Number of entries in this bind group. */
    entryCount: number;
};

/**
 * Information needed to build and set bind groups at runtime.
 */
export type BindGroupInfo = {
    /** All bind groups, in order (indices match pipeline layout). */
    bindGroups: BindGroup[];
    /** Index of the render group in bindGroups, or -1 if not present. */
    renderGroupIndex: number;
    /** Index of the object group in bindGroups, or -1 if not present. */
    objectGroupIndex: number;
};

// ---------------------------------------------------------------------------
// Build BindGroupInfo from CompileResult (Three.js aligned)
// ---------------------------------------------------------------------------

/**
 * Build bind group layouts and info from a CompileResult.
 *
 * Three.js aligned: iterates through uniformGroups (already sorted by order)
 * and creates bind group layouts at the indices specified by groupIndex.
 * Storage/textures/samplers are added to their respective groups.
 */
export function buildBindGroupInfo(
    device: GPUDevice,
    cr: CompileResult,
): BindGroupInfo {
    const vis = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;

    // Build a map of groupIndex → entries for each bind group
    // uniformGroups are already sorted by order in compile
    const groupEntriesMap = new Map<number, { name: string; entries: GPUBindGroupLayoutEntry[] }>();

    // Add uniform buffer entries from uniformGroups
    for (const ug of cr.uniformGroups) {
        if (ug.members.length === 0) continue;
        groupEntriesMap.set(ug.groupIndex, {
            name: ug.groupName,
            entries: [{
                binding: 0,
                visibility: vis,
                buffer: { type: 'uniform' },
            }],
        });
    }

    // Add storage buffers to their respective groups
    for (const s of cr.storage) {
        let groupData = groupEntriesMap.get(s.group);
        if (!groupData) {
            // Group doesn't exist yet (no uniforms) - create it
            // Find the group name from uniformGroups or default to 'object'
            const ug = cr.uniformGroups.find(g => g.groupIndex === s.group);
            groupData = { name: ug?.groupName ?? 'object', entries: [] };
            groupEntriesMap.set(s.group, groupData);
        }
        groupData.entries.push({
            binding: s.binding,
            visibility: vis,
            buffer: { type: 'read-only-storage' },
        });
    }

    // Add textures to their respective groups
    for (const t of cr.textures) {
        let groupData = groupEntriesMap.get(t.group);
        if (!groupData) {
            const ug = cr.uniformGroups.find(g => g.groupIndex === t.group);
            groupData = { name: ug?.groupName ?? 'object', entries: [] };
            groupEntriesMap.set(t.group, groupData);
        }
        groupData.entries.push({
            binding: t.binding,
            visibility: GPUShaderStage.FRAGMENT,
            texture: {},
        });
    }

    // Add samplers to their respective groups
    for (const s of cr.samplers) {
        let groupData = groupEntriesMap.get(s.group);
        if (!groupData) {
            const ug = cr.uniformGroups.find(g => g.groupIndex === s.group);
            groupData = { name: ug?.groupName ?? 'object', entries: [] };
            groupEntriesMap.set(s.group, groupData);
        }
        groupData.entries.push({
            binding: s.binding,
            visibility: GPUShaderStage.FRAGMENT,
            sampler: {},
        });
    }

    // Three.js aligned: bind groups are created with sequential indices 0, 1, 2...
    // The shader @group(N) indices match these sequential indices.
    const sortedIndices = [...groupEntriesMap.keys()].sort((a, b) => a - b);
    const bindGroups: BindGroup[] = [];
    let renderGroupIndex = -1;
    let objectGroupIndex = -1;

    for (const groupIdx of sortedIndices) {
        const groupData = groupEntriesMap.get(groupIdx)!;
        const layout = device.createBindGroupLayout({ entries: groupData.entries });
        const bgIndex = bindGroups.length;
        bindGroups.push({
            name: groupData.name,
            index: bgIndex,
            layout,
            entryCount: groupData.entries.length,
        });
        if (groupData.name === 'render') renderGroupIndex = bgIndex;
        if (groupData.name === 'object') objectGroupIndex = bgIndex;
    }

    return { bindGroups, renderGroupIndex, objectGroupIndex };
}

/**
 * Build bind group info for compute pipelines.
 * 
 * Three.js aligned: iterates through uniformGroups and storage entries,
 * respecting their group indices as assigned by the compiler.
 */
export function buildComputeBindGroupInfo(
    device: GPUDevice,
    cr: ComputeCompileResult,
): BindGroupInfo {
    const vis = GPUShaderStage.COMPUTE;

    // Build a map of groupIndex → entries for each bind group
    const groupEntriesMap = new Map<number, { name: string; entries: GPUBindGroupLayoutEntry[] }>();

    // Add uniform buffer entries from uniformGroups
    for (const ug of cr.uniformGroups) {
        if (ug.members.length === 0) continue;
        groupEntriesMap.set(ug.groupIndex, {
            name: ug.groupName,
            entries: [{
                binding: 0,
                visibility: vis,
                buffer: { type: 'uniform' },
            }],
        });
    }

    // Add storage buffers to their respective groups
    for (const s of cr.storage) {
        let groupData = groupEntriesMap.get(s.group);
        if (!groupData) {
            // Group doesn't exist yet (no uniforms) - create it
            groupData = { name: 'storage', entries: [] };
            groupEntriesMap.set(s.group, groupData);
        }
        groupData.entries.push({
            binding: s.binding,
            visibility: vis,
            buffer: {
                type: s.access === 'read_write'
                    ? ('storage' as GPUBufferBindingType)
                    : ('read-only-storage' as GPUBufferBindingType),
            },
        });
    }

    // Sort by group index and create bind groups
    const sortedIndices = [...groupEntriesMap.keys()].sort((a, b) => a - b);
    const bindGroups: BindGroup[] = [];
    let renderGroupIndex = -1;
    const objectGroupIndex = -1; // Compute doesn't have object group

    for (const groupIdx of sortedIndices) {
        const groupData = groupEntriesMap.get(groupIdx)!;
        // Sort entries by binding index to ensure correct order
        groupData.entries.sort((a, b) => a.binding - b.binding);
        const layout = device.createBindGroupLayout({ entries: groupData.entries });
        const bgIndex = bindGroups.length;
        bindGroups.push({
            name: groupData.name,
            index: bgIndex,
            layout,
            entryCount: groupData.entries.length,
        });
        if (groupData.name === 'render') renderGroupIndex = bgIndex;
    }

    return { bindGroups, renderGroupIndex, objectGroupIndex };
}

// ---------------------------------------------------------------------------
// Build GPUBindGroup instances at runtime
// ---------------------------------------------------------------------------

/**
 * Build the render group GPUBindGroup (struct UBO with camera + time).
 *
 * @param device      GPUDevice
 * @param bindGroup   The BindGroup for render group
 * @param renderBuf   GPUBuffer containing the packed render struct UBO
 */
export function buildRenderGroupGPUBindGroup(
    device: GPUDevice,
    bindGroup: BindGroup,
    renderBuf: GPUBuffer,
): GPUBindGroup {
    return device.createBindGroup({
        layout: bindGroup.layout,
        entries: [
            { binding: 0, resource: { buffer: renderBuf } },
        ],
    });
}

/**
 * Build the object group GPUBindGroup (struct UBO + textures/samplers/storage).
 *
 * Three.js aligned: uses bindGroup.index to filter resources belonging to this group.
 *
 * @param device      GPUDevice
 * @param bindGroup   The BindGroup for object group
 * @param cr          CompileResult for this material
 * @param objectBuf   GPUBuffer containing the packed object struct UBO (null if no object group uniforms)
 * @param buffers     BufferCache for storage buffer lookups
 */
export function buildObjectGroupGPUBindGroup(
    device: GPUDevice,
    bindGroup: BindGroup,
    cr: CompileResult,
    objectBuf: GPUBuffer | null,
    buffers: BufferCache,
): GPUBindGroup {
    const entries: GPUBindGroupEntry[] = [];
    const groupIndex = bindGroup.index;

    // Object struct UBO at binding 0 (only if present)
    const objectGroup = cr.uniformGroups.find(g => g.groupName === 'object' && g.groupIndex === groupIndex);
    if (objectGroup && objectGroup.members.length > 0 && objectBuf) {
        entries.push({ binding: 0, resource: { buffer: objectBuf } });
    }

    // Storage buffers
    for (const s of cr.storage) {
        if (s.group !== groupIndex) continue;
        const buf = buffers.uploadStorage(s.node);
        entries.push({ binding: s.binding, resource: { buffer: buf } });
    }

    // Textures
    for (const t of cr.textures) {
        if (t.group !== groupIndex) continue;
        // Get GPU texture - either from resource directly, or from value object (Three.js pattern)
        let res = t.node.resource;
        if (res === null && t.node.value) {
            // RenderTargetTexture and DepthTexture have gpuTexture directly on them
            res = (t.node.value as { gpuTexture?: GPUTexture | null }).gpuTexture ?? null;
        }
        if (res === null) {
            throw new Error(`[buildObjectGroupGPUBindGroup] TextureNode '${t.textureId}' has no resource set`);
        }
        const view = res instanceof GPUTextureView ? res : (res as GPUTexture).createView();
        entries.push({ binding: t.binding, resource: view });
    }

    // Samplers (Three.js pattern: sampler is on textureNode.gpuSampler, or on value object)
    for (const s of cr.samplers) {
        if (s.group !== groupIndex) continue;
        // Get sampler - either from gpuSampler directly, or from value object (Three.js pattern)
        let samp = s.textureNode.gpuSampler;
        if (samp === null && s.textureNode.value) {
            // RenderTargetTexture and DepthTexture have gpuSampler directly on them
            samp = (s.textureNode.value as { gpuSampler?: GPUSampler | null }).gpuSampler ?? null;
        }
        if (samp === null) {
            throw new Error(`[buildObjectGroupGPUBindGroup] TextureNode '${s.samplerId}' has no gpuSampler set`);
        }
        entries.push({ binding: s.binding, resource: samp });
    }

    return device.createBindGroup({ layout: bindGroup.layout, entries });
}

/**
 * Build storage group GPUBindGroup for compute shaders.
 *
 * @param device      GPUDevice
 * @param bindGroup   The BindGroup for storage
 * @param cr          ComputeCompileResult
 * @param buffers     BufferCache for storage buffer lookups
 */
export function buildComputeStorageGPUBindGroup(
    device: GPUDevice,
    bindGroup: BindGroup,
    cr: ComputeCompileResult,
    buffers: BufferCache,
): GPUBindGroup {
    const entries: GPUBindGroupEntry[] = [];

    for (const s of cr.storage) {
        const buf = buffers.uploadStorage(s.node);
        entries.push({ binding: s.binding, resource: { buffer: buf } });
    }

    return device.createBindGroup({ layout: bindGroup.layout, entries });
}

// ---------------------------------------------------------------------------
// Legacy exports for backwards compatibility during migration
// (These will be removed once renderer is fully migrated)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use buildRenderGroupGPUBindGroup with BindGroup instead
 */
export function buildRenderGroupBindGroup(
    device: GPUDevice,
    layout: GPUBindGroupLayout,
    renderBuf: GPUBuffer,
): GPUBindGroup {
    return device.createBindGroup({
        layout,
        entries: [
            { binding: 0, resource: { buffer: renderBuf } },
        ],
    });
}

/**
 * @deprecated Use buildObjectGroupGPUBindGroup with BindGroup instead
 */
export function buildObjectGroupBindGroup(
    device: GPUDevice,
    layout: GPUBindGroupLayout,
    cr: CompileResult,
    objectBuf: GPUBuffer | null,
    buffers: BufferCache,
): GPUBindGroup {
    const entries: GPUBindGroupEntry[] = [];

    // Object struct UBO at binding 0 (only if present)
    const objectGroup = cr.uniformGroups.find(g => g.groupName === 'object');
    if (objectGroup && objectGroup.members.length > 0 && objectBuf) {
        entries.push({ binding: 0, resource: { buffer: objectBuf } });
    }

    // Storage buffers (binding 1+)
    for (const s of cr.storage) {
        if (s.group !== 1) continue;
        const buf = buffers.uploadStorage(s.node);
        entries.push({ binding: s.binding, resource: { buffer: buf } });
    }

    // Textures (binding 1+)
    for (const t of cr.textures) {
        if (t.group !== 1) continue;
        const res = t.node.resource;
        if (res === null) {
            throw new Error(`[buildObjectGroupBindGroup] TextureNode '${t.textureId}' has no resource set`);
        }
        const view = res instanceof GPUTextureView ? res : (res as GPUTexture).createView();
        entries.push({ binding: t.binding, resource: view });
    }

    // Samplers (Three.js pattern: sampler is on textureNode.gpuSampler)
    for (const s of cr.samplers) {
        if (s.group !== 1) continue;
        const samp = s.textureNode.gpuSampler;
        if (samp === null) {
            throw new Error(`[buildObjectGroupBindGroup] TextureNode '${s.samplerId}' has no gpuSampler set`);
        }
        entries.push({ binding: s.binding, resource: samp });
    }

    return device.createBindGroup({ layout, entries });
}
