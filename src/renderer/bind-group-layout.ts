import type { BindGroup as NodeBindGroup } from './bind-group';

export type BindGroupLayoutCache = {
    cache: Map<string, GPUBindGroupLayout>;
};

/** create a bind group layout cache */
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

/**
 * Build bind group layouts from NodeBuilderState bindings for compute pipelines.
 *
 * @param device - The GPU device
 * @param bindings - The bindings from NodeBuilderState
 * @param layoutCache - Cache for bind group layouts
 * @returns Array of GPUBindGroupLayout in group index order
 */
export function buildComputeBindGroupLayouts(
    device: GPUDevice,
    bindings: NodeBindGroup[],
    layoutCache: BindGroupLayoutCache,
): GPUBindGroupLayout[] {
    const vis = GPUShaderStage.COMPUTE;

    // Sort bindings by group index
    const sortedBindings = [...bindings].sort((a, b) => a.groupIndex - b.groupIndex);
    const layouts: GPUBindGroupLayout[] = [];

    for (const bindGroup of sortedBindings) {
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
                                ? ('storage' as GPUBufferBindingType)
                                : ('read-only-storage' as GPUBufferBindingType),
                        },
                    });
                    break;
                case 'texture':
                    entries.push({
                        binding: binding.entry.binding,
                        visibility: vis,
                        texture: {
                            sampleType: 'float',
                            viewDimension: '2d',
                        },
                    });
                    break;
                case 'sampler':
                    entries.push({
                        binding: binding.entry.binding,
                        visibility: vis,
                        sampler: { type: binding.entry.type === 'sampler_comparison' ? 'comparison' : 'filtering' },
                    });
                    break;
            }
        }

        // Sort entries by binding index for consistent cache keys
        entries.sort((a, b) => a.binding - b.binding);
        layouts.push(getBindGroupLayout(layoutCache, device, entries));
    }

    return layouts;
}


