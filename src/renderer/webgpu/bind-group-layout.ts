import type { SamplerEntry, TextureEntry } from '../../nodes/builder';
import type { BindGroup as NodeBindGroup } from '../core/bind-group';

export type BindGroupLayoutCache = {
    cache: Map<string, GPUBindGroupLayout>;
};

/**
 * The bind-group-layout sample type for a sampled texture's actual format. A `texture_2d<f32>`
 * declaration is format-agnostic in WGSL, but the layout's `sampleType` must match the bound
 * texture's filterability: 32-bit float formats are `unfilterable-float` unless the device enables
 * `float32-filterable`, and integer formats are `uint`/`sint`. Everything else is filterable `float`.
 */
export function sampleTypeForFormat(format: GPUTextureFormat | undefined, float32Filterable: boolean): GPUTextureSampleType {
    if (!format) return 'float';
    if (format.endsWith('uint')) return 'uint';
    if (format.endsWith('sint')) return 'sint';
    if (format === 'r32float' || format === 'rg32float' || format === 'rgba32float') {
        return float32Filterable ? 'float' : 'unfilterable-float';
    }
    return 'float';
}

/**
 * Build the `GPUTextureBindingLayout` for a sampled-texture binding. Derives viewDimension and the
 * multisampled flag from the WGSL type, and the sampleType from the type + the bound texture's format:
 * depth → `depth`; multisampled color → `unfilterable-float` (accessed via textureLoad); otherwise the
 * format's filterability (see {@link sampleTypeForFormat}). Shared by the render and compute layout paths.
 */
export function textureBindingLayout(entry: TextureEntry, float32Filterable: boolean): GPUTextureBindingLayout {
    const wgslType = entry.type;
    const layout: GPUTextureBindingLayout = {};

    if (wgslType.includes('cube_array')) layout.viewDimension = 'cube-array';
    else if (wgslType.includes('cube')) layout.viewDimension = 'cube';
    else if (wgslType.includes('2d_array')) layout.viewDimension = '2d-array';
    else if (wgslType.includes('3d')) layout.viewDimension = '3d';

    const isMultisampled = wgslType.includes('multisampled');
    if (isMultisampled) layout.multisampled = true;

    if (wgslType.startsWith('texture_depth')) {
        layout.sampleType = 'depth';
    } else if (isMultisampled) {
        layout.sampleType = 'unfilterable-float';
    } else {
        const format = entry.node.value?.format;
        layout.sampleType = format ? sampleTypeForFormat(format, float32Filterable) : 'float';
    }

    return layout;
}

/**
 * Sampler binding type from the actual sampler settings: a comparison sampler → `comparison`; an
 * all-nearest, no-compare sampler → `non-filtering` (required to pair with depth/unfilterable-float
 * textures); otherwise `filtering`. Shared by the render and compute layout paths.
 */
export function samplerBindingType(entry: SamplerEntry): GPUSamplerBindingType {
    if (entry.type === 'sampler_comparison') return 'comparison';
    const sampler = entry.samplerNode?.value;
    if (sampler?.compare) return 'comparison';
    if (sampler && sampler.minFilter === 'nearest' && sampler.magFilter === 'nearest' && sampler.mipmapFilter === 'nearest') {
        return 'non-filtering';
    }
    return 'filtering';
}

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
    const normalized = entries.map((e) => ({
        b: e.binding,
        v: e.visibility,
        buf: e.buffer ? { t: e.buffer.type } : null,
        sam: e.sampler ? { t: e.sampler.type } : null,
        tex: e.texture ? { s: e.texture.sampleType, v: e.texture.viewDimension } : null,
        stor: e.storageTexture
            ? { f: e.storageTexture.format, a: e.storageTexture.access, v: e.storageTexture.viewDimension }
            : null,
    }));
    return hashString(JSON.stringify(normalized));
}

function hashString(str: string): string {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) + hash + str.charCodeAt(i);
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
    const float32Filterable = device.features.has('float32-filterable');

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
                            type:
                                binding.entry.access === 'read_write'
                                    ? ('storage' as GPUBufferBindingType)
                                    : ('read-only-storage' as GPUBufferBindingType),
                        },
                    });
                    break;
                case 'texture': {
                    entries.push({
                        binding: binding.entry.binding,
                        visibility: vis,
                        texture: textureBindingLayout(binding.entry, float32Filterable),
                    });
                    break;
                }
                case 'storageTexture': {
                    const access: GPUStorageTextureAccess =
                        binding.entry.access === 'write'
                            ? 'write-only'
                            : binding.entry.access === 'read_write'
                              ? 'read-write'
                              : 'read-only';
                    const viewDimension: GPUTextureViewDimension =
                        binding.entry.dim === '1d'
                            ? '1d'
                            : binding.entry.dim === '2d_array'
                              ? '2d-array'
                              : binding.entry.dim === '3d'
                                ? '3d'
                                : '2d';
                    entries.push({
                        binding: binding.entry.binding,
                        visibility: vis,
                        storageTexture: {
                            access,
                            format: binding.entry.format as GPUTextureFormat,
                            viewDimension,
                        },
                    });
                    break;
                }
                case 'sampler':
                    entries.push({
                        binding: binding.entry.binding,
                        visibility: vis,
                        sampler: { type: samplerBindingType(binding.entry) },
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
