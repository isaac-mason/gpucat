/**
 * read-pixels.ts (webgl) - render-target pixel readback.
 *
 * The GL analogue of `webgpu/read-pixels.ts`. Binds a RenderTarget's texture FBO and reads its color
 * attachment back to a tightly-packed, top-to-bottom RGBA8 `Uint8Array`, the identical output contract
 * to the WebGPU `readPixels`, so an offline/headless bake gets the same bytes on either backend.
 *
 * The read goes into a pixel-pack buffer, which only queues the copy, and the bytes are fetched once a
 * fence says the GPU has written them, polled across event-loop ticks like `readBufferAsync`. A plain
 * `readPixels` into client memory would stall the thread until everything before it has drawn.
 *
 * GL `readPixels` returns rows bottom-to-top (GL's origin is lower-left), so the rows are flipped to
 * top-to-bottom to match the WebGPU convention. The public entry is the `WebGLBackend.readPixels`; this
 * is the free-function impl it delegates to.
 */
import type { RenderTarget } from '../../core/render-target';
import type { WebGLBackend } from './webgl-backend';
/**
 * Read a RenderTarget color attachment back to a tightly-packed, top-to-bottom RGBA8 `Uint8Array`
 * (length `width * height * 4`), matching the WebGPU `readPixels` output. The target's color format
 * must be `rgba8unorm` / `rgba8unorm-srgb` (WebGL2 has no BGRA render format). `attachmentIndex`
 * selects an MRT color attachment; `layer` selects a cube face (0..5). Throws if the target has not
 * been rendered to yet. The copy is queued before this returns, so the target can be drawn into again
 * at once; the promise settles when the bytes are back.
 */
export declare function readPixels(gl: WebGL2RenderingContext, b: WebGLBackend, renderTarget: RenderTarget, attachmentIndex?: number, layer?: number, mipLevel?: number): Promise<Uint8Array>;
