import type { Node } from '../nodes/nodes';
import type { Any } from '../schema/schema';
import type { Uniform } from '../core/uniform';

/**
 * Back-face stencil op overrides. WebGPU applies stencil ops per face; by default gpucat uses the
 * material's stencil ops for both faces. Set `stencilBack` to give back faces different ops (e.g.
 * two-sided stencil shadow volumes). Omitted fields fall back to the corresponding front-face op.
 */
export type StencilFaceOverride = {
    func?: GPUCompareFunction;
    fail?: GPUStencilOperation;
    zFail?: GPUStencilOperation;
    zPass?: GPUStencilOperation;
};

export interface MaterialOptions {
    /** Material name, for debugging. */
    name?: string;

    /**
     * vec4f clip-space position graph.
     * Use `positionClip` for standard MVP transform.
     */
    vertex: Node<Any>;

    /**
     * Fragment output. Can be:
     * - A vec4f node for single color output
     * - An OutputStructNode/MRTNode for multiple render targets
     * - Omitted/null for depth-only rendering (e.g. shadow passes)
     */
    fragment?: Node<Any>;

    /**
     * An optional `f32` override for the fragment depth written to the depth buffer.
     * When set, the compiler emits `@builtin(frag_depth)` on the fragment
     * output and assigns this value.
     */
    depth?: Node<Any>;

    /** Controls draw sort order (opaque vs transparent) AND the default for depthWrite. */
    transparent?: boolean;

    /** Optional blend state. Only meaningful when transparent=true or custom blending. */
    blend?: GPUBlendState;

    /** Whether the fragment shader writes color. When false, the color target's write mask is 0 (e.g. a stencil-only mask pass that still needs a matching color target). Default true. */
    colorWrite?: boolean;

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

    /** Constant depth bias in depth buffer precision steps. Default 0. */
    depthBias?: number;

    /** Depth bias scaled by the fragment's slope (dz/dx, dz/dy). Default 0. */
    depthBiasSlopeScale?: number;

    /** Maximum absolute depth bias value. Default 0 (no clamp). */
    depthBiasClamp?: number;

    /** Whether the stencil test is active. When false, the pipeline uses a no-op stencil state. Default false. */
    stencilTest?: boolean;

    /** Stencil comparison function (stored ref/value → pass/fail). Default 'always'. Only used when stencilTest=true. */
    stencilFunc?: GPUCompareFunction;

    /** Reference value the stencil test compares against; applied via setStencilReference. Default 0. */
    stencilRef?: number;

    /** Bitmask AND-ed with the reference and stored value before comparing. Default 0xff. */
    stencilReadMask?: number;

    /** Bitmask selecting which stencil bits may be written. Default 0xff. */
    stencilWriteMask?: number;

    /** Op applied when the stencil test fails. Default 'keep'. */
    stencilFail?: GPUStencilOperation;

    /** Op applied when the stencil test passes but the depth test fails. Default 'keep'. */
    stencilZFail?: GPUStencilOperation;

    /** Op applied when both the stencil and depth tests pass. Default 'keep'. */
    stencilZPass?: GPUStencilOperation;

    /** Per-face override for back-face stencil ops. When unset, back faces use the front-face ops. */
    stencilBack?: StencilFaceOverride;
}

export class Material {
    /** Material name, for debugging. */
    name: string;

    /** Vertex node. Use `positionClip` for standard MVP transform. */
    vertex: Node<Any>;

    /** Fragment output. Can be vec4f, OutputStructNode for MRT, or undefined for depth-only. */
    fragment: Node<Any> | undefined;

    /** f32 depth override, written to @builtin(frag_depth) */
    depth: Node<Any> | undefined;

    /** Controls draw sort order (opaque vs transparent) AND the default for depthWrite. */
    transparent: boolean;

    /** Optional blend state. Only meaningful when transparent=true or custom blending. */
    blend?: GPUBlendState;

    /** Whether the fragment shader writes color. When false, the color target's write mask is 0. */
    colorWrite: boolean;

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

    /** Constant depth bias in depth buffer precision steps. Default 0. */
    depthBias: number;

    /** Depth bias scaled by the fragment's slope (dz/dx, dz/dy). Default 0. */
    depthBiasSlopeScale: number;

    /** Maximum absolute depth bias value. Default 0 (no clamp). */
    depthBiasClamp: number;

    /** Whether the stencil test is active. When false, the pipeline uses a no-op stencil state. */
    stencilTest: boolean;

    /** Stencil comparison function. Only used when stencilTest=true. */
    stencilFunc: GPUCompareFunction;

    /** Reference value the stencil test compares against; applied via setStencilReference. */
    stencilRef: number;

    /** Bitmask AND-ed with the reference and stored value before comparing. */
    stencilReadMask: number;

    /** Bitmask selecting which stencil bits may be written. */
    stencilWriteMask: number;

    /** Op applied when the stencil test fails. */
    stencilFail: GPUStencilOperation;

    /** Op applied when the stencil test passes but the depth test fails. */
    stencilZFail: GPUStencilOperation;

    /** Op applied when both the stencil and depth tests pass. */
    stencilZPass: GPUStencilOperation;

    /** Per-face override for back-face stencil ops, or null to use the front-face ops on both faces. */
    stencilBack: StencilFaceOverride | null;

    /**
     * Named uniforms for this material.
     * Used for name-based uniform resolution: uniform('roughness', d.f32) resolves
     * to material.uniforms.get('roughness') at render time.
     */
    uniforms: Map<string, Uniform<any>> = new Map();

    constructor(opts: MaterialOptions) {
        this.name = opts.name ?? '';

        this.vertex = opts.vertex;
        this.fragment = opts.fragment;
        this.depth = opts.depth;

        this.transparent = opts.transparent ?? false;
        this.blend = opts.blend;
        this.colorWrite = opts.colorWrite ?? true;
        this.depthTest = opts.depthTest ?? true;
        this.depthWrite = opts.depthWrite ?? !this.transparent;
        this.depthCompare = opts.depthCompare ?? 'less';
        this.cullMode = opts.cullMode ?? 'back';
        this.alphaToCoverage = opts.alphaToCoverage ?? false;
        this.depthBias = opts.depthBias ?? 0;
        this.depthBiasSlopeScale = opts.depthBiasSlopeScale ?? 0;
        this.depthBiasClamp = opts.depthBiasClamp ?? 0;

        this.stencilTest = opts.stencilTest ?? false;
        this.stencilFunc = opts.stencilFunc ?? 'always';
        this.stencilRef = opts.stencilRef ?? 0;
        this.stencilReadMask = opts.stencilReadMask ?? 0xff;
        this.stencilWriteMask = opts.stencilWriteMask ?? 0xff;
        this.stencilFail = opts.stencilFail ?? 'keep';
        this.stencilZFail = opts.stencilZFail ?? 'keep';
        this.stencilZPass = opts.stencilZPass ?? 'keep';
        this.stencilBack = opts.stencilBack ?? null;
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
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this._onDispose?.();
    }
}
