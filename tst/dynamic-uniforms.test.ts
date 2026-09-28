/// <reference types="@webgpu/types" />

import { beforeAll, expect, test } from 'vitest';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

beforeAll(() => {
    installWebGPUPolyfills();
});

import { PerspectiveCamera } from '../src/camera/perspective-camera';
import { createRenderTarget } from '../src/core/render-target';
import { uniformGroup } from '../src/core/uniform';
import { createBoxGeometry } from '../src/geometry/geometry-helpers';
import { Material } from '../src/material/material';
import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    f32,
    modelWorldMatrix,
    mul,
    type Node,
    Uniform,
    UniformNode,
    vec4,
} from '../src/nodes/nodes';
import { Mesh } from '../src/objects/mesh';
import { bundle } from '../src/renderer/core/bundle';
import { frame } from '../src/renderer/core/frame';
import { Renderer } from '../src/renderer/core/renderer';
import { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import * as d from '../src/schema/schema';

async function setup() {
    const stub = createStubGPU();
    const renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));
    await renderer.init();

    const worldPosition = mul(modelWorldMatrix, vec4(attribute('position', d.vec3f), f32(1)));
    const box = new Mesh(
        createBoxGeometry(1, 1, 1),
        new Material({ vertex: mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPosition)), fragment: vec4(0, 0, 1, 1) }),
    );
    box.updateWorldMatrix();
    const camera = new PerspectiveCamera(Math.PI / 4, 1, 0.1, 100);
    const target = createRenderTarget(64, 64, { colorFormat: 'rgba8unorm' });
    const dynamicUniforms = () => renderer.backend.buffers.dynamicUniforms;
    return { stub, renderer, box, camera, target, dynamicUniforms };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function placeCamera(camera: PerspectiveCamera, x: number): void {
    camera.position[0] = x;
    camera.position[2] = 3;
    camera.updateWorldMatrix();
    camera.updateViewMatrix();
}

/** `passes` passes into one target, the one camera moved before each by `step`: 0 keeps it still. */
function recordPasses(ctx: Setup, passes: number, step: number) {
    const f = frame(ctx.renderer);
    for (let index = 0; index < passes; index++) {
        placeCamera(ctx.camera, index * step);
        const pass = f.pass({ target: ctx.target, camera: ctx.camera, clear: index === 0 ? [0, 0, 0, 1] : false });
        pass.draw(ctx.box);
        pass.end();
    }
    return f;
}

function renderPasses(ctx: Setup, passes: number, step: number): void {
    recordPasses(ctx, passes, step).submit();
}

/** Lets a resolved `mapAsync` hand its staging buffer back, as the browser's event loop would. */
const turnEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('a use after an earlier pass read different bytes takes a dynamic allocation, still in one submit', async () => {
    const ctx = await setup();
    renderPasses(ctx, 1, 0);
    ctx.stub.stats.reset();

    renderPasses(ctx, 3, 1);

    // The camera block conflicts in the second and third passes; the box's own block never changes.
    expect(ctx.renderer.info.buffers.dynamicAllocations).toBe(2);
    expect(ctx.stub.stats.submits).toBe(1);
    expect(ctx.stub.stats.encoderCreations, 'the frame encoder, and the uniform copies ahead of it').toBe(2);
    expect(ctx.stub.stats.bufferCopies).toBe(1);
});

test('passes that read the same bytes share the block buffer: no allocation and no copies', async () => {
    const ctx = await setup();
    renderPasses(ctx, 1, 0);
    ctx.stub.stats.reset();

    renderPasses(ctx, 3, 0);

    expect(ctx.renderer.info.buffers.dynamicAllocations).toBe(0);
    expect(ctx.stub.stats.encoderCreations).toBe(1);
    expect(ctx.stub.stats.bufferCopies).toBe(0);
});

test('allocations past one dynamic buffer move to another', async () => {
    const ctx = await setup();

    // A camera block is one 256-byte slot, so 100 KB holds 400: this frame needs two buffers.
    renderPasses(ctx, 450, 0.01);

    expect(ctx.renderer.info.buffers.dynamicAllocations).toBe(449);
    expect(ctx.dynamicUniforms().gpuBuffers.length).toBe(2);
    expect(ctx.stub.stats.bufferCopies).toBe(2);
});

