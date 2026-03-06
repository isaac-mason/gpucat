import type { CompileResult, ComputeCompileResult } from '../nodes/compile';

// ---------------------------------------------------------------------------
// Bind Group Layout Cache
// ---------------------------------------------------------------------------

export type BindGroupLayoutCache = {
    cache: Map<string, GPUBindGroupLayout>;
};

/**
 * Create a bind group layout cache.
 */
export function createBindGroupLayoutCache(): BindGroupLayoutCache {
    return { cache: new Map() };
}

/**
 * Get or create a bind group layout for the given entries.
 * Uses a stable hash of the entries as the cache key.
 */
export function getBindGroupLayout(
    cache: BindGroupLayoutCache,
    device: GPUDevice,
    entries: GPUBindGroupLayoutEntry[],
): GPUBindGroupLayout {
    const key = makeBindGroupLayoutKey(entries);
    let layout = cache.cache.get(key);
    if (!layout) {
        layout = device.createBindGroupLayout({ entries });
        cache.cache.set(key, layout);
    }
    return layout;
}

function makeBindGroupLayoutKey(entries: GPUBindGroupLayoutEntry[]): string {
    const normalized = entries.map(e => ({
        b: e.binding,
        v: e.visibility,
        buf: e.buffer ? { t: e.buffer.type } : null,
        sam: e.sampler ? {} : null,
        tex: e.texture ? { s: e.texture.sampleType, v: e.texture.viewDimension } : null,
        stor: e.storageTexture ? { f: e.storageTexture.format, a: e.storageTexture.access, v: e.storageTexture.viewDimension } : null,
    }));
    return hashString(JSON.stringify(normalized));
}

function hashString(str: string): string {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return (hash >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** bind group representing a collection of bindings */
export type BindGroup = {
    /** the bind group's name (e.g. 'render', 'object'). */
    name: string;
    /** the group index/slot for setBindGroup(). assigned after sorting. */
    index: number;
    /** the bind group layout for this group. */
    layout: GPUBindGroupLayout;
    /** number of entries in this bind group. */
    entryCount: number;
};

/** information needed to build and set bind groups at runtime */
export type BindGroupInfo = {
    /** all bind groups, in order (indices match pipeline layout). */
    bindGroups: BindGroup[];
    /** index of the render group in bindGroups, or -1 if not present. */
    renderGroupIndex: number;
    /** index of the object group in bindGroups, or -1 if not present. */
    objectGroupIndex: number;
};

/**
 * Build bind group layouts and info from a CompileResult.
 *
 * iterates through uniformGroups (already sorted by order) and creates bind group layouts at the indices specified by groupIndex.
 * Storage/textures/samplers are added to their respective groups.
 */
export function buildBindGroupInfo(
    device: GPUDevice,
    cr: CompileResult,
    layoutCache: BindGroupLayoutCache,
): BindGroupInfo {
    const vis = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;

    const groupEntriesMap = new Map<number, { name: string; entries: GPUBindGroupLayoutEntry[] }>();

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

    for (const s of cr.storage) {
        let groupData = groupEntriesMap.get(s.group);
        if (!groupData) {
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

    const sortedIndices = [...groupEntriesMap.keys()].sort((a, b) => a - b);
    const bindGroups: BindGroup[] = [];
    let renderGroupIndex = -1;
    let objectGroupIndex = -1;

    for (const groupIdx of sortedIndices) {
        const groupData = groupEntriesMap.get(groupIdx)!;
        const layout = getBindGroupLayout(layoutCache, device, groupData.entries);
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
 * iterates through uniformGroups and storage entries, respecting their group indices as assigned by the compiler.
 */
export function buildComputeBindGroupInfo(
    device: GPUDevice,
    cr: ComputeCompileResult,
    layoutCache: BindGroupLayoutCache,
): BindGroupInfo {
    const vis = GPUShaderStage.COMPUTE;

    const groupEntriesMap = new Map<number, { name: string; entries: GPUBindGroupLayoutEntry[] }>();

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

    for (const s of cr.storage) {
        let groupData = groupEntriesMap.get(s.group);
        if (!groupData) {
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

    const sortedIndices = [...groupEntriesMap.keys()].sort((a, b) => a - b);
    const bindGroups: BindGroup[] = [];
    let renderGroupIndex = -1;
    const objectGroupIndex = -1;

    for (const groupIdx of sortedIndices) {
        const groupData = groupEntriesMap.get(groupIdx)!;
        groupData.entries.sort((a, b) => a.binding - b.binding);
        const layout = getBindGroupLayout(layoutCache, device, groupData.entries);
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

/** build the render group GPUBindGroup */
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


