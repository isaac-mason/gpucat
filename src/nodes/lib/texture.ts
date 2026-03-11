import { Texture } from '../../texture/texture';
import { CubeTexture } from '../../texture/cube-texture';
import { DepthTexture } from '../../texture/depth-texture';
import { CallNode, Node } from './core';
import { type DepthTextureDesc, type FlatDepthTextureDesc, type FlatSampledTextureDesc, type CubeSampledTextureDesc, type Any, texture2d, textureCube, textureDepth2d, type AnyTextureDesc } from '../schema';
import * as d from '../schema';
import { UniformGroup, objectGroup } from './uniform';
import { uv } from './attribute';
import { varying } from './varying';

/**
 * SamplerNode - represents a sampler binding.
 * 
 * Samplers are first-class nodes with their own bindings, mirroring WGSL's
 * separate texture/sampler model.
 */
export class SamplerNode<D extends d.SamplerDesc | d.SamplerComparisonDesc = d.SamplerDesc> extends Node<D> {
    /** GPU sampler resource. Set by the renderer. */
    resource: GPUSampler | null = null;

    /** Unique ID for this sampler instance */
    readonly samplerId: string;

    /** Uniform group — determines @group index. */
    groupNode: UniformGroup;

    // Sampling parameters
    minFilter: GPUFilterMode = 'linear';
    magFilter: GPUFilterMode = 'linear';
    mipmapFilter: GPUMipmapFilterMode = 'linear';
    addressModeU: GPUAddressMode = 'clamp-to-edge';
    addressModeV: GPUAddressMode = 'clamp-to-edge';
    addressModeW: GPUAddressMode = 'clamp-to-edge';
    maxAnisotropy: number = 1;

    /** For sampler_comparison only */
    compare?: GPUCompareFunction;

    constructor(
        desc: D,
        samplerId: string,
        groupNode: UniformGroup = objectGroup
    ) {
        super(desc);
        this.samplerId = samplerId;
        this.groupNode = groupNode;
    }

    /** Settings key for deduplication - samplers with same settings share bindings */
    get settingsKey(): string {
        const base = `${this.minFilter}-${this.magFilter}-${this.mipmapFilter}-${this.addressModeU}-${this.addressModeV}-${this.addressModeW}-${this.maxAnisotropy}`;
        return this.compare ? `${base}-cmp-${this.compare}` : base;
    }

    /** Clone this sampler with same settings */
    clone(): SamplerNode<D> {
        const cloned = new SamplerNode(this.type as D, this.samplerId, this.groupNode);
        cloned.minFilter = this.minFilter;
        cloned.magFilter = this.magFilter;
        cloned.mipmapFilter = this.mipmapFilter;
        cloned.addressModeU = this.addressModeU;
        cloned.addressModeV = this.addressModeV;
        cloned.addressModeW = this.addressModeW;
        cloned.maxAnisotropy = this.maxAnisotropy;
        cloned.compare = this.compare;
        cloned.resource = this.resource;
        return cloned;
    }
}

/* ────────────────────────────────────────────────────────────────────────────
 * TextureBindingNode
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Maps a texture descriptor to its JS texture value type.
 * - DepthTextureDesc → DepthTexture
 * - CubeSampledTextureDesc → CubeTexture
 * - FlatSampledTextureDesc → Texture
 */
export type TextureValueOf<D extends AnyTextureDesc> =
    D extends DepthTextureDesc ? DepthTexture
    : D extends CubeSampledTextureDesc ? CubeTexture
    : Texture;

/**
 * TextureBindingNode - represents a module-scope texture handle binding.
 *
 * This mirrors how SamplerNode works: it represents a `var t : texture_2d<f32>`
 * (or texture_cube<f32>, texture_depth_2d, etc.) at module scope. When used as
 * an expression, it generates just the binding name — never a sampling operation.
 *
 * The existing TextureNode/CubeTextureNode/DepthTextureNode own a
 * TextureBindingNode internally and delegate binding registration to it.
 * Free functions take TextureBindingNode + SamplerNode as arguments, producing
 * correct WGSL like `textureSample(myTex, mySampler, uv)`.
 */
export class TextureBindingNode<D extends AnyTextureDesc = AnyTextureDesc> extends Node<D> {
    /** GPU texture resource. Set this before rendering, or use `value`. */
    resource: GPUTexture | GPUTextureView | null = null;

