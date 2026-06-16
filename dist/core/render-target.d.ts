import { Texture } from '../texture/texture';
import { DepthTexture, type DepthTextureFormat } from '../texture/depth-texture';
import type { CubeTexture } from '../texture/cube-texture';
export type RenderTargetOptions = {
    /**
     * Default format applied to every color attachment at construction.
     * For per-attachment formats (MRT with mixed formats), mutate `rt.textures[i].format` after construction.
     * Default: 'rgba16float'.
     */
    colorFormat?: GPUTextureFormat;
    /** Whether to allocate a depth attachment. Default: true. */
    depthBuffer?: boolean;
    /** Format of the auto-allocated DepthTexture. Default: 'depth24plus'. Ignored if `depthTexture` is provided or `depthBuffer` is false. */
    depthFormat?: DepthTextureFormat;
    /** Caller-provided depth texture. Overrides `depthBuffer`/`depthFormat`. */
    depthTexture?: DepthTexture;
    /** MSAA sample count. Default: 1. */
    samples?: number;
    /** Number of color attachments (MRT). Default: 1. */
    count?: number;
};
export type RenderTargetTexture = Texture | CubeTexture;
/**
 * A render target is a buffer where the video card draws pixels for a scene
 * that is being rendered in the background. It is used in different effects,
 * such as applying postprocessing to a rendered image before displaying it
 * on the screen.
 */
export declare class RenderTarget {
    /** The width of the render target */
    width: number;
    /** The height of the render target */
    height: number;
    /** The MSAA sample count of the render target */
    readonly samples: number;
    /**
     * Array of color attachment textures.
     * Each has its own mutable `.format` (per-attachment formats supported by mutating `textures[i].format`).
     * Each has a `.name` for MRT mapping; the first texture is also accessible via the `texture` getter.
     */
    textures: RenderTargetTexture[];
    /** Depth texture, or null if no depth */
    depthTexture: DepthTexture | null;
    /** Constructs a new render target */
    constructor(width: number, height: number, opts?: RenderTargetOptions);
    /** The first color attachment texture, or undefined when count=0 (depth-only target). */
    get texture(): RenderTargetTexture | undefined;
    set texture(value: RenderTargetTexture | undefined);
    /** Sets the size of the render target, disposes existing GPU resources; renderer will reallocate on next use */
    setSize(width: number, height: number): void;
    /**
     * Dispose of the render target's GPU resources.
     * This triggers the _onDispose callbacks set by the renderer cache.
     */
    dispose(): void;
    /** Returns the texture index for the given name, or -1 if not found. */
    getTextureIndex(name: string): number;
}
