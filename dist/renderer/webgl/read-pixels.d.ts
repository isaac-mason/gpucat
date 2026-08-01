/**
 * read-pixels.ts (webgl) - render-target pixel readback.
 *
 * The GL analogue of `webgpu/read-pixels.ts`. Binds a RenderTarget's texture FBO and reads its color
 * attachment back to a tightly-packed, top-to-bottom RGBA8 `Uint8Array`, the identical output contract
 * to the WebGPU `readPixels`, so an offline/headless bake gets the same bytes on either backend.
 *
 * GL `readPixels` returns rows bottom-to-top (GL's origin is lower-left), so the rows are flipped to
 * top-to-bottom to match the WebGPU convention. The public entry is the
 * `WebGLRenderer.readRenderTargetPixels` method; this is the free-function impl it delegates to
 * (mirroring `readBufferAsync`).
 */
import type { RenderTarget } from '../../core/render-target';
import { type GlRenderTargetsState } from './render-target';
import { type GlTexturesState } from './textures';
/**
 * Read a RenderTarget color attachment back to a tightly-packed, top-to-bottom RGBA8 `Uint8Array`
 * (length `width * height * 4`), matching the WebGPU `readPixels` output. The target's color format
 * must be `rgba8unorm` / `rgba8unorm-srgb` (WebGL2 has no BGRA render format). `attachmentIndex`
 * selects an MRT color attachment; `layer` selects a cube face (0..5). Throws if the target has not
 * been rendered to yet.
 */
export declare function readRenderTargetPixels(gl: WebGL2RenderingContext, state: GlRenderTargetsState, textures: GlTexturesState, renderTarget: RenderTarget, attachmentIndex?: number, layer?: number): Uint8Array;
