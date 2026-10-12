import type { GpuTexture } from '../../core/gpu-texture';
import type { TextureOrigin, TextureRegion } from '../../core/texture-region';
import { type TextureCache } from './textures';
/**
 * `copyTexture` for WebGL2: the source level and layer attach to a read framebuffer, and
 * `copyTexSubImage` reads the box out of it into the destination. A 2D render-target texture is
 * rendered bottom-up while every other texture holds row 0 at the top, so between one of each the
 * rows go across one at a time, reversed.
 */
export declare function copyTextureRegion(gl: WebGL2RenderingContext, state: TextureCache, source: GpuTexture, region: TextureRegion, destination: GpuTexture, origin: TextureOrigin): void;
