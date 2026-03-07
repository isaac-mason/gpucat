import { type ImageSize } from '../texture/source';
import { Texture, type DepthTextureFormat } from '../texture/texture';
import { DepthTexture } from 'src/texture/depth-texture';

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
    /** the width of the render target */
    width: number;

    /** the height of the render target */
    height: number;

    /** the color format of the render target's texture(s) */
    readonly colorFormat: GPUTextureFormat;

    /** the depth format of the render target's depth texture, or null if no depth attachment */
    readonly depthFormat: DepthTextureFormat | null;

    /** the MSAA sample count of the render target */
    readonly samples: number;

    /**
     * Array of color attachment textures.
     * Each has a `.name` for MRT mapping, the first texture is also accessible via the `texture` getter.
     * these are Texture instances with isRenderTargetTexture = true.
     */
    textures: Texture[];

    /**
     * Depth texture, or null if no depth buffer.
     */
    depthTexture: DepthTexture | null = null;

    /** type flag for runtime checking */
    readonly isRenderTarget = true;

    /** constructs a new render target */
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
            depthTexture.renderTarget = this;
            this.depthTexture = depthTexture;
        }
    }

    /** the first color attachment texture */
    get texture(): Texture {
        return this.textures[0];
    }

    /** sets the size of the render target, disposes existing GPU resources; renderer will reallocate on next use */
    setSize(width: number, height: number): void {
        if (this.width === width && this.height === height) return;

        this.dispose();
        this.width = width;
        this.height = height;

        // update texture dimensions
        for (const tex of this.textures) {
            if (tex.image && typeof tex.image === 'object' && 'width' in tex.image) {
                (tex.image as ImageSize).width = width;
                (tex.image as ImageSize).height = height;
            }
        }
        if (this.depthTexture) {
            this.depthTexture.setSize(width, height);
        }
    }

    /** destroy the underlying GPU textures and samplers */
    dispose(): void {
        for (const tex of this.textures) {
            tex.gpuTexture?.destroy();
            tex.gpuTexture = null;
            // Note: GPUSampler doesn't have a destroy method, just null it
            tex.gpuSampler = null;
        }
        if (this.depthTexture) {
            this.depthTexture.gpuTexture?.destroy();
            this.depthTexture.gpuTexture = null;
            this.depthTexture.gpuSampler = null;
        }
    }

    /**
     * Returns the texture index for the given name, or -1 if not found.
     * Used by MRTNode to map output names to @location indices.
     */
    getTextureIndex(name: string): number {
        for (let i = 0; i < this.textures.length; i++) {
            if (this.textures[i].name === name) return i;
        }
        return -1;
    }
}

/** creates a Texture configured for use as a render target color attachment */
function createRenderTargetTexture(
    renderTarget: RenderTarget,
    width: number,
    height: number,
    format: GPUTextureFormat,
): Texture {
    // create placeholder image object with dimensions
    const image: ImageSize = { width, height };

    const texture = new Texture(image);
    texture.format = format;
    texture.isRenderTargetTexture = true;
    texture.renderTarget = renderTarget;
    texture.generateMipmaps = false;
    texture.flipY = false;

    return texture;
}
