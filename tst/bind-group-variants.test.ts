/// <reference types="@webgpu/types" />

import { beforeAll, expect, test } from 'vitest';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

beforeAll(() => {
    installWebGPUPolyfills();
});

import { GpuBuffer } from '../src/core/gpu-buffer';
import { Fn, globalId, index, storage, u32 } from '../src/nodes/nodes';
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

/** Past the most sets a bind group keeps, the least recently bound is the one let go of. */
test('only the most recently bound sets are kept', async () => {
    const { stub, renderer, node, buffer } = await make();
    const views = Array.from({ length: 9 }, buffer);
    await dispatchEach(renderer, node, views);

    // the first was let go of to make room for the ninth; the ninth is still kept
    stub.stats.reset();
    await dispatchEach(renderer, node, [views[8]!]);
    expect(stub.stats.bindGroupCreations).toBe(0);
    await dispatchEach(renderer, node, [views[0]!]);
    expect(stub.stats.bindGroupCreations).toBe(1);
});
