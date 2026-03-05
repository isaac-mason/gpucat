/**
 * pass-node.ts — PassNode: renders a Scene into an off-screen RenderTarget and
 * exposes the result as texture nodes that can feed into post-processing graphs.
 *
 * Fully mirrors Three.js PassNode API structure:
 * - PassTextureNode extends TextureNode pattern
 * - PassMultipleTextureNode for named texture outputs
 * - PassNode with scope, static COLOR/DEPTH constants
 * - RenderTarget created in constructor (not lazily)
 * - _textures, _textureNodes, _previousTextures dictionaries
 * - _cameraNear, _cameraFar uniform values
 * - _viewZNodes, _linearDepthNodes caching
 * - getTexture(), getPreviousTexture(), toggleTexture()
 * - getTextureNode(), getPreviousTextureNode()
 * - getViewZNode(), getLinearDepthNode()
 * - Full state save/restore in updateBefore()
 *
 * Usage:
 *   const scenePass = pass(scene, camera);
 *   const depth = depthPass(scene, camera);
 *
 *   const color = scenePass.getTextureNode();
 *   const viewZ = scenePass.getViewZNode();
 *   const linearDepth = scenePass.getLinearDepthNode();
 *
 *   renderer.render(color);
 */

import { Node, TextureNode, cameraNear, cameraFar, type WgslType } from './nodes';
import type { Scene } from '../scene/scene';
import type { Camera } from '../scene/camera';
import type { RenderFrame } from '../renderer/render-frame';
import { RenderTarget, RenderTargetTexture, DepthTexture } from '../renderer/render-target';
import type { MRTNode } from './nodes';

// ---------------------------------------------------------------------------
// Unique ID generator
// ---------------------------------------------------------------------------

let _passCount = 0;

// ---------------------------------------------------------------------------
// PassTextureNode
// ---------------------------------------------------------------------------

/**
 * Represents the texture of a pass node.
 * Three.js pattern: PassTextureNode extends TextureNode directly.
 * This ensures the texture is properly registered during setup for sampler generation.
 */
export class PassTextureNode extends TextureNode {
    /** A reference to the pass node. */
    readonly passNode: PassNode;

    /** This flag can be used for type testing. */
    readonly isPassTextureNode = true;

    /**
     * Constructs a new pass texture node.
     * Three.js pattern: PassTextureNode(passNode, texture)
     *
     * @param passNode - The pass node.
     * @param texture - The output texture (RenderTargetTexture or null).
     */
    constructor(passNode: PassNode, texture: RenderTargetTexture | DepthTexture | null = null) {
        // Generate unique texture ID based on pass
        const textureId = `_pass${passNode.passId}_output`;
        super('texture_2d<f32>', textureId);
        this.passNode = passNode;
        
        // Set GPU resources from texture if provided
        if (texture) {
            if (texture.gpuTexture) this.resource = texture.gpuTexture;
            if (texture.gpuSampler) this.gpuSampler = texture.gpuSampler;
        }
    }

    /**
     * Clone this node.
     * Three.js pattern.
     */
    clone(): PassTextureNode {
        return new PassTextureNode(this.passNode, null);
    }
}

// ---------------------------------------------------------------------------
// PassMultipleTextureNode
// ---------------------------------------------------------------------------

/**
 * An extension of PassTextureNode which allows to manage more than one
 * internal texture. Relevant for MRT and getPreviousTexture() API.
 * Three.js pattern: PassMultipleTextureNode extends PassTextureNode.
 */
export class PassMultipleTextureNode extends PassTextureNode {
    /** The output texture name. */
    readonly textureName: string;

    /** Whether previous frame data should be used or not. */
    readonly previousTexture: boolean;

    /** This flag can be used for type testing. */
    readonly isPassMultipleTextureNode = true;

    /**
     * Constructs a new pass multiple texture node.
     * Three.js pattern: PassMultipleTextureNode(passNode, textureName, previousTexture)
     *
     * @param passNode - The pass node.
     * @param textureName - The output texture name.
     * @param previousTexture - Whether previous frame data should be used.
     */
    constructor(passNode: PassNode, textureName: string, previousTexture = false) {
        // Pass null to super - texture is managed by updateTexture()
        super(passNode, null);
        this.textureName = textureName;
        this.previousTexture = previousTexture;
        
        // Override the textureId with the specific name
        // @ts-expect-error - textureId is readonly but we need to set it here
        this.textureId = `${passNode.passId}_${textureName}${previousTexture ? '_prev' : ''}`;
    }

