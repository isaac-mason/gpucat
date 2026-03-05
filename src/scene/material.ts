/**
 * material.ts — Material class: shader slot graphs + render state.
 *
 * Slots mirror three.js NodeMaterial, grouped by pipeline stage:
 *
 *   VERTEX
 *     vertexNode        — full clip-space vec4f override (like three.js vertexNode)
 *     positionNode      — local-space vec3f position override (fed into MVP)
 *
 *   FRAGMENT — full override
 *     fragmentNode      — full vec4f fragment output (bypasses all other frag slots)
 *
 *   FRAGMENT — color / appearance
 *     colorNode         — diffuse vec3f/vec4f color override
 *     opacityNode       — f32 opacity override
 *     alphaTestNode     — f32 alpha-test threshold (discard below)
 *     normalNode        — vec3f surface normal override
 *     emissiveNode      — vec3f emissive color override
 *     maskNode          — bool discard mask (discard when false)
 *
 *   FRAGMENT — depth
 *     depthNode         — f32 override for @builtin(frag_depth)
 *
 *   FRAGMENT — lighting
 *     lightsNode        — custom lights (stub; no lighting system yet)
 *     envNode           — environment map override (stub)
 *     aoNode            — ambient occlusion f32 override (stub)
 *     backdropNode      — backdrop vec3f color (stub)
 *     backdropAlphaNode — backdrop blend f32 (stub)
 *
 *   FRAGMENT — output
 *     outputNode        — post-pipeline vec4f output override (after lighting/fog)
 *
 *   SHADOW
 *     castShadowNode           — shadow map write override (stub)
 *     receivedShadowNode       — shadow receive override fn (stub)
 *     castShadowPositionNode   — local-space position during shadow cast (stub)
 *     receivedShadowPositionNode — world-space position during shadow receive (stub)
 *
 *   GEOMETRY
 *     geometryNode      — side-effect geometry hook (stub; e.g. GPU particles)
 *
 * Slots marked "(stub)" are stored here for API completeness so that higher-level
 * material subclasses can read them; the base compiler does not consume them yet.
 *
 * The compiler actively consumes: vertexNode, positionNode (future), fragmentNode,
 * maskNode (discard), depthNode (frag_depth).
 *
 * No WebGPU imports. GPU resource creation lives in the renderer layer.
 */

import type { Node, WgslType } from '../nodes/nodes';

// ---------------------------------------------------------------------------
// Material
// ---------------------------------------------------------------------------

export interface MaterialOptions {
    // ---- Vertex stage --------------------------------------------------

    /**
     * vec4f clip-space position graph. Omit to use the default MVP transform.
     * Maps to three.js NodeMaterial.vertexNode.
     */
    vertexNode?: Node<WgslType>;

    /**
     * Alias for vertexNode — kept for backward compatibility.
     * If both are set, vertexNode wins.
     */
    position?: Node<WgslType>;

    /**
     * vec3f local-space vertex position override, applied before the MVP
     * transform (after skinning/morphing when those are supported).
     * Maps to three.js NodeMaterial.positionNode.
     */
    positionNode?: Node<WgslType>;

    // ---- Fragment — full override --------------------------------------

    /**
     * vec4f full fragment output. When set, the standard color/lighting
     * pipeline is bypassed; only maskNode, depthNode, and outputNode still
     * apply on top.
     * Maps to three.js NodeMaterial.fragmentNode.
     */
    fragmentNode?: Node<WgslType>;

    /**
     * Alias for fragmentNode — kept for backward compatibility.
     * If both are set, fragmentNode wins.
     */
    color?: Node<WgslType>;

    // ---- Fragment — color / appearance --------------------------------

    /**
     * vec3f or vec4f diffuse color override.
     * Maps to three.js NodeMaterial.colorNode.
     */
    colorNode?: Node<WgslType>;

    /**
     * f32 opacity override. Multiplied into the final alpha.
     * Maps to three.js NodeMaterial.opacityNode.
     */
    opacityNode?: Node<WgslType>;

    /**
     * f32 alpha-test threshold. Fragments with alpha below this value
     * are discarded.
     * Maps to three.js NodeMaterial.alphaTestNode.
     */
    alphaTestNode?: Node<WgslType>;

    /**
     * vec3f surface normal override (world- or view-space, convention to be
     * defined by the consuming higher-level material).
     * Maps to three.js NodeMaterial.normalNode.
     */
    normalNode?: Node<WgslType>;

    /**
     * vec3f emissive color override added to the final output.
     * Maps to three.js NodeMaterial.emissiveNode.
     */
    emissiveNode?: Node<WgslType>;

    /**
     * bool discard mask. When this node evaluates to false, the fragment is
     * discarded. Evaluated before all other fragment logic.
     * Maps to three.js NodeMaterial.maskNode.
     * Compiler support: active — emits `if (!mask) { discard; }` in fs_main.
     */
    maskNode?: Node<WgslType>;

