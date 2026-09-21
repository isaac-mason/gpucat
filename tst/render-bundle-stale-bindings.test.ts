/// <reference types="@webgpu/types" />

import { beforeAll, expect, test } from 'vitest';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

beforeAll(() => {
    installWebGPUPolyfills();
});

import { GpuSampler } from '../src/core/gpu-sampler';
import type { GpuTexture } from '../src/core/gpu-texture';
import { createRenderTarget } from '../src/core/render-target';
import { f32, texture, uniform, vec2, vec4 } from '../src/nodes/nodes';
import { fullscreen } from '../src/objects/fullscreen';
import { bundle } from '../src/renderer/core/bundle';
import { frame } from '../src/renderer/core/frame';
import { Renderer } from '../src/renderer/core/renderer';
import { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import type * as d from '../src/schema/schema';

/** A resize rebuilds the bind group the recording baked in, so the recording has to be thrown away. */
test('a resized render target re-records the bundle that samples it', async () => {
    const stub = createStubGPU();
    const renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));
    await renderer.init();

    const source = createRenderTarget(32, 32, { colorFormat: 'rgba8unorm' });
    // A render target's texture types as a cube-or-2d union; this one is 2d by construction.
    const flat = source.texture!._gpuTexture as unknown as GpuTexture<d.texture2d<d.TextureSampleType>>;
    const sampled = texture(flat, new GpuSampler({}));
    const mesh = fullscreen(sampled.sample(vec2(f32(0.5), f32(0.5))));
    mesh.updateWorldMatrix();

    const encoder = bundle('samples-target');
    encoder.draw(mesh);
    const recorded = encoder.finish();

    const target = createRenderTarget(64, 64, { colorFormat: 'rgba8unorm' });
    const run = () => {
        const f = frame(renderer);
        const pass = f.pass({ target });
        pass.execute(recorded);
        pass.end();
        f.submit();
    };

    run();
    stub.stats.reset();
    run();
    expect(stub.stats.bundleRecordings).toBe(0);

    source.setSize(64, 64);
    stub.stats.reset();
    run();
    expect(stub.stats.bundleRecordings).toBe(1);
});

/** Replay saves the encoding, not the per-draw update, so a changed uniform still has to reach the GPU. */
test('a bundled draw uploads a changed uniform exactly as the direct draw does', async () => {
    const stub = createStubGPU();
    const renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));
    await renderer.init();

    const tint = uniform(vec4(1, 0, 0, 1));
    const mesh = fullscreen(tint);
    mesh.updateWorldMatrix();
    const target = createRenderTarget(64, 64, { colorFormat: 'rgba8unorm' });

    const encoder = bundle('tinted');
    encoder.draw(mesh);
    const recorded = encoder.finish();

    const run = (replay: boolean) => {
        const f = frame(renderer);
        const pass = f.pass({ target });
        if (replay) pass.execute(recorded);
        else pass.draw(mesh);
        pass.end();
        f.submit();
    };
    const writesAfterChange = (replay: boolean, next: [number, number, number, number]) => {
        run(replay);
        run(replay);
        stub.stats.reset();
        (tint as unknown as { value: number[] }).value = next;
        run(replay);
        return stub.stats.bufferWrites;
    };

    const direct = writesAfterChange(false, [0, 1, 0, 1]);
    expect(direct).toBeGreaterThan(0);
    expect(writesAfterChange(true, [0, 0, 1, 1])).toBe(direct);
});
