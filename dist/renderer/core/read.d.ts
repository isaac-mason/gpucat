import type { RenderTarget } from '../../core/render-target';
export type ReadOpts = {
    /** Which MRT colour attachment to read. Defaults to the first. */
    attachment?: number;
    /** Array layer, or cube face: 0..5 = +X, -X, +Y, -Y, +Z, -Z. */
    layer?: number;
};
/** What `read` needs of a renderer. Both renderers satisfy it; a target holds no device to do it itself. */
export type ReadableRenderer = {
    readPixels(target: RenderTarget, attachment: number, layer: number): Promise<Uint8Array>;
};
/**
 * Reads a colour attachment back as tightly-packed, top-to-bottom RGBA8. Call it after the frame that
 * wrote the target has been submitted; reading with one open throws rather than returning stale pixels.
 */
export declare function read(renderer: ReadableRenderer, target: RenderTarget, opts?: ReadOpts): Promise<Uint8Array>;
