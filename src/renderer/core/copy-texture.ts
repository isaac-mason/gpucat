import { GpuTexture, TEXTURE_USAGE } from '../../core/gpu-texture';
import {
    levelExtent,
    type RegionExtent,
    type TextureOrigin,
    type TextureOriginInit,
    type TextureRegion,
    type TextureRegionInit,
} from '../../core/texture-region';
import type { Renderer } from './renderer';
import { isUncompressedColorFormat } from './texture-size';

/** either end of a copy: a `GpuTexture`, or a texture that wraps one, as a render target's does. */
export type CopyTextureEnd = GpuTexture | { readonly _gpuTexture: GpuTexture };

function gpuTextureOf(texture: CopyTextureEnd): GpuTexture {
    return texture instanceof GpuTexture ? texture : texture._gpuTexture;
}

/**
 * copies one box of `source` into `destination` at `destinationOrigin`, on the GPU. Queued at once,
 * like `writeTexture`: after the writes before it, ahead of any frame not yet submitted. Omitted region
 * fields cover the rest of the source level; omitted origin fields are 0. `z` addresses array layers,
 * cube faces and 3D slices alike.
 *
 * Both textures hold the same uncompressed colour format, or the same one but for `-srgb`, single
 * sampled. The destination is one the GPU owns: `cpu: false`, a render target's, or a storage texture.
 */
export function copyTexture(
    renderer: Renderer,
    sourceTexture: CopyTextureEnd,
    destinationTexture: CopyTextureEnd,
    sourceRegion: TextureRegionInit = {},
    destinationOrigin: TextureOriginInit = {},
): void {
    renderer._assertInitialized('copyTexture');
    const source = gpuTextureOf(sourceTexture);
    const destination = gpuTextureOf(destinationTexture);
    const what = `[copyTexture] '${source.label ?? 'unlabelled'}' into '${destination.label ?? 'unlabelled'}'`;
    if (source.disposed) throw new Error(`${what}: the source is disposed.`);
    if (destination.disposed) throw new Error(`${what}: the destination is disposed.`);
    if (!gpuOwned(destination)) {
        throw new Error(`${what}: the destination keeps a CPU source, which would upload over the copy; make it \`cpu: false\`.`);
    }
    if (copyFormat(source.format) !== copyFormat(destination.format)) {
        throw new Error(`${what}: '${source.format}' and '${destination.format}' are not the same format.`);
    }
    if (!isUncompressedColorFormat(source.format)) {
        throw new Error(`${what}: '${source.format}' is not an uncompressed colour format, which is all a copy takes.`);
    }
    if (source.sampleCount > 1 || destination.sampleCount > 1) {
        throw new Error(`${what}: multisampled textures copy only through a resolve.`);
    }
    if (!source.isRenderTargetTexture && (source.usage & TEXTURE_USAGE.COPY_SRC) === 0) {
        throw new Error(`${what}: the source's usage lacks COPY_SRC.`);
    }
    if (!destination.isRenderTargetTexture && (destination.usage & TEXTURE_USAGE.COPY_DST) === 0) {
        throw new Error(`${what}: the destination's usage lacks COPY_DST.`);
    }

    const sourceLevel = sourceRegion.level ?? 0;
    const destinationLevel = destinationOrigin.level ?? 0;
    if (sourceLevel < 0 || sourceLevel >= source.mipLevelCount) {
        throw new Error(`${what}: source level ${sourceLevel} is outside its ${source.mipLevelCount} mip levels.`);
    }
    if (destinationLevel < 0 || destinationLevel >= destination.mipLevelCount) {
        throw new Error(`${what}: destination level ${destinationLevel} is outside its ${destination.mipLevelCount} mip levels.`);
    }
    const sourceExtent = levelExtent(source, sourceLevel);
    const x = sourceRegion.x ?? 0;
    const y = sourceRegion.y ?? 0;
    const z = sourceRegion.z ?? 0;
    const box: TextureRegion = {
        x,
        y,
        z,
        width: sourceRegion.width ?? sourceExtent.width - x,
        height: sourceRegion.height ?? sourceExtent.height - y,
        depth: sourceRegion.depth ?? sourceExtent.depth - z,
        level: sourceLevel,
    };
    const origin: TextureOrigin = {
        x: destinationOrigin.x ?? 0,
        y: destinationOrigin.y ?? 0,
        z: destinationOrigin.z ?? 0,
        level: destinationLevel,
    };
    if (box.width <= 0 || box.height <= 0 || box.depth <= 0 || !fits(box, box, sourceExtent)) {
        throw new Error(
            `${what}: box at (${x}, ${y}, ${z}) of ${box.width}x${box.height}x${box.depth} is not inside source level ` +
                `${sourceLevel}, ${sourceExtent.width}x${sourceExtent.height}x${sourceExtent.depth}.`,
        );
    }
    const destinationExtent = levelExtent(destination, destinationLevel);
    if (!fits(origin, box, destinationExtent)) {
        throw new Error(
            `${what}: a ${box.width}x${box.height}x${box.depth} box at (${origin.x}, ${origin.y}, ${origin.z}) is not inside ` +
                `destination level ${destinationLevel}, ${destinationExtent.width}x${destinationExtent.height}x${destinationExtent.depth}.`,
        );
    }
    if (source === destination && sourceLevel === destinationLevel && overlaps(box, origin)) {
        throw new Error(`${what}: the boxes overlap within one level.`);
    }
    renderer.backend.copyTexture(source, box, destination, origin);
}

function gpuOwned(texture: GpuTexture): boolean {
    return !texture.cpu || texture.isRenderTargetTexture || texture.type.type.startsWith('texture_storage_');
}

/** formats that differ only in `-srgb` hold the same bytes, which is all a copy moves. */
function copyFormat(format: GPUTextureFormat): string {
    return format.endsWith('-srgb') ? format.slice(0, -'-srgb'.length) : format;
}

function fits(corner: { x: number; y: number; z: number }, box: TextureRegion, extent: RegionExtent): boolean {
    return (
        corner.x >= 0 &&
        corner.y >= 0 &&
        corner.z >= 0 &&
        corner.x + box.width <= extent.width &&
        corner.y + box.height <= extent.height &&
        corner.z + box.depth <= extent.depth
    );
}

function overlaps(box: TextureRegion, origin: TextureOrigin): boolean {
    return (
        box.x < origin.x + box.width &&
        origin.x < box.x + box.width &&
        box.y < origin.y + box.height &&
        origin.y < box.y + box.height &&
        box.z < origin.z + box.depth &&
        origin.z < box.z + box.depth
    );
}
