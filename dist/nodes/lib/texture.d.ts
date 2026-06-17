import { Texture } from '../../texture/texture';
import { CubeTexture } from '../../texture/cube-texture';
import { DepthTexture } from '../../texture/depth-texture';
import { ArrayTexture } from '../../texture/array-texture';
import { GpuTexture } from '../../core/gpu-texture';
import { GpuSampler } from '../../core/gpu-sampler';
import { CallNode, Node } from './core';
import { type FlatDepthTexture, type FlatSampledTexture, type CubeSampledTexture, type Any } from '../../schema/schema';
import * as d from '../../schema/schema';
import { UniformGroup } from './uniform';
/**
 * SamplerNode - represents a sampler binding.
 *
 * Samplers are first-class nodes with their own bindings, mirroring WGSL's
 * separate texture/sampler model.
 *
 * Holds a reference to a GpuSampler which contains the actual settings.
 */
export declare class SamplerNode<D extends d.sampler | d.samplerComparison = d.sampler> extends Node<D> {
    /** The GpuSampler - always has a valid default */
    value: GpuSampler;
    /** Unique ID for this sampler instance */
    readonly samplerId: string;
    /** Uniform group, determines @group index. */
    group: UniformGroup;
    constructor(desc: D, samplerId: string, group?: UniformGroup);
    /** Settings key from the GpuSampler (for deduplication) */
    get settingsKey(): string;
    /** Sampling parameters (forwarded from GpuSampler) */
    get minFilter(): GPUFilterMode;
    get magFilter(): GPUFilterMode;
    get mipmapFilter(): GPUMipmapFilterMode;
    get addressModeU(): GPUAddressMode;
    get addressModeV(): GPUAddressMode;
    get addressModeW(): GPUAddressMode;
    get maxAnisotropy(): number;
    get compare(): GPUCompareFunction | undefined;
    /** Clone this sampler (shares same GpuSampler reference) */
    clone(): SamplerNode<D>;
}
/**
 * TextureBindingNode - represents a module-scope texture handle binding.
 *
 * This mirrors how SamplerNode works: it represents a `var t : texture_2d<f32>`
 * (or texture_cube<f32>, texture_depth_2d, etc.) at module scope. When used as
 * an expression, it generates just the binding name, never a sampling operation.
 *
 * The existing TextureNode/CubeTextureNode/DepthTextureNode own a
 * TextureBindingNode internally and delegate binding registration to it.
 * Free functions take TextureBindingNode + SamplerNode as arguments, producing
 * correct WGSL like `textureSample(myTex, mySampler, uv)`.
 *
 * Holds a reference to a GpuTexture<D> which the renderer uses to create/update
 * the GPU texture.
 */
export declare class TextureBindingNode<D extends d.Texture = d.Texture> extends Node<D> {
    /** The GpuTexture */
    value: GpuTexture<D> | null;
    /** Unique ID for this texture binding (e.g. 'tAlbedo', 'tShadowMap'). */
    readonly textureId: string;
    /** Uniform group, determines @group index. */
    group: UniformGroup;
    constructor(desc: D, textureId: string, group?: UniformGroup);
}
/**
 * StorageTextureBindingNode - a module-scope storage texture binding, i.e.
 * `var t : texture_storage_2d<rgba8unorm, write>`. Written via `textureStore`
 * and read via `textureLoad` (no sampler).
 *
 * Format + dimension come from the GpuTexture's descriptor; `access` is a
 * per-binding property (default `'write'`), so the same GpuTexture can be bound
 * `write` in one shader and `read` in another (ping-pong). `mipLevel` selects the
 * mip the binding view targets (for manual mip-pyramid writes).
 */
