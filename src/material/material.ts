import type { Node } from '../nodes/nodes';
import type { WgslDesc } from '../nodes/schema';

export interface MaterialOptions {
    /**
     * vec4f clip-space position graph.
     * Use `positionClip` for standard MVP transform.
     */
    vertex: Node<WgslDesc>;

    /**
     * Fragment output. Can be:
     * - A vec4f node for single color output
     * - An OutputStructNode/MRTNode for multiple render targets
     */
    fragment: Node<WgslDesc>;

    /**
     * An optional `bool` discard mask. When this node evaluates to false, the fragment is
     * discarded. Evaluated before all other fragment logic.
     */
    mask?: Node<WgslDesc>;

    /**
     * An optional `f32` override for the fragment depth written to the depth buffer.
     * When set, the compiler emits `@builtin(frag_depth)` on the fragment
     * output and assigns this value.
     */
    depth?: Node<WgslDesc>;

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
    /**
     * vec4f clip-space position.
     */
    vertexNode: Node<WgslDesc>;

    /** Fragment output. Can be vec4f or OutputStructNode for MRT */
    fragmentNode: Node<WgslDesc>;

    /** bool discard mask — fragment is discarded when false */
    maskNode: Node<WgslDesc> | undefined;

    /** f32 depth override — written to @builtin(frag_depth) */
    depthNode: Node<WgslDesc> | undefined;

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
        this.vertexNode = opts.vertex;
        this.fragmentNode = opts.fragment;
        this.maskNode = opts.mask;
        this.depthNode = opts.depth;

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
     * next frame. 
     */
    version: number = 0;

    /**
     * Setting needsUpdate = true increments version, which causes the renderer
     * to recompile the material's shader on the next frame.
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
