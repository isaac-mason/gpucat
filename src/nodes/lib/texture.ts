import { Texture } from '../../texture/texture';
import { computeId, CallNode, Node, type TextureType, type SamplerType, type WgslType } from './core';
import { type TextureDesc, type DepthTextureDesc, texture2d } from '../schema';
import { UniformGroupNode, objectGroup } from './uniform';

/**
 * TextureNode - represents a texture sample operation.
 *
 * When used as a value, it samples the texture at the given UV coordinates.
 * The node type is 'vec4f' (the sampled color), not the texture type.
 */
export class TextureNode extends Node<'vec4f'> {
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
    uvNode: Node<'vec2f'> | null = null;

    /**
     * The reference node
     * When sampling with different UVs, this points to the base texture node.
     */
    referenceNode: TextureNode | null = null;

    /**
     * The WGSL texture type (e.g., 'texture_2d<f32>').
     * Used for binding declarations.
     */
    readonly textureType: TextureType;

    /** Uniform group — determines @group index. Defaults to objectGroup */
    groupNode: UniformGroupNode;

    /** The texture ID (e.g. 'albedoMap') for caching and reuse. */
    textureId: string;

    constructor(
        textureType: TextureType,
        textureId: string,
        uvNode: Node<'vec2f'> | null = null,
        /** Uniform group — determines @group index. Defaults to objectGroup. */
        groupNode: UniformGroupNode = objectGroup
    ) {
        // Node type is vec4f (the sampled color)
        super(computeId('texture', { type: textureType, textureId, uvNode: uvNode?.id }), 'texture', 'vec4f');
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
    convert(type: 'sampler' | 'sampler_comparison'): CallNode<SamplerType> {
        return new CallNode(type as SamplerType, type, [this]);
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
    sample(uvNode: Node<'vec2f'>): TextureNode {
        const textureNode = this.clone();
        textureNode.uvNode = uvNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

}

export class SamplerNode extends Node<SamplerType> {
    /** GPU sampler resource. Set this before rendering. */
    resource: GPUSampler | null = null;

    constructor(
        type: SamplerType,
        readonly samplerId: string
    ) {
        super(computeId('sampler', { type, samplerId }), 'sampler', type);
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
    const node = new TextureNode(textureDesc.wgslType as TextureType, `t${tex.id}`);
    node.value = tex;
    return node;
};

export const textureSample = (t: Node<WgslType>, s: Node<WgslType>, uv: Node<WgslType>) => new CallNode('vec4f', 'textureSample', [t, s, uv]);

export const textureLoad = (t: Node<WgslType>, coord: Node<WgslType>, level: Node<WgslType>) => new CallNode('vec4f', 'textureLoad', [t, coord, level]);

export const textureSampleLevel = (t: Node<WgslType>, s: Node<WgslType>, uv: Node<WgslType>, level: Node<WgslType>) => new CallNode('vec4f', 'textureSampleLevel', [t, s, uv, level]);
