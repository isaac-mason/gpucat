import { Texture } from '../../texture/texture';
import { CallNode, Node } from './core';
import { type TextureDesc, type DepthTextureDesc, type Any, texture2d } from '../schema';
import * as d from '../schema';
import { UniformGroup, objectGroup } from './uniform';
import { uv } from './attribute';
import { varying } from './varying';

/* ────────────────────────────────────────────────────────────────────────────
 * SamplerNode
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * SamplerNode - represents a sampler binding.
 * 
 * Samplers are first-class nodes with their own bindings, mirroring WGSL's
 * separate texture/sampler model.
 */
export class SamplerNode<D extends d.SamplerDesc | d.SamplerComparisonDesc = d.SamplerDesc> extends Node<D> {
    readonly isSamplerNode = true;

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

    /**
     * GPU texture resource. Set this before rendering.
     * This can be set directly, OR use `value` (a Texture object) which the renderer
     * will use to create/update the GPU texture.
     */
    resource: GPUTexture | GPUTextureView | null = null;

    /**
     * GPU sampler resource. Auto-created by the renderer based on the samplerNode's
     * settings (wrap, filter, etc.).
     * @deprecated Use samplerNode.resource instead
     */
    gpuSampler: GPUSampler | null = null;

    /**
     * High-level Texture wrapper.
     * If set, the renderer will use this to create/update the GPU texture.
     *
     * Can be:
     * - Texture (scene texture with image data)
     * - Texture with isRenderTargetTexture = true (render target color attachment)
     * - DepthTexture (render target depth attachment, extends Texture)
     */
    value: Texture | null = null;

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
     * The WGSL texture type string (e.g., 'texture_2d<f32>').
     * Used for binding declarations.
     */
    readonly textureType: string;

    /** Uniform group — determines @group index. Defaults to objectGroup */
    groupNode: UniformGroup;

    /** The texture ID (e.g. 'albedoMap') for caching and reuse. */
    textureId: string;

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
        textureType: string,
        textureId: string,
        uvNode: Node<d.vec2f> | null = null,
        /** Uniform group — determines @group index. Defaults to objectGroup. */
        groupNode: UniformGroup = objectGroup
    ) {
        // Node type is vec4f (the sampled color)
        super(d.vec4f);
        this.textureType = textureType;
        this.textureId = textureId;
        this.uvNode = uvNode ?? varying(uv());
        this.groupNode = groupNode;
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
        const cloned = new TextureNode(this.textureType, this.textureId, this.uvNode, this.groupNode);
        cloned.value = this.value;
        cloned.resource = this.resource;
        cloned.gpuSampler = this.gpuSampler;
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
    textureDesc: TextureDesc | DepthTextureDesc = texture2d()
): TextureNode => {
    const node = new TextureNode(textureDesc.wgslType, `t${tex.id}`);
    node.value = tex;
    // Auto-create sampler from texture settings
    node.samplerNode = sampler(tex, node.groupNode);
    return node;
};

/* ────────────────────────────────────────────────────────────────────────────
 * WGSL-Mapped Free Functions
 * 
 * These are direct 1:1 mappings to WGSL builtins for full control.
 * Use these when you need explicit control over texture/sampler pairing
 * or for comparison sampling.
 * ──────────────────────────────────────────────────────────────────────────── */

// Type guard for texture nodes
type AnyTextureNode = TextureNode; // Will be extended with CubeTextureNode etc.
type AnySamplerNode = SamplerNode<d.SamplerDesc>;
type AnyComparisonSamplerNode = SamplerNode<d.SamplerComparisonDesc>;

/**
 * textureSample - Sample a texture at UV coordinates.
 * Fragment shader only.
 */
export function textureSample(
    t: AnyTextureNode,
    s: AnySamplerNode,
    coords: Node<d.vec2f>,
    offset?: Node<d.vec2i>
): CallNode<d.vec4f> {
    const args: Node<Any>[] = offset ? [t, s, coords, offset] : [t, s, coords];
    return new CallNode(d.vec4f, 'textureSample', args);
}

/**
 * textureSampleLevel - Sample a texture at a specific mip level.
 * Works in any shader stage.
 */
export function textureSampleLevel(
    t: AnyTextureNode,
    s: AnySamplerNode,
    coords: Node<d.vec2f>,
    level: Node<d.f32>,
    offset?: Node<d.vec2i>
): CallNode<d.vec4f> {
    const args: Node<Any>[] = offset ? [t, s, coords, level, offset] : [t, s, coords, level];
    return new CallNode(d.vec4f, 'textureSampleLevel', args);
}

/**
 * textureSampleBias - Sample a texture with mip level bias.
 * Fragment shader only.
 */
export function textureSampleBias(
    t: AnyTextureNode,
    s: AnySamplerNode,
    coords: Node<d.vec2f>,
    bias: Node<d.f32>,
    offset?: Node<d.vec2i>
): CallNode<d.vec4f> {
    const args: Node<Any>[] = offset ? [t, s, coords, bias, offset] : [t, s, coords, bias];
    return new CallNode(d.vec4f, 'textureSampleBias', args);
}

/**
 * textureSampleGrad - Sample a texture with explicit gradients.
 * Works in any shader stage.
 */
export function textureSampleGrad(
    t: AnyTextureNode,
    s: AnySamplerNode,
    coords: Node<d.vec2f>,
    ddx: Node<d.vec2f>,
    ddy: Node<d.vec2f>,
    offset?: Node<d.vec2i>
): CallNode<d.vec4f> {
    const args: Node<Any>[] = offset ? [t, s, coords, ddx, ddy, offset] : [t, s, coords, ddx, ddy];
    return new CallNode(d.vec4f, 'textureSampleGrad', args);
}

/**
 * textureSampleCompare - Compare-sample a depth texture.
 * Fragment shader only. Requires sampler_comparison.
 */
export function textureSampleCompare(
    t: AnyTextureNode, // Should be DepthTextureNode when we add it
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
    t: AnyTextureNode, // Should be DepthTextureNode when we add it
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
export function textureLoad(
    t: AnyTextureNode,
    coords: Node<d.vec2i>,
    level: Node<d.i32>
): CallNode<d.vec4f> {
    return new CallNode(d.vec4f, 'textureLoad', [t, coords, level]);
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
    t: AnyTextureNode,
    level?: Node<d.u32>
): CallNode<d.vec2u> {
    const args: Node<Any>[] = level ? [t, level] : [t];
    return new CallNode(d.vec2u, 'textureDimensions', args);
}

/**
 * textureNumLevels - Get number of mip levels.
 */
export function textureNumLevels(t: AnyTextureNode): CallNode<d.u32> {
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
export function textureGather(
    component: Node<d.i32>,
    t: AnyTextureNode,
    s: AnySamplerNode,
    coords: Node<d.vec2f>,
    offset?: Node<d.vec2i>
): CallNode<d.vec4f> {
    const args: Node<Any>[] = offset ? [component, t, s, coords, offset] : [component, t, s, coords];
    return new CallNode(d.vec4f, 'textureGather', args);
}

/**
 * textureGatherCompare - Gather compare results from 4 texels.
 * Requires sampler_comparison.
 */
export function textureGatherCompare(
    t: AnyTextureNode, // Should be DepthTextureNode
    s: AnyComparisonSamplerNode,
    coords: Node<d.vec2f>,
    depthRef: Node<d.f32>,
    offset?: Node<d.vec2i>
): CallNode<d.vec4f> {
    const args: Node<Any>[] = offset ? [t, s, coords, depthRef, offset] : [t, s, coords, depthRef];
    return new CallNode(d.vec4f, 'textureGatherCompare', args);
}
