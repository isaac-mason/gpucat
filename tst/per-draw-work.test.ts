/// <reference types="@webgpu/types" />

import { beforeAll, expect, test } from 'vitest';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

beforeAll(() => {
    installWebGPUPolyfills();
});

import { PerspectiveCamera } from '../src/camera/perspective-camera';
import { GpuBuffer } from '../src/core/gpu-buffer';
import { createRenderTarget } from '../src/core/render-target';
import { createBoxGeometry } from '../src/geometry/geometry-helpers';
import { Material } from '../src/material/material';
import { compileWgsl } from '../src/nodes/builder';
import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    f32,
    modelWorldMatrix,
    mul,
    Uniform,
    UniformNode,
    vec4,
} from '../src/nodes/nodes';
import { Mesh } from '../src/objects/mesh';
import { frame } from '../src/renderer/core/frame';
import { Renderer } from '../src/renderer/core/renderer';
import { getUploaded } from '../src/renderer/webgpu/buffers';
import { getRenderObjectGpu } from '../src/renderer/webgpu/render-object-gpu';
import { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import * as d from '../src/schema/schema';

const clip = mul(
    cameraProjectionMatrix,
    mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(attribute('position', d.vec3f), f32(1)))),
);

test('a compile leaves uniforms out of its per-draw update nodes: their blocks run them', () => {
    const result = compileWgsl({ vertex: clip, fragment: vec4(1, 0, 0, 1) });

    expect(result.updateNodes.some((node) => node === (modelWorldMatrix as unknown))).toBe(false);
    const members = result.uniformGroups.flatMap((group) => group.members.map((member) => member.node));
    expect(members.some((node) => node === (modelWorldMatrix as unknown))).toBe(true);
});

async function setup() {
    const renderer = new Renderer(new WebGPUBackend(createStubGPU().getRendererOptions()));
    await renderer.init();
    const camera = new PerspectiveCamera(Math.PI / 4, 1, 0.1, 100);
    const target = createRenderTarget(64, 64, { colorFormat: 'rgba8unorm' });
    const render = (meshes: Mesh[]) => {
        const f = frame(renderer);
        const pass = f.pass({ target, camera });
        for (const mesh of meshes) pass.draw(mesh);
        pass.end();
        f.submit();
    };
    return { renderer, render };
}

test("a per-object uniform's callback runs once per draw", async () => {
    const { render } = await setup();

    let calls = 0;
    const tint = new UniformNode(new Uniform(d.vec4f, [1, 0, 0, 1]), 'tint').onObjectUpdate(() => {
        calls++;
        return [1, 0, 0, 1];
    });
    const material = new Material({ vertex: clip, fragment: tint });
    const meshes = [0, 1, 2].map(() => new Mesh(createBoxGeometry(1, 1, 1), material));

    render(meshes);

    expect(calls).toBe(3);
});

test('a draw keeps the vertex buffers it resolved until the geometry swaps one', async () => {
    const { renderer, render } = await setup();
    const mesh = new Mesh(createBoxGeometry(1, 1, 1), new Material({ vertex: clip, fragment: vec4(1, 0, 0, 1) }));
    render([mesh]);
    const gpu = () => getRenderObjectGpu(renderer.backend.renderObjectGpu, [...renderer._renderObjects.renderObjects][0]);
    const resolved = gpu().vertexBuffers;

    render([mesh]);
    expect(gpu().vertexBuffers, 'nothing moved, so the resolution holds').toBe(resolved);

    // The same format, so only the buffer set moves, not the pipeline's vertex layout.
    const old = mesh.geometry.getBuffer('position')!;
    const replacement = new GpuBuffer(d.vec3f, { data: new Float32Array(old.array!), usage: 'vertex' });
    mesh.geometry.setBuffer('position', replacement);
    render([mesh]);

    expect(gpu().vertexBuffers).toContain(replacement);
    expect(gpu().vertexBuffers).not.toContain(old);
    expect(getUploaded(renderer.backend.buffers, replacement)).toBeDefined();
});
