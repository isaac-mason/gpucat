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
import { getBindings } from '../src/renderer/core/render-object';
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
test('a disposed texture clears the bind groups of every group that bound it', async () => {
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
    expect(groups.every((group) => group.current !== null)).toBe(true);
    source.dispose();
    expect(groups.every((group) => group.current === null && group.needsUpdate)).toBe(true);
});

/** Draws over one texture and sampler, two materials, three meshes: one textured, one fullscreen draw per material. */
function texturedScene() {
    const source = createRenderTarget(32, 32, { colorFormat: 'rgba8unorm' });
    const flat = source.texture!._gpuTexture as unknown as GpuTexture<d.texture2d<d.TextureSampleType>>;
    const sampler = new GpuSampler({});
    const sampled = () => fullscreen(texture(flat, sampler).sample(vec2(f32(0.5), f32(0.5))));
    const meshes = [sampled(), sampled(), sampled()];
    for (const mesh of meshes) mesh.updateWorldMatrix();
    return meshes;
}

async function drawFrame(renderer: Renderer<WebGPUBackend>, meshes: ReturnType<typeof texturedScene>) {
    const target = createRenderTarget(64, 64, { colorFormat: 'rgba8unorm' });
    const f = frame(renderer);
    const pass = f.pass({ target });
    for (const mesh of meshes) pass.draw(mesh);
    pass.end();
    f.submit();
    await f.done;
}

/** The material's group is keyed by what it binds, not by who binds it: three materials over one texture share one. */
test('materials binding the same texture and sampler share one bind group for them', async () => {
    const { renderer } = await make();
    const meshes = texturedScene();
    await drawFrame(renderer, meshes);
    const textureGroups = new Set(
        meshes.map((mesh) => {
            const bindings = getBindings([...renderer._renderObjects.renderObjects].find((ro) => ro.mesh === mesh)!);
            const group = bindings.find((g) => g.bindings.some((binding) => binding.kind === 'texture'))!;
            return renderer.backend.bindings.data.get(group)!.current;
        }),
    );
    expect(textureGroups.size).toBe(1);
});

/** Once a scene's resources are bound, a frame makes no bind group: what Babylon's created counter should read. */
test('a static scene creates no bind group after its first frame, and counts what it holds', async () => {
    const { renderer } = await make();
    const meshes = texturedScene();
    await drawFrame(renderer, meshes);
    const firstCreated = renderer.info.state.created;
    await drawFrame(renderer, meshes);
    expect(firstCreated).toBeGreaterThan(0);
    expect(renderer.info.state.created).toBe(0);
    expect(renderer.info.state.held).toBeGreaterThan(0);
});

/** An entry lives exactly as long as what it binds and its layout: no number of frames unused drops it, as Godot's
 *  uniform-set cache keeps a set until something it depends on is freed. */
test('an entry nothing binds for 600 frames is still there, and binding it again builds nothing', async () => {
    const { stub, renderer, node, buffer } = await make();
    const kept = buffer();
    const left = buffer();
    await dispatchEach(renderer, node, [kept, left]);
    const held = renderer.backend.bindGroupCache.groups.size;
    for (let i = 0; i < 600; i++) await dispatchEach(renderer, node, [kept]);
    expect(renderer.backend.bindGroupCache.groups.size).toBe(held);

    stub.stats.reset();
    await dispatchEach(renderer, node, [left]);
    expect(stub.stats.bindGroupCreations).toBe(0);
});

test('an entry goes with a buffer it binds', async () => {
    const { renderer, node, buffer } = await make();
    const kept = buffer();
    const left = buffer();
    await dispatchEach(renderer, node, [kept, left]);
    const held = renderer.backend.bindGroupCache.groups.size;
    left.dispose();
    expect(renderer.backend.bindGroupCache.groups.size).toBe(held - 1);
});

/** A disposed node's pipeline and groups let go of their layouts, and the entries over a layout go with its last holder,
 *  though the buffers they bound live on. */
test('a compute node disposed takes its layouts and every entry over them, its buffers still alive', async () => {
    const { renderer, node, buffer } = await make();
    const layoutsBefore = renderer.backend.bindGroupLayoutCache.held.size;
    const groupsBefore = renderer.backend.bindGroupCache.groups.size;
    const views = [buffer(), buffer()];
    await dispatchEach(renderer, node, views);
    expect(renderer.backend.bindGroupCache.groups.size).toBeGreaterThan(groupsBefore);

    node.dispose();
    expect(renderer.backend.bindGroupCache.groups.size).toBe(groupsBefore);
    expect(renderer.backend.bindGroupLayoutCache.held.size).toBe(layoutsBefore);
});

test('materials disposed while the texture they sample lives leave no layout or bind group of theirs', async () => {
    const { renderer } = await make();
    const layoutsBefore = renderer.backend.bindGroupLayoutCache.held.size;
    const groupsBefore = renderer.backend.bindGroupCache.groups.size;
    const meshes = texturedScene();
    await drawFrame(renderer, meshes);
    expect(renderer.backend.bindGroupCache.groups.size).toBeGreaterThan(groupsBefore);

    for (const mesh of meshes) mesh.material.dispose();
    expect(renderer.backend.bindGroupCache.groups.size).toBe(groupsBefore);
    expect(renderer.backend.bindGroupLayoutCache.held.size).toBe(layoutsBefore);
});
