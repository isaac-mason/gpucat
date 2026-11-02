import { expect, test } from 'vitest';
import { createRenderTarget } from '../src/index';
import { CanvasTarget } from '../src/renderer/core/canvas-target';
import { createMemoryTally } from '../src/renderer/core/info';
import { estimatedBytesPerTexel } from '../src/renderer/core/texture-size';
import { attachmentsFor, createSwapchainState } from '../src/renderer/webgpu/render-pass';
import { WHOLE_TEXTURE } from '../src/core/gpu-texture-view';
import {
    ensureRenderTargetTexturesAllocated,
    getRenderTargetMsaaView,
    getRenderTargetView,
} from '../src/renderer/webgpu/render-target';
import { attachmentView, createTextureCache, getTextureData, rangeView } from '../src/renderer/webgpu/textures';
import { installWebGPUPolyfills } from './stub-gpu';

// RenderTarget construction + allocation reference GPUTextureUsage (a browser global).
installWebGPUPolyfills();

/**
 * Minimal device that echoes each createTexture descriptor back as the texture,
 * so the allocator's size/format/sampleCount/usage choices are observable, and
 * records each createView descriptor in `views`.
 */
function recordingDevice() {
    const created: GPUTextureDescriptor[] = [];
    const views: GPUTextureViewDescriptor[] = [];
    const device = {
        createTexture(desc: GPUTextureDescriptor): GPUTexture {
            created.push(desc);
            const size = desc.size as number[];
            return {
                width: size[0],
                height: size[1],
                depthOrArrayLayers: size[2] ?? 1,
                dimension: desc.dimension ?? '2d',
                format: desc.format,
                sampleCount: desc.sampleCount ?? 1,
                mipLevelCount: desc.mipLevelCount ?? 1,
                usage: desc.usage,
                createView: (viewDesc?: GPUTextureViewDescriptor) => {
                    views.push(viewDesc ?? {});
                    return {} as GPUTextureView;
                },
                destroy: () => {},
            } as unknown as GPUTexture;
        },
    } as unknown as GPUDevice;
    return { device, created, views };
}

test('non-MSAA render target allocates a single single-sample color texture, no MSAA sibling', () => {
    const { device, created } = recordingDevice();
    const cache = createTextureCache(createMemoryTally());
    const rt = createRenderTarget(64, 32); // samples defaults to 1

    ensureRenderTargetTexturesAllocated(cache, device, rt);

    const colorData = getTextureData(cache, rt.textures[0]._gpuTexture)!;
    expect(colorData.texture.sampleCount).toBe(1);
    expect(colorData.msaaTextures ?? null).toBeNull();
    expect(getRenderTargetMsaaView(colorData, 0)).toBeNull();

    // color (resolve) + depth, nothing else
    expect(created).toHaveLength(2);
});

test('MSAA render target allocates a single-sample resolve texture plus a multisampled sibling', () => {
    const { device, created } = recordingDevice();
    const cache = createTextureCache(createMemoryTally());
    const rt = createRenderTarget(64, 32, { samples: 4 });

    ensureRenderTargetTexturesAllocated(cache, device, rt);

    const colorData = getTextureData(cache, rt.textures[0]._gpuTexture)!;

    // The cached/sampled texture is the single-sample resolve target.
    expect(colorData.texture.sampleCount).toBe(1);
    expect(colorData.texture.usage & GPUTextureUsage.TEXTURE_BINDING).toBeTruthy();

    // The MSAA sibling is multisampled and render-attachment only: one for the target's one layer.
    expect(colorData.msaaTextures).toHaveLength(1);
    expect(colorData.msaaTextures![0]!.sampleCount).toBe(4);
    expect(colorData.msaaTextures![0]!.usage).toBe(GPUTextureUsage.RENDER_ATTACHMENT);
    expect(getRenderTargetMsaaView(colorData, 0)).not.toBeNull();

    // Depth stays at the pass sample count so all attachments match.
    const depthData = getTextureData(cache, rt._depthAttachment!._gpuTexture)!;
    expect(depthData.texture.sampleCount).toBe(4);

    // resolve color + MSAA color + depth
    expect(created).toHaveLength(3);
});

test('a render target tallies its resolve texture, MSAA sibling and multisampled depth, and a resize moves the bytes', () => {
    const { device } = recordingDevice();
    const tally = createMemoryTally();
    const cache = createTextureCache(tally);
    const rt = createRenderTarget(64, 32, { samples: 4 });

    ensureRenderTargetTexturesAllocated(cache, device, rt);
    const texels = 64 * 32;
    const color = estimatedBytesPerTexel(rt.textures[0]!.format);
    const depth = estimatedBytesPerTexel(rt._depthAttachment!.format);
    expect(tally.byCategory.get('texture/render-target')).toBe(texels * color);
    expect(tally.byCategory.get('texture/msaa')).toBe(texels * color * 4);
    expect(tally.byCategory.get('texture/depth')).toBe(texels * depth * 4);
    expect(tally.textures).toBe(3);

    rt.setSize(128, 64);
    ensureRenderTargetTexturesAllocated(cache, device, rt);
    expect(tally.textures).toBe(3);
    expect(tally.texturesSize).toBe(4 * (texels * color + texels * color * 4 + texels * depth * 4));
});

