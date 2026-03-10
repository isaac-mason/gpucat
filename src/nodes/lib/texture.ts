import { Texture } from '../../texture/texture';
import { CallNode, Node } from './core';
import { type TextureDesc, type DepthTextureDesc, type Any, texture2d } from '../schema';
import * as d from '../schema';
import { UniformGroup, objectGroup } from './uniform';

/**
 * TextureNode - represents a texture sample operation.
 *
 * When used as a value, it samples the texture at the given UV coordinates.
 * The node type is 'vec4f' (the sampled color), not the texture type.
 */
export class TextureNode extends Node<d.vec4f> {
    /**
     * GPU texture resource. Set this before rendering.
     * This can be set directly, OR use `value` (a Texture object) which the renderer
     * will use to create/update the GPU texture.
     */
    resource: GPUTexture | GPUTextureView | null = null;

    /**
     * GPU sampler resource. Auto-created by the renderer based on the texture's
     * sampling properties (wrap, filter, etc.).
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
     * Defaults to uv() if not specified.
     */
    uvNode: Node<d.vec2f> | null = null;

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
        this.uvNode = uvNode;
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

    /** Clone this texture node */
    clone(): TextureNode {
        const cloned = new TextureNode(this.textureType, this.textureId, this.uvNode, this.groupNode);
        cloned.value = this.value;
        cloned.resource = this.resource;
        cloned.gpuSampler = this.gpuSampler;
        cloned.referenceNode = this.referenceNode;
        return cloned;
    }

    /** Sample the texture at the given UV coordinates, returns a new TextureNode with the UV and reference node set */
    sample(uvNode: Node<d.vec2f>): TextureNode {
        const textureNode = this.clone();
        textureNode.uvNode = uvNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

}

export class SamplerNode<D extends d.SamplerDesc | d.SamplerComparisonDesc = d.SamplerDesc> extends Node<D> {
    /** GPU sampler resource. Set this before rendering. */
    resource: GPUSampler | null = null;

    constructor(
        desc: D,
        readonly samplerId: string
    ) {
        super(desc);
    }

}

/**
 * Create a texture node from a Texture object.
 *
 * @param tex - The Texture object containing image data
 * @param textureDesc - Optional texture type descriptor (default: texture2d())
 *
 * @example
 * const albedo = texture(myTexture);
 * const cubeMap = texture(myCubeTexture, S.textureCube());
 */
export const texture = (
    tex: Texture,
    textureDesc: TextureDesc | DepthTextureDesc = texture2d()
): TextureNode => {
    const node = new TextureNode(textureDesc.wgslType, `t${tex.id}`);
    node.value = tex;
    return node;
};

export const textureSample = (t: Node<Any>, s: Node<Any>, uv: Node<Any>) => new CallNode(d.vec4f, 'textureSample', [t, s, uv]);

export const textureLoad = (t: Node<Any>, coord: Node<Any>, level: Node<Any>) => new CallNode(d.vec4f, 'textureLoad', [t, coord, level]);

export const textureSampleLevel = (t: Node<Any>, s: Node<Any>, uv: Node<Any>, level: Node<Any>) => new CallNode(d.vec4f, 'textureSampleLevel', [t, s, uv, level]);
