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
import { createBoxGeometry, createFullscreenTriangleGeometry } from '../src/geometry/geometry-helpers';
import { RendererInspector } from '../src/inspector/renderer-inspector';
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
    renderOutput,
    renderTexture,
    storage,
    u32,
    vec4,
} from '../src/nodes/nodes';
import { fullscreen } from '../src/objects/fullscreen';
import { Mesh } from '../src/objects/mesh';
import { bundle } from '../src/renderer/core/bundle';
import { createCanvasTarget } from '../src/renderer/core/canvas-target';
import { frame } from '../src/renderer/core/frame';
import { Renderer } from '../src/renderer/core/renderer';
import { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import { Scene } from '../src/scene/scene';
import * as d from '../src/schema/schema';

/**
 * An attached inspector sees the frame as it was asked for: every pass in call order, every call in
 * it, and what became of each, including the ones that never reach the GPU.
 */
async function setup() {
    const stub = createStubGPU();
    const renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));
    await renderer.init();
    const inspector = new RendererInspector();
    renderer.inspector = inspector;

    const camera = new PerspectiveCamera(Math.PI / 4, 1, 0.1, 100);
    camera.position[2] = 5;
    camera.updateWorldMatrix();
    camera.updateViewMatrix();

    const lastFrame = () => inspector.frames[inspector.frameHead]!;
    return { stub, renderer, camera, lastFrame };
}

function material(): Material {
    const position = attribute('position', d.vec3f);
    const clip = mul(cameraProjectionMatrix, mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(position, f32(1)))));
    return new Material({ vertex: clip, fragment: vec4(f32(1), f32(0), f32(0), f32(1)) });
}

function namedMesh(name: string, geometry = createBoxGeometry(1, 1, 1)): Mesh {
    const mesh = new Mesh(geometry, material());
    mesh.name = name;
    mesh.updateWorldMatrix();
    return mesh;
}

test('every call is listed in order with what became of it, the ones that drew nothing included', async () => {
    const { renderer, camera, lastFrame } = await setup();
    const box = namedMesh('box');
    const broken = namedMesh('broken', new Geometry());
    const props = bundle('props');
    props.draw(namedMesh('crate'));
    props.draw(namedMesh('barrel'));
    const recorded = props.finish();

    const f = frame(renderer);
    const pass = f.pass({ target: createRenderTarget(64, 64), camera, label: 'scene' });
    pass.draw(box);
    pass.draw(box, { instances: 0 });
    pass.execute(recorded);
    expect(() => pass.draw(broken)).toThrow();
    pass.end();
    f.submit();

    const [scene] = lastFrame().passes;
    expect([scene.kind, scene.label, scene.skipped, scene.error]).toEqual(['render', 'scene', null, null]);
    expect(scene.calls.map((call) => [call.kind, call.name, call.detail])).toEqual([
        ['draw', 'box', ''],
        ['draw', 'box', '0 instances'],
        ['bundle', 'props', '2 draws'],
        ['draw', 'broken', ''],
    ]);
    const [drawn, empty, replayed, threw] = scene.calls;
    expect(drawn.renderObjects.map((ro) => ro.mesh)).toEqual([box]);
    expect([empty.renderObjects.length, empty.emptyDraws]).toEqual([0, 1]);
    expect(replayed.renderObjects.map((ro) => ro.mesh.name)).toEqual(['crate', 'barrel']);
    expect(threw.error).not.toBeNull();
    expect(threw.renderObjects).toHaveLength(0);
});

test('compute passes sit in the same list, in the order they were recorded', async () => {
    const { renderer, camera, lastFrame } = await setup();
    const node = Fn(() => {
        const out = storage('out', d.array(d.u32), 'read_write');
        index(out, globalId.x).assign(index(out, globalId.x).add(u32(1)));
    }).compute({ workgroupSize: [64, 1, 1], name: 'bump' });
    const out = new GpuBuffer(d.u32, { data: new Uint32Array(64), usage: 'storage' });

    const f = frame(renderer);
    const cull = f.compute({ label: 'cull' });
    cull.dispatch(node, [2, 1, 1], { buffers: { out } });
    cull.end();
    const pass = f.pass({ target: createRenderTarget(64, 64), camera, label: 'scene' });
    pass.draw(namedMesh('box'));
    pass.end();
    f.submit();

    const passes = lastFrame().passes;
    expect(passes.map((p) => [p.kind, p.label])).toEqual([
        ['compute', 'cull'],
        ['render', 'scene'],
    ]);
    expect(passes[0].calls.map((call) => [call.kind, call.name, call.detail])).toEqual([
        ['dispatch', 'bump', '2 x 1 x 1, buffers out'],
    ]);
});

