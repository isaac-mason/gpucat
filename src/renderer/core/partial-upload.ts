/*
 * The backend-neutral half of the partial-texture-upload decision: which textures may take it, and
 * whether the pending regions are still worth uploading piecemeal.
 *
 * Both backends call these, deliberately. A region means the same thing on WebGPU and WebGL2 or it is
 * not an API, so the rule that decides it lives in exactly one place and cannot drift between them.
 */

import type { GpuTexture } from '../../core/gpu-texture';
import { regionTexelCount, type TextureRegion } from '../../core/texture-region';

/**
 * View dimensions that take the partial path. `z` addresses array layers and cube faces alike, so both
 * qualify; 3D volumes and 1D do not yet.
 */
export function supportsPartialUpload(texture: GpuTexture): boolean {
    const dim = texture.viewDimension;
    return dim === '2d' || dim === '2d-array' || dim === 'cube' || dim === 'cube-array';
}

function isTypedSourceData(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;
    return ArrayBuffer.isView((data as { data?: unknown }).data as ArrayBufferView);
}

/**
 * Whether every source the partial path would read is typed-array backed.
 *
 * The unpack window addresses rows inside a packed buffer, which a DOM element source (image, canvas,
 * video) does not have. Those must fall through to a full upload: skipping them instead would drop the
 * write silently, which is the failure mode this whole model exists to remove.
 */
export function hasTypedPartialSource(texture: GpuTexture): boolean {
    const ok = (source: { dataReady?: boolean; data?: unknown } | null | undefined): boolean =>
        !!source && source.dataReady !== false && isTypedSourceData(source.data);

    if (texture.mipmaps.length > 0 && !texture.mipmaps.every(ok)) return false;
    if (texture.sources.length > 0) return texture.sources.every(ok);
    return ok(texture.source);
}

/** Texels the emitters will actually move for `regions`. Both backends honour a region exactly. */
export function dirtyTexelCount(regions: readonly TextureRegion[]): number {
    let n = 0;
    for (const r of regions) n += regionTexelCount(r);
    return n;
}

/**
 * Whether the pending regions are worth a partial upload. Past half the texture, fewer and simpler
 * calls win: fall through to one full upload.
 */
export function withinPartialBudget(texture: GpuTexture, regions: readonly TextureRegion[]): boolean {
    const total = texture.width * texture.height * texture.depthOrArrayLayers;
    const dirty = dirtyTexelCount(regions);
    return dirty > 0 && dirty <= total / 2;
}
