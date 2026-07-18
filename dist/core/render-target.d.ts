import type { Vec4 } from 'mathcat';
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
    /** Format of the auto-allocated DepthTexture. Default: 'depth24plus' ('depth24plus-stencil8' when `stencilBuffer`). Ignored if `depthTexture` is provided or `depthBuffer` is false. */
    depthFormat?: DepthTextureFormat;
    /** Allocate a stencil aspect on the auto-created depth texture (depth24plus-stencil8). Default false. Ignored if `depthFormat` or `depthTexture` is given. */
    stencilBuffer?: boolean;
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
    readonly isRenderTarget = true;
    /** Brand set true on CubeRenderTarget; declared here so `rt.isCubeRenderTarget` types on a RenderTarget ref. */
    readonly isCubeRenderTarget?: true;
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
    /**
     * Viewport for renders into this target as a `Vec4` [x, y, width, height] in the target's pixels
     * (top-left origin); null = full target. A render into a target uses the target's own viewport/scissor,
     * never the renderer's swapchain one — so a swapchain compositing viewport can't leak into a
     * render-to-texture (or cube) pass.
     */
    viewport: Vec4 | null;
    /** Scissor rect as a `Vec4` [x, y, width, height] in the target's pixels; null = full target. Clips only while scissorTest is on. */
    scissor: Vec4 | null;
    /** Whether the scissor test is enabled for renders into this target. */
    scissorTest: boolean;
    /** Constructs a new render target */
    constructor(width: number, height: number, opts?: RenderTargetOptions);
    /** The first color attachment texture, or undefined when count=0 (depth-only target). */
    get texture(): RenderTargetTexture | undefined;
    set texture(value: RenderTargetTexture | undefined);
    /**
     * Resize the render target. Old GPU resources are NOT destroyed here: the
     * renderer reallocates lazily on next use in `ensureRenderTargetTexturesAllocated`,
     * where `setRenderTargetTexture` destroys the old texture and creates the new
     * one atomically. Marking `needsUpdate` (+ the size mismatch) is enough to
     * trigger that — a version-driven reallocation rather than eager destruction.
     *
     * Eagerly disposing here would destroy a GPU texture synchronously, opening a
     * window where another pass that already recorded a draw against it (e.g. a
     * shared depth attachment) submits with a destroyed texture. The lazy path has
     * no such window.
     */
    setSize(width: number, height: number): void;
    /**
     * Dispose of the render target's GPU resources.
     * This triggers the _onDispose callbacks set by the renderer cache.
     */
    dispose(): void;
    /** Returns the texture index for the given name, or -1 if not found. */
    getTextureIndex(name: string): number;
}