    // ---- Fragment — depth ---------------------------------------------

    /**
     * f32 override for the fragment depth written to the depth buffer.
     * When set, the compiler emits `@builtin(frag_depth)` on the fragment
     * output and assigns this value.
     * Maps to three.js NodeMaterial.depthNode.
     * Compiler support: active.
     */
    depthNode?: Node<WgslType>;

    // ---- Fragment — lighting (stubs) ----------------------------------

    /**
     * Custom lights node override. Stub — stored but not yet consumed by the
     * base compiler. Intended for a future lighting system.
     * Maps to three.js NodeMaterial.lightsNode.
     */
    lightsNode?: Node<WgslType>;

    /**
     * Environment map override. Stub.
     * Maps to three.js NodeMaterial.envNode.
     */
    envNode?: Node<WgslType>;

    /**
     * f32 ambient occlusion factor override. Stub.
     * Maps to three.js NodeMaterial.aoNode.
     */
    aoNode?: Node<WgslType>;

    /**
     * vec3f backdrop color (e.g. viewportSharedTexture for filter effects). Stub.
     * Maps to three.js NodeMaterial.backdropNode.
     */
    backdropNode?: Node<WgslType>;

    /**
     * f32 backdrop blend factor. Stub.
     * Maps to three.js NodeMaterial.backdropAlphaNode.
     */
    backdropAlphaNode?: Node<WgslType>;

    // ---- Fragment — output --------------------------------------------

    /**
     * vec4f post-pipeline fragment output override. Applied after the full
     * standard pipeline (lighting, fog, premultiplied alpha). Stub — the base
     * compiler currently uses fragmentNode (or color) as the terminal output;
     * outputNode is intended to wrap it for post-effects.
     * Maps to three.js NodeMaterial.outputNode.
     */
    outputNode?: Node<WgslType>;

    // ---- Shadow (stubs) -----------------------------------------------

    /**
     * vec4f shadow map write override during shadow casting. Stub.
     * Maps to three.js NodeMaterial.castShadowNode.
     */
    castShadowNode?: Node<WgslType>;

    /**
     * Shadow receive override function. Stub.
     * Maps to three.js NodeMaterial.receivedShadowNode.
     */
    receivedShadowNode?: Node<WgslType>;

    /**
     * Local-space position override used during shadow map projection. Stub.
     * Maps to three.js NodeMaterial.castShadowPositionNode.
     */
    castShadowPositionNode?: Node<WgslType>;

    /**
     * World-space position override used when sampling shadow maps. Stub.
     * Maps to three.js NodeMaterial.receivedShadowPositionNode.
     */
    receivedShadowPositionNode?: Node<WgslType>;

    // ---- Geometry (stub) ----------------------------------------------

    /**
     * Side-effect geometry hook (e.g. GPU particle systems). Stub.
     * Maps to three.js NodeMaterial.geometryNode.
     */
    geometryNode?: Node<WgslType>;

    // ---- Boolean flags ------------------------------------------------

    /**
     * Enable the scene lighting pipeline. Default false (unlit).
     * Maps to three.js NodeMaterial.lights.
     */
    lights?: boolean;

    /**
     * Enable fog post-processing in setupOutput(). Default false (no fog system yet).
     * Maps to three.js NodeMaterial.fog.
     */
    fog?: boolean;

    // ---- Render state overrides ---------------------------------------

    /** Controls draw sort order (opaque vs transparent) AND the default for depthWrite. */
    transparent?: boolean;
    /** Number of MRT color attachments. Default 1. */
    targets?: number;
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
    // Vertex stage slots
    // -----------------------------------------------------------------------

    /**
     * vec4f clip-space position override. Null = use default MVP transform.
     * Maps to three.js NodeMaterial.vertexNode.
     */
    vertexNode: Node<WgslType> | undefined;

    /**
     * vec3f local-space position override (applied before MVP).
     * Maps to three.js NodeMaterial.positionNode.
     */
    positionNode: Node<WgslType> | undefined;

    // -----------------------------------------------------------------------
    // Fragment — full override slots
    // -----------------------------------------------------------------------

    /**
     * vec4f full fragment output. When set, the standard pipeline is bypassed.
     * Maps to three.js NodeMaterial.fragmentNode.
     */
    fragmentNode: Node<WgslType>;

    // -----------------------------------------------------------------------
    // Fragment — color / appearance slots
    // -----------------------------------------------------------------------

    /**
     * vec3f/vec4f diffuse color override.
     * Maps to three.js NodeMaterial.colorNode.
     */
    colorNode: Node<WgslType> | undefined;

    /**
     * f32 opacity override.
     * Maps to three.js NodeMaterial.opacityNode.
     */
    opacityNode: Node<WgslType> | undefined;

    /**
     * f32 alpha-test threshold (discard below).
     * Maps to three.js NodeMaterial.alphaTestNode.
     */
    alphaTestNode: Node<WgslType> | undefined;

