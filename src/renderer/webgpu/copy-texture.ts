import type { GpuTexture } from '../../core/gpu-texture';
import type { TextureOrigin, TextureRegion } from '../../core/texture-region';
import { ensureRenderTargetTexturesAllocated } from './render-target';
import { getTextureData, type TextureCache, updateTexture } from './textures';

/** `copyTexture` for WebGPU: its own submission, so it lands after earlier queue writes and before later frames. */
export function copyTextureRegion(
    cache: TextureCache,
    device: GPUDevice,
    source: GpuTexture,
    region: TextureRegion,
    destination: GpuTexture,
    origin: TextureOrigin,
): void {
    const encoder = device.createCommandEncoder({ label: 'copyTexture' });
    encoder.copyTextureToTexture(
        {
            texture: copyEndpoint(cache, device, source),
            mipLevel: region.level,
            origin: { x: region.x, y: region.y, z: region.z },
        },
        {
            texture: copyEndpoint(cache, device, destination),
            mipLevel: origin.level,
            origin: { x: origin.x, y: origin.y, z: origin.z },
        },
        [region.width, region.height, region.depth],
    );
    device.queue.submit([encoder.finish()]);
}

/** the GPU texture behind either end of a copy: a render target's is allocated by its target, any other by its upload. */
function copyEndpoint(cache: TextureCache, device: GPUDevice, texture: GpuTexture): GPUTexture {
    if (!texture.isRenderTargetTexture) return updateTexture(cache, device, texture).texture;
    if (texture.renderTarget) ensureRenderTargetTexturesAllocated(cache, device, texture.renderTarget);
    const data = getTextureData(cache, texture);
    if (!data)
        throw new Error(`[webgpu] copyTexture: render target texture '${texture.label ?? 'unlabelled'}' has no GPU texture yet.`);
    return data.texture;
}