    /**
     * High-level texture wrapper. The renderer uses this to create/update
     * the GPU texture.
     */
    value: TextureValueOf<D> | null = null;

    /** Unique ID for this texture binding (e.g. 'tAlbedo', 'tShadowMap'). */
    readonly textureId: string;

    /** Uniform group — determines @group index. */
    groupNode: UniformGroup;

    constructor(
        desc: D,
        textureId: string,
        groupNode: UniformGroup = objectGroup,
    ) {
        super(desc);
        this.textureId = textureId;
        this.groupNode = groupNode;
    }
}

/* ────────────────────────────────────────────────────────────────────────────
 * TextureNode
 * ──────────────────────────────────────────────────────────────────────────── */

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
export class TextureNode extends Node<d.vec4f> {
    readonly isTextureNode = true;

    /** The texture binding — holds GPU resource, textureId, groupNode. */
    readonly bindingNode: TextureBindingNode<FlatSampledTextureDesc>;

    /**
     * The UV node for texture coordinates.
     * Defaults to varying(uv()) if not specified.
     */
    uvNode: Node<d.vec2f>;

    /**
     * The reference node
     * When sampling with different UVs, this points to the base texture node.
     */
    referenceNode: TextureNode | null = null;

    /**
     * The sampler node for this texture.
     * Auto-created by texture() factory from texture settings.
     * Can be set explicitly for custom sampler sharing.
     */
    samplerNode: SamplerNode<d.SamplerDesc> | null = null;

    /* ─────────────────────────────────────────────────────────────────────────
     * Sampling mode properties
     * ───────────────────────────────────────────────────────────────────────── */

    /** Current sampling mode */
    samplingMode: SamplingMode = 'sample';

    /** Level node for textureSampleLevel (f32 for regular textures) */
    levelNode: Node<d.f32> | null = null;

    /** Bias node for textureSampleBias */
    biasNode: Node<d.f32> | null = null;

    /** Gradient nodes for textureSampleGrad [ddx, ddy] */
    gradNode: [Node<d.vec2f>, Node<d.vec2f>] | null = null;

    /** Offset node for sampling with offset (2D and 2D-array only, must be const) */
    offsetNode: Node<d.vec2i> | null = null;

    /** Integer coordinates for textureLoad */
    loadCoords: Node<d.vec2i> | null = null;

    /** Level for textureLoad (i32) */
    loadLevel: Node<d.i32> | null = null;

    constructor(
        bindingNode: TextureBindingNode<FlatSampledTextureDesc>,
        uvNode: Node<d.vec2f> | null = null,
    ) {
        // Node type is vec4f (the sampled color)
        super(d.vec4f);
        this.bindingNode = bindingNode;
        this.uvNode = uvNode ?? varying(uv());
    }

    /** Get the base texture node (follows referenceNode chain) */
    getBase(): TextureNode {
        return this.referenceNode ? this.referenceNode.getBase() : this;
    }

    /** Convert this texture node to a sampler type */
    convert(type: 'sampler' | 'sampler_comparison'): CallNode<d.SamplerDesc | d.SamplerComparisonDesc> {
        const desc = type === 'sampler' ? d.sampler : d.samplerComparison;
        return new CallNode(desc, type, [this]);
    }

    /** Clone this texture node with all sampling properties */
    clone(): TextureNode {
        const cloned = new TextureNode(this.bindingNode, this.uvNode);
        cloned.referenceNode = this.referenceNode;
        cloned.samplerNode = this.samplerNode;
        // Copy sampling mode properties
        cloned.samplingMode = this.samplingMode;
        cloned.levelNode = this.levelNode;
        cloned.biasNode = this.biasNode;
        cloned.gradNode = this.gradNode;
        cloned.offsetNode = this.offsetNode;
        cloned.loadCoords = this.loadCoords;
        cloned.loadLevel = this.loadLevel;
        return cloned;
    }

    /* ─────────────────────────────────────────────────────────────────────────
     * Chainable sampling methods
     * ───────────────────────────────────────────────────────────────────────── */

