import type { Camera } from '../../../camera/camera';
import type { Object3D } from '../../../core/object3d';
import { type RenderTarget } from '../../../core/render-target';
import type { Pass } from '../../../renderer/core/frame';
import type { NodeFrame } from '../../../renderer/core/node-frame';
import * as d from '../../../schema/schema';
import type { DepthTexture, DepthTextureFormat } from '../../../texture/depth-texture';
import { Texture } from '../../../texture/texture';
import { Node, NodeKind } from '../core';
import type { MRTNode } from '../mrt';
import { type DepthTextureNode, type TextureNode } from '../texture';
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
export declare class RenderTextureNode extends Node<d.vec4f> {
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
    constructor(contents: RenderTextureContents, camera: Camera, options?: RenderTextureOptions);
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
    getTextureNode(name?: string): TextureNode<d.texture2d>;
    /**
     * Returns the previous texture node for the given output name.
     */
    getPreviousTextureNode(name?: string): TextureNode<d.texture2d>;
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
    /** Records this pass on the open frame, so it encodes before the pass that samples its texture. */
    updateBefore(frame: NodeFrame): void;
    private _updateTextureResources;
    /**
     * Frees internal resources. Should be called when the node is no longer in use.
     */
    dispose(): void;
}
/**
 * Schedules a render of `contents` from `camera` into its own target, and hands back a node you can
 * sample. `read` picks which aspect the node yields when used as a value; every aspect stays
 * reachable through the getters whatever it is set to.
 */
export declare const renderTexture: (contents: RenderTextureContents, camera: Camera, options?: RenderTextureOptions) => RenderTextureNode;