export declare class StorageTextureBindingNode<D extends d.StorageTexture = d.StorageTexture> extends Node<D> {
    /** The GpuTexture */
    value: GpuTexture<D> | null;
    /** Unique ID for this texture binding (e.g. 'st3'). */
    readonly textureId: string;
    /** Uniform group, determines @group index. */
    group: UniformGroup;
    /** WGSL access mode for THIS binding (overrides the descriptor default). */
    access: d.StorageTextureAccess;
    /** Mip level the binding view targets. */
    mipLevel: number;
    constructor(desc: D, textureId: string, access: d.StorageTextureAccess, group?: UniformGroup);
    /** The storage texel format (from the descriptor). */
    get format(): d.StorageTextureFormat;
    /** The WGSL storage dimension tag ('1d' | '2d' | '2d_array' | '3d'). */
    get dim(): D['dim'];
    /** The composed WGSL binding type, e.g. `texture_storage_2d<rgba8unorm, write>`. */
    get wgslBindingType(): string;
    /** Set the mip level this binding view targets (for manual mip writes). */
    setMipLevel(level: number): this;
}
/**
 * storageTexture - bind a GpuTexture as a storage texture for compute writes/reads.
 *
 * @param gpuTex - a storage GpuTexture (e.g. from `createStorageTexture(...)`)
 * @param access - 'write' (default), 'read', or 'read_write'
 */
export declare function storageTexture<D extends d.StorageTexture>(gpuTex: GpuTexture<D>, access?: d.StorageTextureAccess): StorageTextureBindingNode<D>;
/**
 * Sampling mode for texture operations.
 * Determines which WGSL function to emit.
 */
export type SamplingMode = 'sample' | 'level' | 'bias' | 'grad' | 'load';
/**
 * TextureNode - represents a texture sample operation.
 *
 * When used as a value, it samples the texture at the given UV coordinates.
 * The node type is 'vec4f' (the sampled color), not the texture type.
 *
 * Owns a TextureBindingNode that handles the module-scope binding.
 *
 * Supports chainable methods for ergonomic sampling control:
 * - .sample(uv) - set UV coordinates
 * - .level(level) - use textureSampleLevel
 * - .bias(bias) - use textureSampleBias
 * - .grad(ddx, ddy) - use textureSampleGrad
 * - .offset(offset) - add offset parameter (2D only)
 * - .load(coords, level?) - use textureLoad (no sampler)
 */
export declare class TextureNode extends Node<d.vec4f> {
    readonly isTextureNode = true;
    /** The texture binding, holds GPU resource, textureId, group. */
    readonly bindingNode: TextureBindingNode<FlatSampledTexture>;
    /**
     * The UV node for texture coordinates.
     * Defaults to varying(uv()) if not specified.
     */
    uvNode: Node<d.vec2f>;
    /**
     * The reference node
     * When sampling with different UVs, this points to the base texture node.
     */
    referenceNode: TextureNode | null;
    /**
     * The sampler node for this texture.
     * Auto-created by texture() factory from texture settings.
     * Can be set explicitly for custom sampler sharing.
     */
    samplerNode: SamplerNode<d.sampler> | null;
    /** Current sampling mode */
    samplingMode: SamplingMode;
    /** Level node for textureSampleLevel (f32 for regular textures) */
    levelNode: Node<d.f32> | null;
    /** Bias node for textureSampleBias */
    biasNode: Node<d.f32> | null;
    /** Gradient nodes for textureSampleGrad [ddx, ddy] */
    gradNode: [Node<d.vec2f>, Node<d.vec2f>] | null;
    /** Offset node for sampling with offset (2D and 2D-array only, must be const) */
    offsetNode: Node<d.vec2i> | null;
    /** Integer coordinates for textureLoad */
    loadCoords: Node<d.vec2i> | null;
    /** Level for textureLoad (i32) */
    loadLevel: Node<d.i32> | null;
    constructor(bindingNode: TextureBindingNode<FlatSampledTexture>, uvNode?: Node<d.vec2f> | null);
    /** Get the base texture node (follows referenceNode chain) */
    getBase(): TextureNode;
    /** Convert this texture node to a sampler type */
    convert(type: 'sampler' | 'sampler_comparison'): CallNode<d.sampler | d.samplerComparison>;
    /** Clone this texture node with all sampling properties */
    clone(): TextureNode;
    /** Sample the texture at the given UV coordinates */
    sample(uvNode: Node<d.vec2f>): TextureNode;
    /** Use textureSampleLevel with explicit mip level */
    level(levelNode: Node<d.f32>): TextureNode;
    /** Use textureSampleBias with mip level bias */
    bias(biasNode: Node<d.f32>): TextureNode;
    /** Use textureSampleGrad with explicit gradients */
    grad(ddx: Node<d.vec2f>, ddy: Node<d.vec2f>): TextureNode;
    /** Add offset to sampling (2D and 2D-array only, must be const expression) */
    offset(offsetNode: Node<d.vec2i>): TextureNode;
    /** Use textureLoad for direct texel fetch (no filtering) */
    load(coords: Node<d.vec2i>, level?: Node<d.i32>): TextureNode;
}
/**
 * High-level texture types that have _gpuSampler.
 * All have ._gpuTexture and ._gpuSampler properties.
 */
