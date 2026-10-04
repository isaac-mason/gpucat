import type { GpuTexture } from '../../core/gpu-texture';
import type { TextureRegionInit } from '../../core/texture-region';
import type { Renderer } from './renderer';
/**
 * Writes `data` into one box of a `cpu: false` texture, copying it before returning, so the caller may reuse,
 * transfer or drop it straight away. `data` holds exactly the box, tightly packed: rows of `width` texels, then
 * `height` rows per layer. Omitted region fields default to the whole level at its origin; `z` addresses array
 * layers, cube faces and 3D slices alike, as in `addUpdateRegion`. A box outside the level throws rather than
 * being clamped, since the data would no longer line up with it.
 *
 * The texture's GPU storage is created zeroed by the first write or binding. Like any upload, a write made while a
 * frame is being recorded is seen by that whole frame on WebGPU, and by the work recorded after it on WebGL.
 */
export declare function writeTexture(renderer: Renderer, texture: GpuTexture, data: ArrayBufferView, region?: TextureRegionInit): void;
