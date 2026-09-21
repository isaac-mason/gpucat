import type { Camera } from '../../../camera/camera';
import type { Object3D } from '../../../core/object3d';
import { type RenderTarget, createRenderTarget } from '../../../core/render-target';
import type { Pass } from '../../../renderer/core/frame';
import type { NodeFrame } from '../../../renderer/core/node-frame';
import { drawScene } from '../../../scene/draw-scene';
import * as d from '../../../schema/schema';
import type { DepthTexture, DepthTextureFormat } from '../../../texture/depth-texture';
import type { ImageSize } from '../../../texture/source';
import { Texture } from '../../../texture/texture';
import { cameraFar, cameraNear } from '../camera';
import { Node, NodeKind, vec2i } from '../core';
import type { MRTNode } from '../mrt';
import { type DepthTextureNode, depthTexture, type TextureNode, texture } from '../texture';
import { screenCoordinate, screenUV } from './screen';

/** Union type for textures that can be stored in a pass */
type PassTexture = Texture | DepthTexture;

let _passCount = 0;

export type RenderTextureOptions = {
    /** Which aspect the node yields when read as an expression. Defaults to 'color'. */
    read?: 'color' | 'depth';
    /** RGBA clear color for this pass's color attachment. Defaults to [0, 0, 0, 1]. */
    clearColor?: [number, number, number, number];
    /** GPUTextureFormat for the color render target. Defaults to 'rgba16float'. */
    colorFormat?: GPUTextureFormat;
    /**
     * Format for the depth attachment. Defaults to 'depth24plus'. Takes precedence
     * over `stencilBuffer`, so pass this when you want a specific depth precision
     * alongside a stencil aspect (e.g. 'depth32float-stencil8'). Mirrors
     * `RenderTargetOptions.depthFormat`.
     */
    depthFormat?: DepthTextureFormat;
    /**
     * Allocate a stencil aspect on the depth attachment ('depth24plus-stencil8'),
     * so materials drawn in this pass can use `stencilTest` / `stencilRef` and the
     * stencil ops. Default false; ignored when `depthFormat` is given. The pass
     * clears stencil to 0 each render.
     */
    stencilBuffer?: boolean;
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
/** A scene to walk, or a recorder that records its own draws. The scene form is just `drawScene`. */
export type RenderTextureContents = Object3D | ((pass: Pass) => void);

export class RenderTextureNode extends Node<d.vec4f> {
    readonly kind = NodeKind.RenderTexture;

    /** Which aspect this node yields when read as an expression; the getters reach the rest. */
    readonly read: 'color' | 'depth';

    /** What this draws: a scene to walk, or a recorder that calls `draw` itself. Read afresh every
     *  frame, so reassigning it swaps what is rendered without rebuilding the node. */
    contents: RenderTextureContents;

    /** A reference to the camera. */
    readonly camera: Camera;

    /** Options for the internal render target. */
    readonly options: RenderTextureOptions;

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

    constructor(contents: RenderTextureContents, camera: Camera, options: RenderTextureOptions = {}) {
        // `label` (when given) names the pass in the inspector + GPU tooling.
        // still burn a counter slot so auto ids never collide with a label.
        const autoId = `_pass${_passCount++}`;
        const pid = options.label ?? autoId;
        super(d.vec4f);

        this.read = options.read ?? 'color';
        this.contents = contents;
        this.camera = camera;
        this.options = options;
        this.passId = pid;
        this.clearColor = options.clearColor ?? [0, 0, 0, 1];

        const target = createRenderTarget(this._width * this._pixelRatio, this._height * this._pixelRatio, {
            colorFormat: options.colorFormat ?? 'rgba16float',
            // forwarded rather than resolved here: RenderTarget already owns the
            // depthFormat-beats-stencilBuffer precedence, and duplicating it is how
            // the two drift apart.
            depthFormat: options.depthFormat,
            stencilBuffer: options.stencilBuffer,
            samples: options.samples ?? 1,
            count: 1,
        });
        target.texture!.name = 'output';

        this.renderTarget = target;

        this._textures['output'] = target.texture! as Texture;
        // The depth ATTACHMENT, not the sampling-gated `depthTexture` getter, which is null until
        // getDepthTextureNode() declares sampling.
        if (target._depthAttachment) {
            this._textures['depth'] = target._depthAttachment;
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
            if (!depthTex) throw new Error(`RenderTextureNode: no '${name}' depth attachment to bind`);
            node = depthTexture(depthTex);
            node.uvNode = screenUV;
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
            // A pass fills its whole target, so it reads by screen position. The `varying(uv())` a
            // TextureNode defaults to would make every consuming mesh owe a `uv` attribute instead.
            textureNode.uvNode = screenUV;
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
            textureNode.uvNode = screenUV;
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

    /** Records this pass on the open frame, so it encodes before the pass that samples its texture. */
    updateBefore(frame: NodeFrame): void {
        const renderer = frame.renderer!;
        const { contents, camera } = this;

        this._pixelRatio = 1;
        this.setSize(frame.width, frame.height);

        cameraNear.value = camera.near;
        cameraFar.value = camera.far;

        // Motion vectors and TAA read last frame's colour, so swap before this frame overwrites it.
        for (const name in this._previousTextures) {
            this.toggleTexture(name);
        }

        const pass = renderer._frameState!.pass({
            target: this.renderTarget,
            camera,
            clear: this.clearColor,
            mrt: this._mrt ?? undefined,
            label: this.passId,
        });
        if (typeof contents === 'function') contents(pass);
        else drawScene(renderer, pass, contents, camera);
        pass.end();

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

/**
 * Schedules a render of `contents` from `camera` into its own target, and hands back a node you can
 * sample. `read` picks which aspect the node yields when used as a value; every aspect stays
 * reachable through the getters whatever it is set to.
 */
export const renderTexture = (
    contents: RenderTextureContents,
    camera: Camera,
    options?: RenderTextureOptions,
): RenderTextureNode => {
    return new RenderTextureNode(contents, camera, options);
};
