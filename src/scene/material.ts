/**
 * material.ts — Material class: shader slot graphs + render state + live uniform values.
 *
 * No WebGPU imports. GPU resource creation lives in the renderer layer.
 */

import type { Node, WgslType } from '../nodes/nodes.js';

// ---------------------------------------------------------------------------
// UniformValue — the type of values stored in material.uniforms
// ---------------------------------------------------------------------------

/**
 * A live per-material uniform value.
 *
 * - number        → f32 scalar
 * - number[]      → packed into Float32Array by the renderer (vec/mat)
 * - Float32Array  → vector or matrix data (uploaded as-is)
 * - GPUTexture    → bound to the texture slot for the matching textureId
 * - GPUSampler    → bound to the sampler slot for the matching samplerId
 */
export type UniformValue = number | number[] | Float32Array | GPUTexture | GPUSampler;

// ---------------------------------------------------------------------------
// UniformsMap — Map with generation counter for change detection
// ---------------------------------------------------------------------------

export class UniformsMap extends Map<string, UniformValue> {
    /** Incremented every time `set()` is called. The renderer compares this to
     *  `_lastUploadedGeneration` to decide whether a GPU re-upload is needed. */
    generation: number = 0;

    override set(key: string, value: UniformValue): this {
        super.set(key, value);
        this.generation++;
        return this;
    }
}

// ---------------------------------------------------------------------------
// Material
// ---------------------------------------------------------------------------

export interface MaterialOptions {
    /** vec4f clip-space position graph. Omit to use the default MVP transform. */
    position?: Node<WgslType>;
    /** vec4f RGBA color graph. Required. */
    color: Node<WgslType>;

    // Render state overrides
    transparent?: boolean;
    targets?: number;
    blend?: GPUBlendState;
    depthTest?: boolean;
    depthWrite?: boolean;
    depthCompare?: GPUCompareFunction;
    cullMode?: GPUCullMode;
    alphaToCoverage?: boolean;
}

export class Material {
    // -----------------------------------------------------------------------
    // Shader output slots
    // -----------------------------------------------------------------------

    /** vec4f clip-space position. Omit for the default MVP transform. */
    position?: Node<WgslType>;

    /** vec4f RGBA color output. Required. For MRT, resolve to array<vec4f, N>. */
    color: Node<WgslType>;

    // -----------------------------------------------------------------------
    // Render state
    // -----------------------------------------------------------------------

    /** Controls draw sort order (opaque vs transparent) AND the default for depthWrite. */
    transparent: boolean;

    /** Number of MRT color attachments. Default 1. */
    targets: number;

    /** Optional blend state. Only meaningful when transparent=true or custom blending. */
    blend?: GPUBlendState;

    /** Whether depth testing is active. When false, depthCompare is forced to 'always'. */
    depthTest: boolean;

    /** Whether to write to the depth buffer. Default: true for opaque, false for transparent. */
    depthWrite: boolean;

    /** Depth comparison function. Default 'less'. Forced to 'always' when depthTest=false. */
    depthCompare: GPUCompareFunction;

    /** Back-face culling mode. Default 'back'. */
    cullMode: GPUCullMode;

    /** Alpha-to-coverage. Meaningful only when renderer.samples > 1. Default false. */
    alphaToCoverage: boolean;

    // -----------------------------------------------------------------------
    // Live uniform values
    // -----------------------------------------------------------------------

    /**
     * Per-material uniform/texture/sampler values.
     * Keys match uniformId/textureId/samplerId declared in the node graph.
     * The renderer re-uploads when generation advances.
     */
    uniforms: UniformsMap = new UniformsMap();

    /** Tracks which generation was last uploaded to the GPU. Managed by the renderer. */
    _lastUploadedGeneration: number = -1;

    constructor(opts: MaterialOptions) {
        this.color = opts.color;
        this.position = opts.position;

        const transparent = opts.transparent ?? false;

        this.transparent = transparent;
        this.targets = opts.targets ?? 1;
        this.blend = opts.blend;
        this.depthTest = opts.depthTest ?? true;
        // depthWrite defaults to false for transparent materials, true for opaque
        this.depthWrite = opts.depthWrite ?? !transparent;
        this.depthCompare = opts.depthCompare ?? 'less';
        this.cullMode = opts.cullMode ?? 'back';
        this.alphaToCoverage = opts.alphaToCoverage ?? false;
    }
}
