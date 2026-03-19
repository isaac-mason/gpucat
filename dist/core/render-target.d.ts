import { Texture } from '../texture/texture';
import { DepthTexture, type DepthTextureFormat } from '../texture/depth-texture';
export type RenderTargetOptions = {
    /** Color attachment format. Default: 'rgba16float'. Applied to all attachments. */
    colorFormat?: GPUTextureFormat;
    /** Depth attachment format. `null` = no depth attachment. Default: 'depth24plus'. */
    depthFormat?: DepthTextureFormat | null;
    /** MSAA sample count. Default: 1. */
    samples?: number;
    /** Number of color attachments (MRT). Default: 1. */
    count?: number;
};
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
    /** The color format of the render target's texture(s) */
    readonly colorFormat: GPUTextureFormat;
    /** The depth format of the render target's depth texture, or null if no depth attachment */
    readonly depthFormat: DepthTextureFormat | null;
    /** The MSAA sample count of the render target */
    readonly samples: number;
    /**
     * Array of color attachment textures.
     * Each has a `.name` for MRT mapping, the first texture is also accessible via the `texture` getter.
     * These are Texture instances with isRenderTargetTexture = true.
     */
    textures: Texture[];
    /** Depth texture, or null if no depth */
    depthTexture: DepthTexture | null;
    /** Constructs a new render target */
    constructor(width: number, height: number, opts?: RenderTargetOptions);
    /** The first color attachment texture, or undefined when count=0 (depth-only target). */
    get texture(): Texture | undefined;
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
