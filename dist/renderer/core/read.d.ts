import type { RenderTarget } from '../../core/render-target';
import type { Renderer } from './renderer';
export type ReadOptions = {
    /** Which MRT colour attachment to read. Defaults to the first. */
    attachment?: number;
    /** Array layer, or cube face: 0..5 = +X, -X, +Y, -Y, +Z, -Z. */
    layer?: number;
};
/**
 * Reads a colour attachment back as tightly-packed, top-to-bottom RGBA8. Call it after the frame that
 * wrote the target has been submitted; reading with one open throws rather than returning stale pixels.
 */
export declare function read(renderer: Renderer, target: RenderTarget, opts?: ReadOptions): Promise<Uint8Array>;