test('a staging buffer returns once remapped, so steady frames stop creating them', async () => {
    const ctx = await setup();

    for (let index = 0; index < 5; index++) {
        renderPasses(ctx, 2, 1);
        await turnEventLoop();
    }

    expect(ctx.dynamicUniforms().mappedStagingCount).toBe(1);
    expect(ctx.dynamicUniforms().cpuStagingCount).toBe(0);
});

test('frames submitted back to back in one task stop at the staging cap and upload through CPU copies', async () => {
    const ctx = await setup();

    for (let index = 0; index < 19; index++) renderPasses(ctx, 2, 1);
    ctx.stub.stats.reset();
    renderPasses(ctx, 2, 1);

    // No map can resolve inside one task, so the cap is reached and held.
    expect(ctx.dynamicUniforms().mappedStagingCount).toBe(8);
    // A CPU copy is free again the moment its submit writes it, so one serves every frame after the cap.
    expect(ctx.dynamicUniforms().cpuStagingCount).toBe(1);
    expect(ctx.stub.stats.bufferCopies).toBe(0);
    expect(ctx.stub.stats.bufferWrites).toBe(1);
});

test('a discarded frame gives its buffers back unsubmitted', async () => {
    const ctx = await setup();

    recordPasses(ctx, 3, 1).abandon();

    const buffers = ctx.dynamicUniforms();
    expect(buffers.active).toBeNull();
    expect(buffers.usedBuffers.length).toBe(0);
    expect(buffers.gpuBuffers.length).toBe(1);
    expect(buffers.stagingBuffers.length, 'still mapped, so ready for the next frame').toBe(1);
    expect(ctx.stub.stats.submits).toBe(0);
});

test('dispose destroys every dynamic uniform buffer and staging buffer', async () => {
    const ctx = await setup();
    renderPasses(ctx, 3, 1);
    await turnEventLoop();
    const buffers = ctx.dynamicUniforms();
    const owned = buffers.gpuBuffers.length + buffers.stagingBuffers.length;
    expect(owned).toBe(2);
    ctx.stub.stats.reset();

    ctx.renderer.dispose();

    expect(buffers.destroyed).toBe(true);
    expect(ctx.stub.stats.bufferDestroys).toBeGreaterThanOrEqual(owned);
});

test('a bundle replayed in two passes of one moved camera keeps a recording for each, re-recording only for a new pass', async () => {
    const ctx = await setup();
    const encoder = bundle('box');
    encoder.draw(ctx.box);
    const boxBundle = encoder.finish();

    const run = (passes: number) => {
        const f = frame(ctx.renderer);
        for (let index = 0; index < passes; index++) {
            placeCamera(ctx.camera, index);
            const pass = f.pass({ target: ctx.target, camera: ctx.camera, clear: index === 0 ? [0, 0, 0, 1] : false });
            pass.execute(boxBundle);
            pass.end();
        }
        f.submit();
    };

    run(2);
    expect(ctx.stub.stats.bundleRecordings, 'one per replay, since each binds different bytes').toBe(2);

    ctx.stub.stats.reset();
    run(2);
    run(2);
    expect(ctx.stub.stats.bundleRecordings, 'the same passes in the same order bind the same allocations').toBe(0);

    ctx.stub.stats.reset();
    run(3);
    expect(ctx.stub.stats.bundleRecordings, 'only the new third replay records').toBe(1);
});

test('a pipeline binding more changing uniform groups than the device allows is refused by name', async () => {
    const ctx = await setup();
    const limit = ctx.stub.device.limits.maxDynamicUniformBuffersPerPipelineLayout;

    // One group per uniform, each able to change between draws, one past the limit.
    let colour: Node<d.f32> = f32(0);
    for (let index = 0; index <= limit; index++) {
        const group = uniformGroup(`perDraw${index}`, index + 1, 'object');
        colour = colour.add(new UniformNode(new Uniform(d.f32, 0, group), `perDrawValue${index}`)) as Node<d.f32>;
    }
    const worldPosition = mul(modelWorldMatrix, vec4(attribute('position', d.vec3f), f32(1)));
    const material = new Material({
        vertex: mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPosition)),
        fragment: vec4(colour, f32(0), f32(0), f32(1)),
    });
    material.name = 'too-many-groups';
    const mesh = new Mesh(createBoxGeometry(1, 1, 1), material);
    mesh.updateWorldMatrix();
    placeCamera(ctx.camera, 0);

    const f = frame(ctx.renderer);
    const pass = f.pass({ target: ctx.target, camera: ctx.camera });
    expect(() => pass.draw(mesh)).toThrow(/'too-many-groups' binds \d+ uniform groups/);
});
