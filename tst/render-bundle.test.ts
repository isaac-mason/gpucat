/// <reference types="@webgpu/types" />

import { beforeAll, expect, test } from 'vitest';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

beforeAll(() => {
    installWebGPUPolyfills();
});

import { PerspectiveCamera } from '../src/camera/perspective-camera';
import { createRenderTarget } from '../src/core/render-target';
import { createBoxGeometry } from '../src/geometry/geometry-helpers';
import { Material } from '../src/material/material';
import { attribute, cameraProjectionMatrix, cameraViewMatrix, f32, modelWorldMatrix, mul, vec4 } from '../src/nodes/nodes';
import { Mesh } from '../src/objects/mesh';
import { bundle } from '../src/renderer/core/bundle';
import { frame, type RenderBundle } from '../src/renderer/core/frame';
import { Renderer } from '../src/renderer/core/renderer';
import { getDrawArenaStats } from '../src/renderer/webgpu/draw-arena';
import { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import * as d from '../src/schema/schema';

/**
 * Two things have to hold at once: a replay reaches the device as the same draws in the same order
 * as drawing directly, and the recording that produces it happens once rather than per frame.
 */
async function scene() {
    const stub = createStubGPU();
    const renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));
    await renderer.init();

    const position = attribute('position', d.vec3f);
    const clip = mul(cameraProjectionMatrix, mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(position, f32(1)))));
    const mesh = () => {
        const m = new Mesh(createBoxGeometry(1, 1, 1), new Material({ vertex: clip, fragment: vec4(1, 0, 0, 1) }));
        m.updateWorldMatrix();
        return m;
    };

    const camera = new PerspectiveCamera(Math.PI / 4, 1, 0.1, 100);
    camera.position[2] = 5;
    camera.updateWorldMatrix();
    camera.updateViewMatrix();

    // A camera-less pass can only draw a material whose vertex stage reads no camera matrix.
    const flatMesh = () => {
        const m = new Mesh(
            createBoxGeometry(1, 1, 1),
            new Material({ vertex: vec4(position, f32(1)), fragment: vec4(1, 0, 0, 1) }),
        );
        m.updateWorldMatrix();
        return m;
    };

    return { stub, renderer, mesh, flatMesh, camera, target: createRenderTarget(64, 64) };
}

test('replaying a bundle issues the same draws as recording them directly', async () => {
    const { stub, renderer, mesh, camera, target } = await scene();
    const a = mesh();
    const b = mesh();

    stub.stats.reset();
    const direct = frame(renderer);
    const p1 = direct.pass({ target, camera });
    p1.draw(a);
    p1.draw(b);
    p1.end();
    direct.submit();
    const directDraws = stub.stats.drawCalls;
    expect(directDraws).toBe(2);

    const encoder = bundle({ camera, label: 'pair' });
    encoder.draw(a);
    encoder.draw(b);
    const pair = encoder.finish();

    stub.stats.reset();
    const replayed = frame(renderer);
    const p2 = replayed.pass({ target, camera });
    p2.execute(pair);
    p2.end();
    replayed.submit();

    expect(stub.stats.drawCalls).toBe(directDraws);
});

test('a bundle interleaves with direct draws, in the order recorded', async () => {
    const { stub, renderer, mesh, camera, target } = await scene();

    const encoder = bundle({ camera });
    encoder.draw(mesh());
    const one = encoder.finish();

    stub.stats.reset();
    const f = frame(renderer);
    const pass = f.pass({ target, camera });
    pass.draw(mesh());
    pass.execute(one);
    pass.draw(mesh());
    pass.end();
    f.submit();

    expect(stub.stats.drawCalls).toBe(3);
    // The direct draws either side stay out of the device bundle, which holds only its own.
    expect(stub.stats.bundleRecordings).toBe(1);
    expect(stub.stats.bundleExecutions).toBe(1);
});

