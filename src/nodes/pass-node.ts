/**
 * pass-node.ts — PassNode: renders a Scene into an off-screen RenderTarget and
 * exposes the result as texture nodes that can feed into post-processing graphs.
 *
 * Mirrors three's PassNode / pass() API:
 *
 *   const scenePass = pass(scene, camera);
 *
 *   const color = scenePass.getTextureNode();          // samples color RT at screen UV
 *   const viewZ = scenePass.getViewZNode();            // camera-space Z from depth RT
 *   const ld    = scenePass.getLinearDepthNode();      // linear depth [0,1]
 *
 *   renderer.render(color);
 *
 * RenderTarget lifecycle
 * ----------------------
 * The PassNode lazily allocates its color + depth textures on the first render and
 * auto-resizes when the renderer output dimensions change.  The renderer calls
 * updateBefore() once per frame (after compile-time discovery) which handles
 * allocation, scene rendering, and texture resource registration.
 *
 * updateBefore / compile-time discovery
 * --------------------------------------
 * PassNode.updateBeforeType = 'frame'.  During shader compilation, WgslBuilder
 * walks the node graph and collects all nodes with updateBeforeType !== 'none'
 * into CompileResult.updateBeforeNodes (in post-order, so dependencies execute
 * before the nodes that depend on them).  The renderer iterates this list once
 * per frame with per-frame deduplication (each node runs at most once).
 *
 * UV convention
 * -------------
 * All sampling nodes assume the fragment interpolant `in.uv` (vec2f) exists in the
 * fragment shader's input struct.  The renderer's internal fullscreen material
 * provides this via a varying injected by the fullscreen vertex shader.
 *
 * Depth reconstruction
 * --------------------
 * viewZ uses the standard perspective formula for a [0,1] depth buffer:
 *   viewZ = (near * far) / (depth * (near - far) + far)
 */

import { Node, TextureNode, SamplerNode, RawNode, cameraNear, cameraFar, type WgslType } from './nodes';
import type { Scene } from '../scene/scene';
import type { Camera } from '../scene/camera';
import type { RenderFrame } from '../renderer/render-frame';

// ---------------------------------------------------------------------------
// Unique ID generator
// ---------------------------------------------------------------------------

let _passCount = 0;

// ---------------------------------------------------------------------------
// PassColorTextureNode
// ---------------------------------------------------------------------------

/**
 * Samples the color render-target texture of a PassNode at `in.uv`.
 *
 * Emits:  textureSample(<id>_color_tex, <id>_color_sampler_samp, in.uv)
 */
export class PassColorTextureNode extends Node<'vec4f'> {
    readonly passNode: PassNode;
    /** The underlying TextureNode (registered in group 1 by the compiler). */
    readonly textureNode: TextureNode;
    /** The SamplerNode paired with the texture. */
    readonly samplerNode: SamplerNode;
    /**
     * Deps array — mirrors RawNode.deps so that depsOfNode()'s 'raw' branch
     * can traverse into this node's children without a special case.
     */
    readonly deps: Node<WgslType>[];
    /**
     * WGSL template — mirrors RawNode.wgsl so that compile.ts emitNodeExpr's
     * 'raw' branch can call .replace() on it.
     * $0 = texture expr, $1 = sampler expr (provided by deps above).
     */
    readonly wgsl = 'textureSample($0, $1, in.uv)';

    constructor(passNode: PassNode, textureNode: TextureNode, samplerNode: SamplerNode) {
        super(
            `pass_color_sample_${passNode.passId}`,
            'raw',
            'vec4f',
        );
        this.passNode    = passNode;
        this.textureNode = textureNode;
        this.samplerNode = samplerNode;
        // Include passNode in deps so the compiler discovers it and calls updateBefore().
        // Mirrors Three.js PassTextureNode.setup() which stores passNode in properties.
        this.deps        = [textureNode, samplerNode, passNode];
    }
}

// ---------------------------------------------------------------------------
// PassNodeOptions
// ---------------------------------------------------------------------------

export type PassNodeOptions = {
    /** RGBA clear color for this pass's color attachment. Defaults to [0, 0, 0, 1]. */
    clearColor?: [number, number, number, number];
    /**
     * GPUTextureFormat for the color render target.
     * Use 'rgba16float' (default) for HDR pipelines.
     * Use 'rgba8unorm' for LDR / post-sRGB output.
     */
    colorFormat?: GPUTextureFormat;
};