    /**
     * Updates the texture reference of this node.
     * Three.js pattern: Called in setup() to get the current texture.
     * Stores the texture object — GPU resources are accessed at bind time.
     */
    updateTexture(): void {
        this.value = this.previousTexture
            ? this.passNode.getPreviousTexture(this.textureName)
            : this.passNode.getTexture(this.textureName);
    }

    /**
     * Clone this node.
     * Three.js pattern.
     */
    clone(): PassMultipleTextureNode {
        const cloned = new PassMultipleTextureNode(this.passNode, this.textureName, this.previousTexture);
        cloned.uvNode = this.uvNode;
        return cloned;
    }
}

// ---------------------------------------------------------------------------
// PassNodeOptions
// ---------------------------------------------------------------------------

export type PassNodeOptions = {
    /** RGBA clear color for this pass's color attachment. Defaults to [0, 0, 0, 1]. */
    clearColor?: [number, number, number, number];
    /** GPUTextureFormat for the color render target. Defaults to 'rgba16float'. */
    colorFormat?: GPUTextureFormat;
    /** Number of MSAA samples. Defaults to 1 (no MSAA). */
    samples?: number;
};

// ---------------------------------------------------------------------------
// PassNode
// ---------------------------------------------------------------------------

/**
 * Represents a render pass (sometimes called beauty pass) in context of post processing.
 * This pass produces a render for the given scene and camera and can provide multiple outputs
 * via MRT for further processing.
 *
 * Fully mirrors Three.js PassNode structure.
 */
export class PassNode extends Node<'vec4f'> {
    // -----------------------------------------------------------------------
    // Static constants (Three.js pattern)
    // -----------------------------------------------------------------------

    /** @static */
    static readonly COLOR: 'color' = 'color';

    /** @static */
    static readonly DEPTH: 'depth' = 'depth';

    // -----------------------------------------------------------------------
    // Instance properties
    // -----------------------------------------------------------------------

    /**
     * The scope of the pass. The scope determines whether the node outputs color or depth.
     */
    readonly scope: 'color' | 'depth';

    /** A reference to the scene. */
    readonly scene: Scene;

    /** A reference to the camera. */
    readonly camera: Camera;

    /** Options for the internal render target. */
    readonly options: PassNodeOptions;

    /** Stable unique string used to namespace texture/sampler IDs. */
    readonly passId: string;

    /** Clear color for this pass's color attachment. */
    clearColor: [number, number, number, number];

    /**
     * The pass's render target.
     * Mirrors Three.js: created in constructor with initial size.
     */
    readonly renderTarget: RenderTarget;

    /** This flag can be used for type testing. */
    readonly isPassNode = true;

    /** updateBeforeType = 'frame' — runs once per frame. */
    readonly updateBeforeType: 'frame' | 'none' = 'frame';

    /** Required for raw node kind. */
    readonly deps: Node<WgslType>[] = [];
    readonly wgsl = '';

    // -----------------------------------------------------------------------
    // Resolution tracking (Three.js pattern)
    // -----------------------------------------------------------------------

    private _pixelRatio = 1;
    private _width = 1;
    private _height = 1;
    private _resolutionScale = 1;

    // -----------------------------------------------------------------------
    // Camera uniforms (Three.js pattern: _cameraNear, _cameraFar as uniform values)
    // -----------------------------------------------------------------------

    /** The `near` property of the camera as a uniform value. Updated each frame. */
    private _cameraNear = { value: 0 };

    /** The `far` property of the camera as a uniform value. Updated each frame. */
    private _cameraFar = { value: 0 };

    // -----------------------------------------------------------------------
    // MRT support (Three.js pattern)
    // -----------------------------------------------------------------------

    private _mrt: MRTNode | null = null;

