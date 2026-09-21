import type { RenderTarget } from '../../core/render-target';
import { isFrameOpen } from './frame';
import type { Renderer } from './renderer';

export type ReadOptions = {
    /** Which MRT colour attachment to read. Defaults to the first. */
    attachment?: number;
    /** Array layer, or cube face: 0..5 = +X, -X, +Y, -Y, +Z, -Z. */
    layer?: number;
    /** Mip level to read; only a cube target has any but the base. */
    mipLevel?: number;
};

/**
 * Reads a colour attachment back as tightly-packed, top-to-bottom RGBA8. Call it after the frame that
 * wrote the target has been submitted; reading with one open throws rather than returning stale pixels.
 */
export function read(renderer: Renderer, target: RenderTarget, opts: ReadOptions = {}): Promise<Uint8Array> {
    renderer._assertInitialized('read');
    if (isFrameOpen(renderer._frameState)) {
        return Promise.reject(new Error('[read] reading while a frame is open gives stale pixels; submit() first.'));
    }
    return renderer.backend.readPixels(target, opts.attachment ?? 0, opts.layer ?? 0, opts.mipLevel ?? 0);
}
