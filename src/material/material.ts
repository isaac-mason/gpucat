/**
 * material.ts — Material class: shader slot graphs + render state.
 *
 * This is a low-level, minimal Material API (similar to Three.js RawShaderMaterial).
 * Users build their own clip-space position and fragment output — no magic pipeline.
 *
 * Slots consumed by the compiler:
 *
 *   VERTEX
 *     vertexNode    — vec4f clip-space position (required unless using default positionClip)
 *
 *   FRAGMENT
 *     fragmentNode  — vec4f fragment output, OR an OutputStructNode/MRTNode for MRT
 *     maskNode      — bool discard mask (discard when false)
 *     depthNode     — f32 override for @builtin(frag_depth)
 *
 * For MRT (Multiple Render Targets), pass an mrt() node as fragmentNode:
 *
 *   const mat = new Material({
 *       vertex: clipPos,
 *       fragment: mrt({
 *           color: outputColor,
 *           normal: viewNormal,
 *       }),
 *   });
 *
 * No WebGPU imports. GPU resource creation lives in the renderer layer.
 */

import type { Node, WgslType } from '../nodes/nodes';

export interface MaterialOptions {
    // ---- Vertex stage --------------------------------------------------

    /**
     * vec4f clip-space position graph.
     * Use `positionClip` for standard MVP transform.
     */
    vertex: Node<WgslType>;

    // ---- Fragment stage ------------------------------------------------

    /**
     * Fragment output. Can be:
     * - A vec4f node for single color output
     * - An OutputStructNode/MRTNode for multiple render targets
     *
     * Required.
     */
    fragment: Node<WgslType>;

    /**
     * bool discard mask. When this node evaluates to false, the fragment is
     * discarded. Evaluated before all other fragment logic.
     */
    mask?: Node<WgslType>;

    /**
     * f32 override for the fragment depth written to the depth buffer.
     * When set, the compiler emits `@builtin(frag_depth)` on the fragment
     * output and assigns this value.
     */
    depth?: Node<WgslType>;

    // ---- Render state --------------------------------------------------

    /** Controls draw sort order (opaque vs transparent) AND the default for depthWrite. */
    transparent?: boolean;

    /** Optional blend state. Only meaningful when transparent=true or custom blending. */
    blend?: GPUBlendState;

    /** Whether depth testing is active. When false, depthCompare is forced to 'always'. */
    depthTest?: boolean;

    /** Whether to write to the depth buffer. Default: true for opaque, false for transparent. */
    depthWrite?: boolean;

    /** Depth comparison function. Default 'less'. Forced to 'always' when depthTest=false. */
    depthCompare?: GPUCompareFunction;

    /** Back-face culling mode. Default 'back'. */
    cullMode?: GPUCullMode;

    /** Alpha-to-coverage. Meaningful only when renderer.samples > 1. Default false. */
    alphaToCoverage?: boolean;
}

export class Material {
    // -----------------------------------------------------------------------
    // Vertex stage
    // -----------------------------------------------------------------------

    /**
     * vec4f clip-space position.
     */
    vertexNode: Node<WgslType>;

    // -----------------------------------------------------------------------
    // Fragment stage
    // -----------------------------------------------------------------------

    /**
     * Fragment output. Can be vec4f or OutputStructNode for MRT.
     */
    fragmentNode: Node<WgslType>;

    /**
     * bool discard mask — fragment is discarded when false.
     */
    maskNode: Node<WgslType> | undefined;

    /**
     * f32 depth override — written to @builtin(frag_depth).
     */
    depthNode: Node<WgslType> | undefined;

    // -----------------------------------------------------------------------
    // Render state
    // -----------------------------------------------------------------------

    /** Controls draw sort order (opaque vs transparent) AND the default for depthWrite. */
    transparent: boolean;

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
        // Vertex is required
        if (!opts.vertex) {
            throw new Error('[Material] vertex is required. Use positionClip for standard MVP transform.');
        }
        this.vertexNode = opts.vertex;

        // Fragment is required
        if (!opts.fragment) {
            throw new Error('[Material] fragment is required.');
        }
        this.fragmentNode = opts.fragment;

        // Fragment slots
        this.maskNode = opts.mask;
        this.depthNode = opts.depth;

        // Render state
        const transparent = opts.transparent ?? false;
        this.transparent = transparent;
        this.blend = opts.blend;
        this.depthTest = opts.depthTest ?? true;
        this.depthWrite = opts.depthWrite ?? !transparent;
        this.depthCompare = opts.depthCompare ?? 'less';
        this.cullMode = opts.cullMode ?? 'back';
        this.alphaToCoverage = opts.alphaToCoverage ?? false;
    }

    /**
     * Incremented whenever the material's node graph configuration changes in a
     * way that requires a shader recompile.  The renderer includes this in the
     * RenderObject cache key so that bumping it triggers recompilation on the
     * next frame.  Three.js aligned: mirrors Texture.version / Material.version.
     */
    version: number = 0;

    /**
     * Setting needsUpdate = true increments version, which causes the renderer
     * to recompile the material's shader on the next frame.
     * Three.js aligned: mirrors Material.needsUpdate setter.
     */
    set needsUpdate(value: boolean) {
        if (value === true) this.version++;
    }

    /**
     * Set to true after dispose() is called.
     * The renderer checks this flag to skip rendering and clean up GPU resources.
     */
    disposed: boolean = false;

    /**
     * Internal callback set by the renderer to clean up GPU resources (e.g., pipelines).
     * @internal
     */
    _onDispose: (() => void) | null = null;

    /**
     * Frees GPU-related resources allocated for this material.
     * Call this method when the material is no longer used.
     * Mirrors Three.js Material.dispose().
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this._onDispose?.();
    }
}
