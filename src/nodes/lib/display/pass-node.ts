import type { Camera } from '../../../camera/camera';
import { RenderTarget } from '../../../core/render-target';
import type { NodeFrame } from '../../../renderer/core/node-frame';
import type { Scene } from '../../../scene/scene';
import * as d from '../../../schema/schema';
import type { DepthTexture } from '../../../texture/depth-texture';
import type { ImageSize } from '../../../texture/source';
import { Texture } from '../../../texture/texture';
import { cameraFar, cameraNear } from '../camera';
import { Node, NodeKind, vec2i } from '../core';
import type { MRTNode } from '../mrt';
import { type DepthTextureNode, depthTexture, type TextureNode, texture } from '../texture';
import { screenCoordinate } from './screen';

/** Union type for textures that can be stored in a pass */
type PassTexture = Texture | DepthTexture;

let _passCount = 0;

export type PassNodeOptions = {
    /** RGBA clear color for this pass's color attachment. Defaults to [0, 0, 0, 1]. */
    clearColor?: [number, number, number, number];
    /** GPUTextureFormat for the color render target. Defaults to 'rgba16float'. */
    colorFormat?: GPUTextureFormat;
    /** Number of MSAA samples. Defaults to 1 (no MSAA). */
    samples?: number;
    /**
     * Friendly identifier for this pass. Used verbatim as the `passId` (so it
     * must be unique among passes). It names the pass in the inspector's perf
     * panel and labels the GPU render pass for tooling (RenderDoc, browser GPU
     * errors). When omitted, an auto id like `_pass0` is generated.
     */
    label?: string;
};

/**
 * Represents a render pass (sometimes called beauty pass) in context of post processing.
 * This pass produces a render for the given scene and camera and can provide multiple outputs
 * via MRT for further processing.
 */
export class PassNode extends Node<d.vec4f> {
    readonly kind = NodeKind.Pass;
    /** @static */
    static readonly FRAGMENT: 'fragment' = 'fragment';

    /** @static */
    static readonly DEPTH: 'depth' = 'depth';

    /**
     * The scope of the pass. The scope determines whether the node outputs a fragment or depth.
     */
    readonly scope: 'fragment' | 'depth';

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

    private readonly _textures: Record<string, PassTexture> = {};

    private readonly _textureNodes: Record<string, TextureNode<d.texture2d>> = {};

    private readonly _previousTextures: Record<string, PassTexture> = {};

    private readonly _previousTextureNodes: Record<string, TextureNode<d.texture2d>> = {};

    private readonly _depthTextureNodes: Record<string, DepthTextureNode> = {};

    private readonly _viewZNodes: Record<string, Node<d.f32>> = {};

    private readonly _linearDepthNodes: Record<string, Node<d.f32>> = {};

