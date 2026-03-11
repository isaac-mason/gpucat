import type { Camera } from '../../../camera/camera';
import { RenderTarget } from '../../../core/render-target';
import type { NodeFrame } from '../../../renderer/node-frame';
import type { Scene } from '../../../scene/scene';
import { type ImageSize } from '../../../texture/source';
import { Texture } from '../../../texture/texture';
import type { MRTNode } from '../mrt';
import { TextureBindingNode, TextureNode } from '../texture';
import { Node } from '../core';
import { cameraFar, cameraNear } from '../camera';
import * as d from '../../schema';
import { objectGroup } from '../uniform';

let _passCount = 0;

/**
 * Represents the texture of a pass node.
 * Extends TextureNode to ensure proper registration during setup for sampler generation.
 */
export class PassTextureNode extends TextureNode {
    /** A reference to the pass node. */
    readonly passNode: PassNode;

    /** This flag can be used for type testing. */
    readonly isPassTextureNode = true;

    /** Delegates to passNode's updateBefore - renders the scene to texture. */
    readonly updateBeforeType: 'frame' | 'none' = 'frame';

    /**
     * Constructs a new pass texture node.
     *
     * @param passNode - The pass node.
     * @param texture - The output texture (Texture with isRenderTargetTexture=true, or DepthTexture).
     * @param textureId - Optional custom texture ID. If not provided, uses default pass output ID.
     */
    constructor(passNode: PassNode, texture: Texture | null = null, textureId?: string) {
        // Generate unique texture ID based on pass, or use provided ID
        const id = textureId ?? `_pass${passNode.passId}_output`;
        const bindingNode = new TextureBindingNode(d.texture2d(), id, objectGroup);
        super(bindingNode);
        this.passNode = passNode;
        
        // Set GPU texture resource if provided
        if (texture && texture.gpuTexture) {
            this.bindingNode.resource = texture.gpuTexture;
        }
    }

    /**
     * Delegates to passNode.updateBefore() to render the scene to texture.
     */
    updateBefore(frame: NodeFrame): void {
        this.passNode.updateBefore(frame);
    }

    /**
     * Clone this node.
     */
    clone(): PassTextureNode {
        return new PassTextureNode(this.passNode, null);
    }
}

/**
 * An extension of PassTextureNode which allows to manage more than one
 * internal texture. Relevant for MRT and getPreviousTexture() API.
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
     *
     * @param passNode - The pass node.
     * @param textureName - The output texture name.
     * @param previousTexture - Whether previous frame data should be used.
     */
    constructor(passNode: PassNode, textureName: string, previousTexture = false) {
        // Compute the unique textureId BEFORE calling super so it's used in the node ID
        const uniqueTextureId = `${passNode.passId}_${textureName}${previousTexture ? '_prev' : ''}`;
        
        // Pass the unique textureId to super so the node gets a unique ID
        super(passNode, null, uniqueTextureId);
        this.textureName = textureName;
        this.previousTexture = previousTexture;
    }

    /**
     * Updates the texture reference of this node.
     * Called in setup() to get the current texture.
     * Stores the texture object — GPU resources are accessed at bind time.
     */
    updateTexture(): void {
        this.bindingNode.value = this.previousTexture
            ? this.passNode.getPreviousTexture(this.textureName)
            : this.passNode.getTexture(this.textureName);
    }

    /**
     * Clone this node.
     */
    clone(): PassMultipleTextureNode {
        const cloned = new PassMultipleTextureNode(this.passNode, this.textureName, this.previousTexture);
        cloned.uvNode = this.uvNode;
        return cloned;
    }
}

export type PassNodeOptions = {
    /** RGBA clear color for this pass's color attachment. Defaults to [0, 0, 0, 1]. */
    clearColor?: [number, number, number, number];
    /** GPUTextureFormat for the color render target. Defaults to 'rgba16float'. */
    colorFormat?: GPUTextureFormat;
    /** Number of MSAA samples. Defaults to 1 (no MSAA). */
    samples?: number;
};

