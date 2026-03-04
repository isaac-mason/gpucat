/**
 * material.ts — Material class: shader slot graphs + render state.
 *
 * No WebGPU imports. GPU resource creation lives in the renderer layer.
 * Uniform/texture/sampler values live directly on their node objects.
 */

import type { Node, WgslType } from '../nodes/nodes.js';

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