test('a device bundle records once and replays on later frames', async () => {
    const { stub, renderer, mesh, camera, target } = await scene();

    const encoder = bundle({ camera, label: 'pair' });
    encoder.draw(mesh());
    encoder.draw(mesh());
    const pair = encoder.finish();

    const run = () => {
        const f = frame(renderer);
        const pass = f.pass({ target, camera });
        pass.execute(pair);
        pass.end();
        f.submit();
    };

    stub.stats.reset();
    run();
    expect(stub.stats.bundleRecordings).toBe(1);
    expect(stub.stats.drawCalls).toBe(2);
    expect(stub.stats.bundleExecutions).toBe(1);

    stub.stats.reset();
    run();
    expect(stub.stats.bundleRecordings).toBe(0);
    expect(stub.stats.drawCalls).toBe(0);
    expect(stub.stats.bundleExecutions).toBe(1);

    pair.invalidate();
    stub.stats.reset();
    run();
    expect(stub.stats.bundleRecordings).toBe(1);
    expect(stub.stats.drawCalls).toBe(2);
});

test('a pass with no camera can still record and reuse a bundle', async () => {
    const { stub, renderer, flatMesh, target } = await scene();

    const encoder = bundle({ label: 'cameraless' });
    encoder.draw(flatMesh());
    const one = encoder.finish();

    const run = () => {
        const f = frame(renderer);
        const pass = f.pass({ target });
        pass.execute(one);
        pass.end();
        f.submit();
    };

    stub.stats.reset();
    run();
    expect(stub.stats.bundleRecordings).toBe(1);
    expect(stub.stats.bundleExecutions).toBe(1);

    stub.stats.reset();
    run();
    expect(stub.stats.bundleRecordings).toBe(0);
    expect(stub.stats.bundleExecutions).toBe(1);
});

test('a bundle executed in a pass of another attachment layout throws, and still executes in its own', async () => {
    const { stub, renderer, flatMesh, target } = await scene();
    const other = createRenderTarget(64, 64, { colorFormat: 'rgba8unorm' });

    const encoder = bundle({ label: 'shared' });
    encoder.draw(flatMesh());
    const shared = encoder.finish();

    const run = (into: typeof target) => {
        const f = frame(renderer);
        const pass = f.pass({ target: into });
        pass.execute(shared);
        pass.end();
        f.submit();
    };

    stub.stats.reset();
    run(target);
    expect(() => run(other)).toThrow(/\[bundle shared\] recorded for attachments .* executed in a pass of /);
    run(target);
    expect(stub.stats.bundleRecordings).toBe(1);
});

test('drawing into a bundle after finish is refused', () => {
    const encoder = bundle({ label: 'closed' });
    encoder.finish();
    const stray = new Mesh(
        createBoxGeometry(1, 1, 1),
        new Material({ vertex: vec4(f32(0), f32(0), f32(0), f32(1)), fragment: vec4(1, 1, 1, 1) }),
    );
    expect(() => encoder.draw(stray)).toThrow(/after finish/);
});

test('executing a disposed bundle is refused by name, not silently empty', async () => {
    const { renderer, flatMesh, target } = await scene();

    const encoder = bundle({ label: 'scenery' });
    encoder.draw(flatMesh());
    const recorded = encoder.finish();
    recorded.dispose();

    const f = frame(renderer);
    const pass = f.pass({ target });
    expect(() => pass.execute(recorded)).toThrow(/\[bundle scenery\] execute after dispose\(\)/);
});

test('a bundle carries its label to the device objects recorded from it', async () => {
    const { stub, renderer, flatMesh, target } = await scene();

    const encoder = bundle({ label: 'named-props' });
    encoder.draw(flatMesh());
    const recorded = encoder.finish();

    const f = frame(renderer);
    const pass = f.pass({ target });
    pass.execute(recorded);
    pass.end();
    f.submit();

    expect(stub.stats.bundleLabels).toContain('named-props');
});

test('invalidate and dispose both move the version a recorded bundle compares against', () => {
    const encoder = bundle();
    const b = encoder.finish();

    expect(b.version).toBe(0);
    b.invalidate();
    expect(b.version).toBe(1);

    b.dispose();
    expect(b.count).toBe(0);
    expect(b.version).toBe(2);
});

