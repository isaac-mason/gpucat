import { expect, test } from 'vitest';
import { createCubeRenderTarget, createRenderTarget } from '../src/index';
import { resolvePassParams } from '../src/renderer/core/pass-desc';
import { createPassParams } from '../src/renderer/core/render-types';
import { resolveAttachments } from '../src/renderer/webgpu/render-pass';
import { createTextureCache } from '../src/renderer/webgpu/textures';
import type { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import { installWebGPUPolyfills } from './stub-gpu';

installWebGPUPolyfills();

/** Echoes each descriptor back, so the attachment the resolver builds is observable without a device. */
function backend(): WebGPUBackend {
    const device = {
        createTexture(desc: GPUTextureDescriptor): GPUTexture {
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
    return { device, textures: createTextureCache() } as unknown as WebGPUBackend;
}

const loadOpFor = (target: Parameters<typeof resolvePassParams>[0]['target'], desc: Record<string, unknown>) =>
    resolveAttachments(backend(), resolvePassParams({ target, ...desc }, createPassParams())).colorAttachments[0]!.loadOp;

test('clear: false loads on a plain render target', () => {
    const plain = createRenderTarget(8, 8, { colorFormat: 'rgba8unorm' });
    expect(loadOpFor(plain, { clear: false })).toBe('load');
    expect(loadOpFor(plain, {})).toBe('clear');
});

/** Six faces composited by several passes each is the case `clear: false` exists for. */
test('clear: false loads on a cube face', () => {
    const cube = createCubeRenderTarget(8, { colorFormat: 'rgba8unorm' });
    expect(loadOpFor(cube, { clear: false, layer: 2 })).toBe('load');
    expect(loadOpFor(cube, { layer: 2 })).toBe('clear');
});

/** An MSAA render target stores its multisampled texture, so there is something to load. */
test('clear: false loads on an MSAA render target', () => {
    const msaa = createRenderTarget(8, 8, { colorFormat: 'rgba8unorm', samples: 4 });
    expect(loadOpFor(msaa, { clear: false })).toBe('load');
    expect(loadOpFor(msaa, {})).toBe('clear');
});
