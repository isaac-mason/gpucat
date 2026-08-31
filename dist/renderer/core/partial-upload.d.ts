import type { GpuTexture } from '../../core/gpu-texture';
import { type TextureRegion } from '../../core/texture-region';
/**
 * View dimensions that take the partial path. `z` addresses array layers and cube faces alike, so both
 * qualify; 3D volumes and 1D do not yet.
 */
export declare function supportsPartialUpload(texture: GpuTexture): boolean;
/**
 * Whether every source the partial path would read is typed-array backed.
 *
 * The unpack window addresses rows inside a packed buffer, which a DOM element source (image, canvas,
 * video) does not have. Those must fall through to a full upload: skipping them instead would drop the
 * write silently, which is the failure mode this whole model exists to remove.
 */
export declare function hasTypedPartialSource(texture: GpuTexture): boolean;
/** Texels the emitters will actually move for `regions`. Both backends honour a region exactly. */
export declare function dirtyTexelCount(regions: readonly TextureRegion[]): number;
/**
 * Whether the pending regions are worth a partial upload. Past half the texture, fewer and simpler
 * calls win: fall through to one full upload.
 */
export declare function withinPartialBudget(texture: GpuTexture, regions: readonly TextureRegion[]): boolean;