    /**
     * vec3f surface normal override.
     * Maps to three.js NodeMaterial.normalNode.
     */
    normalNode: Node<WgslType> | undefined;

    /**
     * vec3f emissive color override.
     * Maps to three.js NodeMaterial.emissiveNode.
     */
    emissiveNode: Node<WgslType> | undefined;

    /**
     * bool discard mask — fragment is discarded when false.
     * Compiler support: active — emits `if (!mask) { discard; }`.
     * Maps to three.js NodeMaterial.maskNode.
     */
    maskNode: Node<WgslType> | undefined;

    // -----------------------------------------------------------------------
    // Fragment — depth slot
    // -----------------------------------------------------------------------

    /**
     * f32 depth override — written to @builtin(frag_depth).
     * Compiler support: active — emits frag_depth assignment.
     * Maps to three.js NodeMaterial.depthNode.
     */
    depthNode: Node<WgslType> | undefined;

    // -----------------------------------------------------------------------
    // Fragment — lighting slots (stubs)
    // -----------------------------------------------------------------------

    /** Custom lights node override. Stub. */
    lightsNode: Node<WgslType> | undefined;

    /** Environment map node override. Stub. */
    envNode: Node<WgslType> | undefined;

    /** f32 ambient occlusion override. Stub. */
    aoNode: Node<WgslType> | undefined;

    /** vec3f backdrop color. Stub. */
    backdropNode: Node<WgslType> | undefined;

    /** f32 backdrop blend factor. Stub. */
    backdropAlphaNode: Node<WgslType> | undefined;

    // -----------------------------------------------------------------------
    // Fragment — output slot
    // -----------------------------------------------------------------------

    /**
     * vec4f post-pipeline fragment output override. Stub.
     * Maps to three.js NodeMaterial.outputNode.
     */
    outputNode: Node<WgslType> | undefined;

    // -----------------------------------------------------------------------
    // Shadow slots (stubs)
    // -----------------------------------------------------------------------

    /** vec4f shadow map write override. Stub. */
    castShadowNode: Node<WgslType> | undefined;

    /** Shadow receive override fn. Stub. */
    receivedShadowNode: Node<WgslType> | undefined;

    /** Local-space position override for shadow casting. Stub. */
    castShadowPositionNode: Node<WgslType> | undefined;

    /** World-space position override for shadow receiving. Stub. */
    receivedShadowPositionNode: Node<WgslType> | undefined;

    // -----------------------------------------------------------------------
    // Geometry slot (stub)
    // -----------------------------------------------------------------------

    /** Side-effect geometry hook. Stub. */
    geometryNode: Node<WgslType> | undefined;

    // -----------------------------------------------------------------------
    // Boolean flags
    // -----------------------------------------------------------------------

    /** Enable the scene lighting pipeline. Default false (unlit). */
    lights: boolean;

    /** Enable fog post-processing. Default false (no fog system yet). */
    fog: boolean;

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
        // fragmentNode wins over color alias; one of them must be provided.
        const frag = opts.fragmentNode ?? opts.color;
        if (!frag) {
            throw new Error('[Material] fragmentNode (or color) is required.');
        }
        this.fragmentNode = frag;

        // vertexNode wins over position alias
        this.vertexNode = opts.vertexNode ?? opts.position;
        this.positionNode = opts.positionNode;

        // Color / appearance slots
        this.colorNode = opts.colorNode;
        this.opacityNode = opts.opacityNode;
        this.alphaTestNode = opts.alphaTestNode;
        this.normalNode = opts.normalNode;
        this.emissiveNode = opts.emissiveNode;
        this.maskNode = opts.maskNode;

        // Depth
        this.depthNode = opts.depthNode;

        // Lighting stubs
        this.lightsNode = opts.lightsNode;
        this.envNode = opts.envNode;
        this.aoNode = opts.aoNode;
        this.backdropNode = opts.backdropNode;
        this.backdropAlphaNode = opts.backdropAlphaNode;

        // Output
        this.outputNode = opts.outputNode;

        // Shadow stubs
        this.castShadowNode = opts.castShadowNode;
        this.receivedShadowNode = opts.receivedShadowNode;
        this.castShadowPositionNode = opts.castShadowPositionNode;
        this.receivedShadowPositionNode = opts.receivedShadowPositionNode;

        // Geometry stub
        this.geometryNode = opts.geometryNode;

        // Flags
        this.lights = opts.lights ?? false;
        this.fog = opts.fog ?? false;

        // Render state
        const transparent = opts.transparent ?? false;
        this.transparent = transparent;
        this.targets = opts.targets ?? 1;
        this.blend = opts.blend;
        this.depthTest = opts.depthTest ?? true;
        this.depthWrite = opts.depthWrite ?? !transparent;
        this.depthCompare = opts.depthCompare ?? 'less';
        this.cullMode = opts.cullMode ?? 'back';
        this.alphaToCoverage = opts.alphaToCoverage ?? false;
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
