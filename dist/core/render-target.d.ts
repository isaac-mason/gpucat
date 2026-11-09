import { ArrayTexture } from '../texture/array-texture';
import type { CubeTexture } from '../texture/cube-texture';
import { DepthTexture, type DepthTextureFormat } from '../texture/depth-texture';
import { Texture } from '../texture/texture';
import { Data3DTexture } from '../texture/texture-3d';
export type RenderTargetOptions = {
    /**
     * Names the target in memory reports, as `<label>/<attachment>` (`shadows/depth`). Debug identity only:
     * the attachments keep their names (`output`, `depth`), which `mrt()` and shader bindings read.
     */
    label?: string;
    /**
     * Default format applied to every color attachment at construction. Default: 'rgba16float'.
     */
    colorFormat?: GPUTextureFormat;
    /**
     * Each colour attachment's format, for MRT with mixed formats (an integer attachment beside a float one, say),
     * in place of `colorFormat`. Its length is the attachment count; `count`, if given too, has to match. Given at
     * construction because a texture's sample type follows its format there.
     */
    colorFormats?: GPUTextureFormat[];
    /** Whether to allocate a depth attachment. Default: true. */
    depthBuffer?: boolean;
    /** Format of the auto-allocated DepthTexture. Default: 'depth24plus' ('depth24plus-stencil8' when `stencilBuffer`). Ignored if `depthTexture` is provided or `depthBuffer` is false. */
    depthFormat?: DepthTextureFormat;
    /** Allocate a stencil aspect on the auto-created depth texture (depth24plus-stencil8). Default false. Ignored if `depthFormat` or `depthTexture` is given. */
    stencilBuffer?: boolean;
    /** Caller-provided depth texture. Overrides `depthBuffer`/`depthFormat`. */
    depthTexture?: DepthTexture;
    /**
     * Whether the depth attachment will be sampled (read as a texture). Default false: the depth is a
     * write-only attachment (a RENDERBUFFER on WebGL — more broadly FBO-complete, three.js parity), and
     * `rt.depthTexture` is null. Set true (or provide an explicit `depthTexture`, or call
     * `RenderTextureNode.getDepthTextureNode()`) to expose the depth as a sampleable texture — required to read
     * it in a shader (e.g. a shadow map). Depth testing works either way; this only governs readability.
     */
    depthSampled?: boolean;
    /** Clear colour used by a pass that clears without naming one. Default [0, 0, 0, 1]. */
    clearColor?: [number, number, number, number];
    /** MSAA sample count. Default: 1. */
    samples?: number;
    /** Number of color attachments (MRT). Default: 1. */
    count?: number;
    /**
     * Colour attachments by name, in @location order: `{ output: 'rgba8unorm', normal: 'rgba16float' }`. The names
     * are what `mrt()` keys on, so the target is ready for it as made. In place of `count`, `colorFormats` and
     * `colorFormat`. A name can't be `'depth'`, the depth attachment's, or look like an integer, which JS would list
     * ahead of the others and so move to an earlier location than written.
     */
    attachments?: Record<string, GPUTextureFormat>;
    /**
     * The attachments' dimension, as `GPUTextureDimension`. A `'3d'` target draws a pass into one depth slice of its
     * colour textures, and has no depth attachment, since depth formats cannot be 3D. Default `'2d'`.
     */
    dimension?: '2d' | '3d';
    /** Array layers of a `'2d'` target, or depth slices of a `'3d'` one. A pass draws into one. Default 1. */
    layers?: number;
    /**
     * Mip levels of every attachment. A pass draws into one. `'full'` is the whole chain, recomputed when the target is
     * resized. Default 1.
     */
    mipLevelCount?: number | 'full';
    /**
     * Whether compute may also write the colour attachments, as storage textures. WebGPU can't store to an sRGB format,
     * so an sRGB attachment is allocated in its linear twin and drawn and sampled through an sRGB view: a storage
     * binding of it takes the linear format, and a shader storing to it encodes sRGB itself. Single-sampled only.
     * Default false; WebGL has no storage textures and ignores it.
     */
    storage?: boolean;
};
export type RenderTargetTexture = Texture | ArrayTexture | Data3DTexture | CubeTexture;
/**
 * A render target is a buffer where the video card draws pixels for a scene
 * that is being rendered in the background. It is used in different effects,
 * such as applying postprocessing to a rendered image before displaying it
 * on the screen.
 */