type HighLevelTexture = Texture | CubeTexture | DepthTexture | ArrayTexture;
/**
 * Create a sampler node.
 *
 * Accepts either:
 * - A GpuSampler directly (low-level)
 * - A high-level texture (Texture, CubeTexture, etc.) to extract _gpuSampler from
 *
 * @example
 * // From high-level texture
 * const s = sampler(myTexture);
 *
 * // From GpuSampler directly
 * const gpuSampler = new GpuSampler({ minFilter: 'nearest' });
 * const s = sampler(gpuSampler);
 */
export declare function sampler(source: GpuSampler, group?: UniformGroup): SamplerNode<d.sampler>;
export declare function sampler(source: HighLevelTexture, group?: UniformGroup): SamplerNode<d.sampler>;
/**
 * Create a comparison sampler node for shadow mapping.
 *
 * Accepts either:
 * - A GpuSampler directly (low-level) - will create a new GpuSampler with compare function added
 * - A high-level texture to extract _gpuSampler settings from
 *
 * @example
 * // From high-level depth texture
 * const cmpSampler = comparisonSampler(myDepthTex, 'less');
 *
 * // From GpuSampler directly
 * const gpuSampler = new GpuSampler({ minFilter: 'linear' });
 * const cmpSampler = comparisonSampler(gpuSampler, 'less');
 */
export declare function comparisonSampler(source: GpuSampler, compare?: GPUCompareFunction, group?: UniformGroup): SamplerNode<d.samplerComparison>;
export declare function comparisonSampler(source: HighLevelTexture, compare?: GPUCompareFunction, group?: UniformGroup): SamplerNode<d.samplerComparison>;
/**
 * Create a texture node for sampling a 2D texture.
 *
 * Accepts either:
 * - A high-level Texture object (auto-creates sampler from texture settings)
 * - A GpuTexture + GpuSampler pair (low-level)
 *
 * @example
 * // From high-level Texture
 * const albedo = texture(myTexture);
 *
 * // From GpuTexture + GpuSampler (low-level)
 * const albedo = texture(gpuTex, gpuSampler);
 *
 * // Sampling methods
 * albedo.sample(customUv)              // textureSample with custom UVs
 * albedo.level(float(2))               // textureSampleLevel
 * albedo.bias(float(1))                // textureSampleBias
 * albedo.grad(ddx, ddy)                // textureSampleGrad
 * albedo.offset(vec2i(1, 0))           // with offset
 * albedo.load(vec2i(10, 20))           // textureLoad
 */
