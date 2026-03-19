import { Texture } from './texture';
/**
 * A texture created from a canvas element.
 * Convenience subclass that sets appropriate defaults.
 */
export declare class CanvasTexture extends Texture<HTMLCanvasElement | OffscreenCanvas> {
    readonly isCanvasTexture = true;
    constructor(canvas: HTMLCanvasElement | OffscreenCanvas);
}
