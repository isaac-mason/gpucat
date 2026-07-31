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
export declare function createBindGroupLayoutCache(): BindGroupLayoutCache;
/**
 * Get or create a bind group layout for the given entries.
 * Uses a stable hash of the entries as the cache key.
 */
export declare function getBindGroupLayout(cache: BindGroupLayoutCache, device: GPUDevice, entries: GPUBindGroupLayoutEntry[]): GPUBindGroupLayout;
/**
 * Build bind group layouts from NodeBuilderState bindings for compute pipelines.
 *
 * @param device - The GPU device
 * @param bindings - The bindings from NodeBuilderState
 * @param layoutCache - Cache for bind group layouts
 * @returns Array of GPUBindGroupLayout in group index order
 */
export declare function buildComputeBindGroupLayouts(device: GPUDevice, bindings: NodeBindGroup[], layoutCache: BindGroupLayoutCache): GPUBindGroupLayout[];
