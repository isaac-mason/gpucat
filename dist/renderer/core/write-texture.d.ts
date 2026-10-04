import type { GpuTexture } from '../../core/gpu-texture';
import type { TextureRegionInit } from '../../core/texture-region';
import type { Renderer } from './renderer';
/** copies tightly packed `data` into one box of a `cpu: false` texture before returning; omitted region fields cover the rest of the level. */
export declare function writeTexture(renderer: Renderer, texture: GpuTexture, data: ArrayBufferView, region?: TextureRegionInit): void;
