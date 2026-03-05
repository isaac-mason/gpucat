/**
 * texture.ts — Texture class aligned with Three.js Texture.
 *
 * The Texture class is a high-level wrapper around image data that will be
 * uploaded to the GPU. It mirrors Three.js's Texture class but is simplified
 * for WebGPU.
 *
 * Key features:
 * - Version tracking via `needsUpdate` setter
 * - Filter and wrap mode configuration
 * - Support for various image sources (ImageBitmap, HTMLImageElement, etc.)
 *
 * Usage:
 *   const texture = new Texture(imageBitmap);
 *   texture.wrapS = 'repeat';
 *   texture.needsUpdate = true;
 *
 *   // In material:
 *   const mat = new Material({
 *       color: textureNode(texture).sample(uv()),
 *   });
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Wrap modes matching WebGPU GPUAddressMode */
export type WrapMode = 'clamp-to-edge' | 'repeat' | 'mirror-repeat';

/** Filter modes matching WebGPU GPUFilterMode */
export type FilterMode = 'nearest' | 'linear';

/** Mipmap filter modes matching WebGPU GPUMipmapFilterMode */
export type MipmapFilterMode = 'nearest' | 'linear';

/** Supported image source types */
export type TextureSource =
    | ImageBitmap
    | HTMLImageElement
    | HTMLCanvasElement
    | HTMLVideoElement
    | OffscreenCanvas
    | VideoFrame
    | ImageData
    | null;

let _textureId = 0;

/**
 * Base texture class aligned with Three.js Texture.
 *
 * Holds image data and sampling parameters. The renderer will upload
 * the image to the GPU and create appropriate GPUTexture/GPUSampler
 * resources based on these settings.
 */
export class Texture {
    /** Type flag for runtime type checking */
    readonly isTexture = true;

    /** Unique numeric ID */
    readonly id: number;

    /** Optional name for debugging */
    name = '';

    /**
     * The image data source. Can be an ImageBitmap, HTMLImageElement,
     * canvas, video, or null.
     */
    image: TextureSource;

    /**
     * User-provided mipmaps. If empty, mipmaps are auto-generated
     * when `generateMipmaps` is true.
     */
    mipmaps: TextureSource[] = [];

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
     * Version number, incremented when `needsUpdate` is set to true.
     * Used for dirty checking by the renderer.
     * @readonly
     */
    version = 0;

    /**
     * Callback fired when the texture is updated.
     */
    onUpdate: ((texture: Texture) => void) | null = null;

    /**
     * Whether this texture belongs to a render target.
     * @readonly
     */
    isRenderTargetTexture = false;

    /**
     * Constructs a new Texture.
     *
     * @param image - The image source (ImageBitmap, HTMLImageElement, etc.)
     */
    constructor(image: TextureSource = null) {
        this.id = _textureId++;
        this.image = image;
    }

    /**
     * Set to `true` to trigger a GPU upload on the next render.
     * Increments the version counter.
     */
    set needsUpdate(value: boolean) {
        if (value) {
            this.version++;
            this.onUpdate?.(this);
        }
    }

    /**
     * Returns the width of the image, or 1 if no image is set.
     */
    get width(): number {
        if (!this.image) return 1;
        if ('width' in this.image) return this.image.width;
        return 1;
    }

    /**
     * Returns the height of the image, or 1 if no image is set.
     */
    get height(): number {
        if (!this.image) return 1;
        if ('height' in this.image) return this.image.height;
        return 1;
    }

    /**
     * Creates a clone of this texture.
     */
    clone(): Texture {
        const tex = new Texture(this.image);
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
     * Disposes of the texture. Call this when you no longer need the texture
     * to free up memory.
     *
     * Note: This doesn't automatically free GPU resources — the renderer
     * must handle that based on texture disposal.
     */
    dispose(): void {
        // Subclasses or the renderer can hook into this
        // For now, just clear the image reference
        this.image = null;
        this.mipmaps = [];
    }
}

// ---------------------------------------------------------------------------
// CanvasTexture
// ---------------------------------------------------------------------------

/**
 * A texture created from a canvas element.
 * Convenience subclass that sets appropriate defaults.
 */
export class CanvasTexture extends Texture {
    readonly isCanvasTexture = true;

    constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
        super(canvas);
        // Canvas textures typically don't need mipmaps and shouldn't flip
        this.generateMipmaps = false;
        this.flipY = false;
    }
}

// ---------------------------------------------------------------------------
// DataTexture
// ---------------------------------------------------------------------------

/**
 * A texture created from raw typed array data.
 */
export class DataTexture extends Texture {
    readonly isDataTexture = true;

    /** raw pixel data */
    data: ArrayBufferView | null;

    /** explicit width */
    readonly dataWidth: number;

    /** explicit height */
    readonly dataHeight: number;

    constructor(
        data: ArrayBufferView | null,
        width: number,
        height: number,
        format: GPUTextureFormat = 'rgba8unorm',
    ) {
        super(null);
        this.data = data;
        this.dataWidth = width;
        this.dataHeight = height;
        this.format = format;
        this.generateMipmaps = false;
    }

    override get width(): number {
        return this.dataWidth;
    }

    override get height(): number {
        return this.dataHeight;
    }

    override clone(): DataTexture {
        const tex = new DataTexture(
            this.data ? new (this.data.constructor as new (buffer: ArrayBufferLike) => ArrayBufferView)(
                this.data.buffer.slice(0),
            ) : null,
            this.dataWidth,
            this.dataHeight,
            this.format ?? 'rgba8unorm',
        );
        tex.name = this.name;
        tex.wrapS = this.wrapS;
        tex.wrapT = this.wrapT;
        tex.magFilter = this.magFilter;
        tex.minFilter = this.minFilter;
        return tex;
    }
}

// ---------------------------------------------------------------------------
// VideoTexture
// ---------------------------------------------------------------------------

/**
 * A texture created from a video element.
 * Automatically updates each frame.
 */
export class VideoTexture extends Texture {
    readonly isVideoTexture = true;

    constructor(video: HTMLVideoElement) {
        super(video);
        // Video textures need frequent updates
        this.generateMipmaps = false;
        this.flipY = false;
    }

    /**
     * Call this each frame to check if the video needs updating.
     * Sets needsUpdate if the video is playing and has new data.
     */
    update(): void {
        const video = this.image as HTMLVideoElement;
        if (video && video.readyState >= video.HAVE_CURRENT_DATA) {
            this.needsUpdate = true;
        }
    }
}
