import { Texture, DepthTextureFormat } from './texture';

/**
 * A texture for storing depth information.
 * Used as the depth attachment in RenderTarget, or for shadow mapping.
 */
export class DepthTexture extends Texture {
    /** type flag for runtime checking - overrides Texture.isDepthTexture */
    override readonly isDepthTexture = true;

    /** depth compare function for shadow mapping */
    compareFunction: GPUCompareFunction | null = null;

    private _width: number;
    private _height: number;

    /**
     * Constructs a new DepthTexture.
     *
     * @param width - The width of the texture
     * @param height - The height of the texture
     * @param format - The depth format (default: 'depth24plus')
     */
    constructor(width: number, height: number, format: DepthTextureFormat = 'depth24plus') {
        // Create source with size info
        super({ width, height });

        this._width = width;
        this._height = height;

        this.format = format;
        this.generateMipmaps = false;
        this.flipY = false;
        this.magFilter = 'nearest';
        this.minFilter = 'nearest';

        // Depth textures are always render target textures
        this.isRenderTargetTexture = true;
    }

    override get width(): number {
        return this._width;
    }

    override get height(): number {
        return this._height;
    }

    /** set the size of the depth texture */
    setSize(width: number, height: number): void {
        this._width = width;
        this._height = height;
        this.source.data = { width, height };
    }

    override clone(): DepthTexture {
        const tex = new DepthTexture(this._width, this._height, this.format as DepthTextureFormat);
        tex.name = this.name;
        tex.compareFunction = this.compareFunction;
        return tex;
    }
}