export declare function texture(tex: Texture): TextureNode;
export declare function texture(gpuTex: GpuTexture<FlatSampledTexture>, gpuSampler: GpuSampler): TextureNode;
export declare function texture(storageTex: GpuTexture<d.StorageTexture>, gpuSampler: GpuSampler): TextureNode;
/**
 * Create a standalone texture binding node.
 *
 * Use this when you want to work with WGSL-level free functions directly
 * (textureSample, textureLoad, etc.) instead of the high-level TextureNode
 * sampling API.
 */
export declare const textureBinding: <D extends d.Texture>(tex: {
    _gpuTexture: GpuTexture<D>;
    id: number;
}, textureDesc: D) => TextureBindingNode<D>;
/**
 * Sampling mode for cube texture operations.
 * Cube textures do NOT support offset or load.
 */
export type CubeSamplingMode = 'sample' | 'level' | 'bias' | 'grad';
/**
 * CubeTextureNode - represents a cube texture sample operation.
 *
 * Cube textures use a 3D direction vector for sampling (vec3f).
 * WGSL cube texture constraints:
 * - NO offset support (cube textures don't support offset parameter)
 * - NO textureLoad support (cube textures don't support direct texel access)
 * - Uses vec3f for both coordinates and gradients
 *
 * Supports chainable methods:
 * - .sample(direction) - set sampling direction
 * - .level(level) - use textureSampleLevel
 * - .bias(bias) - use textureSampleBias
 * - .grad(ddx, ddy) - use textureSampleGrad
 */
export declare class CubeTextureNode extends Node<d.vec4f> {
    readonly isCubeTextureNode = true;
    /** The texture binding, holds GPU resource, textureId, group. */
    readonly bindingNode: TextureBindingNode<CubeSampledTexture>;
    /**
     * The direction node for cube texture sampling (vec3f).
     * This is a 3D direction vector pointing into the cube.
     */
    directionNode: Node<d.vec3f> | null;
    /**
     * The reference node.
     * When sampling with different directions, this points to the base texture node.
     */
    referenceNode: CubeTextureNode | null;
    /**
     * The sampler node for this texture.
     * Auto-created by cubeTexture() factory from texture settings.
     */
    samplerNode: SamplerNode<d.sampler> | null;
    /** Current sampling mode */
    samplingMode: CubeSamplingMode;
    /** Level node for textureSampleLevel (f32) */
    levelNode: Node<d.f32> | null;
    /** Bias node for textureSampleBias */
    biasNode: Node<d.f32> | null;
    /** Gradient nodes for textureSampleGrad [ddx, ddy] - vec3f for cube textures */
    gradNode: [Node<d.vec3f>, Node<d.vec3f>] | null;
    constructor(bindingNode: TextureBindingNode<CubeSampledTexture>, directionNode?: Node<d.vec3f> | null);
    /** Get the base texture node (follows referenceNode chain) */
    getBase(): CubeTextureNode;
    /** Clone this texture node with all sampling properties */
    clone(): CubeTextureNode;
    /** Sample the cube texture in the given direction */
    sample(directionNode: Node<d.vec3f>): CubeTextureNode;
    /** Use textureSampleLevel with explicit mip level */
    level(levelNode: Node<d.f32>): CubeTextureNode;
    /** Use textureSampleBias with mip level bias */
    bias(biasNode: Node<d.f32>): CubeTextureNode;
    /** Use textureSampleGrad with explicit gradients (vec3f for cube textures) */
    grad(ddx: Node<d.vec3f>, ddy: Node<d.vec3f>): CubeTextureNode;
}
/**
 * Create a cube texture node from a CubeTexture object.
 * Auto-creates a SamplerNode from the texture's settings.
 *
 * @param tex - The CubeTexture object containing 6 face images
 *
 * @example
 * // From high-level CubeTexture
 * const env = cubeTexture(myCubeTex);
 *
 * // From GpuTexture + GpuSampler (low-level)
 * const env = cubeTexture(gpuCubeTex, gpuSampler);
 *
 * // Sampling methods
 * env.sample(reflectDir)                    // textureSample with direction
 * env.sample(reflectDir).level(float(0))    // textureSampleLevel
 * env.sample(reflectDir).bias(float(1))     // textureSampleBias
 * env.sample(reflectDir).grad(ddx, ddy)     // textureSampleGrad
 * // NO .offset() - not supported for cube textures
 * // NO .load() - not supported for cube textures
 */
