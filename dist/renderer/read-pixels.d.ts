import type { RenderTarget } from '../core/render-target';
import type { WebGPURenderer } from './renderer';
/**
 * Read pixels from a RenderTarget color attachment back to a tightly-packed Uint8Array.
 *
 * The target's color format must be a 4-byte format (`rgba8unorm`, `bgra8unorm`,
 * `rgba8unorm-srgb`, `bgra8unorm-srgb`). For HDR formats like `rgba16float`,
 * render through `renderOutput()` into an `rgba8unorm` RenderTarget first.
 *
 * Returns rows top-to-bottom, RGBA (or BGRA) order, length = width * height * 4.
 * Must be called after `render()` has populated the target.
 */
export declare function readPixels(renderer: WebGPURenderer, renderTarget: RenderTarget, attachmentIndex?: number): Promise<Uint8Array>;