// ---------------------------------------------------------------------------
// PassNode
// ---------------------------------------------------------------------------

export class PassNode extends Node<'vec4f'> {
    readonly scene: Scene;
    readonly camera: Camera;

    /** Stable unique string used to namespace texture/sampler IDs. */
    readonly passId: string;

    /** Clear color for this pass's color attachment. Defaults to opaque black. */
    clearColor: [number, number, number, number];

    /**
     * GPUTextureFormat for the off-screen color render target.
     * Defaults to 'rgba16float' (HDR).
     */
    readonly colorFormat: GPUTextureFormat;

    /**
     * Nodes with updateBeforeType !== 'none' are collected at compile time and
     * executed once per frame before the final composite quad.
     * Three.js equivalent: Node.updateBeforeType = NodeUpdateType.FRAME.
     */
    readonly updateBeforeType: 'frame' | 'none' = 'frame';

    /**
     * Dependencies for this node — required because PassNode uses kind='raw'.
     * PassNode itself has no node dependencies (it renders a scene, not nodes),
     * so this is always empty.
     */
    readonly deps: Node<WgslType>[] = [];

    /**
     * WGSL template — required because PassNode uses kind='raw'.
     * PassNode doesn't emit WGSL directly (it's a side-effect node), but the
     * raw-node codepath expects this property.
     */
    readonly wgsl = '';

    // GPU resources — null until updateBefore() is first called.
    _colorTexture: GPUTexture | null = null;
    _depthTexture: GPUTexture | null = null;
    _sampler: GPUSampler | null = null;
    _targetWidth  = 0;
    _targetHeight = 0;

    // Internal node instances — lazily created, stable across frames.
    private readonly _colorTexNode: TextureNode;
    private readonly _samplerNode: SamplerNode;
    private readonly _depthTexNode: TextureNode;
    private readonly _colorSampleNode: PassColorTextureNode;

