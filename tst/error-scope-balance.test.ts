/// <reference types="@webgpu/types" />

import { beforeAll, expect, test } from 'vitest';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

beforeAll(() => {
    installWebGPUPolyfills();
});

import { PerspectiveCamera } from '../src/camera/perspective-camera';
import { GpuBuffer } from '../src/core/gpu-buffer';
import { createRenderTarget } from '../src/core/render-target';
import { Geometry } from '../src/geometry/geometry';
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
import { Renderer } from '../src/renderer/core/renderer';
import { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import * as d from '../src/schema/schema';
import { frame } from '../src/renderer/core/frame';

/**
 * WebGPU error scopes are a stack on the device. `encodePass` pushed one, then reached its
 * `popErrorScope` past three statements that can throw: prepare (which evaluates the node graph, so
 * a missing vertex buffer throws here by design), attachment resolution, and the draw encode. A
 * throw skipped the pop, leaving the scope pushed for the life of the device, so every later pop
 * returned the wrong pass's error.
 */
async function make(validation: 'device' | 'per-pass' = 'per-pass') {
    const stub = createStubGPU();
    const renderer = new Renderer(new WebGPUBackend({ ...stub.getRendererOptions(), validation }));
    await renderer.init();
    const camera = new PerspectiveCamera(Math.PI / 4, 1, 0.1, 100);
    camera.position[2] = 5;
    camera.updateWorldMatrix();
    camera.updateViewMatrix();
    return { stub, renderer, camera };
}

function material(): Material {
    const position = attribute('position', d.vec3f);
    const clip = mul(cameraProjectionMatrix, mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(position, f32(1)))));
    return new Material({ vertex: clip, fragment: vec4(f32(1), f32(0), f32(0), f32(1)) });
}

test('a frame of several passes leaves the error-scope stack where it found it', async () => {
    const { stub, renderer, camera } = await make();
    const mesh = new Mesh(createBoxGeometry(1, 1, 1), material());
    mesh.updateWorldMatrix();

    stub.stats.reset();
    const f = frame(renderer);
    for (let i = 0; i < 3; i++) {
        const pass = f.pass({ target: createRenderTarget(64, 64), camera });
        pass.draw(mesh);
        pass.end();
    }
    f.submit();
    await f.done;

    expect(stub.stats.errorScopeDepth).toBe(0);
});

/** A draw resolves when recorded, so a bad one throws at `draw()` and its pass stays open to end. */
test('a draw that throws while resolving leaves no scope behind once its pass ends', async () => {
    const { stub, renderer, camera } = await make();
    const mesh = new Mesh(new Geometry(), material());
    mesh.updateWorldMatrix();

    stub.stats.reset();
    const f = frame(renderer);
    const pass = f.pass({ target: createRenderTarget(64, 64), camera });
    expect(() => pass.draw(mesh)).toThrow();
    pass.end();
    f.submit();

    expect(stub.stats.errorScopeDepth).toBe(0);
});

test('a draw that throws while resolving leaves no scope behind once its frame is abandoned', async () => {
    const { stub, renderer, camera } = await make();
    const mesh = new Mesh(new Geometry(), material());
    mesh.updateWorldMatrix();

    stub.stats.reset();
    const f = frame(renderer);
    const pass = f.pass({ target: createRenderTarget(64, 64), camera });
    expect(() => pass.draw(mesh)).toThrow();
    f.abandon();

    expect(stub.stats.errorScopeDepth).toBe(0);
});

test('a compute pass scopes its own validation, and names itself when it fails', async () => {
    const { stub, renderer } = await make();
    const node = Fn(() => {
        const out = storage('out', d.array(d.u32), 'read_write');
        index(out, globalId.x).assign(index(out, globalId.x).add(u32(1)));
    }).compute({ workgroupSize: [64, 1, 1] });
    const out = new GpuBuffer(d.u32, { data: new Uint32Array(64), usage: 'storage' });

    stub.stats.reset();
    const f = frame(renderer);
    const pass = f.compute({ label: 'cull' });
    pass.dispatch(node, [1, 1, 1], { buffers: { out } });
    pass.end();
    f.submit();
    await f.done;

    expect(stub.stats.errorScopeDepth).toBe(0);
    expect(stub.stats.errorScopePushes).toBeGreaterThanOrEqual(2);
});

/** A dispatch resolves when recorded, so an unbound buffer throws at `dispatch()`; the pass still ends clean. */
test('a dispatch that throws while resolving leaves no scope behind once its pass ends', async () => {
    const { stub, renderer } = await make();
    const node = Fn(() => {
        const out = storage('out', d.array(d.u32), 'read_write');
        index(out, globalId.x).assign(index(out, globalId.x).add(u32(1)));
    }).compute({ workgroupSize: [64, 1, 1] });

    stub.stats.reset();
    const f = frame(renderer);
    const pass = f.compute({ label: 'unbound' });
    expect(() => pass.dispatch(node, [1, 1, 1])).toThrow(/'out' not found/);
    pass.end();
    f.submit();

    expect(stub.stats.errorScopeDepth).toBe(0);
});

/** A frame's worth of passes and a dispatch, to count what each validation mode does around them. */
async function drawAndDispatch(renderer: Renderer<WebGPUBackend>, camera: PerspectiveCamera): Promise<void> {
    const mesh = new Mesh(createBoxGeometry(1, 1, 1), material());
    mesh.updateWorldMatrix();
    const node = Fn(() => {
        const out = storage('out', d.array(d.u32), 'read_write');
        index(out, globalId.x).assign(index(out, globalId.x).add(u32(1)));
    }).compute({ workgroupSize: [64, 1, 1] });
    const out = new GpuBuffer(d.u32, { data: new Uint32Array(64), usage: 'storage' });
    const f = frame(renderer);
    const compute = f.compute({ label: 'cull' });
    compute.dispatch(node, [1, 1, 1], { buffers: { out } });
    compute.end();
    const pass = f.pass({ target: createRenderTarget(64, 64), camera });
    pass.draw(mesh);
    pass.end();
    f.submit();
    await f.done;
}

/** Validation heard from the device costs a frame nothing: no scope is opened around anything. */
test("'device' validation opens no error scopes", async () => {
    const { stub, renderer, camera } = await make('device');
    stub.stats.reset();
    await drawAndDispatch(renderer, camera);
    expect(stub.stats.errorScopePushes).toBe(0);
});

/** Each pass's scope settles and is let go of; none is held for a later `takeValidationErrors` that may never come. */
test("'per-pass' scopes are let go of once they settle", async () => {
    const { renderer, camera } = await make('per-pass');
    for (let i = 0; i < 3; i++) await drawAndDispatch(renderer, camera);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renderer.backend._pendingValidation.size).toBe(0);
});

/** An error the device raises on its own reaches `takeValidationErrors`, and only the newest are kept. */
test("'device' validation reports what the device raises, the newest 64", async () => {
    const { stub, renderer } = await make('device');
    stub.fireUncapturedError('a bad draw');
    expect(await renderer.backend.takeValidationErrors()).toEqual(['[WebGPU validation error] a bad draw']);

    for (let i = 0; i < 100; i++) stub.fireUncapturedError(`error ${i}`);
    const errors = await renderer.backend.takeValidationErrors();
    expect(errors.length).toBe(64);
    expect(errors.at(-1)).toBe('[WebGPU validation error] error 99');
});
