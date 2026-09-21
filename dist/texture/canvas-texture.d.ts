import { Texture } from './texture';
/**
 * A texture created from a canvas element.
 * Convenience subclass that sets appropriate defaults.
 */
export declare class CanvasTexture extends Texture<HTMLCanvasElement | OffscreenCanvas> {
    readonly isCanvasTexture = true;
    constructor(canvas: HTMLCanvasElement | OffscreenCanvas);
}
/** The factory form; the canvas is re-uploaded whenever `needsUpdate` is set. */
export declare function createCanvasTexture(canvas: HTMLCanvasElement | OffscreenCanvas): CanvasTexture;
