/// <reference types="@webgpu/types" />

import { beforeAll, expect, test } from 'vitest';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

beforeAll(() => {
    installWebGPUPolyfills();
});

import { PerspectiveCamera } from '../src/camera/perspective-camera';
import { GpuBuffer } from '../src/core/gpu-buffer';
import { createBoxGeometry } from '../src/geometry/geometry-helpers';
import { Material } from '../src/material/material';
import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    Fn,
    f32,
    globalId,
    index,
    modelWorldMatrix,
    mul,
    storage,
    u32,
    vec4,
} from '../src/nodes/nodes';
import { Mesh } from '../src/objects/mesh';
import { bundle } from '../src/renderer/core/bundle';
import { createCanvasTarget } from '../src/renderer/core/canvas-target';
import { frame } from '../src/renderer/core/frame';
import { Renderer } from '../src/renderer/core/renderer';
import { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import * as d from '../src/schema/schema';

/**
 * `Frame`'s doc says it holds both pass pools for the life of the renderer so a steady-state frame
 * allocates nothing, which the plan's performance section leans on as the answer to the per-frame
 * allocation it introduces. Nothing checked it. Identity rather than heap size, so there is no GC
 * noise to average out.
 */
async function scene() {
    const stub = createStubGPU();
    const renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));
    await renderer.init();

    const position = attribute('position', d.vec3f);
    const clip = mul(cameraProjectionMatrix, mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(position, f32(1)))));
    const mesh = new Mesh(
        createBoxGeometry(1, 1, 1),
        new Material({ vertex: clip, fragment: vec4(f32(1), f32(0), f32(0), f32(1)) }),
    );
    mesh.updateWorldMatrix();

    const camera = new PerspectiveCamera(Math.PI / 4, 800 / 600, 0.1, 100);
    camera.position[2] = 5;
    camera.updateWorldMatrix();
    camera.updateViewMatrix();

    return { renderer, mesh, camera, view: createCanvasTarget(stub.canvas) };
}

function drawPasses(
    renderer: Renderer<WebGPUBackend>,
    view: ReturnType<typeof createCanvasTarget>,
    mesh: Mesh,
    camera: PerspectiveCamera,
    passes: number,
    drawsPerPass: number,
) {
    const f = frame(renderer);
    for (let p = 0; p < passes; p++) {
        const pass = f.pass({ target: view, camera });
        for (let i = 0; i < drawsPerPass; i++) pass.draw(mesh);
        pass.end();
    }
    f.submit();
    return f;
}

test('a second frame reuses the first frame object and its pass objects', async () => {
    const { renderer, mesh, camera, view } = await scene();

    const first = drawPasses(renderer, view, mesh, camera, 2, 1);
    const firstPasses = [first.pool[0], first.pool[1]];
    expect(first.pool).toHaveLength(2);

    const second = drawPasses(renderer, view, mesh, camera, 2, 1);
    expect(second).toBe(first);
    expect(second.pool).toHaveLength(2);
    expect(second.pool[0]).toBe(firstPasses[0]);
    expect(second.pool[1]).toBe(firstPasses[1]);
});

test("a shorter frame reuses the longer one's draw slots rather than shrinking them", async () => {
    const { renderer, mesh, camera, view } = await scene();

    drawPasses(renderer, view, mesh, camera, 1, 4);
    const pass = frame(renderer).pool[0];
    const slots = pass.records;
    expect(slots).toHaveLength(4);
    const recorded = [slots[0], slots[1], slots[2], slots[3]];

    const short = drawPasses(renderer, view, mesh, camera, 1, 2);
    expect(short.pool[0].count).toBe(2);
    expect(short.pool[0].records).toHaveLength(4);
    expect(short.pool[0].records[0]).toBe(recorded[0]);
    expect(short.pool[0].records[1]).toBe(recorded[1]);
});

test('the pass pool grows to the deepest frame and stays there', async () => {
    const { renderer, mesh, camera, view } = await scene();

    drawPasses(renderer, view, mesh, camera, 1, 1);
    drawPasses(renderer, view, mesh, camera, 3, 1);
    const deep = frame(renderer);
    expect(deep.pool).toHaveLength(3);

    drawPasses(renderer, view, mesh, camera, 1, 1);
    expect(frame(renderer).pool).toHaveLength(3);
});

