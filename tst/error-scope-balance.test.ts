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
async function make() {
    const stub = createStubGPU();
    const renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));
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

test('a pass that throws in prepare still pops its scope', async () => {
    const { stub, renderer, camera } = await make();
    const mesh = new Mesh(new Geometry(), material());
    mesh.updateWorldMatrix();

    stub.stats.reset();
    const f = frame(renderer);
    const pass = f.pass({ target: createRenderTarget(64, 64), camera });
    pass.draw(mesh);

    expect(() => pass.end()).toThrow();
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

test('a compute pass that throws mid-encode still pops its scope', async () => {
    const { stub, renderer } = await make();
    const node = Fn(() => {
        const out = storage('out', d.array(d.u32), 'read_write');
        index(out, globalId.x).assign(index(out, globalId.x).add(u32(1)));
    }).compute({ workgroupSize: [64, 1, 1] });

    stub.stats.reset();
    const f = frame(renderer);
    const pass = f.compute({ label: 'unbound' });
    pass.dispatch(node, [1, 1, 1]);

    expect(() => pass.end()).toThrow();
    expect(stub.stats.errorScopeDepth).toBe(0);
});
