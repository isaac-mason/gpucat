import { Texture } from './texture';
import { Source, type DataTextureImage } from './source';

/** Data format for array textures - typed array with width, height, and layer count */
export type ArrayTextureImage = DataTextureImage & { depth: number };

/**
 * A 2D texture array - multiple 2D textures stacked as layers.
 *
 * Each layer has the same dimensions. Sampled using vec2 UV + layer index.
 * Useful for: sprite atlases, terrain splatting, shadow map arrays.
 */
export class DataArrayTexture extends Texture<ArrayTextureImage> {
    /** Type flag for runtime checking */
    readonly isArrayTexture = true;

    /**
     * Track which layers have been modified.
     * Used for partial updates - only upload changed layers.
     */
    layerUpdates: Set<number> = new Set();

    /**
     * Constructs a new DataArrayTexture.
     *
     * @param data - Optional raw data for all layers
     * @param width - Width of each layer
     * @param height - Height of each layer
     * @param depth - Number of layers
     */
    constructor(
        data: DataTextureImage['data'] = null,
        width = 1,
        height = 1,
        depth = 1,
    ) {
        super(new Source<ArrayTextureImage>({ data, width, height, depth }));

        // Array textures typically use nearest filtering by default
        this.magFilter = 'nearest';
        this.minFilter = 'nearest';
        this.generateMipmaps = false;
        this.flipY = false;
    }

    /** Depth (number of layers) of the texture array */
    get depth(): number {
        return this.image.depth;
    }

    /**
     * Mark a specific layer as needing update.
     * On next upload, only this layer will be transferred.
     */
    addLayerUpdate(layerIndex: number): void {
        this.layerUpdates.add(layerIndex);
    }

    /**
     * Clear the layer update tracking.
     * Called by the renderer after upload.
     */
    clearLayerUpdates(): void {
        this.layerUpdates.clear();
    }

    override clone(): DataArrayTexture {
        const img = this.image;
        const tex = new DataArrayTexture(img.data, img.width, img.height, img.depth);
        tex.name = this.name;
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
}
