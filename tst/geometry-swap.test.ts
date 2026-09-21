/// <reference types="@webgpu/types" />

import { beforeAll, expect, test } from 'vitest';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

beforeAll(() => {
    installWebGPUPolyfills();
});

import { PerspectiveCamera } from '../src/camera/perspective-camera';
import { createVertexBuffer } from '../src/core/gpu-buffer';
import type { Object3D } from '../src/core/object3d';
import { createRenderTarget } from '../src/core/render-target';
import { Geometry } from '../src/geometry/geometry';
import { createBoxGeometry, createPlaneGeometry } from '../src/geometry/geometry-helpers';
import { InspectorBase } from '../src/inspector/inspector-base';
import { Material } from '../src/material/material';
import { renderOutput } from '../src/nodes/lib/display/render-output';
import { renderTexture } from '../src/nodes/lib/display/render-texture-node';
import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    f32,
    modelWorldMatrix,
    mul,
    varying,
    vec4,
} from '../src/nodes/nodes';
import { fullscreen } from '../src/objects/fullscreen';
import { Mesh } from '../src/objects/mesh';
import { frame } from '../src/renderer/core/frame';
import { Renderer } from '../src/renderer/core/renderer';
import { getPipelineCacheStats } from '../src/renderer/webgpu/pipelines';
import { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import { drawScene } from '../src/scene/draw-scene';
import { Scene } from '../src/scene/scene';
import * as d from '../src/schema/schema';

/**
 * `RenderObject.geometry` is a copy of `mesh.geometry` taken when the object is cached, and the
 * staleness check compares versions of *that* copy. Swapping in a different `Geometry` therefore
 * looked unchanged forever, which is what left the editor's brush and lasso drawing their first
 * shape. lib swaps rather than mutates because the vertex count changes with the selection.
 */
async function scene() {
    const stub = createStubGPU();
    const renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));
    await renderer.init();

    const position = attribute('position', d.vec3f);
    const clip = mul(cameraProjectionMatrix, mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(position, f32(1)))));
    const mesh = new Mesh(createBoxGeometry(1, 1, 1), new Material({ vertex: clip, fragment: vec4(1, 0, 0, 1) }));
    mesh.updateWorldMatrix();

    const camera = new PerspectiveCamera(Math.PI / 4, 1, 0.1, 100);
    camera.position[2] = 5;
    camera.updateWorldMatrix();
    camera.updateViewMatrix();

    return { stub, renderer, mesh, camera, target: createRenderTarget(64, 64) };
}

function drawOnce(
    renderer: Renderer<WebGPUBackend>,
    mesh: Mesh,
    camera: PerspectiveCamera,
    target: ReturnType<typeof createRenderTarget>,
) {
    const f = frame(renderer);
    const pass = f.pass({ target, camera });
    pass.draw(mesh);
    pass.end();
    f.submit();
}

test('swapping a mesh onto a different geometry draws the new one', async () => {
    const { stub, renderer, mesh, camera, target } = await scene();

    drawOnce(renderer, mesh, camera, target);
    const boxIndices = stub.stats.lastIndexCount;
    expect(boxIndices).toBeGreaterThan(0);

    const plane = createPlaneGeometry(1, 1);
    const planeIndices = plane.index!.array!.length;
    expect(planeIndices).not.toBe(boxIndices);

    mesh.geometry = plane;
    drawOnce(renderer, mesh, camera, target);

    expect(stub.stats.lastIndexCount).toBe(planeIndices);
});

/**
 * `vertexLayoutKey` is per shader vertex-group stride. The pipeline-key cache is guarded on
 * `_pipelineKeyGeometryVersion === geometry.version`, and a fresh geometry can land on the same
 * version the old key was built at, which is how a swap reused a layout built for the old attributes.
 */
