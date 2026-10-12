import type { GpuTexture } from '../../core/gpu-texture';
import type { TextureOrigin, TextureRegion } from '../../core/texture-region';
import { type TextureCache } from './textures';
/** `copyTexture` for WebGPU: its own submission, so it lands after earlier queue writes and before later frames. */
export declare function copyTextureRegion(cache: TextureCache, device: GPUDevice, source: GpuTexture, region: TextureRegion, destination: GpuTexture, origin: TextureOrigin): void;