    constructor(scope: 'fragment' | 'depth', scene: Scene, camera: Camera, options: PassNodeOptions = {}) {
        // `label` (when given) names the pass in the inspector + GPU tooling.
        // still burn a counter slot so auto ids never collide with a label.
        const autoId = `_pass${_passCount++}`;
        const pid = options.label ?? autoId;
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
        renderTarget.texture!.name = 'output';

        this.renderTarget = renderTarget;

        // Initialize _textures with output and depth
        this._textures['output'] = renderTarget.texture! as Texture;
        // The depth ATTACHMENT (always present here); getDepthTextureNode() flips depthSampled true when
        // it's actually read. Reference the attachment, not the sampling-gated `depthTexture` getter,
        // which is null until sampling is declared.
        if (renderTarget._depthAttachment) {
            this._textures['depth'] = renderTarget._depthAttachment;
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
        let texture = this._textures[name] as Texture | undefined;

        if (texture === undefined) {
            // Clone the reference texture format and create new render target texture
            const refTexture = this.renderTarget.texture!;
            const image: ImageSize = { width: this.renderTarget.width, height: this.renderTarget.height };
            texture = new Texture(image);
            texture.format = refTexture.format;
            texture.isRenderTargetTexture = true;
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
        let texture = this._previousTextures[name] as Texture | undefined;

        if (texture === undefined) {
            // Create a clone of the current texture for previous frame storage
            const currentTexture = this.getTexture(name);
            const image: ImageSize = { width: this.renderTarget.width, height: this.renderTarget.height };
            texture = new Texture(image);
            texture.format = currentTexture.format;
            texture.isRenderTargetTexture = true;
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
            if (texture && !('isDepthTexture' in texture)) {
                const index = this.renderTarget.textures.indexOf(texture as Texture);
                if (index !== -1 && !('isDepthTexture' in prevTexture)) {
                    this.renderTarget.textures[index] = prevTexture as Texture;
                }
            }

            this._textures[name] = prevTexture;
            this._previousTextures[name] = texture;

            // Binding values are refreshed post-render by _updateTextureResources().
        }
    }

    /**
     * Returns the underlying DepthTexture for the given attachment (typically
     * `'depth'`). Null if the pass has no depth attachment.
     */
    getDepthTexture(name = 'depth'): DepthTexture | null {
        const tex = this._textures[name];
        return tex && 'isDepthTexture' in tex ? tex : null;
    }

    /**
     * Returns a depth-typed texture node for the given attachment.
     * Use this instead of `getTextureNode('depth')`, depth-format render
     * targets must be bound as `texture_depth_2d` (sampleType 'depth')
     * because WebGPU rejects them as filterable Float.
     *
     * The pass's depth attachment is a stable reference (RenderTarget.setSize
     * mutates in place), so the binding's `value` is set once at construction
     * and never needs to be refreshed.
     */
    getDepthTextureNode(name = 'depth'): DepthTextureNode {
        let node = this._depthTextureNodes[name];
        if (node === undefined) {
            // Sampling the depth: it must be a texture attachment, not a renderbuffer
            // (the WebGL backend reads this to attach the depth texture, not an RBO).
            this.renderTarget.depthSampled = true;
            const depthTex = this.getDepthTexture(name);
            if (!depthTex) throw new Error(`PassNode: no '${name}' depth attachment to bind`);
            node = depthTexture(depthTex);
            // Tie the binding to this pass so discovery renders + orders the pass before any
            // consumer of the depth — carried through .load()/.sample() clones via the shared binding.
            node.bindingNode.passSource = { passNode: this, textureName: name, previous: false };
            this._depthTextureNodes[name] = node;
        }
        return node;
    }

    /**
     * Returns the texture node for the given output name.
     */
    getTextureNode(name = 'output'): TextureNode<d.texture2d> {
        let textureNode = this._textureNodes[name];

        if (textureNode === undefined) {
            textureNode = texture(this.getTexture(name) as Texture);
            textureNode.bindingNode.passSource = { passNode: this, textureName: name, previous: false };
            this._textureNodes[name] = textureNode;
        }

        return textureNode;
    }

    /**
     * Returns the previous texture node for the given output name.
     */
    getPreviousTextureNode(name = 'output'): TextureNode<d.texture2d> {
        let textureNode = this._previousTextureNodes[name];

        if (textureNode === undefined) {
            // Ensure current texture node exists first
            if (this._textureNodes[name] === undefined) {
                this.getTextureNode(name);
            }

            textureNode = texture(this.getPreviousTexture(name));
            textureNode.bindingNode.passSource = { passNode: this, textureName: name, previous: true };
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
            // Depth-format attachments must be sampled via `texture_depth_2d`
            // + `textureLoad` (no sampler, pixel-coord fetch). Sampling
            // through `textureSample` would require a 'float' sample type,
            // which WebGPU rejects for depth24plus / depth32float.
            const depthNode = this.getDepthTextureNode(name);
            const depth = depthNode.load(vec2i(screenCoordinate));

            // perspectiveDepthToViewZ formula (non-reversed depth buffer):
            // viewZ = near.mul(far).div(far.sub(near).mul(depth).sub(far))
            viewZNode = cameraNear.mul(cameraFar).div(cameraFar.sub(cameraNear).mul(depth).sub(cameraFar)) as Node<d.f32>;

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
            linearDepthNode = viewZNode.add(cameraNear).div(cameraNear.sub(cameraFar)) as Node<d.f32>;

            this._linearDepthNodes[name] = linearDepthNode;
        }

        return linearDepthNode;
    }

    /**
     * Execute this pass's scene render before the final composite quad.
     */
    updateBefore(frame: NodeFrame): void {
        const renderer = frame.renderer!;
        const { scene, camera } = this;

        this._pixelRatio = 1;
        this.setSize(frame.width, frame.height);

        // State save. The render target carries its own viewport/scissor (full by default), so an outer
        // swapchain compositing viewport/scissor can't clip this pass — no viewport/scissor save needed.
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

        renderer.render(scene, camera, this.passId);

        // State restore
        renderer.renderTarget = currentRenderTarget;
        renderer.mrt = currentMRT;
        renderer.clearColor = currentClearColor;

        // Update texture resources for sampling
        this._updateTextureResources();
    }

    private _updateTextureResources(): void {
        // Refresh every pass-sourced binding with its current GPU texture. setSize / toggleTexture
        // can swap the underlying texture object between frames, so each binding is re-pointed here.
        for (const name in this._textureNodes) {
            this._textureNodes[name].bindingNode.value = this.getTexture(name)._gpuTexture as never;
        }
        for (const name in this._previousTextureNodes) {
            this._previousTextureNodes[name].bindingNode.value = this.getPreviousTexture(name)._gpuTexture as never;
        }
        for (const name in this._depthTextureNodes) {
            const depthTex = this.getDepthTexture(name);
            if (depthTex) this._depthTextureNodes[name].bindingNode.value = depthTex._gpuTexture as never;
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
    return new PassNode(PassNode.FRAGMENT, scene, camera, options);
};

/** creates a depth pass node */
export const depthPass = (scene: Scene, camera: Camera, options?: PassNodeOptions): PassNode => {
    return new PassNode(PassNode.DEPTH, scene, camera, options);
};
