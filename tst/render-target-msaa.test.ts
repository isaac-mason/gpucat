import { test, expect } from 'vitest';
import { installWebGPUPolyfills } from './stub-gpu';
import { RenderTarget } from '../src/index';
import {
    createTextureCache,
    ensureRenderTargetTexturesAllocated,
    getTextureData,
    getRenderTargetMsaaView,
} from '../src/renderer/textures';

// RenderTarget construction + allocation reference GPUTextureUsage (a browser global).
installWebGPUPolyfills();

/**
 * Minimal device that echoes each createTexture descriptor back as the texture,
 * so the allocator's size/format/sampleCount/usage choices are observable.
 */
function recordingDevice() {
    const created: GPUTextureDescriptor[] = [];
    const device = {
        createTexture(desc: GPUTextureDescriptor): GPUTexture {
            created.push(desc);
            const size = desc.size as number[];
            return {
                width: size[0],
                height: size[1],
                depthOrArrayLayers: size[2] ?? 1,
                format: desc.format,
                sampleCount: desc.sampleCount ?? 1,
                mipLevelCount: desc.mipLevelCount ?? 1,
                usage: desc.usage,
                createView: () => ({}) as GPUTextureView,
                destroy: () => {},
            } as unknown as GPUTexture;
        },
    } as unknown as GPUDevice;
    return { device, created };
}

test('non-MSAA render target allocates a single single-sample color texture, no MSAA sibling', () => {
    const { device, created } = recordingDevice();
    const cache = createTextureCache();
    const rt = new RenderTarget(64, 32); // samples defaults to 1

    ensureRenderTargetTexturesAllocated(cache, device, rt);

    const colorData = getTextureData(cache, rt.textures[0]._gpuTexture)!;
    expect(colorData.texture.sampleCount).toBe(1);
    expect(colorData.msaaTexture ?? null).toBeNull();
    expect(getRenderTargetMsaaView(colorData)).toBeNull();

    // color (resolve) + depth, nothing else
    expect(created).toHaveLength(2);
});

test('MSAA render target allocates a single-sample resolve texture plus a multisampled sibling', () => {
    const { device, created } = recordingDevice();
    const cache = createTextureCache();
    const rt = new RenderTarget(64, 32, { samples: 4 });

    ensureRenderTargetTexturesAllocated(cache, device, rt);

    const colorData = getTextureData(cache, rt.textures[0]._gpuTexture)!;

    // The cached/sampled texture is the single-sample resolve target.
    expect(colorData.texture.sampleCount).toBe(1);
    expect(colorData.texture.usage & GPUTextureUsage.TEXTURE_BINDING).toBeTruthy();

    // The MSAA sibling is multisampled and render-attachment only.
    expect(colorData.msaaTexture).toBeTruthy();
    expect(colorData.msaaTexture!.sampleCount).toBe(4);
    expect(colorData.msaaTexture!.usage).toBe(GPUTextureUsage.RENDER_ATTACHMENT);
    expect(getRenderTargetMsaaView(colorData)).not.toBeNull();

    // Depth stays at the pass sample count so all attachments match.
    const depthData = getTextureData(cache, rt.depthTexture!._gpuTexture)!;
    expect(depthData.texture.sampleCount).toBe(4);

    // resolve color + MSAA color + depth
    expect(created).toHaveLength(3);
});

test('depth-only render target (count: 0) is allocated once and is idempotent', () => {
    const { device, created } = recordingDevice();
    const cache = createTextureCache();
    const rt = new RenderTarget(1024, 1024, { count: 0, depthFormat: 'depth32float' });

    expect(rt.textures).toHaveLength(0);
    expect(rt.depthTexture).not.toBeNull();

    ensureRenderTargetTexturesAllocated(cache, device, rt);
    expect(created).toHaveLength(1); // depth only

    const depthData = getTextureData(cache, rt.depthTexture!._gpuTexture)!;
    const gen = depthData.generation;
    const tex = depthData.texture;

    // Re-ensuring (e.g. at shadow-sample bind time) must NOT reallocate/destroy the depth.
    ensureRenderTargetTexturesAllocated(cache, device, rt);
    ensureRenderTargetTexturesAllocated(cache, device, rt);

    expect(created).toHaveLength(1);
    expect(depthData.generation).toBe(gen);
    expect(depthData.texture).toBe(tex);
});

test('allocation is idempotent: a second ensure call creates no new textures', () => {
    const { device, created } = recordingDevice();
    const cache = createTextureCache();
    const rt = new RenderTarget(64, 32, { samples: 4 });

    ensureRenderTargetTexturesAllocated(cache, device, rt);
    const countAfterFirst = created.length;
    ensureRenderTargetTexturesAllocated(cache, device, rt);

    expect(created.length).toBe(countAfterFirst);
});

test('resizing reallocates and bumps generation so sampling bind groups rebuild', () => {
    const { device, created } = recordingDevice();
    const cache = createTextureCache();
    const rt = new RenderTarget(64, 32, { samples: 4 });

    ensureRenderTargetTexturesAllocated(cache, device, rt);
    const genBefore = getTextureData(cache, rt.textures[0]._gpuTexture)!.generation;
    const countAfterFirst = created.length;

    rt.setSize(128, 64);
    ensureRenderTargetTexturesAllocated(cache, device, rt);

    const data = getTextureData(cache, rt.textures[0]._gpuTexture)!;
    expect(data.texture.width).toBe(128);
    expect(data.msaaTexture!.width).toBe(128);
    expect(data.generation).toBeGreaterThan(genBefore);
    expect(created.length).toBeGreaterThan(countAfterFirst);
});