/**
 * Represents a render pass (sometimes called beauty pass) in context of post processing.
 * This pass produces a render for the given scene and camera and can provide multiple outputs
 * via MRT for further processing.
 */
export class PassNode extends Node<d.vec4f> {
    /** @static */
    static readonly COLOR: 'color' = 'color';

    /** @static */
    static readonly DEPTH: 'depth' = 'depth';

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

    clearColor: [number, number, number, number];

    readonly renderTarget: RenderTarget;

    readonly updateBeforeType: 'frame' | 'none' = 'frame';

    readonly deps: Node<d.Any>[] = [];
    readonly wgsl = '';

    private _pixelRatio = 1;
    private _width = 1;
    private _height = 1;
    private _resolutionScale = 1;

    private _mrt: MRTNode | null = null;

    private readonly _textures: Record<string, Texture> = {};

    private readonly _textureNodes: Record<string, PassMultipleTextureNode> = {};

    private readonly _previousTextures: Record<string, Texture> = {};

    private readonly _previousTextureNodes: Record<string, PassMultipleTextureNode> = {};

    private readonly _viewZNodes: Record<string, Node<d.f32>> = {};

    private readonly _linearDepthNodes: Record<string, Node<d.f32>> = {};

    constructor(scope: 'color' | 'depth', scene: Scene, camera: Camera, options: PassNodeOptions = {}) {
        const pid = `_pass${_passCount++}`;
        super(d.vec4f);

        this.scope = scope;
        this.scene = scene;
        this.camera = camera;
        this.options = options;
        this.passId = pid;
        this.clearColor = options.clearColor ?? [0, 0, 0, 1];

        const renderTarget = new RenderTarget(this._width * this._pixelRatio, this._height * this._pixelRatio, {
            colorFormat: options.colorFormat ?? 'rgba16float',
            depthFormat: 'depth24plus',
            samples: options.samples ?? 1,
            count: 1,
        });
        renderTarget.texture.name = 'output';

        this.renderTarget = renderTarget;

        // Initialize _textures with output and depth
        this._textures['output'] = renderTarget.texture;
        if (renderTarget.depthTexture) {
            this._textures['depth'] = renderTarget.depthTexture;
        }
    }

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

    /** Sets the given MRT node to setup MRT for this pass. */
    setMRT(mrt: MRTNode | null): this {
        this._mrt = mrt;
        return this;
    }

    /** Returns the current MRT node. */
    getMRT(): MRTNode | null {
        return this._mrt;
    }

    /**
     * Returns the texture for the given output name.
     * Creates a new texture slot if it doesn't exist.
     */
    getTexture(name: string): Texture {
        let texture = this._textures[name];

        if (texture === undefined) {
            // Clone the reference texture format and create new render target texture
            const refTexture = this.renderTarget.texture;
            const image: ImageSize = { width: this.renderTarget.width, height: this.renderTarget.height };
            texture = new Texture(image);
            texture.format = refTexture.format;
            texture.isRenderTargetTexture = true;
            texture.renderTarget = this.renderTarget;
            texture.generateMipmaps = false;
            texture.flipY = false;
            texture.name = name;

            this._textures[name] = texture;
            this.renderTarget.textures.push(texture);
        }

        return texture;
    }

    /**
     * Returns the texture holding the data of the previous frame for the given output name.
     */
    getPreviousTexture(name: string): Texture {
        let texture = this._previousTextures[name];

        if (texture === undefined) {
            // Create a clone of the current texture for previous frame storage
            const currentTexture = this.getTexture(name);
            const image: ImageSize = { width: this.renderTarget.width, height: this.renderTarget.height };
            texture = new Texture(image);
            texture.format = currentTexture.format;
            texture.isRenderTargetTexture = true;
            texture.renderTarget = this.renderTarget;
            texture.generateMipmaps = false;
            texture.flipY = false;
            texture.name = name;

            this._previousTextures[name] = texture;
        }

        return texture;
    }

