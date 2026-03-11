import { Texture } from './texture';
import { Source, type SourceData } from './source';

/**
 * Cube texture mapping modes.
 * Determines which vector to use for cube texture sampling.
 */
export type CubeTextureMapping = 'reflection' | 'refraction';

/** Data format for cube textures - array of 6 face images */
export type CubeTextureImage = SourceData[];

/**
 * A texture for cubemaps (environment maps, skyboxes, etc).
 *
 * Stores 6 faces: +X, -X, +Y, -Y, +Z, -Z.
 * Sampled using a 3D direction vector.
 *
 * Three.js aligned: mirrors CubeTexture.js
 */
export class CubeTexture extends Texture<CubeTextureImage> {
    /** Type flag for runtime checking */
    readonly isCubeTexture = true;

    /**
     * Array of 6 Sources for cube faces.
     * Order: +X, -X, +Y, -Y, +Z, -Z
     */
    private _imageSources: Source[] = [];

    /**
     * Mapping mode - determines default UV vector.
     * - 'reflection': uses reflect(viewDir, normal)
     * - 'refraction': uses refract(viewDir, normal, ior)
     */
    mapping: CubeTextureMapping = 'reflection';

    /**
     * Constructs a new CubeTexture.
     *
     * @param images - Array of 6 images for cube faces (+X, -X, +Y, -Y, +Z, -Z)
     */
    constructor(images: SourceData[] = []) {
        super(new Source<CubeTextureImage>(images));
        this._imageSources = images.map(img =>
            img instanceof Source ? img : new Source(img)
        );
        this.flipY = false;
    }

    /** The 6 face images as SourceData (for easy assignment) */
    get images(): SourceData[] {
        return this._imageSources.map(s => s.data);
    }

    set images(value: SourceData[]) {
        this._imageSources = value.map(img =>
            img instanceof Source ? img : new Source(img)
        );
        this.source.data = value;
        this.version++;
    }

    /** The 6 face Sources (for internal use) */
    get imageSources(): Source[] {
        return this._imageSources;
    }

    override get width(): number {
        if (this._imageSources.length > 0) {
            return this._imageSources[0].width || 1;
        }
        return 1;
    }

    override get height(): number {
        if (this._imageSources.length > 0) {
            return this._imageSources[0].height || 1;
        }
        return 1;
    }

    /** Check if all 6 faces are present and ready */
    get isComplete(): boolean {
        return this._imageSources.length === 6 &&
            this._imageSources.every(s => s.dataReady && s.width > 0);
    }

    override clone(): CubeTexture {
        const tex = new CubeTexture(this.images);
        tex.name = this.name;
        tex.mapping = this.mapping;
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