test('a storage target allocates an sRGB colour in its linear twin with storage usage, and draws and samples it sRGB', () => {
    const { device, created, views } = recordingDevice();
    const cache = createTextureCache(createMemoryTally());
    const rt = createRenderTarget(16, 16, { colorFormat: 'rgba8unorm-srgb', storage: true });

    ensureRenderTargetTexturesAllocated(cache, device, rt);

    const [colour, depth] = created;
    expect(colour!.format).toBe('rgba8unorm');
    expect(colour!.usage & GPUTextureUsage.STORAGE_BINDING).toBeTruthy();
    expect(colour!.viewFormats).toEqual(['rgba8unorm-srgb']);
    // depth is never a storage texture
    expect(depth!.usage & GPUTextureUsage.STORAGE_BINDING).toBeFalsy();

    // the sRGB views drop storage, which the sRGB format can't take
    const drawnAndSampled = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const data = getTextureData(cache, rt.textures[0]!._gpuTexture)!;
    expect(data.viewFormat).toBe('rgba8unorm-srgb');
    getRenderTargetView(data);
    attachmentView(data, 0, 0, false);
    rangeView(data, WHOLE_TEXTURE, '2d', false);
    for (const view of views) {
        expect(view.format).toBe('rgba8unorm-srgb');
        expect(view.usage).toBe(drawnAndSampled);
    }
    expect(views).toHaveLength(3);

    // a storage binding takes the allocation's own format and every usage
    views.length = 0;
    rangeView(data, WHOLE_TEXTURE, '2d', false, true);
    expect(views[0]!.format).toBeUndefined();
    expect(views[0]!.usage).toBeUndefined();
});

test('a linear storage target is allocated in its own format with storage usage, its views in that format', () => {
    const { device, created } = recordingDevice();
    const cache = createTextureCache(createMemoryTally());
    const rt = createRenderTarget(16, 16, { colorFormat: 'rgba16float', storage: true, depthBuffer: false });

    ensureRenderTargetTexturesAllocated(cache, device, rt);

    expect(created[0]!.format).toBe('rgba16float');
    expect(created[0]!.usage & GPUTextureUsage.STORAGE_BINDING).toBeTruthy();
    expect(created[0]!.viewFormats).toEqual([]);
    expect(getTextureData(cache, rt.textures[0]!._gpuTexture)!.viewFormat).toBeUndefined();
});

test('a target without storage has no storage usage', () => {
    const { device, created } = recordingDevice();
    const cache = createTextureCache(createMemoryTally());
    const rt = createRenderTarget(16, 16, { colorFormat: 'rgba8unorm-srgb', depthBuffer: false });

    ensureRenderTargetTexturesAllocated(cache, device, rt);

    expect(created[0]!.format).toBe('rgba8unorm-srgb');
    expect(created[0]!.usage & GPUTextureUsage.STORAGE_BINDING).toBeFalsy();
});

test('a storage target is single-sampled', () => {
    expect(() => createRenderTarget(16, 16, { storage: true, samples: 4 })).toThrow(/storage render target is single-sampled/);
});

test('depth-only render target (count: 0) is allocated once and is idempotent', () => {
    const { device, created } = recordingDevice();
    const cache = createTextureCache(createMemoryTally());
    const rt = createRenderTarget(1024, 1024, { count: 0, depthFormat: 'depth32float' });

    expect(rt.textures).toHaveLength(0);
    expect(rt._depthAttachment).not.toBeNull();

    ensureRenderTargetTexturesAllocated(cache, device, rt);
    expect(created).toHaveLength(1); // depth only

    const depthData = getTextureData(cache, rt._depthAttachment!._gpuTexture)!;
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
    const cache = createTextureCache(createMemoryTally());
    const rt = createRenderTarget(64, 32, { samples: 4 });

    ensureRenderTargetTexturesAllocated(cache, device, rt);
    const countAfterFirst = created.length;
    ensureRenderTargetTexturesAllocated(cache, device, rt);

    expect(created.length).toBe(countAfterFirst);
});

test('resizing reallocates and bumps generation so sampling bind groups rebuild', () => {
    const { device, created } = recordingDevice();
    const cache = createTextureCache(createMemoryTally());
    const rt = createRenderTarget(64, 32, { samples: 4 });

    ensureRenderTargetTexturesAllocated(cache, device, rt);
    const genBefore = getTextureData(cache, rt.textures[0]._gpuTexture)!.generation;
    const countAfterFirst = created.length;

    rt.setSize(128, 64);
    ensureRenderTargetTexturesAllocated(cache, device, rt);

    const data = getTextureData(cache, rt.textures[0]._gpuTexture)!;
    expect(data.texture.width).toBe(128);
    expect(data.msaaTextures![0]!.width).toBe(128);
    expect(data.generation).toBeGreaterThan(genBefore);
    expect(created.length).toBeGreaterThan(countAfterFirst);
});

test('a labelled target files its attachments under its label without renaming them', () => {
    const { device } = recordingDevice();
    const tally = createMemoryTally();
    const cache = createTextureCache(tally);
    const rt = createRenderTarget(16, 16, { samples: 4, label: 'shadows' });

    ensureRenderTargetTexturesAllocated(cache, device, rt);
    expect([...tally.live].map((allocation) => allocation.label).sort()).toEqual([
        'shadows/depth',
        'shadows/output',
        'shadows/output',
    ]);
    // `mrt()` and shader bindings read the attachment names, which stay as they were
    expect(rt.textures[0]!.name).toBe('output');
    expect(rt.getTextureIndex('output')).toBe(0);
});

test("a canvas's own attachments are filed under its label, else as canvas", () => {
    const sc = createSwapchainState(createMemoryTally());
    const labelled = new CanvasTarget({ width: 8, height: 8 } as OffscreenCanvas, { label: 'stage/inventory' });
    const plain = new CanvasTarget({ width: 8, height: 8 } as OffscreenCanvas);
    expect(attachmentsFor(sc, labelled).depthAllocation.label).toBe('stage/inventory');
    expect(attachmentsFor(sc, plain).msaaAllocation.label).toBe('canvas');
});