export declare function cubeTexture(tex: CubeTexture): CubeTextureNode;
export declare function cubeTexture(gpuTex: GpuTexture<CubeSampledTexture>, gpuSampler: GpuSampler): CubeTextureNode;
/**
 * Sampling mode for depth texture operations.
 * Depth textures do NOT support bias or grad.
 */
export type DepthSamplingMode = 'sample' | 'level' | 'load';
/**
 * DepthTextureNode - represents a depth texture sample operation.
 *
 * Maps to WGSL `texture_depth_2d`. Returns f32 (not vec4f).
 *
 * Key differences from regular TextureNode:
 * - Returns f32 (single depth value)
 * - Level is i32 (not f32) for textureSampleLevel
 * - NO textureSampleBias support
 * - NO textureSampleGrad support
 * - Supports offset (2D depth textures)
 * - Comparison sampling via free functions (textureSampleCompare/textureSampleCompareLevel)
 *   which require a sampler_comparison, use comparisonSampler() to create one
 *
 * Supports chainable methods:
 * - .sample(uv) - set UV coordinates
 * - .level(level) - use textureSampleLevel (i32 level)
 * - .offset(offset) - add offset parameter
 * - .load(coords, level?) - use textureLoad
 */
export declare class DepthTextureNode extends Node<d.f32> {
    readonly isDepthTextureNode = true;
    /** The texture binding, holds GPU resource, textureId, group. */
    readonly bindingNode: TextureBindingNode<FlatDepthTexture>;
    /**
     * The UV node for texture coordinates (vec2f).
     * Defaults to varying(uv()) if not specified.
     */
    uvNode: Node<d.vec2f>;
    /**
     * The reference node.
     * When sampling with different UVs, this points to the base texture node.
     */
    referenceNode: DepthTextureNode | null;
    /**
     * The sampler node for this texture.
     * Auto-created by depthTexture() factory from texture settings.
     * This is a regular sampler for textureSample/textureSampleLevel.
     * For comparison sampling, use comparisonSampler() and the free functions.
     */
    samplerNode: SamplerNode<d.sampler> | null;
    /** Current sampling mode */
    samplingMode: DepthSamplingMode;
    /** Level node for textureSampleLevel (i32 for depth textures) */
    levelNode: Node<d.i32> | null;
    /** Offset node for sampling with offset (must be const expression) */
    offsetNode: Node<d.vec2i> | null;
    /** Integer coordinates for textureLoad */
    loadCoords: Node<d.vec2i> | null;
    /** Level for textureLoad (i32) */
    loadLevel: Node<d.i32> | null;
    constructor(bindingNode: TextureBindingNode<FlatDepthTexture>, uvNode?: Node<d.vec2f> | null);
    /** Get the base texture node (follows referenceNode chain) */
    getBase(): DepthTextureNode;
    /** Clone this texture node with all sampling properties */
    clone(): DepthTextureNode;
    /** Sample the depth texture at the given UV coordinates */
    sample(uvNode: Node<d.vec2f>): DepthTextureNode;
    /** Use textureSampleLevel with explicit mip level (i32 for depth textures) */
    level(levelNode: Node<d.i32>): DepthTextureNode;
    /** Add offset to sampling (must be const expression) */
    offset(offsetNode: Node<d.vec2i>): DepthTextureNode;
    /** Use textureLoad for direct texel fetch (no filtering) */
    load(coords: Node<d.vec2i>, level?: Node<d.i32>): DepthTextureNode;
}
/**
 * Create a depth texture node.
 *
 * Accepts either:
 * - A high-level DepthTexture object (auto-creates sampler from texture settings)
 * - A GpuTexture + GpuSampler pair (low-level)
 *
 * For comparison sampling (shadow mapping), create a comparison sampler separately:
 * ```
 * const shadow = depthTexture(myDepthTex);
 * const cmpSampler = comparisonSampler(myDepthTex, 'less');
 * // Regular depth read:
 * shadow.sample(uv)
 * // Comparison sampling (shadow test):
 * textureSampleCompare(shadow, cmpSampler, uv, depthRef)
 * ```
 *
 * @example
 * // From high-level DepthTexture
 * const shadow = depthTexture(myDepthTex);
 *
 * // From GpuTexture + GpuSampler (low-level)
 * const shadow = depthTexture(gpuDepthTex, gpuSampler);
 */
