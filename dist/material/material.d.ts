import type { Node } from 'gpucat/dist/nodes/nodes';
import type { Any } from 'gpucat/dist/schema/schema';
import type { Uniform } from 'gpucat/dist/core/uniform';
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
    fragment?: Node<Any> | null;
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
}
export declare class Material {
    /** Material name, for debugging. */
    name: string;
    /** vec4f clip-space position. */
    vertexNode: Node<Any>;
    /** Fragment output. Can be vec4f, OutputStructNode for MRT, or null for depth-only. */
    fragmentNode: Node<Any> | null;
    /** f32 depth override — written to @builtin(frag_depth) */
    depthNode: Node<Any> | undefined;
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
    /** Constant depth bias in depth buffer precision steps. Default 0. */
    depthBias: number;
    /** Depth bias scaled by the fragment's slope (dz/dx, dz/dy). Default 0. */
    depthBiasSlopeScale: number;
    /** Maximum absolute depth bias value. Default 0 (no clamp). */
    depthBiasClamp: number;
    /**
     * Named uniforms for this material.
     * Used for name-based uniform resolution: uniform('roughness', d.f32) resolves
     * to material.uniforms.get('roughness') at render time.
     */
    uniforms: Map<string, Uniform>;
    constructor(opts: MaterialOptions);
    /**
     * Incremented whenever the material's node graph configuration changes in a
     * way that requires a shader recompile.  The renderer includes this in the
     * RenderObject cache key so that bumping it triggers recompilation on the
     * next frame.
     */
    version: number;
    /**
     * Setting needsUpdate = true increments version, which causes the renderer
     * to recompile the material's shader on the next frame.
     */
    set needsUpdate(value: boolean);
    /**
     * Set to true after dispose() is called.
     * The renderer checks this flag to skip rendering and clean up GPU resources.
     */
    disposed: boolean;
    /**
     * Internal callback set by the renderer to clean up GPU resources (e.g., pipelines).
     * @internal
     */
    _onDispose: (() => void) | null;
    /**
     * Frees GPU-related resources allocated for this material.
     * Call this method when the material is no longer used.
     * Mirrors Three.js Material.dispose().
     */
    dispose(): void;
}