    /** Sample the texture at the given UV coordinates */
    sample(uvNode: Node<d.vec2f>): TextureNode {
        const textureNode = this.clone();
        textureNode.uvNode = uvNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Use textureSampleLevel with explicit mip level */
    level(levelNode: Node<d.f32>): TextureNode {
        const textureNode = this.clone();
        textureNode.samplingMode = 'level';
        textureNode.levelNode = levelNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Use textureSampleBias with mip level bias */
    bias(biasNode: Node<d.f32>): TextureNode {
        const textureNode = this.clone();
        textureNode.samplingMode = 'bias';
        textureNode.biasNode = biasNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Use textureSampleGrad with explicit gradients */
    grad(ddx: Node<d.vec2f>, ddy: Node<d.vec2f>): TextureNode {
        const textureNode = this.clone();
        textureNode.samplingMode = 'grad';
        textureNode.gradNode = [ddx, ddy];
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Add offset to sampling (2D and 2D-array only, must be const expression) */
    offset(offsetNode: Node<d.vec2i>): TextureNode {
        const textureNode = this.clone();
        textureNode.offsetNode = offsetNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Use textureLoad for direct texel fetch (no filtering) */
    load(coords: Node<d.vec2i>, level?: Node<d.i32>): TextureNode {
        const textureNode = this.clone();
        textureNode.samplingMode = 'load';
        textureNode.loadCoords = coords;
        textureNode.loadLevel = level ?? null;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Factory Functions
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Create a sampler node from a Texture object's settings.
 */
export const sampler = (tex: Texture, groupNode: UniformGroup = objectGroup): SamplerNode<d.SamplerDesc> => {
    const node = new SamplerNode(d.sampler, `s${tex.id}`, groupNode);
    // Copy settings from texture
    node.minFilter = tex.minFilter;
    node.magFilter = tex.magFilter;
    node.mipmapFilter = tex.mipmapFilter;
    node.addressModeU = tex.wrapS;
    node.addressModeV = tex.wrapT;
    node.addressModeW = 'clamp-to-edge'; // wrapR for 3D textures, will add to Texture later
    node.maxAnisotropy = tex.anisotropy;
    return node;
};

/**
 * Create a comparison sampler node for shadow mapping.
 */
export const comparisonSampler = (
    tex: Texture,
    compare: GPUCompareFunction = 'less',
    groupNode: UniformGroup = objectGroup
): SamplerNode<d.SamplerComparisonDesc> => {
    const node = new SamplerNode(d.samplerComparison, `s${tex.id}_cmp`, groupNode);
    // Copy settings from texture
    node.minFilter = tex.minFilter;
    node.magFilter = tex.magFilter;
    node.mipmapFilter = tex.mipmapFilter;
    node.addressModeU = tex.wrapS;
    node.addressModeV = tex.wrapT;
    node.addressModeW = 'clamp-to-edge'; // wrapR for 3D textures, will add to Texture later
    node.maxAnisotropy = tex.anisotropy;
    node.compare = compare;
    return node;
};

/**
 * Create a texture node from a Texture object.
 * Auto-creates a SamplerNode from the texture's settings.
 *
 * @param tex - The Texture object containing image data
 * @param textureDesc - Optional texture type descriptor (default: texture2d())
 *
 * @example
 * const albedo = texture(myTexture);
 * albedo.sample(customUv)              // textureSample with custom UVs
 * albedo.level(float(2))               // textureSampleLevel
 * albedo.bias(float(1))                // textureSampleBias
 * albedo.grad(ddx, ddy)                // textureSampleGrad
 * albedo.offset(vec2i(1, 0))           // with offset
 * albedo.load(vec2i(10, 20))           // textureLoad
 */
export const texture = (
    tex: Texture,
    textureDesc: FlatSampledTextureDesc = texture2d()
): TextureNode => {
    const binding = new TextureBindingNode(textureDesc, `t${tex.id}`);
    binding.value = tex;
    const node = new TextureNode(binding);
    // Auto-create sampler from texture settings
    node.samplerNode = sampler(tex, binding.groupNode);
    return node;
};

/**
 * Create a standalone texture binding node.
 *
 * Use this when you want to work with WGSL-level free functions directly
 * (textureSample, textureLoad, etc.) instead of the high-level TextureNode
 * sampling API.
 */
export const textureBinding = <D extends AnyTextureDesc>(
    tex: TextureValueOf<D>,
    textureDesc: D
): TextureBindingNode<D> => {
    const binding = new TextureBindingNode(textureDesc, `t${tex.id}`);
    binding.value = tex;
    return binding;
};

/* ────────────────────────────────────────────────────────────────────────────
 * CubeTextureNode
 * ──────────────────────────────────────────────────────────────────────────── */

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
export class CubeTextureNode extends Node<d.vec4f> {
    readonly isCubeTextureNode = true;

    /** The texture binding — holds GPU resource, textureId, groupNode. */
    readonly bindingNode: TextureBindingNode<CubeSampledTextureDesc>;

    /**
     * The direction node for cube texture sampling (vec3f).
     * This is a 3D direction vector pointing into the cube.
     */
    directionNode: Node<d.vec3f> | null = null;

    /**
     * The reference node.
     * When sampling with different directions, this points to the base texture node.
     */
    referenceNode: CubeTextureNode | null = null;

    /**
     * The sampler node for this texture.
     * Auto-created by cubeTexture() factory from texture settings.
     */
    samplerNode: SamplerNode<d.SamplerDesc> | null = null;

    /* ─────────────────────────────────────────────────────────────────────────
     * Sampling mode properties
     * ───────────────────────────────────────────────────────────────────────── */

    /** Current sampling mode */
    samplingMode: CubeSamplingMode = 'sample';

    /** Level node for textureSampleLevel (f32) */
    levelNode: Node<d.f32> | null = null;

    /** Bias node for textureSampleBias */
    biasNode: Node<d.f32> | null = null;

    /** Gradient nodes for textureSampleGrad [ddx, ddy] - vec3f for cube textures */
    gradNode: [Node<d.vec3f>, Node<d.vec3f>] | null = null;

    constructor(
        bindingNode: TextureBindingNode<CubeSampledTextureDesc>,
        directionNode: Node<d.vec3f> | null = null,
    ) {
        // Node type is vec4f (the sampled color)
        super(d.vec4f);
        this.bindingNode = bindingNode;
        this.directionNode = directionNode;
    }

    /** Get the base texture node (follows referenceNode chain) */
    getBase(): CubeTextureNode {
        return this.referenceNode ? this.referenceNode.getBase() : this;
    }

    /** Clone this texture node with all sampling properties */
    clone(): CubeTextureNode {
        const cloned = new CubeTextureNode(this.bindingNode, this.directionNode);
        cloned.referenceNode = this.referenceNode;
        cloned.samplerNode = this.samplerNode;
        // Copy sampling mode properties
        cloned.samplingMode = this.samplingMode;
        cloned.levelNode = this.levelNode;
        cloned.biasNode = this.biasNode;
        cloned.gradNode = this.gradNode;
        return cloned;
    }

    /* ─────────────────────────────────────────────────────────────────────────
     * Chainable sampling methods
     * ───────────────────────────────────────────────────────────────────────── */

    /** Sample the cube texture in the given direction */
    sample(directionNode: Node<d.vec3f>): CubeTextureNode {
        const textureNode = this.clone();
        textureNode.directionNode = directionNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Use textureSampleLevel with explicit mip level */
    level(levelNode: Node<d.f32>): CubeTextureNode {
        const textureNode = this.clone();
        textureNode.samplingMode = 'level';
        textureNode.levelNode = levelNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Use textureSampleBias with mip level bias */
    bias(biasNode: Node<d.f32>): CubeTextureNode {
        const textureNode = this.clone();
        textureNode.samplingMode = 'bias';
        textureNode.biasNode = biasNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Use textureSampleGrad with explicit gradients (vec3f for cube textures) */
    grad(ddx: Node<d.vec3f>, ddy: Node<d.vec3f>): CubeTextureNode {
        const textureNode = this.clone();
        textureNode.samplingMode = 'grad';
        textureNode.gradNode = [ddx, ddy];
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    // NOTE: NO .offset() method - cube textures don't support offset in WGSL
    // NOTE: NO .load() method - cube textures don't support textureLoad in WGSL
}

/**
 * Create a cube texture node from a CubeTexture object.
 * Auto-creates a SamplerNode from the texture's settings.
 *
 * @param tex - The CubeTexture object containing 6 face images
 *
 * @example
 * const env = cubeTexture(myCubeTex);
 * env.sample(reflectDir)                    // textureSample with direction
 * env.sample(reflectDir).level(float(0))    // textureSampleLevel
 * env.sample(reflectDir).bias(float(1))     // textureSampleBias
 * env.sample(reflectDir).grad(ddx, ddy)     // textureSampleGrad
 * // NO .offset() - not supported for cube textures
 * // NO .load() - not supported for cube textures
 */
export const cubeTexture = (tex: CubeTexture): CubeTextureNode => {
    const desc = textureCube();
    const binding = new TextureBindingNode(desc, `t${tex.id}`);
    binding.value = tex;
    const node = new CubeTextureNode(binding);
    // Auto-create sampler from texture settings (CubeTexture has same filter/wrap properties)
    node.samplerNode = sampler(tex as unknown as Texture, binding.groupNode);
    return node;
};

/* ────────────────────────────────────────────────────────────────────────────
 * DepthTextureNode
 * ──────────────────────────────────────────────────────────────────────────── */

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
 *   which require a sampler_comparison — use comparisonSampler() to create one
 *
 * Supports chainable methods:
 * - .sample(uv) - set UV coordinates
 * - .level(level) - use textureSampleLevel (i32 level)
 * - .offset(offset) - add offset parameter
 * - .load(coords, level?) - use textureLoad
 */
export class DepthTextureNode extends Node<d.f32> {
    readonly isDepthTextureNode = true;

    /** The texture binding — holds GPU resource, textureId, groupNode. */
    readonly bindingNode: TextureBindingNode<FlatDepthTextureDesc>;

    /**
     * The UV node for texture coordinates (vec2f).
     * Defaults to varying(uv()) if not specified.
     */
    uvNode: Node<d.vec2f>;

    /**
     * The reference node.
     * When sampling with different UVs, this points to the base texture node.
     */
    referenceNode: DepthTextureNode | null = null;

    /**
     * The sampler node for this texture.
     * Auto-created by depthTexture() factory from texture settings.
     * This is a regular sampler for textureSample/textureSampleLevel.
     * For comparison sampling, use comparisonSampler() and the free functions.
     */
    samplerNode: SamplerNode<d.SamplerDesc> | null = null;

    /* ─────────────────────────────────────────────────────────────────────────
     * Sampling mode properties
     * ───────────────────────────────────────────────────────────────────────── */

    /** Current sampling mode */
    samplingMode: DepthSamplingMode = 'sample';

    /** Level node for textureSampleLevel (i32 for depth textures) */
    levelNode: Node<d.i32> | null = null;

    /** Offset node for sampling with offset (must be const expression) */
    offsetNode: Node<d.vec2i> | null = null;

    /** Integer coordinates for textureLoad */
    loadCoords: Node<d.vec2i> | null = null;

    /** Level for textureLoad (i32) */
    loadLevel: Node<d.i32> | null = null;

    constructor(
        bindingNode: TextureBindingNode<FlatDepthTextureDesc>,
        uvNode: Node<d.vec2f> | null = null,
    ) {
        // Node type is f32 (depth value)
        super(d.f32);
        this.bindingNode = bindingNode;
        this.uvNode = uvNode ?? varying(uv());
    }

    /** Get the base texture node (follows referenceNode chain) */
    getBase(): DepthTextureNode {
        return this.referenceNode ? this.referenceNode.getBase() : this;
    }

    /** Clone this texture node with all sampling properties */
    clone(): DepthTextureNode {
        const cloned = new DepthTextureNode(this.bindingNode, this.uvNode);
        cloned.referenceNode = this.referenceNode;
        cloned.samplerNode = this.samplerNode;
        // Copy sampling mode properties
        cloned.samplingMode = this.samplingMode;
        cloned.levelNode = this.levelNode;
        cloned.offsetNode = this.offsetNode;
        cloned.loadCoords = this.loadCoords;
        cloned.loadLevel = this.loadLevel;
        return cloned;
    }

    /* ─────────────────────────────────────────────────────────────────────────
     * Chainable sampling methods
     * ───────────────────────────────────────────────────────────────────────── */

    /** Sample the depth texture at the given UV coordinates */
    sample(uvNode: Node<d.vec2f>): DepthTextureNode {
        const textureNode = this.clone();
        textureNode.uvNode = uvNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Use textureSampleLevel with explicit mip level (i32 for depth textures) */
    level(levelNode: Node<d.i32>): DepthTextureNode {
        const textureNode = this.clone();
        textureNode.samplingMode = 'level';
        textureNode.levelNode = levelNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Add offset to sampling (must be const expression) */
    offset(offsetNode: Node<d.vec2i>): DepthTextureNode {
        const textureNode = this.clone();
        textureNode.offsetNode = offsetNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Use textureLoad for direct texel fetch (no filtering) */
    load(coords: Node<d.vec2i>, level?: Node<d.i32>): DepthTextureNode {
        const textureNode = this.clone();
        textureNode.samplingMode = 'load';
        textureNode.loadCoords = coords;
        textureNode.loadLevel = level ?? null;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    // NOTE: NO .bias() method - depth textures don't support textureSampleBias in WGSL
    // NOTE: NO .grad() method - depth textures don't support textureSampleGrad in WGSL
    // NOTE: For comparison sampling, use the free functions textureSampleCompare() /
    //       textureSampleCompareLevel() with a comparisonSampler().
}

/**
 * Create a depth texture node from a DepthTexture object.
 * Auto-creates a SamplerNode from the texture's settings.
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
 * @param tex - The DepthTexture object
 */
export const depthTexture = (tex: DepthTexture): DepthTextureNode => {
    const desc = textureDepth2d;
    const binding = new TextureBindingNode(desc, `t${tex.id}`);
    binding.value = tex;
    const node = new DepthTextureNode(binding);
    // Auto-create sampler from texture settings
    node.samplerNode = sampler(tex, binding.groupNode);
    return node;
};

/* ────────────────────────────────────────────────────────────────────────────
 * WGSL-Mapped Free Functions
 * 
 * These are direct 1:1 mappings to WGSL builtins for full control.
 * Use these when you need explicit control over texture/sampler pairing
 * or for comparison sampling.
 * ──────────────────────────────────────────────────────────────────────────── */

// Type aliases for free function parameters
type AnySamplerNode = SamplerNode<d.SamplerDesc>;
type AnyComparisonSamplerNode = SamplerNode<d.SamplerComparisonDesc>;

/**
 * textureSample - Sample a texture at UV coordinates.
 * Fragment shader only.
 */
export function textureSample<D extends FlatSampledTextureDesc>(
    t: TextureBindingNode<D>,
    s: AnySamplerNode,
    coords: Node<d.vec2f>,
    offset?: Node<d.vec2i>
): CallNode<d.TextureSampleResultOf<D>> {
    const args: Node<Any>[] = offset ? [t, s, coords, offset] : [t, s, coords];
    return new CallNode(d.textureSampleResultOf(t.type) as d.TextureSampleResultOf<D>, 'textureSample', args);
}

/**
 * textureSampleLevel - Sample a texture at a specific mip level.
 * Works in any shader stage.
 */
export function textureSampleLevel<D extends FlatSampledTextureDesc>(
    t: TextureBindingNode<D>,
    s: AnySamplerNode,
    coords: Node<d.vec2f>,
    level: Node<d.f32>,
    offset?: Node<d.vec2i>
): CallNode<d.TextureSampleResultOf<D>> {
    const args: Node<Any>[] = offset ? [t, s, coords, level, offset] : [t, s, coords, level];
    return new CallNode(d.textureSampleResultOf(t.type) as d.TextureSampleResultOf<D>, 'textureSampleLevel', args);
}

/**
 * textureSampleBias - Sample a texture with mip level bias.
 * Fragment shader only. Not supported for depth textures.
 */
export function textureSampleBias<D extends FlatSampledTextureDesc>(
    t: TextureBindingNode<D>,
    s: AnySamplerNode,
    coords: Node<d.vec2f>,
    bias: Node<d.f32>,
    offset?: Node<d.vec2i>
): CallNode<d.TextureSampleResultOf<D>> {
    const args: Node<Any>[] = offset ? [t, s, coords, bias, offset] : [t, s, coords, bias];
    return new CallNode(d.textureSampleResultOf(t.type) as d.TextureSampleResultOf<D>, 'textureSampleBias', args);
}

/**
 * textureSampleGrad - Sample a texture with explicit gradients.
 * Works in any shader stage. Not supported for depth textures.
 */
export function textureSampleGrad<D extends FlatSampledTextureDesc>(
    t: TextureBindingNode<D>,
    s: AnySamplerNode,
    coords: Node<d.vec2f>,
    ddx: Node<d.vec2f>,
    ddy: Node<d.vec2f>,
    offset?: Node<d.vec2i>
): CallNode<d.TextureSampleResultOf<D>> {
    const args: Node<Any>[] = offset ? [t, s, coords, ddx, ddy, offset] : [t, s, coords, ddx, ddy];
    return new CallNode(d.textureSampleResultOf(t.type) as d.TextureSampleResultOf<D>, 'textureSampleGrad', args);
}

/**
 * textureSampleCompare - Compare-sample a depth texture.
 * Fragment shader only. Requires sampler_comparison.
 */
export function textureSampleCompare(
    t: TextureBindingNode<FlatDepthTextureDesc>,
    s: AnyComparisonSamplerNode,
    coords: Node<d.vec2f>,
    depthRef: Node<d.f32>,
    offset?: Node<d.vec2i>
): CallNode<d.f32> {
    const args: Node<Any>[] = offset ? [t, s, coords, depthRef, offset] : [t, s, coords, depthRef];
    return new CallNode(d.f32, 'textureSampleCompare', args);
}

/**
 * textureSampleCompareLevel - Compare-sample a depth texture at a specific level.
 * Works in any shader stage. Requires sampler_comparison.
 */
export function textureSampleCompareLevel(
    t: TextureBindingNode<FlatDepthTextureDesc>,
    s: AnyComparisonSamplerNode,
    coords: Node<d.vec2f>,
    depthRef: Node<d.f32>,
    level: Node<d.i32>,
    offset?: Node<d.vec2i>
): CallNode<d.f32> {
    const args: Node<Any>[] = offset ? [t, s, coords, depthRef, level, offset] : [t, s, coords, depthRef, level];
    return new CallNode(d.f32, 'textureSampleCompareLevel', args);
}

/**
 * textureLoad - Load a texel directly without filtering.
 * Works in any shader stage. No sampler needed.
 */
export function textureLoad<D extends AnyTextureDesc>(
    t: TextureBindingNode<D>,
    coords: Node<d.vec2i>,
    level: Node<d.i32>
): CallNode<d.TextureSampleResultOf<D>> {
    return new CallNode(d.textureSampleResultOf(t.type) as d.TextureSampleResultOf<D>, 'textureLoad', [t, coords, level]);
}

/**
 * textureStore - Store a value to a storage texture.
 */
export function textureStore(
    t: Node<Any>, // StorageTextureNode when we add it
    coords: Node<d.vec2i>,
    value: Node<d.vec4f>
): CallNode<d.voidDesc> {
    return new CallNode(d.voidDesc, 'textureStore', [t, coords, value]);
}

/**
 * textureDimensions - Get texture dimensions.
 */
export function textureDimensions(
    t: TextureBindingNode,
    level?: Node<d.u32>
): CallNode<d.vec2u> {
    const args: Node<Any>[] = level ? [t, level] : [t];
    return new CallNode(d.vec2u, 'textureDimensions', args);
}

/**
 * textureNumLevels - Get number of mip levels.
 */
export function textureNumLevels(t: TextureBindingNode): CallNode<d.u32> {
    return new CallNode(d.u32, 'textureNumLevels', [t]);
}

/**
 * textureNumLayers - Get number of array layers.
 */
export function textureNumLayers(t: Node<Any>): CallNode<d.u32> {
    return new CallNode(d.u32, 'textureNumLayers', [t]);
}

/**
 * textureGather - Gather a single component from 4 texels.
 */
export function textureGather<D extends FlatSampledTextureDesc>(
    component: Node<d.i32>,
    t: TextureBindingNode<D>,
    s: AnySamplerNode,
    coords: Node<d.vec2f>,
    offset?: Node<d.vec2i>
): CallNode<d.TextureSampleResultOf<D>> {
    const args: Node<Any>[] = offset ? [component, t, s, coords, offset] : [component, t, s, coords];
    return new CallNode(d.textureSampleResultOf(t.type) as d.TextureSampleResultOf<D>, 'textureGather', args);
}

/**
 * textureGatherCompare - Gather compare results from 4 texels.
 * Requires sampler_comparison.
 */
export function textureGatherCompare(
    t: TextureBindingNode<FlatDepthTextureDesc>,
    s: AnyComparisonSamplerNode,
    coords: Node<d.vec2f>,
    depthRef: Node<d.f32>,
    offset?: Node<d.vec2i>
): CallNode<d.vec4f> {
    const args: Node<Any>[] = offset ? [t, s, coords, depthRef, offset] : [t, s, coords, depthRef];
    return new CallNode(d.vec4f, 'textureGatherCompare', args);
}
