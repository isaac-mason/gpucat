/// <reference types="@webgpu/types" />

import { beforeAll, expect, test, vi } from 'vitest';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

beforeAll(() => {
    installWebGPUPolyfills();
});

import { PerspectiveCamera } from '../src/camera/perspective-camera';
import { createRenderTarget, type RenderTarget } from '../src/core/render-target';
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
import { frame } from '../src/renderer/core/frame';
import type { UniformBinding } from '../src/renderer/core/bind-group';
import type { RenderObject } from '../src/renderer/core/render-object';
import { Renderer } from '../src/renderer/core/renderer';
import { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import * as d from '../src/schema/schema';

const geometry = createBoxGeometry(1, 1, 1);
const clip = mul(
    cameraProjectionMatrix,
    mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(attribute('position', d.vec3f), f32(1)))),
);
const blue = vec4(0, 0, 1, 1) as Node<d.vec4f>;
const red = vec4(1, 0, 0, 1) as Node<d.vec4f>;

async function setup() {
    const renderer = new Renderer(new WebGPUBackend(createStubGPU().getRendererOptions()));
    await renderer.init();
    const camera = new PerspectiveCamera(Math.PI / 4, 1, 0.1, 100);
    camera.position[2] = 3;
    camera.updateWorldMatrix();
    camera.updateViewMatrix();
    const target = createRenderTarget(64, 64, { colorFormat: 'rgba8unorm' });
    return { renderer, camera, target };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function meshOf(material: Material): Mesh {
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.updateWorldMatrix();
    return mesh;
}

function render(ctx: Setup, meshes: Mesh[], target: RenderTarget = ctx.target): void {
    const f = frame(ctx.renderer);
    const pass = f.pass({ target, camera: ctx.camera });
    for (const mesh of meshes) pass.draw(mesh);
    pass.end();
    f.submit();
}

function renderObjectsOf(ctx: Setup, mesh: Mesh): RenderObject[] {
    return [...ctx.renderer._renderObjects.renderObjects].filter((renderObject) => renderObject.mesh === mesh);
}

const compiled = (ctx: Setup) => ctx.renderer._nodes.renderStates.size;

test('meshes drawing one material compile it once and share the result', async () => {
    const ctx = await setup();
    const material = new Material({ vertex: clip, fragment: blue });
    const meshes = Array.from({ length: 50 }, () => meshOf(material));

    render(ctx, meshes);

    expect(compiled(ctx)).toBe(1);
    const states = new Set(meshes.map((mesh) => renderObjectsOf(ctx, mesh)[0].nodeBuilderState));
    expect(states.size).toBe(1);
    expect(ctx.renderer._nodes.renderStates.values().next().value!.users).toBe(50);
});

test('each mesh still gets its own copy of the per-object bind groups', async () => {
    const ctx = await setup();
    const material = new Material({ vertex: clip, fragment: blue });
    const a = meshOf(material);
    const b = meshOf(material);

    render(ctx, [a, b]);

    const ownGroup = (mesh: Mesh) => renderObjectsOf(ctx, mesh)[0]._bindings!.find((group) => !group.shared)!;
    expect(ownGroup(a)).toBeDefined();
    expect(ownGroup(a)).not.toBe(ownGroup(b));
});

test('materials holding the same nodes share a compile whatever their render state', async () => {
    const ctx = await setup();
    const opaque = new Material({ vertex: clip, fragment: blue });
    const transparent = new Material({ vertex: clip, fragment: blue, transparent: true });

    render(ctx, [meshOf(opaque), meshOf(transparent)]);

    expect(compiled(ctx)).toBe(1);
});

test('materials with the same render state but different nodes do not', async () => {
    const ctx = await setup();
    const a = meshOf(new Material({ vertex: clip, fragment: blue }));
    const b = meshOf(new Material({ vertex: clip, fragment: red }));

    render(ctx, [a, b]);

    expect(compiled(ctx)).toBe(2);
    expect(renderObjectsOf(ctx, a)[0].nodeBuilderState!.vertexCode).not.toBe(
        renderObjectsOf(ctx, b)[0].nodeBuilderState!.vertexCode,
    );
});

test('one material drawn into two render contexts compiles for each', async () => {
    const ctx = await setup();
    const mesh = meshOf(new Material({ vertex: clip, fragment: blue }));

    render(ctx, [mesh]);
    render(ctx, [mesh], createRenderTarget(64, 64, { colorFormat: 'rgba16float' }));

    expect(compiled(ctx)).toBe(2);
});

test('needsUpdate recompiles, and the old compile goes once nothing holds it', async () => {
    const ctx = await setup();
    const material = new Material({ vertex: clip, fragment: blue });
    const meshes = [meshOf(material), meshOf(material)];
    render(ctx, meshes);
    const before = renderObjectsOf(ctx, meshes[0])[0].nodeBuilderState;

    material.needsUpdate = true;
    render(ctx, meshes);

    const after = renderObjectsOf(ctx, meshes[0])[0].nodeBuilderState;
    expect(after).not.toBe(before);
    expect(renderObjectsOf(ctx, meshes[1])[0].nodeBuilderState).toBe(after);
    expect(compiled(ctx)).toBe(1);
});

test('disposing the material releases its compile', async () => {
    const ctx = await setup();
    const kept = new Material({ vertex: clip, fragment: red });
    const disposed = new Material({ vertex: clip, fragment: blue });
    render(ctx, [meshOf(kept), meshOf(disposed), meshOf(disposed)]);
    expect(compiled(ctx)).toBe(2);

    disposed.dispose();

    expect(compiled(ctx)).toBe(1);
});

test('a recompile gives the RenderObject bind groups copied from the new compile, freeing the old ones', async () => {
    const ctx = await setup();
    const tint = new UniformNode(new Uniform(d.vec4f, [1, 0, 0, 1]), 'tint');
    const shade = new UniformNode(new Uniform(d.vec4f, [0, 1, 0, 1]), 'shade');
    const material = new Material({ vertex: clip, fragment: tint });
    const mesh = meshOf(material);
    render(ctx, [mesh]);

    const ownUniform = () => {
        const group = renderObjectsOf(ctx, mesh)[0]._bindings!.find((g) => !g.shared)!;
        return group.bindings[0] as UniformBinding;
    };
    const before = ownUniform();
    expect(before.block.members.map((m) => m.node.name)).toContain('tint');
    const release = vi.spyOn(ctx.renderer.backend, 'releaseUniformBlock');

    material.fragment = shade;
    material.needsUpdate = true;
    render(ctx, [mesh]);

    const names = ownUniform().block.members.map((m) => m.node.name);
    expect(names).toContain('shade');
    expect(names).not.toContain('tint');
    expect(release).toHaveBeenCalledWith(before.bufferKey);
});
