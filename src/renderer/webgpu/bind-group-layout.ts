import type { SamplerEntry, TextureEntry, UniformGroupBlock } from '../../nodes/builder';
import type * as d from '../../schema/schema';
import type { BindGroup as NodeBindGroup } from '../core/bind-group';
import { type BindGroupCache, releaseGroupsNaming } from './bind-group-cache';

/**
 * Whether a uniform block is bound at a dynamic offset. Anything but frame scope can hold different values
 * for two passes or dispatches of one frame, and the second takes a dynamic allocation; frame scope is
 * written once a frame. Both layout builders ask this, so render and compute layouts agree.
 */
export function usesDynamicOffset(block: UniformGroupBlock): boolean {
    return block.group.updateType !== 'frame';
}

/**
 * Throws, naming `label`, when a pipeline's groups bind more dynamic uniform buffers than the device
 * allows in one pipeline layout (8 is guaranteed). WebGPU's own error would name neither the material nor
 * the fix. A group holds at most one uniform block, so each counts once.
 */
export function assertDynamicUniformLimit(device: GPUDevice, bindGroups: readonly NodeBindGroup[], label: string): void {
    let count = 0;
    for (const bindGroup of bindGroups) {
        const binding = bindGroup.bindings[0];
        if (binding?.kind === 'uniform' && usesDynamicOffset(binding.block)) count++;
    }
    const limit = device.limits.maxDynamicUniformBuffersPerPipelineLayout;
    if (count > limit) {
        throw new Error(
            `[gpucat] '${label}' binds ${count} uniform groups that can change between passes or draws, and this ` +
                `device allows ${limit} in one pipeline. Merge groups, or move values that change at most once a ` +
                'frame into frame scope.',
        );
    }
}

/**
 * Layouts by their entries, each counted by what holds it, as Dawn's pipeline layouts and bind groups hold theirs: a
 * pipeline for each of its groups, and a bind group's data for its own. A layout leaves with its last holder, and the
 * cached bind groups over it with it.
 */
export type BindGroupLayoutCache = {
    cache: Map<string, GPUBindGroupLayout>;
    /** each layout's key and how many hold it */
    held: Map<GPUBindGroupLayout, { key: string; holders: number }>;
    /** the bind groups cached over each layout, released with it */
    bindGroups: BindGroupCache;
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
    } else if (entry.node.slot !== null) {
        // A named slot's texture is known only when a dispatch fills it, after the layout is made. Any float format
        // binds as `unfilterable-float`, and a slot is read with `load`, which filters nothing.
        const sampleType = (entry.node.type as d.SampledTexture).sampleType?.type;
        layout.sampleType = sampleType === 'u32' ? 'uint' : sampleType === 'i32' ? 'sint' : 'unfilterable-float';
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
export function createBindGroupLayoutCache(bindGroups: BindGroupCache): BindGroupLayoutCache {
    return { cache: new Map(), held: new Map(), bindGroups };
}

/** One more holder of `layout`, a layout from this cache. */
export function holdBindGroupLayout(cache: BindGroupLayoutCache, layout: GPUBindGroupLayout): void {
    const entry = cache.held.get(layout);
    if (entry === undefined) throw new Error('[gpucat] a held bind group layout must come from the layout cache');
    entry.holders++;
}

/** One fewer holder of `layout`: with none left it leaves the cache, and every bind group cached over it goes. */
export function releaseBindGroupLayout(cache: BindGroupLayoutCache, layout: GPUBindGroupLayout): void {
    const entry = cache.held.get(layout);
    if (entry === undefined) return;
    entry.holders--;
    if (entry.holders > 0) return;
    cache.held.delete(layout);
    if (cache.cache.get(entry.key) === layout) cache.cache.delete(entry.key);
    releaseGroupsNaming(cache.bindGroups, layout);
}

/**
 * Get or create a bind group layout for the given entries.
 * Uses a stable hash of the entries as the cache key.
 */
/** `layouts` with the @group indices nothing sits at given the empty layout: a pipeline layout has no holes, and an
 *  empty group needs no bind group set at draw */
export function fillEmptyLayouts(
    cache: BindGroupLayoutCache,
    device: GPUDevice,
    layouts: (GPUBindGroupLayout | undefined)[],
): GPUBindGroupLayout[] {
    for (let i = 0; i < layouts.length; i++) layouts[i] ??= getBindGroupLayout(cache, device, []);
    return layouts as GPUBindGroupLayout[];
}

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
        cache.held.set(layout, { key, holders: 0 });
    }
    return layout;
}

function makeBindGroupLayoutKey(entries: GPUBindGroupLayoutEntry[]): string {
    const normalized = entries.map((e) => ({
        b: e.binding,
        v: e.visibility,
        buf: e.buffer ? { t: e.buffer.type, d: e.buffer.hasDynamicOffset === true } : null,
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
 * @returns each group's layout at its @group index, the empty layout where the shader has none
 */
export function buildComputeBindGroupLayouts(
    device: GPUDevice,
    bindings: NodeBindGroup[],
    layoutCache: BindGroupLayoutCache,
): GPUBindGroupLayout[] {
    const vis = GPUShaderStage.COMPUTE;
    const float32Filterable = device.features.has('float32-filterable');

    const sortedBindings = [...bindings].sort((a, b) => a.groupIndex - b.groupIndex);
    const layouts: (GPUBindGroupLayout | undefined)[] = [];

    for (const bindGroup of sortedBindings) {
        const entries: GPUBindGroupLayoutEntry[] = [];

        for (const binding of bindGroup.bindings) {
            switch (binding.kind) {
                case 'uniform':
                    entries.push({
                        binding: binding.block.binding,
                        visibility: vis,
                        buffer: { type: 'uniform', hasDynamicOffset: usesDynamicOffset(binding.block) },
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
        layouts[bindGroup.groupIndex] = getBindGroupLayout(layoutCache, device, entries);
    }

    return fillEmptyLayouts(layoutCache, device, layouts);
}

/** Drop every cached layout (called on renderer dispose; `device.destroy()` frees the GPU side). */
export function disposeBindGroupLayoutCache(cache: BindGroupLayoutCache): void {
    cache.cache.clear();
    cache.held.clear();
}

export function getBindGroupLayoutCacheStats(cache: BindGroupLayoutCache): { layoutCount: number } {
    return { layoutCount: cache.cache.size };
}