    // -----------------------------------------------------------------------
    // Internal texture management (Three.js pattern)
    // -----------------------------------------------------------------------

    /**
     * A dictionary holding the internal result textures.
     * Mirrors Three.js `this._textures = { output: renderTarget.texture, depth: depthTexture };`
     * Stores RenderTargetTexture/DepthTexture references (GPU allocation managed by renderer).
     */
    private readonly _textures: Record<string, RenderTargetTexture | DepthTexture> = {};

    /**
     * A dictionary holding the internal texture nodes.
     * Mirrors Three.js `this._textureNodes = {};`
     */
    private readonly _textureNodes: Record<string, PassMultipleTextureNode> = {};

    /**
     * A dictionary holding the texture data of the previous frame.
     * Used for computing velocity/motion vectors.
     * Mirrors Three.js `this._previousTextures = {};`
     */
    private readonly _previousTextures: Record<string, RenderTargetTexture | DepthTexture> = {};

    /**
     * A dictionary holding the texture nodes of the previous frame.
     * Mirrors Three.js `this._previousTextureNodes = {};`
     */
    private readonly _previousTextureNodes: Record<string, PassMultipleTextureNode> = {};

    /**
     * A dictionary holding the internal viewZ nodes.
     * Mirrors Three.js `this._viewZNodes = {};`
     */
    private readonly _viewZNodes: Record<string, Node<'f32'>> = {};

    /**
     * A dictionary holding the internal linear depth nodes.
     * Mirrors Three.js `this._linearDepthNodes = {};`
     */
    private readonly _linearDepthNodes: Record<string, Node<'f32'>> = {};

    // -----------------------------------------------------------------------
    // Constructor (Three.js pattern: scope, scene, camera, options)
    // -----------------------------------------------------------------------

    constructor(scope: 'color' | 'depth', scene: Scene, camera: Camera, options: PassNodeOptions = {}) {
        const pid = `_pass${_passCount++}`;
        super(`passnode_${pid}`, 'raw', 'vec4f');

        this.scope = scope;
        this.scene = scene;
        this.camera = camera;
        this.options = options;
        this.passId = pid;
        this.clearColor = options.clearColor ?? [0, 0, 0, 1];

        // -----------------------------------------------------------------------
        // Create RenderTarget in constructor (Three.js pattern)
        // -----------------------------------------------------------------------
        const renderTarget = new RenderTarget(this._width * this._pixelRatio, this._height * this._pixelRatio, {
            colorFormat: options.colorFormat ?? 'rgba16float',
            depthFormat: 'depth24plus',
            samples: options.samples ?? 1,
            count: 1,
        });
        renderTarget.texture.name = 'output';

        this.renderTarget = renderTarget;

        // Initialize _textures with output and depth (Three.js pattern)
        this._textures['output'] = renderTarget.texture;
        if (renderTarget.depthTexture) {
            this._textures['depth'] = renderTarget.depthTexture;
        }
    }

    // -----------------------------------------------------------------------
    // Resolution API (Three.js pattern)
    // -----------------------------------------------------------------------

    /**
     * Sets the resolution scale for the pass.
     * The resolution scale is a factor that is multiplied with the renderer's width and height.
     */
    setResolutionScale(resolutionScale: number): this {
        this._resolutionScale = resolutionScale;
        return this;
    }

    /** Gets the current resolution scale of the pass. */
    getResolutionScale(): number {
        return this._resolutionScale;
    }

    /**
     * Sets the size of the pass's render target. Honors the pixel ratio.
     * Mirrors Three.js PassNode.setSize() — directly calls renderTarget.setSize().
     */
    setSize(width: number, height: number): void {
        this._width = width;
        this._height = height;

        const effectiveWidth = Math.floor(this._width * this._pixelRatio * this._resolutionScale);
        const effectiveHeight = Math.floor(this._height * this._pixelRatio * this._resolutionScale);

        this.renderTarget.setSize(effectiveWidth, effectiveHeight);
    }

    /** Sets the pixel ratio for the pass's render target and updates the size. */
    setPixelRatio(pixelRatio: number): void {
        this._pixelRatio = pixelRatio;
        this.setSize(this._width, this._height);
    }