export declare function depthTexture(tex: DepthTexture): DepthTextureNode;
export declare function depthTexture(gpuTex: GpuTexture<FlatDepthTexture>, gpuSampler: GpuSampler): DepthTextureNode;
/**
 * Sampling mode for array texture operations.
 * Array textures support all the same modes as 2D textures.
 */
export type ArraySamplingMode = 'sample' | 'level' | 'bias' | 'grad' | 'load';
/**
 * ArrayTextureNode - represents a 2D array texture sample operation.
 *
 * Maps to WGSL `texture_2d_array<f32>`. Returns vec4f.
 *
 * Key differences from regular TextureNode:
 * - Has a `layerNode` (i32) for the array layer index
 * - WGSL inserts the array_index after coords in all sampling calls
 * - Uses vec2f coords + i32 array_index (not vec3f)
 *
 * Supports chainable methods:
 * - .layer(index) - set the array layer index
 * - .sample(uv) - set UV coordinates
 * - .level(level) - use textureSampleLevel
 * - .bias(bias) - use textureSampleBias
 * - .grad(ddx, ddy) - use textureSampleGrad
 * - .offset(offset) - add offset parameter
 * - .load(coords, level?) - use textureLoad
 */
export declare class ArrayTextureNode extends Node<d.vec4f> {
    readonly isArrayTextureNode = true;
    /** The texture binding, holds GPU resource, textureId, group. */
    readonly bindingNode: TextureBindingNode<d.texture2dArray>;
    /**
     * The UV node for texture coordinates (vec2f).
     * Defaults to varying(uv()) if not specified.
     */
    uvNode: Node<d.vec2f>;
    /** The array layer index (i32). */
    layerNode: Node<d.i32>;
    /**
     * The reference node.
     * When sampling with different UVs/layers, this points to the base texture node.
     */
    referenceNode: ArrayTextureNode | null;
    /**
     * The sampler node for this texture.
     * Auto-created by arrayTexture() factory from texture settings.
     */
    samplerNode: SamplerNode<d.sampler> | null;
    /** Current sampling mode */
    samplingMode: ArraySamplingMode;
    /** Level node for textureSampleLevel (f32) */
    levelNode: Node<d.f32> | null;
    /** Bias node for textureSampleBias */
    biasNode: Node<d.f32> | null;
    /** Gradient nodes for textureSampleGrad [ddx, ddy] (vec2f) */
    gradNode: [Node<d.vec2f>, Node<d.vec2f>] | null;
    /** Offset node for sampling with offset (must be const expression) */
    offsetNode: Node<d.vec2i> | null;
    /** Integer coordinates for textureLoad */
    loadCoords: Node<d.vec2i> | null;
    /** Level for textureLoad (i32) */
    loadLevel: Node<d.i32> | null;
    constructor(bindingNode: TextureBindingNode<d.texture2dArray>, layerNode: Node<d.i32>, uvNode?: Node<d.vec2f> | null);
    /** Get the base texture node (follows referenceNode chain) */
    getBase(): ArrayTextureNode;
    /** Clone this texture node with all sampling properties */
    clone(): ArrayTextureNode;
    /** Set the array layer index */
    layer(layerNode: Node<d.i32>): ArrayTextureNode;
    /** Sample the texture at the given UV coordinates */
    sample(uvNode: Node<d.vec2f>): ArrayTextureNode;
    /** Use textureSampleLevel with explicit mip level */
    level(levelNode: Node<d.f32>): ArrayTextureNode;
    /** Use textureSampleBias with mip level bias */
    bias(biasNode: Node<d.f32>): ArrayTextureNode;
    /** Use textureSampleGrad with explicit gradients */
    grad(ddx: Node<d.vec2f>, ddy: Node<d.vec2f>): ArrayTextureNode;
    /** Add offset to sampling (must be const expression) */
    offset(offsetNode: Node<d.vec2i>): ArrayTextureNode;
    /** Use textureLoad for direct texel fetch (no filtering) */
    load(coords: Node<d.vec2i>, level?: Node<d.i32>): ArrayTextureNode;
}
/**
 * Create an array texture node.
 *
 * Accepts either:
 * - A high-level ArrayTexture object (auto-creates sampler from texture settings)
 * - A GpuTexture + GpuSampler pair (low-level)
 *
 * @param layerNode - The initial array layer index (i32 node)
 *
 * @example
 * // From high-level ArrayTexture
 * const frames = arrayTexture(myArrayTex, i32(0));
 *
 * // From GpuTexture + GpuSampler (low-level)
 * const frames = arrayTexture(gpuArrayTex, gpuSampler, i32(0));
 *
 * // Sampling methods
 * frames.layer(frameIndex)                   // change layer
 * frames.sample(customUv)                    // change UVs
 * frames.level(float(2))                     // textureSampleLevel
 * frames.bias(float(1))                      // textureSampleBias
 * frames.grad(ddx, ddy)                      // textureSampleGrad
 * frames.offset(vec2i(1, 0))                 // with offset
 * frames.load(vec2i(10, 20))                 // textureLoad
 */
