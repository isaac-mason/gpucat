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
    pass,
    renderOutput,
    vec4,
} from '../src/nodes/nodes';
import { Mesh } from '../src/objects/mesh';
import { RenderPipeline } from '../src/renderer/core/render-pipeline';
import { WebGPURenderer } from '../src/renderer/webgpu/renderer';
import { Scene } from '../src/scene/scene';
import * as d from '../src/schema/schema';

/**
 * Render-path safety net for the Phase-2 encoder internalization.
 *
 * Invariant: a top-level render() (or compute()) owns exactly one command encoder and issues exactly
 * one queue.submit(); a nested render (PassNode.updateBefore) must REUSE the parent's encoder — so a
 * frame that contains a nested pass still produces one encoder + one submit, not two. The upcoming
 * change moves encoder ownership from a threaded param onto the renderer; this test locks the current
 * behavior so that change stays faithful.
 */

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
    const renderer = new WebGPURenderer(stub.getRendererOptions());
    await renderer.init();
    renderer.setSize(800, 600);
    return { stub, renderer };
}

describe('render encoder ownership', () => {
    test('a top-level render creates one encoder and submits once', async () => {
        const { stub, renderer } = await makeRenderer();
        const { scene, camera } = makeScene();

        stub.stats.reset();
        renderer.render(scene, camera);

        expect(stub.stats.encoderCreations).toBe(1);
        expect(stub.stats.submits).toBe(1);
    });

    test('a nested PassNode render reuses the parent encoder (1 encoder, 1 submit)', async () => {
        const { stub, renderer } = await makeRenderer();
        const { scene, camera } = makeScene();

        const scenePass = pass(scene, camera);
        const output = renderOutput(scenePass.getTextureNode());
        const renderPipeline = new RenderPipeline(renderer, output);

        stub.stats.reset();
        renderPipeline.render();

        // Guard: the nested pass must actually have fired — the inner scene's box draws AND the
        // composite quad draws, so >= 2 draw calls (otherwise the 1-encoder assertion is vacuous).
        expect(stub.stats.drawCalls).toBeGreaterThanOrEqual(2);
        // The RenderPipeline's fullscreen quad render is the top-level frame; the PassNode's nested
        // scene render must reuse the parent encoder — so exactly one encoder and one submit.
        expect(stub.stats.encoderCreations).toBe(1);
        expect(stub.stats.submits).toBe(1);
    });
});
