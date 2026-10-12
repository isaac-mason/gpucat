import { GpuTexture } from '../../core/gpu-texture';
import { type TextureOriginInit, type TextureRegionInit } from '../../core/texture-region';
import type { Renderer } from './renderer';
/** either end of a copy: a `GpuTexture`, or a texture that wraps one, as a render target's does. */
export type CopyTextureEnd = GpuTexture | {
    readonly _gpuTexture: GpuTexture;
};
/**
 * copies one box of `source` into `destination` at `destinationOrigin`, on the GPU. Queued at once,
 * like `writeTexture`: after the writes before it, ahead of any frame not yet submitted. Omitted region
 * fields cover the rest of the source level; omitted origin fields are 0. `z` addresses array layers,
 * cube faces and 3D slices alike.
 *
 * Both textures hold the same uncompressed colour format, or the same one but for `-srgb`, single
 * sampled. The destination is one the GPU owns: `cpu: false`, a render target's, or a storage texture.
 */
export declare function copyTexture(renderer: Renderer, sourceTexture: CopyTextureEnd, destinationTexture: CopyTextureEnd, sourceRegion?: TextureRegionInit, destinationOrigin?: TextureOriginInit): void;
