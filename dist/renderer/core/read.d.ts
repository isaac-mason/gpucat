import type { GpuBuffer } from '../../core/gpu-buffer';
import { type RenderTarget } from '../../core/render-target';
import type { Any, TypedArrayFor } from '../../schema/schema';
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
export declare function read(renderer: Renderer, target: RenderTarget, opts?: ReadOptions): Promise<Uint8Array>;
export type ReadBufferOptions = {
    /** The first element read. Defaults to 0. */
    offset?: number;
    /** How many elements to read. Defaults to the rest of the buffer. */
    count?: number;
};
/**
 * Reads a buffer back as its own typed array (a struct array's as floats, which a view over the same bytes
 * reinterprets), the buffer counterpart of `read()` for targets. Call it after the frame that wrote the buffer has
 * been submitted; reading with one open throws rather than returning stale data. On WebGL2 it reads a buffer a
 * transform feedback wrote; a storage buffer there lives in a texture and is not read back yet.
 */
export declare function readBuffer<T extends Any>(renderer: Renderer, buffer: GpuBuffer<T>, opts?: ReadBufferOptions): Promise<TypedArrayFor<T>>;
