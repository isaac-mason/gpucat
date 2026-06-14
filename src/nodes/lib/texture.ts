import { Texture } from '../../texture/texture';
import { CubeTexture } from '../../texture/cube-texture';
import { DepthTexture } from '../../texture/depth-texture';
import { ArrayTexture } from '../../texture/array-texture';
import { GpuTexture } from '../../core/gpu-texture';
import { GpuSampler } from '../../core/gpu-sampler';
import { CallNode, Node } from './core';
import { type FlatDepthTexture, type FlatSampledTexture, type CubeSampledTexture, type Any } from '../../schema/schema';
import * as d from '../../schema/schema';
import { UniformGroup, objectGroup } from './uniform';
import { uv } from './attribute';
import { varying } from './varying';

/**
 * SamplerNode - represents a sampler binding.
 * 
 * Samplers are first-class nodes with their own bindings, mirroring WGSL's
 * separate texture/sampler model.
 * 
 * Holds a reference to a GpuSampler which contains the actual settings.
 */
export class SamplerNode<D extends d.sampler | d.samplerComparison = d.sampler> extends Node<D> {
    /** The GpuSampler - always has a valid default */
    value: GpuSampler = new GpuSampler();

    /** Unique ID for this sampler instance */
    readonly samplerId: string;

    /** Uniform group, determines @group index. */
    groupNode: UniformGroup;

    constructor(
        desc: D,
        samplerId: string,
        groupNode: UniformGroup = objectGroup
    ) {
        super(desc);
        this.samplerId = samplerId;
        this.groupNode = groupNode;
    }

    /** Settings key from the GpuSampler (for deduplication) */
    get settingsKey(): string {
        return this.value.settingsKey;
    }

    /** Sampling parameters (forwarded from GpuSampler) */
    get minFilter(): GPUFilterMode { return this.value.minFilter; }
    get magFilter(): GPUFilterMode { return this.value.magFilter; }
    get mipmapFilter(): GPUMipmapFilterMode { return this.value.mipmapFilter; }
    get addressModeU(): GPUAddressMode { return this.value.addressModeU; }
    get addressModeV(): GPUAddressMode { return this.value.addressModeV; }
    get addressModeW(): GPUAddressMode { return this.value.addressModeW; }
    get maxAnisotropy(): number { return this.value.maxAnisotropy; }
    get compare(): GPUCompareFunction | undefined { return this.value.compare; }

    /** Clone this sampler (shares same GpuSampler reference) */
    clone(): SamplerNode<D> {
        const cloned = new SamplerNode(this.type as D, this.samplerId, this.groupNode);
        cloned.value = this.value;
        return cloned;
    }
}

/* ────────────────────────────────────────────────────────────────────────────
 * TextureBindingNode
 * ──────────────────────────────────────────────────────────────────────────── */

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
export class TextureBindingNode<D extends d.Texture = d.Texture> extends Node<D> {
    /** The GpuTexture */
    value: GpuTexture<D> | null = null;

    /** Unique ID for this texture binding (e.g. 'tAlbedo', 'tShadowMap'). */
    readonly textureId: string;

    /** Uniform group, determines @group index. */
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

    /** The texture binding, holds GPU resource, textureId, groupNode. */
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
    referenceNode: TextureNode | null = null;

    /**
     * The sampler node for this texture.
     * Auto-created by texture() factory from texture settings.
     * Can be set explicitly for custom sampler sharing.
     */
    samplerNode: SamplerNode<d.sampler> | null = null;

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
        bindingNode: TextureBindingNode<FlatSampledTexture>,
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
    convert(type: 'sampler' | 'sampler_comparison'): CallNode<d.sampler | d.samplerComparison> {
        const desc = type === 'sampler' ? d.sampler : d.samplerComparison;
        return new CallNode(desc, type, [this]);
    }

