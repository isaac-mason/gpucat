/// <reference types="@webgpu/types" />

import { beforeAll, expect, test } from 'vitest';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

beforeAll(() => {
    installWebGPUPolyfills();
});

import { GpuBuffer } from '../src/core/gpu-buffer';
import { GpuSampler } from '../src/core/gpu-sampler';
import type { GpuTexture } from '../src/core/gpu-texture';
import { createRenderTarget } from '../src/core/render-target';
import { Fn, f32, globalId, index, storage, texture, u32, vec2 } from '../src/nodes/nodes';
import { fullscreen } from '../src/objects/fullscreen';
import { frame } from '../src/renderer/core/frame';
import { Renderer } from '../src/renderer/core/renderer';
import { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import * as d from '../src/schema/schema';

async function make() {
    const stub = createStubGPU();
    const renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));
    await renderer.init();
    const node = Fn(() => {
        const out = storage('out', d.array(d.u32), 'read_write');
        index(out, globalId.x).assign(index(out, globalId.x).add(u32(1)));
    }).compute({ workgroupSize: [64, 1, 1] });
    const buffer = () => new GpuBuffer(d.u32, { data: new Uint32Array(64), usage: 'storage' });
    return { stub, renderer, node, buffer };
}

/** one frame dispatching `node` over each of `outs` in turn */
async function dispatchEach(
    renderer: Renderer<WebGPUBackend>,
    node: Awaited<ReturnType<typeof make>>['node'],
    outs: GpuBuffer<d.Any>[],
) {
    const f = frame(renderer);
    const pass = f.compute({ label: 'views' });
    for (const out of outs) pass.dispatch(node, [1, 1, 1], { buffers: { out } });
    pass.end();
    f.submit();
    await f.done;
}

/** One node dispatched over a few views' buffers, frame after frame, builds each view's bind group once. */
test('a compute node fed buffer sets in turn builds each set once', async () => {
    const { stub, renderer, node, buffer } = await make();
    const views = [buffer(), buffer(), buffer()];
    await dispatchEach(renderer, node, views);
    const firstFrame = stub.stats.bindGroupCreations;

    stub.stats.reset();
    for (let i = 0; i < 4; i++) await dispatchEach(renderer, node, views);
    expect(firstFrame).toBeGreaterThanOrEqual(3);
    expect(stub.stats.bindGroupCreations).toBe(0);
});

/** A reallocated buffer is a new GPU object, so its set builds again rather than binding the old one. */
test('a buffer that grows builds its set anew', async () => {
    const { stub, renderer, node, buffer } = await make();
    const view = buffer();
    await dispatchEach(renderer, node, [view]);

    stub.stats.reset();
    view.array = new Uint32Array(4096);
    view.needsUpdate = true;
    await dispatchEach(renderer, node, [view]);
    expect(stub.stats.bindGroupCreations).toBe(1);
});

/** Every set bound is kept, however many: past a fixed number, a node fed one more set would rebuild every frame. */
test('every resource set bound is kept', async () => {
    const { stub, renderer, node, buffer } = await make();
    const views = Array.from({ length: 12 }, buffer);
    await dispatchEach(renderer, node, views);

    stub.stats.reset();
    await dispatchEach(renderer, node, views);
    expect(stub.stats.bindGroupCreations).toBe(0);
});

/** A disposed texture's GPU texture is destroyed, so no group that bound it may keep a bind group over it. */
test('a disposed texture clears the variants of every group that bound it', async () => {
    const { renderer } = await make();
    const source = createRenderTarget(32, 32, { colorFormat: 'rgba8unorm' });
    // A render target's texture types as a cube-or-2d union; this one is 2d by construction.
    const flat = source.texture!._gpuTexture as unknown as GpuTexture<d.texture2d<d.TextureSampleType>>;
    const mesh = fullscreen(texture(flat, new GpuSampler({})).sample(vec2(f32(0.5), f32(0.5))));
    mesh.updateWorldMatrix();
    const target = createRenderTarget(64, 64, { colorFormat: 'rgba8unorm' });
    const f = frame(renderer);
    const pass = f.pass({ target });
    pass.draw(mesh);
    pass.end();
    f.submit();
    await f.done;

    const groups = [...(renderer.backend.textures.textureMap.get(flat)?.bindGroups ?? [])];
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((group) => group.variants.size > 0)).toBe(true);
    source.dispose();
    expect(groups.every((group) => group.variants.size === 0 && group.needsUpdate)).toBe(true);
});