test('a pass recorded while a call resolves sits under that call', async () => {
    const { renderer, lastFrame } = await setup();
    const innerScene = new Scene();
    const innerCamera = new PerspectiveCamera(Math.PI / 4, 1, 0.1, 100);
    innerScene.add(innerCamera);
    innerScene.add(
        new Mesh(
            createFullscreenTriangleGeometry(),
            new Material({ vertex: vec4(attribute('position', d.vec3f), f32(1)), fragment: vec4(1, 0, 1, 1), depthTest: false }),
        ),
    );
    innerScene.updateWorldMatrix();
    innerCamera.updateViewMatrix();
    const composite = fullscreen(renderOutput(renderTexture(innerScene, innerCamera).getTextureNode()));
    composite.name = 'composite';

    const f = frame(renderer);
    const outer = f.pass({ target: createRenderTarget(64, 64), label: 'outer' });
    outer.draw(composite);
    outer.end();
    f.submit();

    const passes = lastFrame().passes;
    expect(passes.map((p) => p.label)).toEqual(['outer']);
    const [call] = passes[0].calls;
    expect(call.name).toBe('composite');
    expect(call.renderObjects).toHaveLength(1);
    expect(call.passes.map((p) => p.kind)).toEqual(['render']);
    expect(call.passes[0].calls.length).toBeGreaterThan(0);
    expect(call.passes[0].error).toBeNull();
});

test('a pass its backend skips says why, and a refused begin says what refused it', async () => {
    const { stub, renderer, camera, lastFrame } = await setup();
    const hidden = createCanvasTarget(stub.makeCanvas(0, 0));

    const f = frame(renderer);
    const skipped = f.pass({ target: hidden, camera, label: 'hidden' });
    skipped.draw(namedMesh('box'));
    skipped.end();
    // `mrt` needs a render target to name its outputs against; the canvas has one attachment.
    expect(() => f.pass({ target: hidden, camera, label: 'refused', mrt: {} as never })).toThrow(/needs a RenderTarget/);
    f.submit();

    const [hiddenPass, refused] = lastFrame().passes;
    expect(hiddenPass.skipped).toMatch(/zero-size/);
    expect(hiddenPass.calls.map((call) => call.renderObjects.length)).toEqual([0]);
    expect(refused.label).toBe('refused');
    expect(refused.error).toMatch(/needs a RenderTarget/);
});

test('a call that throws inside a pass it recorded marks that pass as never ended', async () => {
    const { renderer, lastFrame } = await setup();
    const innerScene = new Scene();
    const innerCamera = new PerspectiveCamera(Math.PI / 4, 1, 0.1, 100);
    innerScene.add(innerCamera);
    innerScene.add(namedMesh('broken', new Geometry()));
    innerScene.updateWorldMatrix();
    innerCamera.updateViewMatrix();
    const composite = fullscreen(renderOutput(renderTexture(innerScene, innerCamera).getTextureNode()));
    composite.name = 'composite';

    const f = frame(renderer);
    const outer = f.pass({ target: createRenderTarget(64, 64), label: 'outer' });
    expect(() => outer.draw(composite)).toThrow();
    outer.end();
    f.submit();

    const [outerPass] = lastFrame().passes;
    expect(outerPass.error).toBeNull();
    const [call] = outerPass.calls;
    expect(call.error).not.toBeNull();
    expect(call.passes).toHaveLength(1);
    expect(call.passes[0].error).toBe('never ended');
    expect(call.passes[0].calls.map((inner) => [inner.name, inner.error !== null])).toEqual([['broken', true]]);
});
