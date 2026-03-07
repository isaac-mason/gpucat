import { Texture } from './texture';

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
        format: GPUTextureFormat = 'rgba8unorm'
    ) {
        // create source with size info
        super({ width, height });
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
                this.data.buffer.slice(0)
            ) : null,
            this.dataWidth,
            this.dataHeight,
            this.format ?? 'rgba8unorm'
        );
        tex.name = this.name;
        tex.wrapS = this.wrapS;
        tex.wrapT = this.wrapT;
        tex.magFilter = this.magFilter;
        tex.minFilter = this.minFilter;
        return tex;
    }
}