    constructor(scene: Scene, camera: Camera, options: PassNodeOptions = {}) {
        const pid = `_pass${_passCount++}`;
        super(`passnode_${pid}`, 'raw', 'vec4f');

        this.scene  = scene;
        this.camera = camera;
        this.passId = pid;
        this.clearColor  = options.clearColor  ?? [0, 0, 0, 1];
        this.colorFormat = options.colorFormat ?? 'rgba16float';

        this._colorTexNode   = new TextureNode('texture_2d<f32>',    `${pid}_color`);
        this._samplerNode    = new SamplerNode('sampler',             `${pid}_samp`);
        this._depthTexNode   = new TextureNode('texture_depth_2d',   `${pid}_depth`);
        this._colorSampleNode = new PassColorTextureNode(this, this._colorTexNode, this._samplerNode);
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Returns a Node<'vec4f'> that samples the color output of this pass at
     * the current fragment UV.  Use as `renderer.render(scenePass.getTextureNode())`.
     */
    getTextureNode(): Node<'vec4f'> {
        return this._colorSampleNode;
    }

    /**
     * Returns a Node<'f32'> for the camera-space Z of the nearest surface.
     * Negative in front of the camera (standard OpenGL convention).
     *
     * Uses the `cameraNear` and `cameraFar` builtin nodes so that depth
     * reconstruction is always correct — even if the camera frustum changes
     * at runtime.  (Previously near/far were baked as WGSL literals at node
     * construction time, which broke if the camera was updated after pass().)
     */
    getViewZNode(): Node<'f32'> {
        const near = cameraNear;
        const far  = cameraFar;
        return new RawNode<'f32'>(
            'f32',
            [
                '(func() -> f32 {',
                `  let d = textureSample($0, $1, in.uv).r;`,
                `  let n = $2;`,
                `  let f = $3;`,
                '  return (n * f) / (d * (n - f) + f);',
                '})()',
            ].join(' '),
            [this._depthTexNode, this._samplerNode, near, far],
        );
    }

    /**
     * Returns a Node<'f32'> for linear depth in [0,1].
     * 0 = at near plane, 1 = at far plane.
     *
     * Uses the `cameraNear` and `cameraFar` builtin nodes so that depth
     * reconstruction is always correct — even if the camera frustum changes
     * at runtime.
     */
    getLinearDepthNode(): Node<'f32'> {
        const near = cameraNear;
        const far  = cameraFar;
        return new RawNode<'f32'>(
            'f32',
            [
                '(func() -> f32 {',
                `  let d = textureSample($0, $1, in.uv).r;`,
                `  let n = $2;`,
                `  let f = $3;`,
                '  let vz = (n * f) / (d * (n - f) + f);',
                '  return (vz - n) / (n - f);',
                '})()',
            ].join(' '),
            [this._depthTexNode, this._samplerNode, near, far],
        );
    }

    // -----------------------------------------------------------------------
    // updateBefore — called once per frame by the renderer (compile-time discovered)
    // -----------------------------------------------------------------------

    /**
     * Execute this pass's scene render before the final composite quad.
     *
     * Called by the renderer once per frame, in the order determined at compile
     * time (post-order DFS, so leaf passes execute before passes that depend on
     * them).  The renderer deduplicates calls — this runs at most once per frame
     * regardless of how many downstream nodes reference this PassNode.
     *
     * Three.js equivalent: PassNode.updateBefore(frame) — single argument.
     *
     * @param frame  The current render frame context.
     *               frame.renderer.renderScene() issues the off-screen draw.
     *               frame.encoder / frame.width / frame.height carry the rest.
     */
    updateBefore(frame: RenderFrame): void {
        // Ensure/resize color + depth textures.
        this._ensureTarget(frame.renderer.device, frame.width, frame.height);

        // Render the scene into our off-screen textures.
        // Note: Camera state save/restore is no longer needed with the new
        // struct-based uniform system — each compile result tracks its own
        // version sums, and callbacks are always invoked with the current camera.
        frame.renderer.renderScene(
            this.scene,
            this.camera,
            frame.encoder,
            this._colorTexture!,
            this._depthTexture!,
            this.clearColor,
            this.colorFormat,
        );

        // Register GPU resources onto the texture/sampler nodes so that the
        // fullscreen composite shader can sample them.
        const { colorTexNode, samplerNode, depthTexNode } = this._getResourceNodes();
        if (this._colorTexture) colorTexNode.resource = this._colorTexture;
        if (this._sampler)       samplerNode.resource  = this._sampler;
        if (this._depthTexture)  depthTexNode.resource = this._depthTexture;
    }

    // -----------------------------------------------------------------------
    // Internal — renderer API
    // -----------------------------------------------------------------------

    /**
     * Returns all nodes that must be registered in the material to make the
     * sampling work: the color TextureNode, sampler, and depth TextureNode.
     */
    _getResourceNodes(): {
        colorTexNode: TextureNode;
        samplerNode: SamplerNode;
        depthTexNode: TextureNode;
    } {
        return {
            colorTexNode: this._colorTexNode,
            samplerNode:  this._samplerNode,
            depthTexNode: this._depthTexNode,
        };
    }

    /**
     * Ensure color + depth textures exist at the requested dimensions.
     * Creates or resizes them as needed.
     */
    _ensureTarget(device: GPUDevice, width: number, height: number): void {
        if (
            this._colorTexture !== null &&
            this._targetWidth === width &&
            this._targetHeight === height
        ) {
            return;
        }

        this._colorTexture?.destroy();
        this._depthTexture?.destroy();

        this._colorTexture = device.createTexture({
            size: [width, height],
            format: this.colorFormat,
            usage:
                GPUTextureUsage.RENDER_ATTACHMENT |
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.COPY_SRC,
        });

        this._depthTexture = device.createTexture({
            size: [width, height],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });

        if (!this._sampler) {
            this._sampler = device.createSampler({
                magFilter: 'linear',
                minFilter: 'linear',
            });
        }

        this._targetWidth  = width;
        this._targetHeight = height;
    }

    /** Free GPU resources. */
    dispose(): void {
        this._colorTexture?.destroy();
        this._depthTexture?.destroy();
        this._colorTexture = null;
        this._depthTexture = null;
        this._sampler      = null;
        this._targetWidth  = 0;
        this._targetHeight = 0;
    }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a PassNode that renders `scene` from `camera` into an off-screen
 * render target.  The result feeds into post-processing node expressions.
 *
 * ```ts
 * const scenePass = pass(scene, camera, { colorFormat: 'rgba16float' });
 * renderer.render(renderOutput(scenePass.getTextureNode()));
 * ```
 */
export function pass(scene: Scene, camera: Camera, options?: PassNodeOptions): PassNode {
    return new PassNode(scene, camera, options);
}
