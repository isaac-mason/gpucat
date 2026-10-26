/// <reference types="@webgpu/types" />

import { beforeAll, describe, expect, test } from 'vitest';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

beforeAll(() => {
    installWebGPUPolyfills();
});

import { PerspectiveCamera } from '../src/camera/perspective-camera';
import { createRenderTarget } from '../src/core/render-target';
import { createBoxGeometry } from '../src/geometry/geometry-helpers';
import { InspectorBase } from '../src/inspector/inspector-base';
import { Material } from '../src/material/material';
import { attribute, cameraProjectionMatrix, cameraViewMatrix, f32, modelWorldMatrix, mul, vec4 } from '../src/nodes/nodes';
import { Mesh } from '../src/objects/mesh';
import { bundle } from '../src/renderer/core/bundle';
import { type CallRecord, frame } from '../src/renderer/core/frame';
import type { RenderObject } from '../src/renderer/core/render-object';
import { Renderer } from '../src/renderer/core/renderer';
import type { View } from '../src/renderer/core/view';
import { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import { Scene } from '../src/scene/scene';
import * as d from '../src/schema/schema';

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

function cameraAt(z: number): PerspectiveCamera {
    const camera = new PerspectiveCamera(Math.PI / 2, 1, 0.1, 100);
    camera.position[2] = z;
    camera.updateWorldMatrix();
    camera.updateViewMatrix();
    return camera;
}

/** What a pass's calls were and which camera each draw resolved with, in order. */
class CallLog extends InspectorBase {
    calls: CallRecord['kind'][] = [];
    drawCameras: View[] = [];
    override beginRecordedCall(record: CallRecord): void {
        this.calls.push(record.kind);
    }
    override resolvedDraw(renderObject: RenderObject, drawsNothing: boolean): void {
        if (!drawsNothing) this.drawCameras.push(renderObject.camera);
    }
}

async function makeRenderer() {
    const stub = createStubGPU();
    const renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));
    await renderer.init();
    return { stub, renderer };
}

describe('a pass drawing several views', () => {
    test('each view draws under its own camera, viewport and scissor, in order', async () => {
        const { stub, renderer } = await makeRenderer();
        const log = new CallLog();
        renderer.inspector = log;
        const target = createRenderTarget(64, 32);
        const mesh = boxMesh();
        const front = cameraAt(5);
        const back = cameraAt(-5);
        stub.stats.reset();

        const f = frame(renderer);
        const pass = f.pass({ target, label: 'views' });
        pass.setCamera(front);
        pass.setViewport({ x: 0, y: 0, width: 32, height: 32 });
        pass.setScissor({ x: 0, y: 0, width: 32, height: 32 });
        pass.draw(mesh);
        pass.setCamera(back);
        pass.setViewport({ x: 32, y: 0, width: 32, height: 32 });
        pass.setScissor({ x: 32, y: 0, width: 32, height: 32 });
        pass.draw(mesh);
        pass.end();
        f.submit();

        expect(stub.stats.passCommands).toEqual([
            'viewport 0 0 32 32',
            'scissor 0 0 32 32',
            'draw',
            'viewport 32 0 32 32',
            'scissor 32 0 32 32',
            'draw',
        ]);
        expect(log.drawCameras).toEqual([front, back]);
        expect(log.calls).toEqual(['camera', 'viewport', 'scissor', 'draw', 'camera', 'viewport', 'scissor', 'draw']);
    });

    test('a rect back to undefined is the whole target, and an unchanged rect is not set again', async () => {
        const { stub, renderer } = await makeRenderer();
        const target = createRenderTarget(64, 32);
        const mesh = boxMesh();
        stub.stats.reset();

        const f = frame(renderer);
        const pass = f.pass({ target, camera: cameraAt(5) });
        pass.setViewport({ x: 0, y: 0, width: 32, height: 32 });
        pass.draw(mesh);
        pass.setScissor({ x: 0, y: 0, width: 16, height: 16 });
        pass.draw(mesh);
        pass.setViewport(undefined);
        pass.setScissor(undefined);
        pass.draw(mesh);
        pass.end();
        f.submit();

        expect(stub.stats.passCommands).toEqual([
            'viewport 0 0 32 32',
            'draw',
            'scissor 0 0 16 16',
            'draw',
            'viewport 0 0 64 32',
            'scissor 0 0 64 32',
            'draw',
        ]);
    });

    test('a new camera opens a render scope of its own; the same camera again does not', async () => {
        const { renderer } = await makeRenderer();
        const target = createRenderTarget(32, 32);
        const camera = cameraAt(5);
        const nodeFrame = renderer._nodes.nodeFrame;

        const f = frame(renderer);
        const pass = f.pass({ target, camera });
        const opened = nodeFrame.renderId;
        pass.setCamera(camera);
        expect(nodeFrame.renderId, 'the camera the pass already draws from').toBe(opened);
        pass.setCamera(cameraAt(-5));
        expect(nodeFrame.renderId).toBeGreaterThan(opened);
        pass.end();
        f.submit();
    });

    test('a viewport reaching outside the target throws, naming the pass', async () => {
        const { renderer } = await makeRenderer();
        const target = createRenderTarget(32, 32);

        const f = frame(renderer);
        const pass = f.pass({ target, camera: cameraAt(5), label: 'atlas' });
        expect(() => pass.setViewport({ x: 16, y: 0, width: 32, height: 32 })).toThrow(/\[pass atlas\] viewport/);
        f.abandon();
    });

    test('a scissor is clamped to the target', async () => {
        const { stub, renderer } = await makeRenderer();
        const target = createRenderTarget(32, 32);
        stub.stats.reset();

        const f = frame(renderer);
        const pass = f.pass({ target, camera: cameraAt(5) });
        pass.setScissor({ x: 16, y: 16, width: 64, height: 64 });
        pass.draw(boxMesh());
        pass.end();
        f.submit();

        expect(stub.stats.passCommands).toEqual(['scissor 16 16 16 16', 'draw']);
    });

    test('a bundle draws under the view before it, and records once per camera it is replayed under', async () => {
        const { stub, renderer } = await makeRenderer();
        const target = createRenderTarget(64, 32);
        const encoder = bundle('casters');
        encoder.draw(boxMesh());
        const casters = encoder.finish();
        stub.stats.reset();

        const f = frame(renderer);
        const pass = f.pass({ target, label: 'views' });
        pass.setCamera(cameraAt(5));
        pass.setViewport({ x: 0, y: 0, width: 32, height: 32 });
        pass.execute(casters);
        pass.setCamera(cameraAt(-5));
        pass.setViewport({ x: 32, y: 0, width: 32, height: 32 });
        pass.execute(casters);
        pass.end();
        f.submit();

        expect(stub.stats.passCommands).toEqual(['viewport 0 0 32 32', 'bundle', 'viewport 32 0 32 32', 'bundle']);
        expect(stub.stats.bundleRecordings).toBe(2);
    });

    test('scene() with no camera walks from the one the pass draws from now', async () => {
        const { renderer } = await makeRenderer();
        const log = new CallLog();
        renderer.inspector = log;
        const target = createRenderTarget(32, 32);
        const scene = new Scene();
        scene.add(boxMesh());
        scene.updateWorldMatrix();
        // both look down -Z: the first has the box behind it, so a walk from it would draw nothing
        const later = cameraAt(5);

        const f = frame(renderer);
        const pass = f.pass({ target, camera: cameraAt(-5) });
        pass.setCamera(later);
        pass.scene(scene);
        pass.end();
        f.submit();

        expect(log.drawCameras).toEqual([later]);
    });
});
