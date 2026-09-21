/// <reference types="@webgpu/types" />

import { beforeAll, expect, test } from 'vitest';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

beforeAll(() => {
    installWebGPUPolyfills();
});

import { GpuBuffer } from '../src/core/gpu-buffer';
import { Fn, globalId, index, storage, u32 } from '../src/nodes/nodes';
import { frame } from '../src/renderer/core/frame';
import { createRendererInfo } from '../src/renderer/core/info';
import { Renderer } from '../src/renderer/core/renderer';
import { getBindGroupLayoutCacheStats } from '../src/renderer/webgpu/bind-group-layout';
import { getBufferCacheStats } from '../src/renderer/webgpu/buffers';
import { getPipelineCacheStats } from '../src/renderer/webgpu/pipelines';
import { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import * as d from '../src/schema/schema';

/**
 * Layer 6.84 rerouted `readMemoryStats` from cache fields to each owning module's stats function, and
 * nothing covered it either way. A dispatch runs first so the caches are non-empty: against an idle
 * stub every count is zero and the comparison holds no matter where the numbers come from.
 */
async function dispatchedBackend(): Promise<WebGPUBackend> {
    const stub = createStubGPU();
    const renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));
    await renderer.init();

    const node = Fn(() => {
        const out = storage('out', d.array(d.u32), 'read_write');
        index(out, globalId.x).assign(index(out, globalId.x).add(u32(1)));
    }).compute({ workgroupSize: [64, 1, 1] });

    const f = frame(renderer);
    const pass = f.compute();
    pass.dispatch(node, [1, 1, 1], { buffers: { out: new GpuBuffer(d.u32, { data: new Uint32Array(64), usage: 'storage' }) } });
    pass.end();
    f.submit();
    return renderer.backend;
}

test('every WebGPU memory count matches what its owning module reports', async () => {
    const gpu = await dispatchedBackend();
    const memory = createRendererInfo().memory;
    gpu.readMemoryStats(memory);

    const buffers = getBufferCacheStats(gpu.buffers);
    const pipelines = getPipelineCacheStats(gpu.pipelines);
    const layouts = getBindGroupLayoutCacheStats(gpu.bindGroupLayoutCache);

    expect(buffers.bufferCount).toBeGreaterThan(0);
    expect(pipelines.computeCount).toBeGreaterThan(0);
    expect(layouts.layoutCount).toBeGreaterThan(0);

    expect(memory.buffers).toBe(buffers.bufferCount + buffers.rawCount);
    expect(memory.backend.rawBuffers).toBe(buffers.rawCount);
    expect(memory.backend.renderPipelines).toBe(pipelines.renderCount);
    expect(memory.backend.computePipelines).toBe(pipelines.computeCount);
    expect(memory.backend.bindGroupLayouts).toBe(layouts.layoutCount);
});
