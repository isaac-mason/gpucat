import type { GpuTexture } from '../../core/gpu-texture';
import type { TextureRegion, TextureRegionInit } from '../../core/texture-region';
import type { Renderer } from './renderer';
import { bytesPerTexel } from './texture-size';

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
export function writeTexture(
    renderer: Renderer,
    texture: GpuTexture,
    data: ArrayBufferView,
    region: TextureRegionInit = {},
): void {
    renderer._assertInitialized('writeTexture');
    const what = `[writeTexture] texture '${texture.label ?? 'unlabelled'}'`;
    if (texture.cpu) {
        throw new Error(`${what} keeps a CPU source; update the source and queue a region instead, or make it \`cpu: false\`.`);
    }
    if (texture.disposed) throw new Error(`${what} is disposed.`);

    const level = region.level ?? 0;
    if (level < 0 || level >= texture.mipLevelCount) {
        throw new Error(`${what}: level ${level} is outside its ${texture.mipLevelCount} mip levels.`);
    }
    const levelWidth = Math.max(1, texture.width >> level);
    const levelHeight = Math.max(1, texture.height >> level);
    // slices shrink down a 3D chain; array layers and cube faces do not
    const levelDepth = texture.dimension === '3d' ? Math.max(1, texture.depthOrArrayLayers >> level) : texture.depthOrArrayLayers;
    const x = region.x ?? 0;
    const y = region.y ?? 0;
    const z = region.z ?? 0;
    const box: TextureRegion = {
        x,
        y,
        z,
        width: region.width ?? levelWidth - x,
        height: region.height ?? levelHeight - y,
        depth: region.depth ?? levelDepth - z,
        level,
    };
    if (
        x < 0 ||
        y < 0 ||
        z < 0 ||
        box.width <= 0 ||
        box.height <= 0 ||
        box.depth <= 0 ||
        x + box.width > levelWidth ||
        y + box.height > levelHeight ||
        z + box.depth > levelDepth
    ) {
        throw new Error(
            `${what}: box at (${x}, ${y}, ${z}) of ${box.width}x${box.height}x${box.depth} is not inside level ${level}, ` +
                `${levelWidth}x${levelHeight}x${levelDepth}.`,
        );
    }
    const byteSize = box.width * box.height * box.depth * bytesPerTexel(texture.format);
    if (data.byteLength !== byteSize) {
        throw new Error(`${what}: the box takes ${byteSize} bytes of ${texture.format}, but the data is ${data.byteLength}.`);
    }
    renderer.backend.writeTexture(texture, box, data);
}