export declare function arrayTexture(tex: ArrayTexture, layerNode: Node<d.i32>): ArrayTextureNode;
export declare function arrayTexture(gpuTex: GpuTexture<d.texture2dArray>, gpuSampler: GpuSampler, layerNode: Node<d.i32>): ArrayTextureNode;
type AnySamplerNode = SamplerNode<d.sampler>;
type AnyComparisonSamplerNode = SamplerNode<d.samplerComparison>;
/**
 * textureSample - Sample a texture at UV coordinates.
 * Fragment shader only.
 */
export declare function textureSample<D extends FlatSampledTexture>(t: TextureBindingNode<D>, s: AnySamplerNode, coords: Node<d.vec2f>, offset?: Node<d.vec2i>): CallNode<d.TextureSampleResultOf<D>>;
/**
 * textureSampleLevel - Sample a texture at a specific mip level.
 * Works in any shader stage.
 */
export declare function textureSampleLevel<D extends FlatSampledTexture>(t: TextureBindingNode<D>, s: AnySamplerNode, coords: Node<d.vec2f>, level: Node<d.f32>, offset?: Node<d.vec2i>): CallNode<d.TextureSampleResultOf<D>>;
/**
 * textureSampleBias - Sample a texture with mip level bias.
 * Fragment shader only. Not supported for depth textures.
 */
export declare function textureSampleBias<D extends FlatSampledTexture>(t: TextureBindingNode<D>, s: AnySamplerNode, coords: Node<d.vec2f>, bias: Node<d.f32>, offset?: Node<d.vec2i>): CallNode<d.TextureSampleResultOf<D>>;
/**
 * textureSampleGrad - Sample a texture with explicit gradients.
 * Works in any shader stage. Not supported for depth textures.
 */