    // -----------------------------------------------------------------------
    // MRT API (Three.js pattern)
    // -----------------------------------------------------------------------

    /** Sets the given MRT node to setup MRT for this pass. */
    setMRT(mrt: MRTNode | null): this {
        this._mrt = mrt;
        return this;
    }

    /** Returns the current MRT node. */
    getMRT(): MRTNode | null {
        return this._mrt;
    }

    // -----------------------------------------------------------------------
    // Texture API (Three.js pattern)
    // -----------------------------------------------------------------------

    /**
     * Returns the texture for the given output name.
     * Mirrors Three.js `getTexture(name)`.
     * Creates a new texture slot if it doesn't exist.
     */
    getTexture(name: string): RenderTargetTexture | DepthTexture {
        let texture = this._textures[name];

        if (texture === undefined) {
            // Clone the reference texture and add to render target
            const refTexture = this.renderTarget.texture;
            texture = new RenderTargetTexture(this.renderTarget, refTexture.format);
            texture.name = name;

            this._textures[name] = texture;
            this.renderTarget.textures.push(texture);
        }

        return texture;
    }

    /**
     * Returns the texture holding the data of the previous frame for the given output name.
     * Mirrors Three.js `getPreviousTexture(name)`.
     */
    getPreviousTexture(name: string): RenderTargetTexture | DepthTexture {
        let texture = this._previousTextures[name];

        if (texture === undefined) {
            // Create a clone of the current texture for previous frame storage
            const currentTexture = this.getTexture(name);
            texture = new RenderTargetTexture(this.renderTarget, currentTexture.format);
            texture.name = name;

            this._previousTextures[name] = texture;
        }

        return texture;
    }

    /**
     * Switches current and previous textures for the given output name.
     * Mirrors Three.js `toggleTexture(name)`.
     */
    toggleTexture(name: string): void {
        const prevTexture = this._previousTextures[name];

        if (prevTexture !== undefined) {
            const texture = this._textures[name];

            // Swap in renderTarget.textures array (only for color textures, not depth)
            if (texture && 'isDepthTexture' in texture === false) {
                const index = this.renderTarget.textures.indexOf(texture as RenderTargetTexture);
                if (index !== -1 && 'isDepthTexture' in prevTexture === false) {
                    this.renderTarget.textures[index] = prevTexture as RenderTargetTexture;
                }
            }

            this._textures[name] = prevTexture;
            this._previousTextures[name] = texture;

            this._textureNodes[name]?.updateTexture();
            this._previousTextureNodes[name]?.updateTexture();
        }
    }

    /**
     * Returns the texture node for the given output name.
     * Mirrors Three.js `getTextureNode(name)`.
     */
    getTextureNode(name = 'output'): PassMultipleTextureNode {
        let textureNode = this._textureNodes[name];

        if (textureNode === undefined) {
            textureNode = new PassMultipleTextureNode(this, name);
            textureNode.updateTexture();
            this._textureNodes[name] = textureNode;
        }

        return textureNode;
    }

    /**
     * Returns the previous texture node for the given output name.
     * Mirrors Three.js `getPreviousTextureNode(name)`.
     */
    getPreviousTextureNode(name = 'output'): PassMultipleTextureNode {
        let textureNode = this._previousTextureNodes[name];

        if (textureNode === undefined) {
            // Ensure current texture node exists first
            if (this._textureNodes[name] === undefined) {
                this.getTextureNode(name);
            }

            textureNode = new PassMultipleTextureNode(this, name, true);
            textureNode.updateTexture();
            this._previousTextureNodes[name] = textureNode;
        }

        return textureNode;
    }

    /**
     * Returns a viewZ node of this pass.
     * Three.js pattern: perspectiveDepthToViewZ(depthTexture, cameraNear, cameraFar)
     *
     * Uses cameraNear/cameraFar builtin nodes for correct depth reconstruction.
     */
    getViewZNode(name = 'depth'): Node<'f32'> {
        let viewZNode = this._viewZNodes[name];

        if (viewZNode === undefined) {
            const depthTextureNode = this.getTextureNode(name);

            // Get depth value from texture (TextureNode generates textureSample())
            const depth = depthTextureNode.r as Node<'f32'>;

            // perspectiveDepthToViewZ formula (Three.js non-reversed depth buffer):
            // viewZ = near.mul(far).div(far.sub(near).mul(depth).sub(far))
            viewZNode = cameraNear
                .mul(cameraFar)
                .div(cameraFar.sub(cameraNear).mul(depth).sub(cameraFar));

            this._viewZNodes[name] = viewZNode;
        }

        return viewZNode;
    }