/** One pass a frame, the bundle executed once in it. */
function runOnce(
    renderer: Awaited<ReturnType<typeof scene>>['renderer'],
    target: ReturnType<typeof createRenderTarget>,
    b: RenderBundle,
) {
    const f = frame(renderer);
    const pass = f.pass({ target });
    pass.execute(b);
    pass.end();
    f.submit();
}

function moveTo(camera: PerspectiveCamera, x: number): void {
    camera.position[0] = x;
    camera.updateWorldMatrix();
    camera.updateViewMatrix();
}

test('a bundle draws from its camera as it moves, recording once', async () => {
    const { stub, renderer, mesh, camera, target } = await scene();
    const encoder = bundle({ camera, label: 'moving' });
    encoder.draw(mesh());
    const moving = encoder.finish();

    runOnce(renderer, target, moving);
    stub.stats.reset();
    for (let i = 1; i <= 3; i++) {
        moveTo(camera, i);
        runOnce(renderer, target, moving);
    }
    expect(stub.stats.bundleRecordings).toBe(0);
    expect(stub.stats.bundleExecutions).toBe(3);
});

test('a bundle given another camera keeps its recording', async () => {
    const { stub, renderer, mesh, camera, target } = await scene();
    const encoder = bundle({ camera, label: 'swapped' });
    encoder.draw(mesh());
    const swapped = encoder.finish();
    runOnce(renderer, target, swapped);

    const other = new PerspectiveCamera(Math.PI / 3, 1, 0.1, 100);
    moveTo(other, 2);
    swapped.camera = other;
    stub.stats.reset();
    runOnce(renderer, target, swapped);
    expect(stub.stats.bundleRecordings).toBe(0);
});

test('a bundle executed twice in a frame draws both while its camera holds, and throws once it moved between', async () => {
    const { stub, renderer, mesh, camera, target } = await scene();
    const encoder = bundle({ camera, label: 'twice' });
    encoder.draw(mesh());
    const twice = encoder.finish();

    stub.stats.reset();
    const still = frame(renderer);
    for (let i = 0; i < 2; i++) {
        const pass = still.pass({ target, clear: i === 0 ? [0, 0, 0, 1] : false });
        pass.execute(twice);
        pass.end();
    }
    still.submit();
    expect(stub.stats.bundleExecutions).toBe(2);

    const moved = frame(renderer);
    const first = moved.pass({ target });
    first.execute(twice);
    first.end();
    moveTo(camera, 3);
    const second = moved.pass({ target, clear: false });
    expect(() => second.execute(twice)).toThrow(/\[bundle twice\] executed twice in one frame with different camera values/);
});

test('executing a bundle whose material was disposed throws, naming it', async () => {
    const { renderer, mesh, camera, target } = await scene();
    const box = mesh();
    box.material.name = 'crate';
    const encoder = bundle({ camera, label: 'props' });
    encoder.draw(box);
    const props = encoder.finish();
    runOnce(renderer, target, props);

    box.material.dispose();
    const f = frame(renderer);
    const pass = f.pass({ target });
    expect(() => pass.execute(props)).toThrow(/\[bundle props\] material 'crate' was disposed/);
});

test('a draw testing stencil against a reference other than 0 is refused when recorded', () => {
    const encoder = bundle({ label: 'masked' });
    const masked = new Mesh(
        createBoxGeometry(1, 1, 1),
        new Material({
            vertex: vec4(f32(0), f32(0), f32(0), f32(1)),
            fragment: vec4(1, 1, 1, 1),
            stencilTest: true,
            stencilRef: 1,
        }),
    );
    expect(() => encoder.draw(masked)).toThrow(/\[bundle masked\] .* reference 1, which a bundle cannot set/);
});

test('dispose releases the view slot the bundle held', async () => {
    const { renderer, mesh, camera, target } = await scene();
    const arena = () => getDrawArenaStats(renderer.backend.buffers.drawArena).slots;
    const encoder = bundle({ camera, label: 'released' });
    encoder.draw(mesh());
    const released = encoder.finish();
    runOnce(renderer, target, released);
    const held = arena();

    released.dispose();
    expect(arena()).toBe(held - 1);
    expect(renderer.backend.renderBundles.has(released)).toBe(false);
});