test('a swap to a different vertex layout builds a new pipeline, not the cached key', async () => {
    const { stub, renderer, camera, target } = await scene();

    const position = attribute('position', d.vec3f);
    const normal = attribute('normal', d.vec3f);
    const clip = mul(cameraProjectionMatrix, mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(position, f32(1)))));
    const vNormal = varying(normal, 'vNormal');
    const material = new Material({ vertex: clip, fragment: vec4(vNormal, f32(1)) });

    const withNormal = new Geometry();
    withNormal.setBuffer('position', createVertexBuffer(d.vec3f, new Float32Array(9)));
    withNormal.setBuffer('normal', createVertexBuffer(d.vec3f, new Float32Array(9)));

    // Same attribute names so `assertVertexBuffers` is satisfied, wider normal so the stride differs.
    const widerNormal = new Geometry();
    widerNormal.setBuffer('position', createVertexBuffer(d.vec3f, new Float32Array(9)));
    widerNormal.setBuffer('normal', createVertexBuffer(d.vec4f, new Float32Array(12)));

    // The collision the guard cannot see: same version, different layout.
    expect(widerNormal.version).toBe(withNormal.version);

    const mesh = new Mesh(withNormal, material);
    mesh.updateWorldMatrix();

    drawOnce(renderer, mesh, camera, target);
    const afterFirst = getPipelineCacheStats(renderer.backend.pipelines).renderCount;

    mesh.geometry = widerNormal;
    drawOnce(renderer, mesh, camera, target);

    expect(getPipelineCacheStats(renderer.backend.pipelines).renderCount).toBeGreaterThan(afterFirst);
    void stub;
});

/**
 * lib swaps the active room onto the node every frame, and cast away `readonly` to do it. The node
 * reads `contents` afresh in `updateBefore`, so the cast was the type disagreeing with the code
 * rather than a consumer reaching somewhere it should not.
 */
test('reassigning contents swaps what the node renders, without rebuilding it', async () => {
    const { renderer, camera, target } = await scene();

    const first = new Scene();
    first.add(
        new Mesh(
            createBoxGeometry(1, 1, 1),
            new Material({ vertex: vec4(f32(0), f32(0), f32(0), f32(1)), fragment: vec4(1, 0, 0, 1) }),
        ),
    );
    first.updateWorldMatrix();

    const second = new Scene();
    second.updateWorldMatrix();

    const node = renderTexture(first, camera);
    expect(node.contents).toBe(first);

    node.contents = second;
    expect(node.contents).toBe(second);

    // Which scene `drawScene` actually walked is the claim; the field holding what it was assigned is not.
    const walked: Object3D[] = [];
    class WalkRecorder extends InspectorBase {
        override beginRenderScene(_passId: string, scene: Object3D): void {
            walked.push(scene);
        }
    }
    renderer.inspector = new WalkRecorder();

    const composite = fullscreen(renderOutput(node.getTextureNode()));
    const f = frame(renderer);
    const pass = f.pass({ target, camera });
    pass.draw(composite);
    pass.end();
    f.submit();

    expect(walked).toContain(second);
    expect(walked).not.toContain(first);
});

/**
 * `mesh.visible` gates `walkObject`, which is the scene-walk path, and nothing in the recorded path
 * reads it. That asymmetry is deliberate — recording a draw is the decision that `visible` would
 * otherwise make — but it is silent, so it is pinned rather than left to be rediscovered.
 */
test('a recorded draw ignores mesh.visible; the scene walk honours it', async () => {
    const { stub, renderer, mesh, camera, target } = await scene();

    mesh.visible = false;

    stub.stats.reset();
    drawOnce(renderer, mesh, camera, target);
    expect(stub.stats.drawCalls).toBe(1);

    const hidden = new Scene();
    hidden.add(mesh);
    hidden.updateWorldMatrix();

    stub.stats.reset();
    const f = frame(renderer);
    const pass = f.pass({ target, camera });
    drawScene(renderer, pass, hidden, camera);
    pass.end();
    f.submit();
    expect(stub.stats.drawCalls).toBe(0);
});