export declare class RenderTarget {
    readonly isRenderTarget = true;
    clearColor: [number, number, number, number];
    /** Brand set true on CubeRenderTarget; declared here so `rt.isCubeRenderTarget` types on a RenderTarget ref. */
    readonly isCubeRenderTarget?: true;
    /** The width of the render target */
    width: number;
    /** The height of the render target */
    height: number;
    /** The MSAA sample count of the render target */
    readonly samples: number;
    /** See `RenderTargetOptions.storage`. */
    readonly storage: boolean;
    /** See `RenderTargetOptions.label`. Read when the attachments are allocated. */
    label: string | undefined;
    /** See `RenderTargetOptions.dimension`. */
    readonly dimension: '2d' | '3d';
    /** Array layers, or a 3D target's depth slices. See `RenderTargetOptions.layers`. */
    readonly layers: number;
    /** The mip levels asked for; {@link mipLevelCount} is how many that is at the current size. */
    readonly mipLevels: number | 'full';
    /**
     * Array of color attachment textures.
     * Their formats come from `colorFormats` or `colorFormat` at construction; one can change after only to a format of
     * the same sample type.
     * Each has a `.name` for MRT mapping; the first texture is also accessible via the `texture` getter.
     */
    textures: RenderTargetTexture[];
    /**
     * The depth ATTACHMENT texture — always present when the target has a depth buffer, and what the
     * backends read to build/attach depth (so depth testing always works). Internal: it is NOT the
     * sampling surface. Consumers sample via the public {@link depthTexture} getter, which only exposes
     * this when the depth is declared sampled.
     */
    _depthAttachment: DepthTexture | null;
    /** What a backend set up for this target beyond its textures (WebGL's framebuffers and renderbuffers), released by `dispose`. @internal */
    _onDispose: (() => void) | null;
    /**
     * The depth attachment exposed for SAMPLING, or null when the depth isn't declared sampled.
     * three.js-aligned: a render target's depth is readable as a texture only when you opt in
     * (`depthSampled: true`, an explicit `depthTexture`, or `RenderTextureNode.getDepthTextureNode()`), mirroring
     * three.js where the *presence* of `renderTarget.depthTexture` is the signal. The actual depth
     * attachment for depth testing always exists (see {@link _depthAttachment}); returning null here
     * makes sampling an undeclared depth fail loud (a null at wiring time) instead of silently reading
     * an unwritten texture — which on the WebGL backend reads as ~1.0 everywhere, e.g. no shadows.
     */
    get depthTexture(): DepthTexture | null;
    /**
     * Whether the depth attachment is sampled. When false and the target owns an
     * auto-allocated depth, the WebGL backend attaches a depth RENDERBUFFER instead
     * of a texture (three.js parity, more broadly FBO-complete; depth-testing still
     * works). Set true by `RenderTextureNode.getDepthTextureNode()` or the `depthSampled` option.
     * WebGPU always allocates the attachment as a texture, so it is unaffected.
     */
    depthSampled: boolean;
    /** Constructs a new render target */
    constructor(width: number, height: number, opts?: RenderTargetOptions);
    /** Mip levels of every attachment at the current size. */
    get mipLevelCount(): number;
    /** The first color attachment texture, or undefined when count=0 (depth-only target). */
    get texture(): RenderTargetTexture | undefined;
    set texture(value: RenderTargetTexture | undefined);
    /**
     * Resize the render target. Old GPU resources are NOT destroyed here: the
     * renderer reallocates lazily on next use in `ensureRenderTargetTexturesAllocated`,
     * where `setRenderTargetTexture` destroys the old texture and creates the new
     * one atomically. Marking `needsUpdate` (+ the size mismatch) is enough to
     * trigger that: a version-driven reallocation rather than eager destruction.
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
/** Holds no device: the backend allocates the textures on first use. */
export declare function createRenderTarget(width: number, height: number, opts?: RenderTargetOptions): RenderTarget;
/**
 * Throws unless mip `mipLevel` and layer `layer` are in `renderTarget`'s layout: a mip it has, and a layer it has, or
 * for a `'3d'` target a slice of that mip. `what` names the caller in the message.
 */
export declare function assertSubresource(renderTarget: RenderTarget, mipLevel: number, layer: number, what: string): void;
/** The name of the first attachment whose texture is disposed, or null. Depth counts: a submit dies on either. */
export declare function deadAttachment(rt: RenderTarget): string | null;