export declare function textureSampleGrad<D extends FlatSampledTexture>(t: TextureBindingNode<D>, s: AnySamplerNode, coords: Node<d.vec2f>, ddx: Node<d.vec2f>, ddy: Node<d.vec2f>, offset?: Node<d.vec2i>): CallNode<d.TextureSampleResultOf<D>>;
/**
 * textureSampleCompare - Compare-sample a depth texture.
 * Fragment shader only. Requires sampler_comparison.
 */
export declare function textureSampleCompare(t: TextureBindingNode<FlatDepthTexture>, s: AnyComparisonSamplerNode, coords: Node<d.vec2f>, depthRef: Node<d.f32>, offset?: Node<d.vec2i>): CallNode<d.f32>;
/**
 * textureSampleCompareLevel - Compare-sample a depth texture at a specific level.
 * Works in any shader stage. Requires sampler_comparison.
 */
export declare function textureSampleCompareLevel(t: TextureBindingNode<FlatDepthTexture>, s: AnyComparisonSamplerNode, coords: Node<d.vec2f>, depthRef: Node<d.f32>, level: Node<d.i32>, offset?: Node<d.vec2i>): CallNode<d.f32>;
/** Integer coordinate node accepted by storage textureStore/textureLoad. */
export type StorageCoord = Node<d.u32> | Node<d.i32> | Node<d.vec2u> | Node<d.vec2i> | Node<d.vec3u> | Node<d.vec3i>;
/** vec4 value node accepted by storage textureStore. */
export type StorageValue = Node<d.vec4f> | Node<d.vec4i> | Node<d.vec4u>;
/**
 * textureLoad - Load a texel directly without filtering.
 * - Sampled textures: needs a mip `level`. Works in any stage. No sampler.
 * - Storage textures (read / read_write): no level; returns `vec4<channel>` for the format.
 */
export declare function textureLoad<D extends d.Texture>(t: TextureBindingNode<D>, coords: Node<d.vec2i>, level: Node<d.i32>): CallNode<d.TextureSampleResultOf<D>>;
export declare function textureLoad<D extends d.StorageTexture>(t: StorageTextureBindingNode<D>, coords: StorageCoord, layer?: Node<d.i32> | Node<d.u32>): CallNode<d.vec4f | d.vec4i | d.vec4u>;
/**
 * textureStore - Store a value into a storage texture (a statement / side effect).
 *
 * 2D/3D: `textureStore(tex, coords, value)`. 2D-array: pass the array `layer` between
 * coords and value. The binding must have access 'write' or 'read_write'.
 */
export declare function textureStore<D extends d.StorageTexture>(t: StorageTextureBindingNode<D>, coords: StorageCoord, value: StorageValue, layer?: Node<d.i32> | Node<d.u32>): void;
/**
 * textureDimensions - Get texture dimensions.
 */
export declare function textureDimensions(t: TextureBindingNode, level?: Node<d.u32>): CallNode<d.vec2u>;
/**
 * textureNumLevels - Get number of mip levels.
 */
export declare function textureNumLevels(t: TextureBindingNode): CallNode<d.u32>;
/**
 * textureNumLayers - Get number of array layers.
 */
export declare function textureNumLayers(t: Node<Any>): CallNode<d.u32>;
/**
 * textureGather - Gather a single component from 4 texels.
 */
export declare function textureGather<D extends FlatSampledTexture>(component: Node<d.i32>, t: TextureBindingNode<D>, s: AnySamplerNode, coords: Node<d.vec2f>, offset?: Node<d.vec2i>): CallNode<d.TextureSampleResultOf<D>>;
/**
 * textureGatherCompare - Gather compare results from 4 texels.
 * Requires sampler_comparison.
 */
export declare function textureGatherCompare(t: TextureBindingNode<FlatDepthTexture>, s: AnyComparisonSamplerNode, coords: Node<d.vec2f>, depthRef: Node<d.f32>, offset?: Node<d.vec2i>): CallNode<d.vec4f>;
export {};