test('compute passes pool the same way, dispatch slots included', async () => {
    const { renderer } = await scene();
    const node = Fn(() => {
        const out = storage('out', d.array(d.u32), 'read_write');
        index(out, globalId.x).assign(index(out, globalId.x).add(u32(1)));
    }).compute({ workgroupSize: [64, 1, 1] });
    const out = new GpuBuffer(d.u32, { data: new Uint32Array(64), usage: 'storage' });

    const first = frame(renderer);
    const wide = first.compute();
    wide.dispatch(node, [1, 1, 1], { buffers: { out } });
    wide.dispatch(node, [2, 1, 1], { buffers: { out } });
    wide.end();
    first.submit();

    const pooled = first.computePool[0];
    const slots = [pooled.records[0], pooled.records[1]];
    expect(pooled.records).toHaveLength(2);

    const second = frame(renderer);
    const narrow = second.compute();
    narrow.dispatch(node, [1, 1, 1], { buffers: { out } });
    narrow.end();
    second.submit();

    expect(narrow).toBe(pooled);
    expect(narrow.count).toBe(1);
    expect(narrow.records).toHaveLength(2);
    expect(narrow.records[0]).toBe(slots[0]);
    expect(narrow.records[1]).toBe(slots[1]);
});

/**
 * A bundle entry joins `Pass.records` at the `kind` discriminant, and pooling mutates records in
 * place. A reused slot must therefore still read as a draw, or the encode loop would take the wrong
 * branch for an entry that was a bundle last frame.
 */
test('a reused draw slot still reads as a draw', async () => {
    const { renderer, mesh, camera, view } = await scene();

    drawPasses(renderer, view, mesh, camera, 1, 3);
    const long = frame(renderer).pool[0];
    expect(long.records.every((r) => r.kind === 'draw')).toBe(true);

    const short = drawPasses(renderer, view, mesh, camera, 1, 1);
    expect(short.pool[0].records.every((r) => r.kind === 'draw')).toBe(true);
});

/** A `PassEntry` slot is a union, so a pooled draw slot has no bundle fields to overwrite and vice versa. */
test('a frame whose passes hold bundles pools its record slots too', async () => {
    const { renderer, mesh, camera, view } = await scene();

    const encoder = bundle('pooled');
    encoder.draw(mesh);
    const recorded = encoder.finish();

    const run = () => {
        const f = frame(renderer);
        const pass = f.pass({ target: view, camera });
        pass.draw(mesh);
        pass.execute(recorded);
        pass.draw(mesh);
        pass.end();
        f.submit();
        return f;
    };

    const first = run();
    const slots = [first.pool[0].records[0], first.pool[0].records[1], first.pool[0].records[2]];
    expect(slots.map((entry) => entry?.kind)).toEqual(['draw', 'bundle', 'draw']);

    const second = run();
    expect(second.pool[0].records[0]).toBe(slots[0]);
    expect(second.pool[0].records[1]).toBe(slots[1]);
    expect(second.pool[0].records[2]).toBe(slots[2]);
});

/** The segments array is pooled beside the prepared arrays, so a bundled frame reuses it as well. */
test('the prepared-segment pool is reused across frames', async () => {
    const { renderer, mesh, camera, view } = await scene();

    const encoder = bundle('segmented');
    encoder.draw(mesh);
    const recorded = encoder.finish();

    const run = () => {
        const f = frame(renderer);
        const pass = f.pass({ target: view, camera });
        pass.draw(mesh);
        pass.execute(recorded);
        pass.end();
        f.submit();
    };

    const segmentsAtDepth0 = () =>
        (renderer.backend as unknown as { _frame: { segmentsByDepth: unknown[][] } })._frame.segmentsByDepth[0];

    run();
    const segments = segmentsAtDepth0();
    // One run for the direct draw, one for the bundle that follows it.
    expect(segments).toHaveLength(2);
    run();
    expect(segmentsAtDepth0()).toBe(segments);
});
