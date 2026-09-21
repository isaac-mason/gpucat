/// <reference types="@webgpu/types" />

import { beforeAll, describe, expect, test } from 'vitest';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

beforeAll(() => {
    installWebGPUPolyfills();
});

import { PerspectiveCamera } from '../src/camera/perspective-camera';
import { createBoxGeometry } from '../src/geometry/geometry-helpers';
import { Material } from '../src/material/material';
import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    f32,
    modelWorldMatrix,
    mul,
    renderTexture,
    renderOutput,
    vec4,
} from '../src/nodes/nodes';
import { fullscreen } from '../src/objects/fullscreen';
import { Mesh } from '../src/objects/mesh';
import { createCanvasTarget } from '../src/renderer/core/canvas-target';
import { Renderer } from '../src/renderer/core/renderer';
import { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import { drawScene } from '../src/scene/draw-scene';
import { Scene } from '../src/scene/scene';
import * as d from '../src/schema/schema';
import { frame } from '../src/renderer/core/frame';

/** One frame owns one encoder and one submit, including the pass a `RenderTextureNode` records inside it. */

function basicMaterial(): Material {
    const position = attribute('position', d.vec3f);
    const clip = mul(cameraProjectionMatrix, mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(position, f32(1)))));
    return new Material({ vertex: clip, fragment: vec4(f32(1), f32(0), f32(0), f32(1)) });
}

function makeScene(): { scene: Scene; camera: PerspectiveCamera } {
    const scene = new Scene();
    const camera = new PerspectiveCamera(Math.PI / 4, 800 / 600, 0.1, 100);
    camera.position[2] = 5;
    scene.add(camera);
    const mesh = new Mesh(createBoxGeometry(1, 1, 1), basicMaterial());
    scene.add(mesh);
    scene.updateWorldMatrix();
    camera.updateViewMatrix();
    mesh.updateWorldMatrix();
    return { scene, camera };
}

async function makeRenderer() {
    const stub = createStubGPU();
    const renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));
    await renderer.init();
    return { stub, renderer, view: createCanvasTarget(stub.canvas) };
}

describe('render encoder ownership', () => {
    test('a frame of one scene pass creates one encoder and submits once', async () => {
        const { stub, renderer, view } = await makeRenderer();
        const { scene, camera } = makeScene();

        stub.stats.reset();
        const f = frame(renderer);
        const scenePass = f.pass({ target: view, camera });
        drawScene(renderer, scenePass, scene, camera);
        scenePass.end();
        f.submit();

        expect(stub.stats.encoderCreations).toBe(1);
        expect(stub.stats.submits).toBe(1);
    });

    test('a RenderTextureNode records its pass on the open frame (1 encoder, 1 submit)', async () => {
        const { stub, renderer, view } = await makeRenderer();
        const { scene, camera } = makeScene();

        const scenePass = renderTexture(scene, camera);
        const output = renderOutput(scenePass.getTextureNode());
        const composite = fullscreen(output);

        stub.stats.reset();
        const f = frame(renderer);
        const compositePass = f.pass({ target: view });
        compositePass.draw(composite);
        compositePass.end();
        f.submit();

        // Guard: the beauty pass must actually have fired — its box draws AND the composite draws, so
        // >= 2 draw calls, otherwise the one-encoder assertion is vacuous.
        expect(stub.stats.drawCalls).toBeGreaterThanOrEqual(2);
        expect(stub.stats.encoderCreations).toBe(1);
        expect(stub.stats.submits).toBe(1);
    });
});
