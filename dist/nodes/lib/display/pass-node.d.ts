import type { Camera } from '../../../camera/camera';
import { RenderTarget } from '../../../core/render-target';
import type { NodeFrame } from '../../../renderer/node-frame';
import type { Scene } from '../../../scene/scene';
import { Texture } from '../../../texture/texture';
import { DepthTexture } from '../../../texture/depth-texture';
import type { MRTNode } from '../mrt';
import { DepthTextureNode, TextureBindingNode, TextureNode } from '../texture';
import { Node, NodeKind } from '../core';
import * as d from '../../../schema/schema';
/**
 * Represents the texture of a pass node.
 * Extends TextureNode to ensure proper registration during setup for sampler generation.
 */
export declare class PassTextureNode extends TextureNode {
    /** A reference to the pass node. */
    readonly passNode: PassNode;
    /**
     * Constructs a new pass texture node.
     *
     * @param passNode - The pass node.
     * @param texture - The output texture (Texture with isRenderTargetTexture=true, or DepthTexture).
     * @param textureId - Optional custom texture ID. If not provided, uses default pass output ID.
     * @param existingBinding - If provided, reuse this binding instead of creating a new one (used by clone).
     */
    constructor(passNode: PassNode, texture?: Texture | null, textureId?: string, existingBinding?: TextureBindingNode<d.texture2d>);
    clone(): PassTextureNode;
}
/**
 * An extension of PassTextureNode which allows to manage more than one
 * internal texture. Relevant for MRT and getPreviousTexture() API.
 */
export declare class PassMultipleTextureNode extends PassTextureNode {
    /** The output texture name. */
    readonly textureName: string;
    /** Whether previous frame data should be used or not. */
    readonly previousTexture: boolean;
    /**
     * Constructs a new pass multiple texture node.
     *
     * @param passNode - The pass node.
     * @param textureName - The output texture name.
     * @param previousTexture - Whether previous frame data should be used.
     */
    constructor(passNode: PassNode, textureName: string, previousTexture?: boolean, existingBinding?: TextureBindingNode<d.texture2d>);
    /**
     * Updates the texture reference of this node.
     * Called in setup() to get the current texture.
     * Stores the GpuTexture, GPU resources are accessed at bind time via the texture cache.
     */
    updateTexture(): void;
    /**
     * Clone sharing the same bindingNode so the renderer's texture updates
     * are visible to all clones (e.g. nodes returned by .sample(uv)).
     */
    clone(): PassMultipleTextureNode;
}
export type PassNodeOptions = {
    /** RGBA clear color for this pass's color attachment. Defaults to [0, 0, 0, 1]. */
    clearColor?: [number, number, number, number];
    /** GPUTextureFormat for the color render target. Defaults to 'rgba16float'. */
    colorFormat?: GPUTextureFormat;
    /** Number of MSAA samples. Defaults to 1 (no MSAA). */
    samples?: number;
    /**
     * Friendly identifier for this pass. Used verbatim as the `passId` (so it
     * must be unique among passes) — it names the pass in the inspector's perf
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
export declare class PassNode extends Node<d.vec4f> {
    readonly kind = NodeKind.Pass;
    /** @static */
    static readonly FRAGMENT: 'fragment';
    /** @static */
    static readonly DEPTH: 'depth';
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
    readonly updateBeforeType: 'frame' | 'none';
    readonly deps: Node<d.Any>[];
    readonly wgsl = "";
    private _pixelRatio;
    private _width;
    private _height;
    private _resolutionScale;
    private _mrt;
    private readonly _textures;
    private readonly _textureNodes;
    private readonly _previousTextures;
    private readonly _previousTextureNodes;
    private readonly _depthTextureNodes;
    private readonly _viewZNodes;
    private readonly _linearDepthNodes;
    constructor(scope: 'fragment' | 'depth', scene: Scene, camera: Camera, options?: PassNodeOptions);
    /**
     * Sets the resolution scale for the pass.
     * The resolution scale is a factor that is multiplied with the renderer's width and height.
     */
    setResolutionScale(resolutionScale: number): this;
    /** Gets the current resolution scale of the pass. */
    getResolutionScale(): number;
    /**
     * Sets the size of the pass's render target. Honors the pixel ratio.
     */
    setSize(width: number, height: number): void;
    /** Sets the pixel ratio for the pass's render target and updates the size. */
    setPixelRatio(pixelRatio: number): void;
    /** Sets the given MRT node to setup MRT for this pass. */
    setMRT(mrt: MRTNode | null): this;
    /** Returns the current MRT node. */
    getMRT(): MRTNode | null;
    /**
     * Returns the texture for the given output name.
     * Creates a new texture slot if it doesn't exist.
     */
    getTexture(name: string): Texture;
    /**
     * Returns the texture holding the data of the previous frame for the given output name.
     */
    getPreviousTexture(name: string): Texture;
    /**
     * Switches current and previous textures for the given output name.
     */
    toggleTexture(name: string): void;
    /**
     * Returns the underlying DepthTexture for the given attachment (typically
     * `'depth'`). Null if the pass has no depth attachment.
     */
    getDepthTexture(name?: string): DepthTexture | null;
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
    getDepthTextureNode(name?: string): DepthTextureNode;
    /**
     * Returns the texture node for the given output name.
     */
    getTextureNode(name?: string): PassMultipleTextureNode;
    /**
     * Returns the previous texture node for the given output name.
     */
    getPreviousTextureNode(name?: string): PassMultipleTextureNode;
    /**
     * Returns a viewZ node of this pass.
     * Uses cameraNear/cameraFar builtin nodes for correct depth reconstruction.
     */
    getViewZNode(name?: string): Node<d.f32>;
    /**
     * Returns a linear depth node of this pass.
     * Uses cameraNear/cameraFar builtin nodes for correct depth reconstruction.
     */
    getLinearDepthNode(name?: string): Node<d.f32>;
    /**
     * Execute this pass's scene render before the final composite quad.
     */
    updateBefore(frame: NodeFrame): void;
    private _updateTextureResources;
    /**
     * Frees internal resources. Should be called when the node is no longer in use.
     */
    dispose(): void;
}
/** creates a pass node */
export declare const pass: (scene: Scene, camera: Camera, options?: PassNodeOptions) => PassNode;
/** creates a depth pass node */
export declare const depthPass: (scene: Scene, camera: Camera, options?: PassNodeOptions) => PassNode;
/** creates a pass texture node */
export declare const passTexture: (passNode: PassNode, texture?: Texture | null) => PassTextureNode;
