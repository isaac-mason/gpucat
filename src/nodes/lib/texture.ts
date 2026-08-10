import type { GpuBuffer } from '../../core/gpu-buffer';
import { GpuSampler } from '../../core/gpu-sampler';
import type { GpuTexture } from '../../core/gpu-texture';
import { layoutStrideOf, structFieldLayout } from '../../schema/pack';
import type { Any, CubeSampledTexture, FlatDepthTexture, FlatSampledTexture } from '../../schema/schema';
import * as d from '../../schema/schema';
import type { ArrayTexture } from '../../texture/array-texture';
import type { CubeTexture } from '../../texture/cube-texture';
import type { DataTexture } from '../../texture/data-texture';
import type { DepthTexture } from '../../texture/depth-texture';
import type { Texture } from '../../texture/texture';
import { uv } from './attribute';
import {
    addToStack,
    bitcastF32,
    bitcastI32,
    bitwiseAnd,
    CallNode,
    ConstructNode,
    i32,
    mat3,
    mat4,
    Node,
    NodeKind,
    type StructDef,
    shiftRight,
    u32,
    vec2f,
    vec2i,
    vec2u,
    vec3,
    vec3i,
    vec3u,
    vec4,
    vec4i,
} from './core';
import { objectGroup, type UniformGroup } from './uniform';
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
    readonly kind = NodeKind.Sampler;
    /** The GpuSampler - always has a valid default */
    value: GpuSampler = new GpuSampler();

    /** Unique ID for this sampler instance */
    readonly samplerId: string;

    /** Uniform group, determines @group index. */
    group: UniformGroup;

    constructor(desc: D, samplerId: string, group: UniformGroup = objectGroup) {
        super(desc);
        this.samplerId = samplerId;
        this.group = group;
    }

    /** Settings key from the GpuSampler (for deduplication) */
    get settingsKey(): string {
        return this.value.settingsKey;
    }

    /** Sampling parameters (forwarded from GpuSampler) */
    get minFilter(): GPUFilterMode {
        return this.value.minFilter;
    }
    get magFilter(): GPUFilterMode {
        return this.value.magFilter;
    }
    get mipmapFilter(): GPUMipmapFilterMode {
        return this.value.mipmapFilter;
    }
    get addressModeU(): GPUAddressMode {
        return this.value.addressModeU;
    }
    get addressModeV(): GPUAddressMode {
        return this.value.addressModeV;
    }
    get addressModeW(): GPUAddressMode {
        return this.value.addressModeW;
    }
    get maxAnisotropy(): number {
        return this.value.maxAnisotropy;
    }
    get compare(): GPUCompareFunction | undefined {
        return this.value.compare;
    }

    /** Clone this sampler (shares same GpuSampler reference) */
    clone(): SamplerNode<D> {
        const cloned = new SamplerNode(this.type as D, this.samplerId, this.group);
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

/**
 * A read-only storage `GpuBuffer` reinterpreted as an integer texture for the WebGL backend (which has
 * no SSBO). The renderer reads the buffer's own bytes directly as `width × height` texels — no
 * `DataTexture`, no second CPU array — and caches one GL texture per `GpuBuffer` (version-synced to
 * `buffer.version`). Carried on the synthetic `TextureBindingNode` that a lowered `storage()` read
 * samples through. The shader reads the row width at RUNTIME via `textureSize()` (see `storageRowWidth`),
 * so the emitted GLSL is independent of buffer size AND of value-vs-name binding — both compile identically.
 *
 * `bytesPerTexel` sizes each texel to the element so exactly one element (or, for a >16-byte element, a
 * whole number of texels) lands per texel — `4 → r32uint`, `8 → rg32uint`, `16·k → rgba32uint` — see
 * {@link storageMirrorBytesPerTexel}. Element `i` then reads at texel `i · (stride/bytesPerTexel)`, which
 * is what the emitted addressing already assumes; the renderer maps `bytesPerTexel` to the GL format.
 *
 * Two shapes:
 *  - value-based: the `GpuBuffer` is known at compile (`storage(buffer, 'read')`), so its texel grid is
 *    computed here and the renderer uploads it directly.
 *  - name-based: `storage('slot', 'read')` bound via `geometry.setBuffer('slot', buf)`. The buffer isn't
 *    known until draw, so only the name (and the element's `bytesPerTexel`, known from the schema) is
 *    carried; the renderer resolves the buffer from the render object's geometry and sizes the grid then.
 */
export type ResolvedStorageBufferTexture = { buffer: GpuBuffer; width: number; height: number; bytesPerTexel: number };
export type StorageBufferTextureSource = ResolvedStorageBufferTexture | { name: string; bytesPerTexel: number };

/**
 * Bytes per mirror texel for a read-only `storage()` element on WebGL: the element's std430 array stride,
 * capped at one rgba32uint texel. `4 → r32uint`, `8 → rg32uint`, and any multiple of 16 → `rgba32uint`
 * (spanning `stride/16` texels per element). This packs one element (or a whole number of texels) per
 * texel, so a scalar `array<u32>` reads element `i` from texel `i` — NOT `4·i` — and needs no padding
 * (its byte length is always a multiple of 4). We never use a 3-component (`rgb`) texel: std430 pads a
 * `vec3` to 16 bytes, so the only sub-16 strides are 4 and 8. Throws for an exotic stride (e.g. a 12- or
 * 20-byte all-scalar struct) that has no whole-texel home — pad the struct to a multiple of 16 to read it.
 */
export function storageMirrorBytesPerTexel(element: Any): number {
    const stride = layoutStrideOf(element, 'std430');
    if (stride === 4) return 4;
    if (stride === 8) return 8;
    if (stride % 16 === 0) return 16;
    throw new Error(
        `[gpucat] storage() read-lowering: element stride ${stride} bytes has no whole-texel WebGL layout ` +
            `(supported: 4 → r32uint, 8 → rg32uint, multiples of 16 → rgba32uint). Pad the element to a ` +
            `multiple of 16 bytes to read it on WebGL2.`,
    );
}

export class TextureBindingNode<D extends d.Texture = d.Texture> extends Node<D> {
    readonly kind = NodeKind.TextureBinding;
    /** The GpuTexture */
    value: GpuTexture<D> | null = null;

    /**
     * When set, this binding is NOT a GpuTexture but a read-only storage `GpuBuffer` reinterpreted as an
     * `rgba32uint` texture — the WebGL `storage()` read-lowering (WebGL2 has no SSBO). `value` stays null;
     * the renderer reads the buffer's bytes directly as `width × height` u32 texels and caches one GL
     * texture per `GpuBuffer`. WebGPU never sets this (storage stays a native `array<Struct>` there).
     */
    storageBufferSource: StorageBufferTextureSource | null = null;

    /**
     * When set, this binding's texture is the OUTPUT of a render pass, refreshed each frame by that pass.
     * Carrying the source on the binding (not on a bespoke node subclass) is what lets any sampling node —
     * color or depth — share one lifecycle: `getChildren` reaches `passNode` through here so discovery
     * renders the source pass and orders it before consumers, and because `.sample()`/`.load()` clones
     * SHARE this binding, that wiring survives cloning automatically. `previous` selects the ping-pong
     * (last-frame) texture. `value` is (re)written from the pass each frame; the pass owns the texture.
     */
    passSource: { passNode: Node<d.Any>; textureName: string; previous: boolean } | null = null;

    /** Unique ID for this texture binding (e.g. 'tAlbedo', 'tShadowMap'). */
    readonly textureId: string;

    /** Uniform group, determines @group index. */
    group: UniformGroup;

    constructor(desc: D, textureId: string, group: UniformGroup = objectGroup) {
        super(desc);
        this.textureId = textureId;
        this.group = group;
    }
}

/* ────────────────────────────────────────────────────────────────────────────
 * StorageTextureBindingNode
 * ──────────────────────────────────────────────────────────────────────────── */

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
export class StorageTextureBindingNode<D extends d.StorageTexture = d.StorageTexture> extends Node<D> {
    readonly kind = NodeKind.StorageTextureBinding;
    /** The GpuTexture */
    value: GpuTexture<D> | null = null;

    /** Unique ID for this texture binding (e.g. 'st3'). */
    readonly textureId: string;

    /** Uniform group, determines @group index. */
    group: UniformGroup;

    /** WGSL access mode for THIS binding (overrides the descriptor default). */
    access: d.StorageTextureAccess;

    /** Mip level the binding view targets. */
    mipLevel: number = 0;

    constructor(desc: D, textureId: string, access: d.StorageTextureAccess, group: UniformGroup = objectGroup) {
        super(desc);
        this.textureId = textureId;
        this.access = access;
        this.group = group;
    }

    /** The storage texel format (from the descriptor). */
    get format(): d.StorageTextureFormat {
        return this.type.format;
    }

    /** The WGSL storage dimension tag ('1d' | '2d' | '2d_array' | '3d'). */
    get dim(): D['dim'] {
        return this.type.dim;
    }

    /** The composed WGSL binding type, e.g. `texture_storage_2d<rgba8unorm, write>`. */
    get wgslBindingType(): string {
        return `texture_storage_${this.type.dim}<${this.type.format}, ${this.access}>`;
    }

    /** Set the mip level this binding view targets (for manual mip writes). */
    setMipLevel(level: number): this {
        this.mipLevel = level;
        return this;
    }
}

/**
 * storageTexture - bind a GpuTexture as a storage texture for compute writes/reads.
 *
 * @param gpuTex - a storage GpuTexture (e.g. from `createStorageTexture(...)`)
 * @param access - 'write' (default), 'read', or 'read_write'
 */
export function storageTexture<D extends d.StorageTexture>(
    gpuTex: GpuTexture<D>,
    access: d.StorageTextureAccess = 'write',
): StorageTextureBindingNode<D> {
    if (access === 'read_write' && !d.STORAGE_FORMATS[gpuTex.type.format].readWrite) {
        throw new Error(
            `[gpucat] storage format '${gpuTex.type.format}' does not support 'read_write' access. ` +
                `Use 'write' or 'read', or pick a read_write-capable format.`,
        );
    }
    const node = new StorageTextureBindingNode(gpuTex.type, `st${gpuTex.id}`, access);
    node.value = gpuTex;
    return node;
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
/**
 * The vec4 result type for sampling/loading a texture: `vec4u`/`vec4i` for integer-sample textures
 * (`texture_2d<u32>`/`<i32>` → usampler2D/isampler2D, whose texelFetch yields uvec4/ivec4), else
 * `vec4f`. Set as the node's *runtime* type so both emitters declare the right texel type; the class
 * keeps its static `vec4f` type (the common float case) to avoid widening every sampler's result.
 */
function textureResultVec4(desc: d.Texture): d.vec4f | d.vec4u | d.vec4i {
    const sampleType = (desc as d.SampledTexture).sampleType?.type;
    return sampleType === 'u32' ? d.vec4u : sampleType === 'i32' ? d.vec4i : d.vec4f;
}

export class TextureNode<D extends FlatSampledTexture = d.texture2d> extends Node<d.vec4f> {
    readonly kind = NodeKind.Texture;

    /** The texture binding, holds GPU resource, textureId, group. */
    readonly bindingNode: TextureBindingNode<D>;

    /**
     * The texture coordinate node, derived from the texture's dimensionality:
     * `vec2f` for 2D, `vec3f` for 3D (e.g. raymarching a volume or a 3D LUT),
     * `f32` for 1D. Defaults to varying(uv()) (2D).
     */
    uvNode: Node<d.TextureCoordOf<D>>;

    /**
     * The reference node
     * When sampling with different UVs, this points to the base texture node.
     */
    referenceNode: TextureNode<D> | null = null;

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

    constructor(bindingNode: TextureBindingNode<D>, uvNode: Node<d.TextureCoordOf<D>> | null = null) {
        // Node type is the sampled vec4 — vec4u/vec4i for integer-sample textures, else vec4f. Runtime
        // type carries the truth (drives the emitter's texel type + swizzle element type); the static
        // class type stays vec4f so existing float-texture usage isn't widened to a union.
        super(textureResultVec4(bindingNode.type) as d.vec4f);
        this.bindingNode = bindingNode;
        // Default uv() (vec2f) only applies to 2D; 3D/1D always pass coords via sample().
        this.uvNode = uvNode ?? (varying(uv()) as unknown as Node<d.TextureCoordOf<D>>);
    }

    /** Get the base texture node (follows referenceNode chain) */
    getBase(): TextureNode<D> {
        return this.referenceNode ? this.referenceNode.getBase() : this;
    }

    /** Convert this texture node to a sampler type */
    convert(type: 'sampler' | 'sampler_comparison'): CallNode<d.sampler | d.samplerComparison> {
        const desc = type === 'sampler' ? d.sampler : d.samplerComparison;
        return new CallNode(desc, type, [this]);
    }

    /** Clone this texture node with all sampling properties */
    clone(): TextureNode<D> {
        const cloned = new TextureNode<D>(this.bindingNode, this.uvNode);

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

    /** Sample the texture at the given coordinates (vec2 for 2D, vec3 for 3D, f32 for 1D). */
    sample(uvNode: Node<d.TextureCoordOf<D>>): TextureNode<D> {
        const textureNode = this.clone();
        textureNode.uvNode = uvNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Use textureSampleLevel with explicit mip level */
    level(levelNode: Node<d.f32>): TextureNode<D> {
        const textureNode = this.clone();
        textureNode.samplingMode = 'level';
        textureNode.levelNode = levelNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Use textureSampleBias with mip level bias */
    bias(biasNode: Node<d.f32>): TextureNode<D> {
        const textureNode = this.clone();
        textureNode.samplingMode = 'bias';
        textureNode.biasNode = biasNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Use textureSampleGrad with explicit gradients */
    grad(ddx: Node<d.vec2f>, ddy: Node<d.vec2f>): TextureNode<D> {
        const textureNode = this.clone();
        textureNode.samplingMode = 'grad';
        textureNode.gradNode = [ddx, ddy];
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Add offset to sampling (2D and 2D-array only, must be const expression) */
    offset(offsetNode: Node<d.vec2i>): TextureNode<D> {
        const textureNode = this.clone();
        textureNode.offsetNode = offsetNode;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Use textureLoad for direct texel fetch (no filtering). */
    load(coords: Node<d.vec2i>, level?: Node<d.i32>): TextureNode<D>;
    /**
     * Read a struct record by index: `texture(t).load(schema, i)` returns an accessor whose fields
     * (`.color`, `.transform`, …) lazily decode from `rgba32uint` texels. `i` is a record index
     * (offset `i · texelStride`, derived from the schema); use {@link loadAt} for an explicit texel.
     */
    load<S extends d.StructSchema>(schema: StructDef<S>, index: Node<d.u32> | Node<d.i32>): RecordAccessor<S>;
    load(
        a: Node<d.vec2i> | StructDef<d.StructSchema>,
        b?: Node<d.i32> | Node<d.u32>,
    ): TextureNode<D> | RecordAccessor<d.StructSchema> {
        // Struct read: first arg is a struct def (its `.type` is the literal 'struct'; a coord Node's
        // `.type` is a schema descriptor object, never that string).
        if ((a as { type?: unknown }).type === 'struct') {
            const schema = a as StructDef<d.StructSchema>;
            const layout = structFieldLayout(schema as unknown as d.StructDesc);
            const idx = ensureU32(b as Node<d.u32 | d.i32>);
            const texelBase = layout.texelStride === 1 ? idx : idx.mul(u32(layout.texelStride));
            return buildRecordAccessor(this.getBase(), schema, texelBase, storageRowWidth(this.getBase()));
        }
        const textureNode = this.clone();
        textureNode.samplingMode = 'load';
        textureNode.loadCoords = a as Node<d.vec2i>;
        textureNode.loadLevel = (b as Node<d.i32>) ?? null;
        textureNode.referenceNode = this.getBase();
        return textureNode;
    }

    /** Read a struct record starting at an explicit TEXEL index (the primitive under {@link load}). */
    loadAt<S extends d.StructSchema>(schema: StructDef<S>, texel: Node<d.u32> | Node<d.i32>): RecordAccessor<S> {
        return buildRecordAccessor(this.getBase(), schema, ensureU32(texel), storageRowWidth(this.getBase()));
    }
}

/* ───────────────────────────────────────────────────────────────────────────
 * Structured-texture read accessor — decodes struct fields from rgba32uint texels.
 * Built purely from existing node primitives (textureLoad + swizzle + bitcast + constructors);
 * no new NodeKind. Repeated texel reads across fields dedup via CSE.
 * ─────────────────────────────────────────────────────────────────────────── */

/** Per-field accessor object returned by {@link TextureNode.load}/{@link TextureNode.loadAt}. */
export type RecordAccessor<S extends d.StructSchema> = { readonly [K in keyof S]: FieldAccessor<S[K]> };

/**
 * Decoded accessor type for one struct field. A `d.bits({...})` field becomes a sub-accessor with a
 * `Node<u32>` per declared bit-field name (matching the runtime `decodeField` bits branch); every
 * other field type stays a `Node` of its (decoded) type.
 */
type FieldAccessor<T extends d.Any> = T extends d.bits<infer F> ? { readonly [N in keyof F]: Node<d.u32> } : Node<T>;

function ensureU32(n: Node<d.u32 | d.i32>): Node<d.u32> {
    return (n.type as { wgslType?: string }).wgslType === 'u32' ? (n as Node<d.u32>) : u32(n);
}

/** Read one rgba32uint texel at a linear texel index → a `vec4u` node. `width` (texels per row) is always
 *  the runtime `textureSize()` node from {@link storageRowWidth} — the SAME addressing for both a real
 *  `texture(t).load(schema, i)` and the WebGL `storage()` mirror lowering, mirroring three.js's PBO
 *  indexing. Reading the width at runtime (never baking it) keeps the shader size- and binding-independent
 *  and correct when the underlying texture is resized under a cached program. */
function readTexel(
    base: TextureNode<FlatSampledTexture>,
    texelIndex: Node<d.u32>,
    width: Node<d.u32>,
): TextureNode<FlatSampledTexture> {
    const x = i32(texelIndex.mod(width));
    const y = i32(texelIndex.div(width));
    return base.load(vec2i(x, y), i32(0)) as TextureNode<FlatSampledTexture>;
}

/**
 * Runtime texel-row width of a storage mirror texture: `uint(textureSize(tex, 0).x)`. The WebGL
 * `storage()` read-lowering addresses texels with this instead of a baked width constant, mirroring
 * three.js's PBO addressing (`index % textureSize(...).x`). The emitted GLSL is then identical whether
 * the buffer is value- or name-based and whatever its size, and the renderer sizes the mirror texture
 * tight. Build ONE per mirror (cached on the `StorageMirror`) so CSE hoists the `textureSize` call.
 */
export function storageRowWidth(base: TextureNode<FlatSampledTexture>): Node<d.u32> {
    return textureDimensions(base.bindingNode).x;
}

/**
 * Decode one field at `byteOffset` from the record beginning at texel `texelBase` of an `rgba32uint`
 * texture. Exported so the `storage()` WebGL lowering (the GLSL emitter's `matchStorageRead`) can decode
 * a mirror-texture read through the same path as `texture(t).load(schema, i)`.
 */
export function decodeField(
    base: TextureNode<FlatSampledTexture>,
    texelBase: Node<d.u32>,
    width: Node<d.u32>,
    byteOffset: number,
    type: Any,
): Node<Any> {
    const texelWithin = Math.floor(byteOffset / 16);
    const comp = (byteOffset % 16) / 4; // 0..3
    const t = (type as { wgslType: string }).wgslType;
    const texAt = (tw: number): TextureNode<FlatSampledTexture> =>
        readTexel(base, tw === 0 ? texelBase : texelBase.add(u32(tw)), width);
    // Swizzle a texel's component (0..3) → its u32 lane.
    const lane = (texel: TextureNode<FlatSampledTexture>, i: number): Node<d.u32> =>
        [texel.x, texel.y, texel.z, texel.w][i] as unknown as Node<d.u32>;

    const texel = texAt(texelWithin);

    // Packed types occupy one u32 lane → decode via the WGSL unpack builtin (the GLSL emitter
    // translates `unpack*` to native builtins / shift-mask). CSE-friendly: just wraps the lane.
    if (d.isPackedDesc(type)) {
        const spec = d.PACKED_SPECS[type.type as keyof typeof d.PACKED_SPECS];
        const logical = spec.lanes === 4 ? d.vec4f : d.vec2f;
        return new CallNode(logical, spec.unpackFn, [lane(texel, comp)]);
    }

    // Bitfields: one u32 lane split into named fields via shift/mask (no builtins, both backends).
    // Returns a sub-accessor whose `.<name>` lazily emits `(lane >> shift) & mask`.
    if (d.isBitsDesc(type)) {
        const laneNode = lane(texel, comp);
        const sub: Record<string, Node<d.u32>> = {};
        for (const bf of type.fields) {
            Object.defineProperty(sub, bf.name, {
                enumerable: true,
                get: () => {
                    const shifted = bf.shift === 0 ? laneNode : shiftRight(laneNode, u32(bf.shift));
                    if (bf.width >= 32) return shifted;
                    const mask = ((1 << bf.width) - 1) >>> 0;
                    return bitwiseAnd(shifted, u32(mask));
                },
            });
        }
        return sub as unknown as Node<Any>;
    }

    // Scalars and float/int/uint vectors, driven by the descriptor's `scalar` kind + `len`. Read `len`
    // lanes starting at `comp` (a vec2 aligns to 8 bytes so it may sit at comp 0 or 2; vec3/vec4 align to
    // 16 so comp is 0), reinterpreting each lane per the component kind: u32 raw, i32/f32 via bitcast.
    if ('scalar' in type && 'len' in type) {
        const len = type.len;
        const lanes = <T extends d.Any>(reinterpret: (l: Node<d.u32>) => Node<T>): Node<T>[] =>
            Array.from({ length: len }, (_, k) => reinterpret(lane(texel, comp + k)));
        if (type.scalar === 'u32') {
            // A whole u32 vec4 IS the texel — return it directly, no per-lane reconstruction.
            if (len === 4) return texel as unknown as Node<Any>;
            const c = lanes((l) => l);
            if (len === 1) return c[0] as Node<Any>;
            return (len === 2 ? vec2u(c[0], c[1]) : vec3u(c[0], c[1], c[2])) as Node<Any>;
        }
        if (type.scalar === 'i32') {
            const c = lanes(bitcastI32);
            if (len === 1) return c[0] as Node<Any>;
            return (
                len === 2 ? vec2i(c[0], c[1]) : len === 3 ? vec3i(c[0], c[1], c[2]) : vec4i(c[0], c[1], c[2], c[3])
            ) as Node<Any>;
        }
        if (type.scalar === 'f32') {
            const c = lanes(bitcastF32);
            if (len === 1) return c[0] as Node<Any>;
            return (
                len === 2 ? vec2f(c[0], c[1]) : len === 3 ? vec3(c[0], c[1], c[2]) : vec4(c[0], c[1], c[2], c[3])
            ) as Node<Any>;
        }
        // bool / f16 components have no structured-texture decode form; fall through to the error below.
    }
    // f32 matrices: each column has stride 16 (one texel) for 3- and 4-row matrices. Shape read from the
    // descriptor's cols/rows (present only on the matNxMf descriptors).
    if ('cols' in type && 'rows' in type) {
        const cols = type.cols;
        const rows = type.rows;
        if (rows !== 3 && rows !== 4) {
            throw new Error(`[gpucat] structured-texture load: matrix '${t}' (2-row column packing) not yet supported`);
        }
        const columns = Array.from({ length: cols }, (_, c) => {
            const ct = texAt(texelWithin + c);
            return rows === 4
                ? vec4(bitcastF32(lane(ct, 0)), bitcastF32(lane(ct, 1)), bitcastF32(lane(ct, 2)), bitcastF32(lane(ct, 3)))
                : vec3(bitcastF32(lane(ct, 0)), bitcastF32(lane(ct, 1)), bitcastF32(lane(ct, 2)));
        });
        if (cols === 4 && rows === 4) {
            const c = columns as Node<d.Vec4>[];
            return mat4(c[0], c[1], c[2], c[3]);
        }
        if (cols === 3 && rows === 3) {
            const c = columns as Node<d.Vec3>[];
            return mat3(c[0], c[1], c[2]);
        }
        throw new Error(`[gpucat] structured-texture load: matrix '${t}' not yet supported`);
    }
    // Nested / whole struct: a structured-texture decode form like the scalar/vec/matrix branches above,
    // decoding each member at its own byte offset and assembling a struct constructor (recursing for
    // nested structs). Shared texel reads across members dedupe via CSE, so the record costs one fetch
    // per distinct texel. Serves any struct-typed `texture(t).load(schema, i)` read; the storage() WebGL
    // lowering reuses it like the other branches (a whole `storage.element(i)`, or a nested
    // `.field('params').field('tint')`, resolves here). Members that are themselves arrays / bool / f16
    // fall through to the per-member error below.
    if (d.isStructDesc(type)) {
        const layout = structFieldLayout(type as unknown as d.StructDesc);
        const members = layout.fields.map((f) => decodeField(base, texelBase, width, byteOffset + f.byteOffset, f.type));
        return new ConstructNode(type, members);
    }
    throw new Error(`[gpucat] structured-texture load: field type '${t}' not supported`);
}

function buildRecordAccessor<S extends d.StructSchema>(
    base: TextureNode<FlatSampledTexture>,
    schema: StructDef<S>,
    texelBase: Node<d.u32>,
    width: Node<d.u32>,
): RecordAccessor<S> {
    const layout = structFieldLayout(schema as unknown as d.StructDesc);
    const acc: Record<string, Node<Any>> = {};
    for (const f of layout.fields) {
        Object.defineProperty(acc, f.name, {
            enumerable: true,
            get: () => decodeField(base, texelBase, width, f.byteOffset, f.type),
        });
    }
    return acc as RecordAccessor<S>;
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
export function sampler(source: GpuSampler, group?: UniformGroup): SamplerNode<d.sampler>;
export function sampler(source: HighLevelTexture, group?: UniformGroup): SamplerNode<d.sampler>;
export function sampler(source: GpuSampler | HighLevelTexture, group: UniformGroup = objectGroup): SamplerNode<d.sampler> {
    if ('isGpuSampler' in source) {
        const node = new SamplerNode(d.sampler, `s${_samplerIdCounter++}`, group);
        node.value = source;
        return node;
    } else {
        const node = new SamplerNode(d.sampler, `s${source.id}`, group);
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
export function comparisonSampler(
    source: GpuSampler,
    compare?: GPUCompareFunction,
    group?: UniformGroup,
): SamplerNode<d.samplerComparison>;
export function comparisonSampler(
    source: HighLevelTexture,
    compare?: GPUCompareFunction,
    group?: UniformGroup,
): SamplerNode<d.samplerComparison>;
export function comparisonSampler(
    source: GpuSampler | HighLevelTexture,
    compare: GPUCompareFunction = 'less',
    group: UniformGroup = objectGroup,
): SamplerNode<d.samplerComparison> {
    const baseSampler = 'isGpuSampler' in source ? source : source._gpuSampler;
    const samplerId = 'isGpuSampler' in source ? `s${_samplerIdCounter++}_cmp` : `s${source.id}_cmp`;

    const node = new SamplerNode(d.samplerComparison, samplerId, group);
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

/** The sampled-texture descriptor a storage texture is sampled as (dual-usage). */
type StorageSampledOf<S extends d.StorageTexture> = S extends d.textureStorage3d
    ? d.texture3d
    : S extends d.textureStorage2dArray
      ? d.texture2dArray
      : S extends d.textureStorage1d
        ? d.texture1d
        : d.texture2d;

/** Build the sampled texture descriptor for sampling a storage texture (dual-usage). */
function sampledDescForStorage(desc: d.StorageTexture): FlatSampledTexture {
    const channel = d.STORAGE_FORMATS[desc.format].channel;
    const sampleType = channel === 'u32' ? d.u32 : channel === 'i32' ? d.i32 : d.f32;
    switch (desc.dim) {
        case '1d':
            return d.texture1d(sampleType);
        case '2d_array':
            return d.texture2dArray(sampleType);
        case '3d':
            return d.texture3d(sampleType);
        default:
            return d.texture2d(sampleType);
    }
}

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
export function texture(tex: Texture): TextureNode<d.texture2d>;
export function texture(dataTex: DataTexture): TextureNode<d.texture2d>;
export function texture<D extends FlatSampledTexture>(gpuTex: GpuTexture<D>, gpuSampler: GpuSampler): TextureNode<D>;
export function texture<S extends d.StorageTexture>(
    storageTex: GpuTexture<S>,
    gpuSampler: GpuSampler,
): TextureNode<StorageSampledOf<S>>;
export function texture(
    source: Texture | DataTexture | GpuTexture<FlatSampledTexture> | GpuTexture<d.StorageTexture>,
    gpuSampler?: GpuSampler,
): TextureNode<FlatSampledTexture> {
    if ('isGpuTexture' in source) {
        if (!gpuSampler) {
            throw new Error('texture(): GpuSampler required when passing GpuTexture directly');
        }
        // Storage textures are dual-usage (STORAGE_BINDING | TEXTURE_BINDING): the same GPU
        // texture written in compute can be sampled here. Bind it as a sampled texture whose
        // sample type matches the storage format's channel.
        if (d.isStorageTextureDesc(source.type)) {
            const sampledDesc = sampledDescForStorage(source.type);
            const binding = new TextureBindingNode(sampledDesc, `t${_textureIdCounter++}`);
            binding.value = source as unknown as GpuTexture<FlatSampledTexture>;
            const node = new TextureNode(binding);
            node.samplerNode = sampler(gpuSampler, binding.group);
            return node;
        }
        // Widen the type for the binding to FlatSampledTexture
        const sampledSource = source as GpuTexture<FlatSampledTexture>;
        const desc = sampledSource.type as FlatSampledTexture;
        const binding = new TextureBindingNode(desc, `t${_textureIdCounter++}`);
        binding.value = sampledSource;
        const node = new TextureNode(binding);
        node.samplerNode = sampler(gpuSampler, binding.group);
        return node;
    } else {
        // A high-level Texture or DataTexture — both expose `_gpuTexture` / `_gpuSampler` / `id`. The
        // GpuTexture's descriptor carries the sampled type (a DataTexture backed by an integer format
        // reports `texture2d<u32>`/`texture2d<i32>`, so the emitter declares usampler2D/isampler2D and
        // `.load()` returns uvec4/ivec4) — so DataTexture rides this same branch, no cast needed.
        const gpuTex = source._gpuTexture;
        const desc = gpuTex.type as FlatSampledTexture;
        const binding = new TextureBindingNode(desc, `t${source.id}`);
        binding.value = gpuTex;
        const node = new TextureNode(binding);
        node.samplerNode = sampler(source._gpuSampler, binding.group);
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
    textureDesc: D,
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
    readonly kind = NodeKind.CubeTexture;

    /** The texture binding, holds GPU resource, textureId, group. */
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

    constructor(bindingNode: TextureBindingNode<CubeSampledTexture>, directionNode: Node<d.vec3f> | null = null) {
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
export function cubeTexture(source: CubeTexture | GpuTexture<CubeSampledTexture>, gpuSampler?: GpuSampler): CubeTextureNode {
    if ('isGpuTexture' in source) {
        if (!gpuSampler) {
            throw new Error('cubeTexture(): GpuSampler required when passing GpuTexture directly');
        }
        const desc = source.type as CubeSampledTexture;
        const binding = new TextureBindingNode(desc, `t${_textureIdCounter++}`);
        binding.value = source;
        const node = new CubeTextureNode(binding);
        node.samplerNode = sampler(gpuSampler, binding.group);
        return node;
    } else {
        const gpuTex = source._gpuTexture;
        const desc = gpuTex.type as CubeSampledTexture;
        const binding = new TextureBindingNode(desc, `t${source.id}`);
        binding.value = gpuTex;
        const node = new CubeTextureNode(binding);
        node.samplerNode = sampler(source._gpuSampler, binding.group);
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
    readonly kind = NodeKind.DepthTexture;

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

    constructor(bindingNode: TextureBindingNode<FlatDepthTexture>, uvNode: Node<d.vec2f> | null = null) {
        // Node type is f32 (depth value)
        super(d.f32);
        this.bindingNode = bindingNode;
        this.uvNode = uvNode ?? varying(uv());
    }

    /** Get the base texture node (follows referenceNode chain) */
    getBase(): DepthTextureNode {
        return this.referenceNode ? this.referenceNode.getBase() : this;
    }

    /** Clone this texture node */
    clone(): DepthTextureNode {
        const cloned = new DepthTextureNode(this.bindingNode, this.uvNode);
        cloned.referenceNode = this.referenceNode;
        cloned.samplerNode = this.samplerNode;
        cloned.samplingMode = this.samplingMode;
        cloned.levelNode = this.levelNode;
        cloned.offsetNode = this.offsetNode;
        cloned.loadCoords = this.loadCoords;
        cloned.loadLevel = this.loadLevel;
        if (this._beforeNodes) cloned._beforeNodes = [...this._beforeNodes];
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
export function depthTexture(source: DepthTexture | GpuTexture<FlatDepthTexture>, gpuSampler?: GpuSampler): DepthTextureNode {
    if ('isGpuTexture' in source) {
        if (!gpuSampler) {
            throw new Error('depthTexture(): GpuSampler required when passing GpuTexture directly');
        }
        const desc = source.type as FlatDepthTexture;
        const binding = new TextureBindingNode(desc, `t${_textureIdCounter++}`);
        binding.value = source;
        const node = new DepthTextureNode(binding);
        node.samplerNode = sampler(gpuSampler, binding.group);
        return node;
    } else {
        const gpuTex = source._gpuTexture;
        const desc = gpuTex.type as FlatDepthTexture;
        const binding = new TextureBindingNode(desc, `t${source.id}`);
        binding.value = gpuTex;
        const node = new DepthTextureNode(binding);
        node.samplerNode = sampler(source._gpuSampler, binding.group);
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
    readonly kind = NodeKind.ArrayTexture;

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

    constructor(bindingNode: TextureBindingNode<d.texture2dArray>, layerNode: Node<d.i32>, uvNode: Node<d.vec2f> | null = null) {
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
export function arrayTexture(
    gpuTex: GpuTexture<d.texture2dArray>,
    gpuSampler: GpuSampler,
    layerNode: Node<d.i32>,
): ArrayTextureNode;
export function arrayTexture(
    source: ArrayTexture | GpuTexture<d.texture2dArray>,
    samplerOrLayer: GpuSampler | Node<d.i32>,
    maybeLayerNode?: Node<d.i32>,
): ArrayTextureNode {
    if ('isGpuTexture' in source) {
        const gpuSampler = samplerOrLayer as GpuSampler;
        const layerNode = maybeLayerNode!;
        const binding = new TextureBindingNode(source.type, `t${_textureIdCounter++}`);
        binding.value = source;
        const node = new ArrayTextureNode(binding, layerNode);
        node.samplerNode = sampler(gpuSampler, binding.group);
        return node;
    } else {
        const layerNode = samplerOrLayer as Node<d.i32>;
        const gpuTex = source._gpuTexture;
        const binding = new TextureBindingNode(gpuTex.type, `t${source.id}`);
        binding.value = gpuTex;
        const node = new ArrayTextureNode(binding, layerNode);
        node.samplerNode = sampler(source._gpuSampler, binding.group);
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
    offset?: Node<d.vec2i>,
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
    offset?: Node<d.vec2i>,
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
    offset?: Node<d.vec2i>,
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
    offset?: Node<d.vec2i>,
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
    offset?: Node<d.vec2i>,
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
    offset?: Node<d.vec2i>,
): CallNode<d.f32> {
    const args: Node<Any>[] = offset ? [t, s, coords, depthRef, level, offset] : [t, s, coords, depthRef, level];
    return new CallNode(d.f32, 'textureSampleCompareLevel', args);
}

/** Integer coordinate node accepted by storage textureStore/textureLoad. */
export type StorageCoord = Node<d.u32> | Node<d.i32> | Node<d.vec2u> | Node<d.vec2i> | Node<d.vec3u> | Node<d.vec3i>;

/** vec4 value node accepted by storage textureStore. */
export type StorageValue = Node<d.vec4f> | Node<d.vec4i> | Node<d.vec4u>;

/**
 * textureLoad - Load a texel directly without filtering.
 * - Sampled textures: needs a mip `level`. Works in any stage. No sampler.
 * - Storage textures (read / read_write): no level; returns `vec4<channel>` for the format.
 */
export function textureLoad<D extends d.Texture>(
    t: TextureBindingNode<D>,
    coords: Node<d.vec2i>,
    level: Node<d.i32>,
): CallNode<d.TextureSampleResultOf<D>>;
export function textureLoad<D extends d.StorageTexture>(
    t: StorageTextureBindingNode<D>,
    coords: StorageCoord,
    layer?: Node<d.i32> | Node<d.u32>,
): CallNode<d.vec4f | d.vec4i | d.vec4u>;
export function textureLoad(
    t: TextureBindingNode | StorageTextureBindingNode,
    coords: Node<Any>,
    levelOrLayer?: Node<Any>,
): CallNode<Any> {
    if (t.kind === NodeKind.StorageTextureBinding) {
        if (t.access === 'write') {
            throw new Error(`[gpucat] textureLoad on a 'write' storage texture; bind it with access 'read' or 'read_write'.`);
        }
        const args: Node<Any>[] = levelOrLayer !== undefined ? [t, coords, levelOrLayer] : [t, coords];
        return new CallNode(d.storageValueOf(t.type.format), 'textureLoad', args);
    }
    return new CallNode(d.textureSampleResultOf(t.type), 'textureLoad', [t, coords, levelOrLayer as Node<d.i32>]);
}

/**
 * textureStore - Store a value into a storage texture (a statement / side effect).
 *
 * 2D/3D: `textureStore(tex, coords, value)`. 2D-array: pass the array `layer` between
 * coords and value. The binding must have access 'write' or 'read_write'.
 */
export function textureStore<D extends d.StorageTexture>(
    t: StorageTextureBindingNode<D>,
    coords: StorageCoord,
    value: StorageValue,
    layer?: Node<d.i32> | Node<d.u32>,
): void {
    if (t.access === 'read') {
        throw new Error(`[gpucat] textureStore on a 'read' storage texture; bind it with access 'write' or 'read_write'.`);
    }
    const args: Node<Any>[] = layer !== undefined ? [t, coords, layer, value] : [t, coords, value];
    addToStack(new CallNode(d.Void, 'textureStore', args));
}

/**
 * textureDimensions - Get texture dimensions.
 */
export function textureDimensions(t: TextureBindingNode, level?: Node<d.u32>): CallNode<d.vec2u> {
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
    offset?: Node<d.vec2i>,
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
    offset?: Node<d.vec2i>,
): CallNode<d.vec4f> {
    const args: Node<Any>[] = offset ? [t, s, coords, depthRef, offset] : [t, s, coords, depthRef];
    return new CallNode(d.vec4f, 'textureGatherCompare', args);
}
