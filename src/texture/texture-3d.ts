import { Texture } from './texture';
import { Source, type DataTextureImage } from './source';

/** Data format for 3D textures - typed array with width, height, and depth */
export type Texture3DImage = DataTextureImage & { depth: number };

/**
 * A 3D (volume) texture.
 *
 * Sampled using vec3 UVW coordinates. Useful for:
 * - Volume rendering (medical imaging, clouds, fog)
 * - 3D LUTs (color grading)
 * - Signed distance fields
 */
export class Data3DTexture extends Texture<Texture3DImage> {
    /** Type flag for runtime checking */
    readonly is3DTexture = true;

    /**
     * Constructs a new Data3DTexture.
     *
     * @param data optional raw data for voxels
     * @param width width of the texture
     * @param height height of the texture
     * @param depth depth of the texture
     */
    constructor(
        data: DataTextureImage['data'] = null,
        width = 1,
        height = 1,
        depth = 1,
    ) {
        super(new Source<Texture3DImage>({ data, width, height, depth }));

        // 3D textures typically use nearest filtering by default
        this.magFilter = 'nearest';
        this.minFilter = 'nearest';
        this.generateMipmaps = false;
        this.flipY = false;
    }

    /** Depth of the 3D texture */
    get depth(): number {
        return this.image.depth;
    }

    override clone(): Data3DTexture {
        const img = this.image;
        const tex = new Data3DTexture(img.data, img.width, img.height, img.depth);
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
