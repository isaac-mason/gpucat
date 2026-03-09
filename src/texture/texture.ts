import { Source, type SourceData } from './source';

/** Wrap modes matching WebGPU GPUAddressMode */
export type WrapMode = 'clamp-to-edge' | 'repeat' | 'mirror-repeat';

/** Filter modes matching WebGPU GPUFilterMode */
export type FilterMode = 'nearest' | 'linear';

/** Mipmap filter modes matching WebGPU GPUMipmapFilterMode */
export type MipmapFilterMode = 'nearest' | 'linear';

/** Depth texture formats */
export type DepthTextureFormat = 'depth16unorm' | 'depth24plus' | 'depth24plus-stencil8' | 'depth32float' | 'depth32float-stencil8';

let _textureId = 0;

/**
 * Base texture class aligned with Three.js Texture.
 *
 * Holds sampling parameters and references a Source for image data.
 * The renderer will upload the image to the GPU and create appropriate
 * GPUTexture/GPUSampler resources based on these settings.
 */
export class Texture {
    /** Type flag for runtime type checking */
    readonly isTexture = true;

    /** Unique numeric ID */
    readonly id: number;

    /** Optional name for debugging */
    name = '';

    /**
     * The data source for this texture.
     * Multiple textures can share the same Source.
     */
    source: Source;

    /**
     * User-provided mipmaps as Sources. If empty, mipmaps are auto-generated
     * when `generateMipmaps` is true.
     */
    mipmaps: Source[] = [];

    /**
     * Horizontal wrap mode (U direction).
     * @default 'clamp-to-edge'
     */
    wrapS: WrapMode = 'clamp-to-edge';

    /**
     * Vertical wrap mode (V direction).
     * @default 'clamp-to-edge'
     */
    wrapT: WrapMode = 'clamp-to-edge';

    /**
     * Magnification filter (when texel covers more than one pixel).
     * @default 'linear'
     */
    magFilter: FilterMode = 'linear';

    /**
     * Minification filter (when texel covers less than one pixel).
     * @default 'linear'
     */
    minFilter: FilterMode = 'linear';

    /**
     * Mipmap filter mode for minification.
     * @default 'linear'
     */
    mipmapFilter: MipmapFilterMode = 'linear';

    /**
     * Anisotropic filtering level. Higher values = better quality at oblique angles.
     * @default 1
     */
    anisotropy = 1;

    /**
     * WebGPU texture format. If null, the renderer will choose based on the image.
     * @default null
     */
    format: GPUTextureFormat | null = null;

    /**
     * Whether to auto-generate mipmaps.
     * @default true
     */
    generateMipmaps = true;

    /**
     * Whether to flip the image vertically when uploading.
     * Note: WebGPU handles this differently than WebGL.
     * @default false
     */
    flipY = false;

    /**
     * Whether to premultiply alpha.
     * @default false
     */
    premultiplyAlpha = false;

    /**
     * Texture-level version, incremented when `needsUpdate` is set to true.
     * Note: The Source also has its own version for data changes.
     * @readonly
     */
    version = 0;

    /**
     * Callback fired when the texture is updated.
     */
    onUpdate: ((texture: Texture) => void) | null = null;

    /**
     * Whether this texture belongs to a render target.
     * Set to true by RenderTarget when creating its textures.
     * @default false
     */
    isRenderTargetTexture = false;

    /**
     * Whether this is a depth texture.
     * Set to true by DepthTexture subclass.
     * @default false
     */
    isDepthTexture = false;

    /**
     * Back-reference to the owning RenderTarget, if this is a render target texture.
     * Three.js aligned: set when texture is attached to a render target.
     * @default null
     */
    renderTarget: unknown = null; // Use unknown to avoid circular import; will be RenderTarget

    /**
     * GPU texture resource. Managed by renderer for render target textures.
     * For user textures, this is managed by the TextureCache.
     * @default null
     */
    gpuTexture: GPUTexture | null = null;

    /**
     * GPU sampler resource. Managed by renderer.
     * @default null
     */
    gpuSampler: GPUSampler | null = null;

    /**
     * Constructs a new Texture.
     *
     * @param image - The image source (ImageBitmap, HTMLImageElement, Source, etc.)
     */
    constructor(image: SourceData | Source = null) {
        this.id = _textureId++;

        // Accept either a Source directly or raw data (which we wrap in a Source)
        if (image instanceof Source) {
            this.source = image;
        } else {
            this.source = new Source(image);
        }
    }

    /**
     * Convenience getter for the source data.
     * Three.js aligned: texture.image returns the underlying data.
     */
    get image(): SourceData {
        return this.source.data;
    }

    /**
     * Convenience setter for the source data.
     * Three.js aligned: setting texture.image updates source.data.
     */
    set image(value: SourceData) {
        this.source.data = value;
    }

    /**
     * Set to `true` to trigger a GPU upload on the next render.
     * Increments both the texture version and the source version.
     */
    set needsUpdate(value: boolean) {
        if (value) {
            this.version++;
            this.source.needsUpdate = true;
            this.onUpdate?.(this);
        }
    }

    /**
     * Returns the width of the source, or 1 if no data.
     */
    get width(): number {
        return this.source.width || 1;
    }

    /**
     * Returns the height of the source, or 1 if no data.
     */
    get height(): number {
        return this.source.height || 1;
    }

    /**
     * Creates a clone of this texture.
     * Note: The clone shares the same Source by default.
     * Use clone().source = new Source(data) if you need independent data.
     */
    clone(): Texture {
        const tex = new Texture(this.source);
        tex.name = this.name;
        tex.mipmaps = [...this.mipmaps];
        tex.wrapS = this.wrapS;
        tex.wrapT = this.wrapT;
        tex.magFilter = this.magFilter;
        tex.minFilter = this.minFilter;
        tex.mipmapFilter = this.mipmapFilter;
        tex.anisotropy = this.anisotropy;
        tex.format = this.format;
        tex.generateMipmaps = this.generateMipmaps;
        tex.flipY = this.flipY;
        tex.premultiplyAlpha = this.premultiplyAlpha;
        return tex;
    }

    /**
     * Disposes of the texture. Call this when you no longer need the texture to free up memory.
     *
     * Note: This doesn't automatically free GPU resources — the renderer
     * must handle that based on texture disposal.
     *
     * Note: This doesn't dispose the Source, as it may be shared.
     */
    dispose(): void {
        this.mipmaps = [];
        // don't clear source - it may be shared with other textures
    }
}

