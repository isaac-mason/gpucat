import { Texture } from './texture';

/**
 * A texture created from a canvas element.
 * Convenience subclass that sets appropriate defaults.
 */
export class CanvasTexture extends Texture {
    readonly isCanvasTexture = true;

    constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
        super(canvas);

        // canvas textures typically don't need mipmaps and shouldn't flip
        this.generateMipmaps = false;
        this.flipY = false;
    }
}
