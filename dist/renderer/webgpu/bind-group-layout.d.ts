import type { SamplerEntry, TextureEntry, UniformGroupBlock } from '../../nodes/builder';
import type { BindGroup as NodeBindGroup } from '../core/bind-group';
import { type BindGroupCache } from './bind-group-cache';
/**
 * Whether a uniform block is bound at a dynamic offset. Anything but frame scope can hold different values
 * for two passes or dispatches of one frame, and the second takes a dynamic allocation; frame scope is
 * written once a frame. Both layout builders ask this, so render and compute layouts agree.
 */
export declare function usesDynamicOffset(block: UniformGroupBlock): boolean;
/**
 * Throws, naming `label`, when a pipeline's groups bind more dynamic uniform buffers than the device
 * allows in one pipeline layout (8 is guaranteed). WebGPU's own error would name neither the material nor
 * the fix. A group holds at most one uniform block, so each counts once.
 */
export declare function assertDynamicUniformLimit(device: GPUDevice, bindGroups: readonly NodeBindGroup[], label: string): void;
/**
 * Layouts by their entries, each counted by what holds it, as Dawn's pipeline layouts and bind groups hold theirs: a
 * pipeline for each of its groups, and a bind group's data for its own. A layout leaves with its last holder, and the
 * cached bind groups over it with it.
 */
export type BindGroupLayoutCache = {
    cache: Map<string, GPUBindGroupLayout>;
    /** each layout's key and how many hold it */
    held: Map<GPUBindGroupLayout, {
        key: string;
        holders: number;
    }>;
    /** the bind groups cached over each layout, released with it */
    bindGroups: BindGroupCache;
};
/**
 * The bind-group-layout sample type for a sampled texture's actual format. A `texture_2d<f32>`
 * declaration is format-agnostic in WGSL, but the layout's `sampleType` must match the bound
 * texture's filterability: 32-bit float formats are `unfilterable-float` unless the device enables
 * `float32-filterable`, and integer formats are `uint`/`sint`. Everything else is filterable `float`.
 */
export declare function sampleTypeForFormat(format: GPUTextureFormat | undefined, float32Filterable: boolean): GPUTextureSampleType;
/**
 * Build the `GPUTextureBindingLayout` for a sampled-texture binding. Derives viewDimension and the
 * multisampled flag from the WGSL type, and the sampleType from the type + the bound texture's format:
 * depth → `depth`; multisampled color → `unfilterable-float` (accessed via textureLoad); otherwise the
 * format's filterability (see {@link sampleTypeForFormat}). Shared by the render and compute layout paths.
 */
export declare function textureBindingLayout(entry: TextureEntry, float32Filterable: boolean): GPUTextureBindingLayout;
/**
 * Sampler binding type from the actual sampler settings: a comparison sampler → `comparison`; an
 * all-nearest, no-compare sampler → `non-filtering` (required to pair with depth/unfilterable-float
 * textures); otherwise `filtering`. Shared by the render and compute layout paths.
 */
export declare function samplerBindingType(entry: SamplerEntry): GPUSamplerBindingType;
/** create a bind group layout cache */
export declare function createBindGroupLayoutCache(bindGroups: BindGroupCache): BindGroupLayoutCache;
/** One more holder of `layout`, a layout from this cache. */
export declare function holdBindGroupLayout(cache: BindGroupLayoutCache, layout: GPUBindGroupLayout): void;
/** One fewer holder of `layout`: with none left it leaves the cache, and every bind group cached over it goes. */
export declare function releaseBindGroupLayout(cache: BindGroupLayoutCache, layout: GPUBindGroupLayout): void;
/**
 * Get or create a bind group layout for the given entries.
 * Uses a stable hash of the entries as the cache key.
 */
/** `layouts` with the @group indices nothing sits at given the empty layout: a pipeline layout has no holes, and an
 *  empty group needs no bind group set at draw */
export declare function fillEmptyLayouts(cache: BindGroupLayoutCache, device: GPUDevice, layouts: (GPUBindGroupLayout | undefined)[]): GPUBindGroupLayout[];
export declare function getBindGroupLayout(cache: BindGroupLayoutCache, device: GPUDevice, entries: GPUBindGroupLayoutEntry[]): GPUBindGroupLayout;
/**
 * Build bind group layouts from NodeBuilderState bindings for compute pipelines.
 *
 * @param device - The GPU device
 * @param bindings - The bindings from NodeBuilderState
 * @param layoutCache - Cache for bind group layouts
 * @returns each group's layout at its @group index, the empty layout where the shader has none
 */
export declare function buildComputeBindGroupLayouts(device: GPUDevice, bindings: NodeBindGroup[], layoutCache: BindGroupLayoutCache): GPUBindGroupLayout[];
/** Drop every cached layout (called on renderer dispose; `device.destroy()` frees the GPU side). */
export declare function disposeBindGroupLayoutCache(cache: BindGroupLayoutCache): void;
export declare function getBindGroupLayoutCacheStats(cache: BindGroupLayoutCache): {
    layoutCount: number;
};
