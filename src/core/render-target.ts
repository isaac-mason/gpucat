import { type ImageSize } from '../texture/source';
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
export class RenderTarget {
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
    depthTexture: DepthTexture | null = null;

    /** Constructs a new render target */
    constructor(width: number, height: number, opts: RenderTargetOptions = {}) {
        this.width = width;
        this.height = height;
        this.colorFormat = opts.colorFormat ?? 'rgba16float';
        this.depthFormat = opts.depthFormat !== undefined ? opts.depthFormat : 'depth24plus';
        this.samples = opts.samples ?? 1;

        // Create color attachment textures
        const count = opts.count ?? 1;
        this.textures = [];
        for (let i = 0; i < count; i++) {
            const texture = createRenderTargetTexture(this, width, height, this.colorFormat);
            texture.name = i === 0 ? 'output' : `output${i}`;
            this.textures.push(texture);
        }

        // Create depth texture if depth format specified
        if (this.depthFormat) {
            const depthTexture = new DepthTexture(width, height, this.depthFormat);
            depthTexture.name = 'depth';
            depthTexture._gpuTexture.isRenderTargetTexture = true;
            this.depthTexture = depthTexture;
        }
    }

    /** The first color attachment texture, or undefined when count=0 (depth-only target). */
    get texture(): Texture | undefined {
        return this.textures[0];
    }

    /** Sets the size of the render target, disposes existing GPU resources; renderer will reallocate on next use */
    setSize(width: number, height: number): void {
        if (this.width === width && this.height === height) return;

        this.dispose();
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