    /** Clone this texture node with all sampling properties */
    clone(): TextureNode {
        const cloned = new TextureNode(this.bindingNode, this.uvNode);
        
        // copy nodes
        cloned.referenceNode = this.referenceNode;
        cloned.samplerNode = this.samplerNode;
        
        // copy sampling mode properties
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
 * High-level texture types that have _gpuSampler.
 * All have ._gpuTexture and ._gpuSampler properties.
 */
type HighLevelTexture = Texture | CubeTexture | DepthTexture | ArrayTexture;

/** Counter for generating unique sampler IDs when using GpuSampler directly */
let _samplerIdCounter = 0;

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
export function sampler(source: GpuSampler, groupNode?: UniformGroup): SamplerNode<d.sampler>;
export function sampler(source: HighLevelTexture, groupNode?: UniformGroup): SamplerNode<d.sampler>;
export function sampler(source: GpuSampler | HighLevelTexture, groupNode: UniformGroup = objectGroup): SamplerNode<d.sampler> {
    if (source instanceof GpuSampler) {
        const node = new SamplerNode(d.sampler, `s${_samplerIdCounter++}`, groupNode);
        node.value = source;
        return node;
    } else {
        const node = new SamplerNode(d.sampler, `s${source.id}`, groupNode);
        node.value = source._gpuSampler;
        return node;
    }
}

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
export function comparisonSampler(source: GpuSampler, compare?: GPUCompareFunction, groupNode?: UniformGroup): SamplerNode<d.samplerComparison>;
export function comparisonSampler(source: HighLevelTexture, compare?: GPUCompareFunction, groupNode?: UniformGroup): SamplerNode<d.samplerComparison>;
export function comparisonSampler(
    source: GpuSampler | HighLevelTexture,
    compare: GPUCompareFunction = 'less',
    groupNode: UniformGroup = objectGroup
): SamplerNode<d.samplerComparison> {
    const baseSampler = source instanceof GpuSampler ? source : source._gpuSampler;
    const samplerId = source instanceof GpuSampler ? `s${_samplerIdCounter++}_cmp` : `s${source.id}_cmp`;
    
    const node = new SamplerNode(d.samplerComparison, samplerId, groupNode);
    // Create a new GpuSampler with comparison function
    const cmpSampler = new GpuSampler({
        minFilter: baseSampler.minFilter,
        magFilter: baseSampler.magFilter,
        mipmapFilter: baseSampler.mipmapFilter,
        addressModeU: baseSampler.addressModeU,
        addressModeV: baseSampler.addressModeV,
        addressModeW: baseSampler.addressModeW,
        maxAnisotropy: baseSampler.maxAnisotropy,
        compare,
    });
    node.value = cmpSampler;
    return node;
}

/** Counter for generating unique texture IDs when using GpuTexture directly */
let _textureIdCounter = 0;

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
export function texture(tex: Texture): TextureNode;
export function texture(gpuTex: GpuTexture<FlatSampledTexture>, gpuSampler: GpuSampler): TextureNode;
export function texture(
    source: Texture | GpuTexture<FlatSampledTexture>,
    gpuSampler?: GpuSampler
): TextureNode {
    if (source instanceof GpuTexture) {
        if (!gpuSampler) {
            throw new Error('texture(): GpuSampler required when passing GpuTexture directly');
        }
        // Widen the type for the binding to FlatSampledTexture
        const desc = source.type as FlatSampledTexture;
        const binding = new TextureBindingNode(desc, `t${_textureIdCounter++}`);
        binding.value = source;
        const node = new TextureNode(binding);
        node.samplerNode = sampler(gpuSampler, binding.groupNode);
        return node;
    } else {
        // Texture._gpuTexture is GpuTexture<d.texture2d>
        // Widen to FlatSampledTexture for the binding
        const gpuTex = source._gpuTexture;
        const desc = gpuTex.type as FlatSampledTexture;
        const binding = new TextureBindingNode(desc, `t${source.id}`);
        binding.value = gpuTex;
        const node = new TextureNode(binding);
        node.samplerNode = sampler(source._gpuSampler, binding.groupNode);
        return node;
    }
}

/**
 * Create a standalone texture binding node.
 *
 * Use this when you want to work with WGSL-level free functions directly
 * (textureSample, textureLoad, etc.) instead of the high-level TextureNode
 * sampling API.
 */
export const textureBinding = <D extends d.Texture>(
    tex: { _gpuTexture: GpuTexture<D>; id: number },
    textureDesc: D
): TextureBindingNode<D> => {
    const binding = new TextureBindingNode(textureDesc, `t${tex.id}`);
    binding.value = tex._gpuTexture;
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

    /** The texture binding, holds GPU resource, textureId, groupNode. */
    readonly bindingNode: TextureBindingNode<CubeSampledTexture>;

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
    samplerNode: SamplerNode<d.sampler> | null = null;

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
        bindingNode: TextureBindingNode<CubeSampledTexture>,
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
export function cubeTexture(tex: CubeTexture): CubeTextureNode;
export function cubeTexture(gpuTex: GpuTexture<CubeSampledTexture>, gpuSampler: GpuSampler): CubeTextureNode;
export function cubeTexture(
    source: CubeTexture | GpuTexture<CubeSampledTexture>,
    gpuSampler?: GpuSampler
): CubeTextureNode {
    if (source instanceof GpuTexture) {
        if (!gpuSampler) {
            throw new Error('cubeTexture(): GpuSampler required when passing GpuTexture directly');
        }
        const desc = source.type as CubeSampledTexture;
        const binding = new TextureBindingNode(desc, `t${_textureIdCounter++}`);
        binding.value = source;
        const node = new CubeTextureNode(binding);
        node.samplerNode = sampler(gpuSampler, binding.groupNode);
        return node;
    } else {
        const gpuTex = source._gpuTexture;
        const desc = gpuTex.type as CubeSampledTexture;
        const binding = new TextureBindingNode(desc, `t${source.id}`);
        binding.value = gpuTex;
        const node = new CubeTextureNode(binding);
        node.samplerNode = sampler(source._gpuSampler, binding.groupNode);
        return node;
    }
}

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
 *   which require a sampler_comparison, use comparisonSampler() to create one
 *
 * Supports chainable methods:
 * - .sample(uv) - set UV coordinates
 * - .level(level) - use textureSampleLevel (i32 level)
 * - .offset(offset) - add offset parameter
 * - .load(coords, level?) - use textureLoad
 */
export class DepthTextureNode extends Node<d.f32> {
    readonly isDepthTextureNode = true;

    /** The texture binding, holds GPU resource, textureId, groupNode. */
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
    referenceNode: DepthTextureNode | null = null;

    /**
     * The sampler node for this texture.
     * Auto-created by depthTexture() factory from texture settings.
     * This is a regular sampler for textureSample/textureSampleLevel.
     * For comparison sampling, use comparisonSampler() and the free functions.
     */
    samplerNode: SamplerNode<d.sampler> | null = null;

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
        bindingNode: TextureBindingNode<FlatDepthTexture>,
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
export function depthTexture(tex: DepthTexture): DepthTextureNode;
export function depthTexture(gpuTex: GpuTexture<FlatDepthTexture>, gpuSampler: GpuSampler): DepthTextureNode;
export function depthTexture(
    source: DepthTexture | GpuTexture<FlatDepthTexture>,
    gpuSampler?: GpuSampler
): DepthTextureNode {
    if (source instanceof GpuTexture) {
        if (!gpuSampler) {
            throw new Error('depthTexture(): GpuSampler required when passing GpuTexture directly');
        }
        const desc = source.type as FlatDepthTexture;
        const binding = new TextureBindingNode(desc, `t${_textureIdCounter++}`);
        binding.value = source;
        const node = new DepthTextureNode(binding);
        node.samplerNode = sampler(gpuSampler, binding.groupNode);
        return node;
    } else {
        const gpuTex = source._gpuTexture;
        const desc = gpuTex.type as FlatDepthTexture;
        const binding = new TextureBindingNode(desc, `t${source.id}`);
        binding.value = gpuTex;
        const node = new DepthTextureNode(binding);
        node.samplerNode = sampler(source._gpuSampler, binding.groupNode);
        return node;
    }
}

/* ────────────────────────────────────────────────────────────────────────────
 * ArrayTextureNode
 * ──────────────────────────────────────────────────────────────────────────── */

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
export class ArrayTextureNode extends Node<d.vec4f> {
    readonly isArrayTextureNode = true;

    /** The texture binding, holds GPU resource, textureId, groupNode. */
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
    referenceNode: ArrayTextureNode | null = null;

    /**
     * The sampler node for this texture.
     * Auto-created by arrayTexture() factory from texture settings.
     */
    samplerNode: SamplerNode<d.sampler> | null = null;

    /* ─────────────────────────────────────────────────────────────────────────
     * Sampling mode properties
     * ───────────────────────────────────────────────────────────────────────── */

    /** Current sampling mode */
    samplingMode: ArraySamplingMode = 'sample';

    /** Level node for textureSampleLevel (f32) */
    levelNode: Node<d.f32> | null = null;

    /** Bias node for textureSampleBias */
    biasNode: Node<d.f32> | null = null;

    /** Gradient nodes for textureSampleGrad [ddx, ddy] (vec2f) */
    gradNode: [Node<d.vec2f>, Node<d.vec2f>] | null = null;

    /** Offset node for sampling with offset (must be const expression) */
    offsetNode: Node<d.vec2i> | null = null;

    /** Integer coordinates for textureLoad */
    loadCoords: Node<d.vec2i> | null = null;

    /** Level for textureLoad (i32) */
    loadLevel: Node<d.i32> | null = null;

    constructor(
        bindingNode: TextureBindingNode<d.texture2dArray>,
        layerNode: Node<d.i32>,
        uvNode: Node<d.vec2f> | null = null,
    ) {
        // Node type is vec4f (the sampled color)
        super(d.vec4f);
        this.bindingNode = bindingNode;
        this.layerNode = layerNode;
        this.uvNode = uvNode ?? varying(uv());
    }

    /** Get the base texture node (follows referenceNode chain) */
    getBase(): ArrayTextureNode {
        return this.referenceNode ? this.referenceNode.getBase() : this;
    }

    /** Clone this texture node with all sampling properties */
    clone(): ArrayTextureNode {
        const cloned = new ArrayTextureNode(this.bindingNode, this.layerNode, this.uvNode);
        cloned.referenceNode = this.referenceNode;
        cloned.samplerNode = this.samplerNode;
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

    /** Set the array layer index */
    layer(layerNode: Node<d.i32>): ArrayTextureNode {
        const textureNode = this.clone();
        textureNode.layerNode = layerNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Sample the texture at the given UV coordinates */
    sample(uvNode: Node<d.vec2f>): ArrayTextureNode {
        const textureNode = this.clone();
        textureNode.uvNode = uvNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Use textureSampleLevel with explicit mip level */
    level(levelNode: Node<d.f32>): ArrayTextureNode {
        const textureNode = this.clone();
        textureNode.samplingMode = 'level';
        textureNode.levelNode = levelNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Use textureSampleBias with mip level bias */
    bias(biasNode: Node<d.f32>): ArrayTextureNode {
        const textureNode = this.clone();
        textureNode.samplingMode = 'bias';
        textureNode.biasNode = biasNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Use textureSampleGrad with explicit gradients */
    grad(ddx: Node<d.vec2f>, ddy: Node<d.vec2f>): ArrayTextureNode {
        const textureNode = this.clone();
        textureNode.samplingMode = 'grad';
        textureNode.gradNode = [ddx, ddy];
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Add offset to sampling (must be const expression) */
    offset(offsetNode: Node<d.vec2i>): ArrayTextureNode {
        const textureNode = this.clone();
        textureNode.offsetNode = offsetNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Use textureLoad for direct texel fetch (no filtering) */
    load(coords: Node<d.vec2i>, level?: Node<d.i32>): ArrayTextureNode {
        const textureNode = this.clone();
        textureNode.samplingMode = 'load';
        textureNode.loadCoords = coords;
        textureNode.loadLevel = level ?? null;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }
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
export function arrayTexture(tex: ArrayTexture, layerNode: Node<d.i32>): ArrayTextureNode;
export function arrayTexture(gpuTex: GpuTexture<d.texture2dArray>, gpuSampler: GpuSampler, layerNode: Node<d.i32>): ArrayTextureNode;
export function arrayTexture(
    source: ArrayTexture | GpuTexture<d.texture2dArray>,
    samplerOrLayer: GpuSampler | Node<d.i32>,
    maybeLayerNode?: Node<d.i32>
): ArrayTextureNode {
    if (source instanceof GpuTexture) {
        const gpuSampler = samplerOrLayer as GpuSampler;
        const layerNode = maybeLayerNode!;
        const binding = new TextureBindingNode(source.type, `t${_textureIdCounter++}`);
        binding.value = source;
        const node = new ArrayTextureNode(binding, layerNode);
        node.samplerNode = sampler(gpuSampler, binding.groupNode);
        return node;
    } else {
        const layerNode = samplerOrLayer as Node<d.i32>;
        const gpuTex = source._gpuTexture;
        const binding = new TextureBindingNode(gpuTex.type, `t${source.id}`);
        binding.value = gpuTex;
        const node = new ArrayTextureNode(binding, layerNode);
        node.samplerNode = sampler(source._gpuSampler, binding.groupNode);
        return node;
    }
}

/* ────────────────────────────────────────────────────────────────────────────
 * WGSL-Mapped Free Functions
 * 
 * These are direct 1:1 mappings to WGSL builtins for full control.
 * Use these when you need explicit control over texture/sampler pairing
 * or for comparison sampling.
 * ──────────────────────────────────────────────────────────────────────────── */

// Type aliases for free function parameters
type AnySamplerNode = SamplerNode<d.sampler>;
type AnyComparisonSamplerNode = SamplerNode<d.samplerComparison>;

/**
 * textureSample - Sample a texture at UV coordinates.
 * Fragment shader only.
 */
export function textureSample<D extends FlatSampledTexture>(
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
export function textureSampleLevel<D extends FlatSampledTexture>(
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
export function textureSampleBias<D extends FlatSampledTexture>(
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
export function textureSampleGrad<D extends FlatSampledTexture>(
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
    t: TextureBindingNode<FlatDepthTexture>,
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
    t: TextureBindingNode<FlatDepthTexture>,
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
export function textureLoad<D extends d.Texture>(
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
): CallNode<d.Void> {
    return new CallNode(d.Void, 'textureStore', [t, coords, value]);
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
export function textureGather<D extends FlatSampledTexture>(
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
    t: TextureBindingNode<FlatDepthTexture>,
    s: AnyComparisonSamplerNode,
    coords: Node<d.vec2f>,
    depthRef: Node<d.f32>,
    offset?: Node<d.vec2i>
): CallNode<d.vec4f> {
    const args: Node<Any>[] = offset ? [t, s, coords, depthRef, offset] : [t, s, coords, depthRef];
    return new CallNode(d.vec4f, 'textureGatherCompare', args);
}