    /**
     * Returns a linear depth node of this pass.
     * Three.js pattern: viewZToOrthographicDepth(viewZ, cameraNear, cameraFar)
     *
     * Uses cameraNear/cameraFar builtin nodes for correct depth reconstruction.
     */
    getLinearDepthNode(name = 'depth'): Node<'f32'> {
        let linearDepthNode = this._linearDepthNodes[name];

        if (linearDepthNode === undefined) {
            const viewZNode = this.getViewZNode(name);

            // viewZToOrthographicDepth formula (Three.js):
            // linearDepth = viewZ.add(near).div(near.sub(far))
            linearDepthNode = viewZNode
                .add(cameraNear)
                .div(cameraNear.sub(cameraFar)) as Node<'f32'>;

            this._linearDepthNodes[name] = linearDepthNode;
        }

        return linearDepthNode;
    }

    // -----------------------------------------------------------------------
    // updateBefore (Three.js pattern: full state save/restore)
    // -----------------------------------------------------------------------

    /**
     * Execute this pass's scene render before the final composite quad.
     * Mirrors Three.js `PassNode.updateBefore(frame)`.
     */
    updateBefore(frame: RenderFrame): void {
        const { renderer } = frame;
        const { scene, camera } = this;

        // Update pixel ratio and size (Three.js pattern)
        this._pixelRatio = 1; // gpucat doesn't track pixelRatio on renderer
        this.setSize(frame.width, frame.height);

        // -----------------------------------------------------------------------
        // State save (Three.js pattern)
        // -----------------------------------------------------------------------
        const currentRenderTarget = renderer.getRenderTarget();
        const currentMRT = renderer.getMRT();
        const currentClearColor = renderer.clearColor;

        // Update camera uniforms (Three.js pattern)
        this._cameraNear.value = camera.near;
        this._cameraFar.value = camera.far;

        // Toggle previous textures for motion vectors / TAA
        for (const name in this._previousTextures) {
            this.toggleTexture(name);
        }

        // -----------------------------------------------------------------------
        // Render (Three.js pattern)
        // -----------------------------------------------------------------------
        renderer.setRenderTarget(this.renderTarget);
        renderer.setMRT(this._mrt);
        renderer.clearColor = this.clearColor;

        renderer.renderScene(scene, camera, frame.encoder, this.passId);

        // -----------------------------------------------------------------------
        // State restore (Three.js pattern)
        // -----------------------------------------------------------------------
        renderer.setRenderTarget(currentRenderTarget);
        renderer.setMRT(currentMRT);
        renderer.clearColor = currentClearColor;

        // Update texture resources for sampling
        this._updateTextureResources();
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    private _updateTextureResources(): void {
        // Update all texture nodes with current GPU textures
        for (const name in this._textureNodes) {
            this._textureNodes[name].updateTexture();
        }
    }

    /**
     * Frees internal resources. Should be called when the node is no longer in use.
     * Mirrors Three.js `dispose()`.
     */
    dispose(): void {
        this.renderTarget.dispose();
    }
}

/**
 * TSL function for creating a pass node.
 */
export const pass = (scene: Scene, camera: Camera, options?: PassNodeOptions): PassNode =>
    new PassNode(PassNode.COLOR, scene, camera, options);

/**
 * TSL function for creating a depth pass node.
 */
export const depthPass = (scene: Scene, camera: Camera, options?: PassNodeOptions): PassNode =>
    new PassNode(PassNode.DEPTH, scene, camera, options);

/**
 * TSL function for creating a pass texture node.
 */
export const passTexture = (passNode: PassNode, texture?: RenderTargetTexture | DepthTexture | null): PassTextureNode =>
    new PassTextureNode(passNode, texture ?? null);