    /**
     * Switches current and previous textures for the given output name.
     */
    toggleTexture(name: string): void {
        const prevTexture = this._previousTextures[name];

        if (prevTexture !== undefined) {
            const texture = this._textures[name];

            // Swap in renderTarget.textures array (only for color textures, not depth)
            if (texture && !texture.isDepthTexture) {
                const index = this.renderTarget.textures.indexOf(texture);
                if (index !== -1 && !prevTexture.isDepthTexture) {
                    this.renderTarget.textures[index] = prevTexture;
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
     * Uses cameraNear/cameraFar builtin nodes for correct depth reconstruction.
     */
    getViewZNode(name = 'depth'): Node<d.f32> {
        let viewZNode = this._viewZNodes[name];

        if (viewZNode === undefined) {
            const depthTextureNode = this.getTextureNode(name);

            // Get depth value from texture (TextureNode generates textureSample())
            const depth = depthTextureNode.r as Node<d.f32>;

            // perspectiveDepthToViewZ formula (non-reversed depth buffer):
            // viewZ = near.mul(far).div(far.sub(near).mul(depth).sub(far))
            viewZNode = cameraNear
                .mul(cameraFar)
                .div(cameraFar.sub(cameraNear).mul(depth).sub(cameraFar)) as Node<d.f32>;

            this._viewZNodes[name] = viewZNode;
        }

        return viewZNode;
    }

    /**
     * Returns a linear depth node of this pass.
     * Uses cameraNear/cameraFar builtin nodes for correct depth reconstruction.
     */
    getLinearDepthNode(name = 'depth'): Node<d.f32> {
        let linearDepthNode = this._linearDepthNodes[name];

        if (linearDepthNode === undefined) {
            const viewZNode = this.getViewZNode(name);

            // viewZToOrthographicDepth formula:
            // linearDepth = viewZ.add(near).div(near.sub(far))
            linearDepthNode = viewZNode
                .add(cameraNear)
                .div(cameraNear.sub(cameraFar)) as Node<d.f32>;

            this._linearDepthNodes[name] = linearDepthNode;
        }

        return linearDepthNode;
    }

    /**
     * Execute this pass's scene render before the final composite quad.
     */
    updateBefore(frame: NodeFrame): void {
        const renderer = frame.renderer!;
        const encoder = frame.encoder!;
        const { scene, camera } = this;

        this._pixelRatio = 1;
        this.setSize(frame.width, frame.height);

        // State save
        const currentRenderTarget = renderer.renderTarget;
        const currentMRT = renderer.mrt;
        const currentClearColor = renderer.clearColor;

        // Update global camera uniforms for depth reconstruction
        cameraNear.value = camera.near;
        cameraFar.value = camera.far;

        // Toggle previous textures for motion vectors / TAA
        for (const name in this._previousTextures) {
            this.toggleTexture(name);
        }

        // Render
        renderer.renderTarget = this.renderTarget;
        renderer.mrt = this._mrt;
        renderer.clearColor = this.clearColor;

        renderer.render(scene, camera, encoder, this.passId);

        // State restore
        renderer.renderTarget = currentRenderTarget;
        renderer.mrt = currentMRT;
        renderer.clearColor = currentClearColor;

        // Update texture resources for sampling
        this._updateTextureResources();
    }

    private _updateTextureResources(): void {
        // Update all texture nodes with current GPU textures
        for (const name in this._textureNodes) {
            this._textureNodes[name].updateTexture();
        }
    }

    /**
     * Frees internal resources. Should be called when the node is no longer in use.
     */
    dispose(): void {
        this.renderTarget.dispose();
    }
}

/** creates a pass node */
export const pass = (scene: Scene, camera: Camera, options?: PassNodeOptions): PassNode => {
    return new PassNode(PassNode.COLOR, scene, camera, options);
}

/** creates a depth pass node */
export const depthPass = (scene: Scene, camera: Camera, options?: PassNodeOptions): PassNode => {
    return new PassNode(PassNode.DEPTH, scene, camera, options);
}

/** creates a pass texture node */
export const passTexture = (passNode: PassNode, texture?: Texture | null): PassTextureNode => {
    return new PassTextureNode(passNode, texture ?? null);
}
