import type { RenderTarget } from '../core/render-target';
import { getTextureData } from './textures';
import type { WebGPURenderer } from './renderer';

/**
 * Read pixels from a RenderTarget color attachment back to a tightly-packed Uint8Array.
 *
 * The target's color format must be a 4-byte format (`rgba8unorm`, `bgra8unorm`,
 * `rgba8unorm-srgb`, `bgra8unorm-srgb`). For HDR formats like `rgba16float`,
 * render through `renderOutput()` into an `rgba8unorm` RenderTarget first.
 *
 * Returns rows top-to-bottom, RGBA (or BGRA) order, length = width * height * 4.
 * Must be called after `render()` has populated the target.
 */
export async function readPixels(
    renderer: WebGPURenderer,
    renderTarget: RenderTarget,
    attachmentIndex = 0,
): Promise<Uint8Array> {
    const tex = renderTarget.textures[attachmentIndex];
    if (!tex) {
        throw new Error(`[readPixels] no color attachment at index ${attachmentIndex}.`);
    }
    const fmt = tex.format;
    if (
        fmt !== 'rgba8unorm' &&
        fmt !== 'bgra8unorm' &&
        fmt !== 'rgba8unorm-srgb' &&
        fmt !== 'bgra8unorm-srgb'
    ) {
        throw new Error(
            `[readPixels] unsupported attachment format '${fmt}' at index ${attachmentIndex}. Render through an rgba8unorm RenderTarget first.`,
        );
    }

    const textureData = getTextureData(renderer._textures, tex._gpuTexture);
    if (!textureData) {
        throw new Error('[readPixels] render target has not been rendered to yet.');
    }

    const { width, height } = renderTarget;
    const bytesPerPixel = 4;
    // copyTextureToBuffer requires bytesPerRow to be a multiple of 256.
    const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256;
    const bufferSize = bytesPerRow * height;

    const device = renderer._device;
    const stagingBuffer = device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
        { texture: textureData.texture },
        { buffer: stagingBuffer, bytesPerRow, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish()]);

    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(stagingBuffer.getMappedRange());

    const tightlyPacked = new Uint8Array(width * height * bytesPerPixel);
    const rowBytes = width * bytesPerPixel;
    for (let row = 0; row < height; row++) {
        tightlyPacked.set(
            padded.subarray(row * bytesPerRow, row * bytesPerRow + rowBytes),
            row * rowBytes,
        );
    }

    stagingBuffer.unmap();
    stagingBuffer.destroy();

    return tightlyPacked;
}
