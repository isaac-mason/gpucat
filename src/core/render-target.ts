import { type ImageSize } from '../texture/source';
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
export class RenderTarget {
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
    depthTexture: DepthTexture | null = null;

    /** Constructs a new render target */
    constructor(width: number, height: number, opts: RenderTargetOptions = {}) {
        this.width = width;
        this.height = height;
        this.samples = opts.samples ?? 1;

        const defaultFormat = opts.colorFormat ?? 'rgba16float';
        const count = opts.count ?? 1;
        this.textures = [];
        for (let i = 0; i < count; i++) {
            const texture = createRenderTargetTexture(this, width, height, defaultFormat);
            texture.name = i === 0 ? 'output' : `output${i}`;
            texture._gpuTexture.renderTarget = this;
            this.textures.push(texture);
        }

        if (opts.depthTexture) {
            this.depthTexture = opts.depthTexture;
            this.depthTexture._gpuTexture.isRenderTargetTexture = true;
        } else if (opts.depthBuffer !== false) {
            const depthTexture = new DepthTexture(width, height, opts.depthFormat ?? 'depth24plus');
            depthTexture.name = 'depth';
            depthTexture._gpuTexture.isRenderTargetTexture = true;
            this.depthTexture = depthTexture;
        }
        if (this.depthTexture) {
            this.depthTexture._gpuTexture.renderTarget = this;
        }
    }

    /** The first color attachment texture, or undefined when count=0 (depth-only target). */
    get texture(): RenderTargetTexture | undefined {
        return this.textures[0];
    }

    set texture(value: RenderTargetTexture | undefined) {
        if (value === undefined) {
            this.textures.length = 0;
            return;
        }
        if (this.textures.length === 0) {
            this.textures.push(value);
        } else {
            this.textures[0] = value;
        }
    }

    /**
     * Resize the render target. Old GPU resources are NOT destroyed here: the
     * renderer reallocates lazily on next use in `ensureRenderTargetTexturesAllocated`,
     * where `setRenderTargetTexture` destroys the old texture and creates the new
     * one atomically. Marking `needsUpdate` (+ the size mismatch) is enough to
     * trigger that. This mirrors three.js, whose `RenderTarget.setSize` defers to
     * a version-driven `updateTexture` rather than eager-destroying.
     *
     * Eagerly disposing here would destroy a GPU texture synchronously, opening a
     * window where another pass that already recorded a draw against it (e.g. a
     * shared depth attachment) submits with a destroyed texture. The lazy path has
     * no such window.
     */
    setSize(width: number, height: number): void {
        if (this.width === width && this.height === height) return;

        this.width = width;
        this.height = height;

        // update texture dimensions on the GpuTexture
        for (const tex of this.textures) {
            tex._gpuTexture.width = width;
            tex._gpuTexture.height = height;
            tex._gpuTexture.needsUpdate = true;
        }
        if (this.depthTexture) {
            this.depthTexture.setSize(width, height);
        }
    }

    /** 
     * Dispose of the render target's GPU resources.
     * This triggers the _onDispose callbacks set by the renderer cache.
     */
    dispose(): void {
        for (const tex of this.textures) {
            tex._gpuTexture.dispose();
        }
        if (this.depthTexture) {
            this.depthTexture._gpuTexture.dispose();
        }
    }

    /** Returns the texture index for the given name, or -1 if not found. */
    getTextureIndex(name: string): number {
        for (let i = 0; i < this.textures.length; i++) {
            if (this.textures[i].name === name) return i;
        }
        return -1;
    }
}

/** creates a Texture configured for use as a render target color attachment */
function createRenderTargetTexture(
    _renderTarget: RenderTarget,
    width: number,
    height: number,
    format: GPUTextureFormat,
): Texture {
    // create placeholder image object with dimensions
    const image: ImageSize = { width, height };

    const texture = new Texture(image);
    texture.format = format;
    texture.isRenderTargetTexture = true;
    texture.generateMipmaps = false;
    texture.flipY = false;
    
    // Mark the underlying GpuTexture as a render target texture too
    texture._gpuTexture.isRenderTargetTexture = true;

    return texture;
}
