/// <reference types="@webgpu/types" />

import { beforeAll, describe, expect, test } from 'vitest';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

beforeAll(() => {
    installWebGPUPolyfills();
});

import { PerspectiveCamera } from '../src/camera/perspective-camera';
import { GpuBuffer } from '../src/core/gpu-buffer';
import { createRenderTarget } from '../src/core/render-target';
import { createBoxGeometry } from '../src/geometry/geometry-helpers';
import { InspectorBase } from '../src/inspector/inspector-base';
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
import { createCanvasTarget } from '../src/renderer/core/canvas-target';
import { frame } from '../src/renderer/core/frame';
import { Renderer } from '../src/renderer/core/renderer';
import { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import * as d from '../src/schema/schema';

function makeRenderer() {
    const stub = createStubGPU();
    const renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));
    return renderer.init().then(() => ({ stub, renderer, view: createCanvasTarget(stub.canvas) }));
}

const COUNT = 64;

function bumpNode() {
    return Fn(() => {
        const out = storage('out', d.array(d.u32), 'read_write');
        const slot = globalId.x.toVar('slot');
        index(out, slot).assign(index(out, slot).add(u32(1)));
    }).compute({ workgroupSize: [64, 1, 1] });
}

function outBuffer(): GpuBuffer<d.Any> {
    return new GpuBuffer(d.u32, { data: new Uint32Array(COUNT), usage: 'storage' });
}

function boxMesh(): Mesh {
    const position = attribute('position', d.vec3f);
    const clip = mul(cameraProjectionMatrix, mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(position, f32(1)))));
    const mesh = new Mesh(
        createBoxGeometry(1, 1, 1),
        new Material({ vertex: clip, fragment: vec4(f32(1), f32(0), f32(0), f32(1)) }),
    );
    mesh.updateWorldMatrix();
    return mesh;
}

function makeCamera(): PerspectiveCamera {
    const camera = new PerspectiveCamera(Math.PI / 4, 800 / 600, 0.1, 100);
    camera.position[2] = 5;
    camera.updateWorldMatrix();
    camera.updateViewMatrix();
    return camera;
}

describe('compute passes ride the frame encoder', () => {
    test('compute then render is one encoder and one submit', async () => {
        const { stub, renderer } = await makeRenderer();
        const out = outBuffer();

        stub.stats.reset();

        const f = frame(renderer);

        const c = f.compute({ label: 'bump' });
        c.dispatch(bumpNode(), [1, 1, 1], { buffers: { out } });
        c.end();

        const g = f.pass({ target: createRenderTarget(64, 64), camera: makeCamera() });
        g.draw(boxMesh());
        g.end();

        f.submit();

        expect(stub.stats.dispatches).toBe(1);
        expect(stub.stats.drawCalls).toBeGreaterThanOrEqual(1);
        expect(stub.stats.encoderCreations).toBe(1);
        expect(stub.stats.submits).toBe(1);
    });

    test('an indirect dispatch reads its counts from a buffer', async () => {
        const { stub, renderer } = await makeRenderer();
        const out = outBuffer();
        const counts = new GpuBuffer(d.u32, { data: new Uint32Array([1, 1, 1, 0]), usage: 'indirect' });

        stub.stats.reset();

        const f = frame(renderer);
        const c = f.compute();
        c.dispatchIndirect(bumpNode(), counts, { buffers: { out } });
        c.end();
        f.submit();

        expect(stub.stats.dispatches).toBe(1);
        expect(stub.stats.submits).toBe(1);
    });

    test('a compute pass cannot be opened while a render pass is open', async () => {
        const { renderer } = await makeRenderer();
        const f = frame(renderer);

        f.pass({ target: createRenderTarget(64, 64), camera: makeCamera(), label: 'main' });
        expect(() => f.compute()).toThrow(/"main" is still open/);
    });

    test('a rejected begin leaves the compute pool untouched', async () => {
        const { renderer } = await makeRenderer();
        const f = frame(renderer);

        f.pass({ target: createRenderTarget(64, 64), camera: makeCamera(), label: 'main' });
        expect(() => f.compute()).toThrow();

        expect(f.computePool.length).toBe(0);
        expect(f.computePoolIndex).toBe(0);
    });

    test('compute passes are pooled across frames', async () => {
        const { renderer } = await makeRenderer();
        const out = outBuffer();
        const node = bumpNode();

        for (let i = 0; i < 3; i++) {
            const f = frame(renderer);
            const c = f.compute();
            c.dispatch(node, [1, 1, 1], { buffers: { out } });
            c.end();
            f.submit();
            expect(f.computePool.length).toBe(1);
        }
    });
});

describe('a batch shares one GPU compute pass', () => {
    test('three dispatches of one node are one pass and one setPipeline', async () => {
        const { stub, renderer } = await makeRenderer();
        const out = outBuffer();
        const node = bumpNode();

        stub.stats.reset();

        const f = frame(renderer);
        const c = f.compute({ label: 'bump' });
        for (let i = 0; i < 3; i++) c.dispatch(node, [1, 1, 1], { buffers: { out } });
        c.end();
        f.submit();

        expect(stub.stats.dispatches).toBe(3);
        expect(stub.stats.computePasses).toBe(1);
        expect(stub.stats.computeSetPipelines).toBe(1);
    });

    test('distinct nodes in one pass each set their pipeline once', async () => {
        const { stub, renderer } = await makeRenderer();
        const out = outBuffer();

        stub.stats.reset();

        const f = frame(renderer);
        const c = f.compute();
        c.dispatch(bumpNode(), [1, 1, 1], { buffers: { out } });
        c.dispatch(bumpNode(), [1, 1, 1], { buffers: { out } });
        c.end();
        f.submit();

        expect(stub.stats.computePasses).toBe(1);
        expect(stub.stats.computeSetPipelines).toBe(2);
    });

    test('an attached inspector splits the batch one pass per dispatch', async () => {
        const { stub, renderer } = await makeRenderer();
        const out = outBuffer();
        const node = bumpNode();
        renderer.inspector = new InspectorBase();

        stub.stats.reset();

        const f = frame(renderer);
        const c = f.compute();
        for (let i = 0; i < 3; i++) c.dispatch(node, [1, 1, 1], { buffers: { out } });
        c.end();
        f.submit();

        expect(stub.stats.dispatches).toBe(3);
        expect(stub.stats.computePasses).toBe(3);
    });
});

describe('transform feedback is the WebGL2 mirror of a compute pass', () => {
    test('opening one on a webgpu frame is refused, as compute is on webgl', async () => {
        const { renderer } = await makeRenderer();
        const f = frame(renderer);
        expect(() => f.transformFeedback()).toThrow(/WebGL2-only/);
    });

    test('it cannot open while another pass is open, which is what kept it out of the frame', async () => {
        const { renderer, view } = await makeRenderer();
        const f = frame(renderer);
        const pass = f.pass({ target: view, camera: makeCamera() });
        expect(() => f.transformFeedback()).toThrow(/is still open/);
        pass.end();
        f.submit();
    });
});
