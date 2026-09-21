/// <reference types="@webgpu/types" />

import { beforeAll, describe, expect, test } from 'vitest';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

beforeAll(() => {
    installWebGPUPolyfills();
});

import { PerspectiveCamera } from '../src/camera/perspective-camera';
import { CoordinateSystem } from '../src/core/coordinate-system';
import { GpuBuffer } from '../src/core/gpu-buffer';
import { createRenderTarget, type RenderTarget } from '../src/core/render-target';
import { Geometry } from '../src/geometry/geometry';
import { createBoxGeometry } from '../src/geometry/geometry-helpers';
import { InspectorBase } from '../src/inspector/inspector-base';
import { Material } from '../src/material/material';
import { attribute, cameraProjectionMatrix, cameraViewMatrix, f32, modelWorldMatrix, mrt, mul, vec4 } from '../src/nodes/nodes';
import { Mesh } from '../src/objects/mesh';
import { createCanvasTarget } from '../src/renderer/core/canvas-target';
import { compile } from '../src/renderer/core/compile';
import { frame } from '../src/renderer/core/frame';
import { read } from '../src/renderer/core/read';
import { Renderer } from '../src/renderer/core/renderer';
import type { View } from '../src/renderer/core/view';
import { attachmentsFor } from '../src/renderer/webgpu/render-pass';
import { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import { drawScene } from '../src/scene/draw-scene';
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

function makeCamera(): PerspectiveCamera {
    const camera = new PerspectiveCamera(Math.PI / 4, 800 / 600, 0.1, 100);
    camera.position[2] = 5;
    camera.updateWorldMatrix();
    camera.updateViewMatrix();
    return camera;
}

async function makeRenderer() {
    const stub = createStubGPU();
    const renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));
    await renderer.init();
    return { stub, renderer, view: createCanvasTarget(stub.canvas) };
}

describe('frame encoder ownership', () => {
    test('one frame of several passes creates one encoder and submits once', async () => {
        const { stub, renderer } = await makeRenderer();
        const camera = makeCamera();
        const a = createRenderTarget(64, 64);
        const b = createRenderTarget(64, 64);

        stub.stats.reset();

        const f = frame(renderer);
        for (const target of [a, b]) {
            const pass = f.pass({ target, camera, label: target === a ? 'a' : 'b' });
            pass.draw(boxMesh());
            pass.end();
        }
        f.submit();

        expect(stub.stats.drawCalls).toBeGreaterThanOrEqual(2);
        expect(stub.stats.encoderCreations).toBe(1);
        expect(stub.stats.submits).toBe(1);
    });

    test('each frame is its own encoder and submit', async () => {
        const { stub, renderer } = await makeRenderer();
        const camera = makeCamera();
        const target = createRenderTarget(64, 64);
        const mesh = boxMesh();

        stub.stats.reset();

        for (let i = 0; i < 3; i++) {
            const f = frame(renderer);
            const pass = f.pass({ target, camera });
            pass.draw(mesh);
            pass.end();
            f.submit();
        }

        expect(stub.stats.encoderCreations).toBe(3);
        expect(stub.stats.submits).toBe(3);
    });

    test('a pass that records nothing still opens and closes its gpu pass', async () => {
        const { stub, renderer } = await makeRenderer();
        const target = createRenderTarget(64, 64);

        stub.stats.reset();

        const f = frame(renderer);
        const pass = f.pass({ target, camera: makeCamera() });
        pass.end();
        f.submit();

        expect(stub.stats.drawCalls).toBe(0);
        expect(stub.stats.encoderCreations).toBe(1);
        expect(stub.stats.submits).toBe(1);
    });
});

describe('each pass is its own render scope', () => {
    test('passes in one frame get distinct renderIds, and each frame advances them', async () => {
        const { renderer } = await makeRenderer();
        const camera = makeCamera();
        const mesh = boxMesh();
        const nodeFrame = renderer._nodes.nodeFrame;
        const before = nodeFrame.renderIdCounter;
        const outerRenderId = nodeFrame.renderId;

        for (let f = 0; f < 2; f++) {
            const f = frame(renderer);
            for (const label of ['a', 'b']) {
                const pass = f.pass({ target: createRenderTarget(64, 64), camera, label });
                pass.draw(mesh);
                pass.end();
            }
            f.submit();
        }

        // One fresh renderId minted per pass, and each pass restores the scope it opened in.
        expect(nodeFrame.renderIdCounter - before).toBe(4);
        expect(nodeFrame.renderId).toBe(outerRenderId);
    });

    test('render stats count passes, not frames', async () => {
        const { renderer } = await makeRenderer();
        const camera = makeCamera();
        const mesh = boxMesh();

        const f = frame(renderer);
        for (const label of ['a', 'b', 'c']) {
            const pass = f.pass({ target: createRenderTarget(64, 64), camera, label });
            pass.draw(mesh);
            pass.end();
        }
        f.submit();

        expect(renderer.info.render.frameCalls).toBe(3);
    });
});

class SceneRecordingInspector extends InspectorBase {
    readonly reported: string[] = [];
    override beginRenderScene(passId: string): void {
        this.reported.push(passId);
    }
}

class PassRecordingInspector extends InspectorBase {
    readonly opened: string[] = [];
    readonly closed: string[] = [];
    override beginRender(passId: string): void {
        this.opened.push(passId);
    }
    override finishRender(passId: string): void {
        this.closed.push(passId);
    }
}

describe('the scene tab is fed by the scene walk, not by the renderer', () => {
    test('a walked pass reports its tree; a hand-recorded pass reports none', async () => {
        const { renderer } = await makeRenderer();
        const inspector = new SceneRecordingInspector();
        renderer.inspector = inspector;

        const camera = makeCamera();
        const scene = new Scene();
        scene.add(boxMesh());
        scene.updateWorldMatrix();

        const f = frame(renderer);

        const walked = f.pass({ target: createRenderTarget(64, 64), camera, label: 'walked' });
        drawScene(renderer, walked, scene, camera);
        walked.end();

        const recorded = f.pass({ target: createRenderTarget(64, 64), camera, label: 'recorded' });
        recorded.draw(boxMesh());
        recorded.end();

        f.submit();

        expect(inspector.reported).toEqual(['walked']);
    });
});

describe('a pass draws to the target in its desc', () => {
    test('a second CanvasTarget gets configured, not the renderer current one', async () => {
        const { stub, renderer } = await makeRenderer();
        const preview = createCanvasTarget(stub.canvas, { samples: 1 });

        expect(preview.colorFormat).toBe('');

        const f = frame(renderer);
        const pass = f.pass({ target: preview, camera: makeCamera(), label: 'preview' });
        pass.draw(boxMesh());
        pass.end();
        f.submit();

        // Only configuring this target stamps its format; ignoring desc.target would leave it empty.
        expect(preview.colorFormat).not.toBe('');
    });

    test('each canvas target keeps its own depth attachment', async () => {
        const { stub, renderer } = await makeRenderer();
        const a = createCanvasTarget(stub.canvas);
        const b = createCanvasTarget(stub.canvas);

        const f = frame(renderer);
        for (const target of [a, b]) {
            const pass = f.pass({ target, camera: makeCamera() });
            pass.draw(boxMesh());
            pass.end();
        }
        f.submit();

        const attachmentsA = attachmentsFor(renderer.backend.swapchain, a);
        const attachmentsB = attachmentsFor(renderer.backend.swapchain, b);
        expect(attachmentsA.depthTexture).not.toBeNull();
        expect(attachmentsA.depthTexture).not.toBe(attachmentsB.depthTexture);
    });
});

describe('a lost device stops the frame path without throwing', () => {
    test('a full frame after device loss touches no device work', async () => {
        const { stub, renderer } = await makeRenderer();
        const camera = makeCamera();
        const target = createRenderTarget(64, 64);

        renderer._isDeviceLost = true;
        stub.stats.reset();

        // A host's animation loop keeps calling this; it must no-op, not crash.
        const f = frame(renderer);
        const pass = f.pass({ target, camera });
        pass.draw(boxMesh());
        pass.end();
        f.submit();

        expect(stub.stats.encoderCreations).toBe(0);
        expect(stub.stats.drawCalls).toBe(0);
        expect(stub.stats.submits).toBe(0);
    });

    test('frame() before init throws rather than reaching a null device', () => {
        const stub = createStubGPU();
        const renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));

        expect(() => frame(renderer)).toThrow(/before init/);
    });
});

describe('a pass aligns its camera to the backend clip convention', () => {
    test('a WEBGL-built camera is rebuilt for a WebGPU pass', async () => {
        const { renderer } = await makeRenderer();
        const camera = makeCamera();
        camera.coordinateSystem = CoordinateSystem.WEBGL;
        camera.updateProjectionMatrix();
        const webglProjection = [...camera.projectionMatrix];

        const f = frame(renderer);
        const pass = f.pass({ target: createRenderTarget(64, 64), camera });
        pass.draw(boxMesh());
        pass.end();
        f.submit();

        expect(camera.coordinateSystem).toBe(CoordinateSystem.WEBGPU);
        expect([...camera.projectionMatrix]).not.toEqual(webglProjection);
    });

    test('a matching camera is left alone, projection untouched', async () => {
        const { renderer } = await makeRenderer();
        const camera = makeCamera();
        const before = [...camera.projectionMatrix];

        const f = frame(renderer);
        const pass = f.pass({ target: createRenderTarget(64, 64), camera });
        pass.end();
        f.submit();

        expect([...camera.projectionMatrix]).toEqual(before);
    });

    test('a View with no updateProjectionMatrix is the caller to keep consistent', async () => {
        const { renderer } = await makeRenderer();
        const view: View = {
            projectionMatrix: makeCamera().projectionMatrix,
            matrixWorldInverse: makeCamera().matrixWorldInverse,
            matrixWorld: makeCamera().matrixWorld,
            near: 0.1,
            far: 100,
            coordinateSystem: CoordinateSystem.WEBGL,
        };

        const f = frame(renderer);
        const pass = f.pass({ target: createRenderTarget(64, 64), camera: view });
        expect(() => pass.end()).not.toThrow();
        f.submit();
    });
});

describe('a zero-sized target is skipped, not failed on', () => {
    test('a pass to a hidden canvas encodes nothing and does not throw', async () => {
        const { stub, renderer } = await makeRenderer();
        // display:none reports zero layout, which is what autoResize reads.
        const element = stub.makeCanvas(0, 0);
        const hidden = createCanvasTarget(element);

        stub.stats.reset();

        const f = frame(renderer);
        const pass = f.pass({ target: hidden, camera: makeCamera(), label: 'hidden' });
        pass.draw(boxMesh());
        expect(() => pass.end()).not.toThrow();
        f.submit();

        expect(stub.stats.drawCalls).toBe(0);
    });

    test('a sized target in the same frame still encodes', async () => {
        const { stub, renderer } = await makeRenderer();
        // display:none reports zero layout, which is what autoResize reads.
        const element = stub.makeCanvas(0, 0);
        const hidden = createCanvasTarget(element);

        stub.stats.reset();

        const f = frame(renderer);
        const skipped = f.pass({ target: hidden, camera: makeCamera() });
        skipped.draw(boxMesh());
        skipped.end();

        const drawn = f.pass({ target: createRenderTarget(64, 64), camera: makeCamera() });
        drawn.draw(boxMesh());
        drawn.end();
        f.submit();

        expect(stub.stats.drawCalls).toBeGreaterThanOrEqual(1);
        expect(stub.stats.submits).toBe(1);
    });
});

describe('compile pre-warms the pipeline a pass will look up', () => {
    test('compiling for a render target leaves that pass with nothing to build', async () => {
        const { renderer } = await makeRenderer();
        const camera = makeCamera();
        const target = createRenderTarget(64, 64);
        const mesh = boxMesh();
        const scene = new Scene();
        scene.add(mesh);
        scene.updateWorldMatrix();

        await compile(renderer, mesh, target, camera);
        const warmed = renderer.backend.pipelines.renderPipelines.size;
        expect(warmed).toBeGreaterThan(0);

        const f = frame(renderer);
        const pass = f.pass({ target, camera });
        drawScene(renderer, pass, scene, camera);
        pass.end();
        f.submit();

        // A key built from the swapchain instead of this target would force a second pipeline here.
        expect(renderer.backend.pipelines.renderPipelines.size).toBe(warmed);
    });

    test('the pre-warmed render objects are the ones the pass uses', async () => {
        const { renderer } = await makeRenderer();
        const camera = makeCamera();
        const target = createRenderTarget(64, 64);
        const mesh = boxMesh();
        const scene = new Scene();
        scene.add(mesh);
        scene.updateWorldMatrix();

        await compile(renderer, mesh, target, camera);
        const warmed = renderer._renderObjects.renderObjects.size;
        expect(warmed).toBeGreaterThan(0);

        const f = frame(renderer);
        const pass = f.pass({ target, camera, label: 'not-compile' });
        drawScene(renderer, pass, scene, camera);
        pass.end();
        f.submit();

        // A label in the cache key would make 'not-compile' a separate universe from 'compile'.
        expect(renderer._renderObjects.renderObjects.size).toBe(warmed);
    });

    test('labelling passes does not multiply render objects', async () => {
        const { renderer } = await makeRenderer();
        const camera = makeCamera();
        const target = createRenderTarget(64, 64);
        const mesh = boxMesh();

        for (const label of ['a', 'b', 'c']) {
            const f = frame(renderer);
            const pass = f.pass({ target, camera, label });
            pass.draw(mesh);
            pass.end();
            f.submit();
        }

        expect(renderer._renderObjects.renderObjects.size).toBe(1);
    });
});

describe('work that owns its own encoder refuses to run inside a frame', () => {
    test('readPixels rejects while a frame is open, and resolves after submit', async () => {
        const { renderer } = await makeRenderer();
        const target = createRenderTarget(64, 64);

        const f = frame(renderer);
        const pass = f.pass({ target, camera: makeCamera() });
        pass.draw(boxMesh());
        pass.end();

        // The pass is recorded but not queued, so a read here returns the previous frame's pixels.
        await expect(read(renderer, target)).rejects.toThrow(/submit\(\) first/);

        // After submit the guard is gone; the stub cannot do a real readback, so only the guard is asserted.
        f.submit();
        await expect(read(renderer, target)).rejects.not.toThrow(/submit\(\) first/);
    });
});

describe('the stub validates attachment agreement, as the device would', () => {
    test('two canvas targets of different sizes in one frame each get matching attachments', async () => {
        const { stub, renderer } = await makeRenderer();
        const big = createCanvasTarget(stub.makeCanvas(800, 600));
        const small = createCanvasTarget(stub.makeCanvas(140, 140));

        const f = frame(renderer);
        for (const target of [big, small]) {
            const pass = f.pass({ target, camera: makeCamera() });
            pass.draw(boxMesh());
            pass.end();
        }

        // Coverage, not a regression test: the size reconcile would recreate a shared depth texture
        // per pass, so this stays green either way. It pins that two canvases in one frame work at all.
        expect(() => f.submit()).not.toThrow();
    });

    test('the check bites: mismatched attachments are rejected', async () => {
        const { stub } = await makeRenderer();
        const encoder = stub.device.createCommandEncoder();
        const colour = stub.device.createTexture({ size: [140, 140, 1] } as unknown as GPUTextureDescriptor);
        const depth = stub.device.createTexture({ size: [800, 600, 1] } as unknown as GPUTextureDescriptor);

        expect(() =>
            encoder.beginRenderPass({
                colorAttachments: [{ view: colour.createView(), loadOp: 'clear', storeOp: 'store' }],
                depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store' },
            } as GPURenderPassDescriptor),
        ).toThrow(/attachments disagree: 140x140 vs 800x600/);
    });
});

test('a pass with mrt on a canvas target is rejected, not silently collapsed', async () => {
    const { stub, renderer } = await makeRenderer();
    const canvas = createCanvasTarget(stub.canvas);
    const outputs = mrt({ output: vec4(f32(1), f32(0), f32(0), f32(1)) });

    const f = frame(renderer);
    const pass = f.pass({ target: canvas, camera: makeCamera(), mrt: outputs });
    pass.draw(boxMesh());

    expect(() => pass.end()).toThrow(/needs a RenderTarget/);
});

test('a pass to an autoResizing canvas picks up a layout change', async () => {
    const { stub, renderer } = await makeRenderer();
    const element = stub.makeCanvas(200, 100);
    const target = createCanvasTarget(element);
    expect(target.autoResize).toBe(true);

    (element as unknown as { clientWidth: number }).clientWidth = 640;
    (element as unknown as { clientHeight: number }).clientHeight = 480;

    const f = frame(renderer);
    const pass = f.pass({ target, camera: makeCamera() });
    pass.draw(boxMesh());
    pass.end();
    f.submit();

    expect(target.getDrawingBufferSize()).toEqual({ width: 640, height: 480 });
});

test('one material over two geometries of differing stride builds two pipelines', async () => {
    const { renderer } = await makeRenderer();
    const camera = makeCamera();

    // The attribute names the buffer; the buffer's format supplies arrayStride. Two geometries can
    // therefore disagree on stride under one material, which the pipeline key has to separate.
    const position = attribute('position', d.vec3f);
    const material = new Material({
        vertex: mul(cameraProjectionMatrix, mul(cameraViewMatrix, vec4(position, f32(1)))),
        fragment: vec4(f32(1), f32(0), f32(0), f32(1)),
    });

    const tight = new Geometry();
    tight.setBuffer('position', new GpuBuffer(d.vec3f, { data: new Float32Array(9), usage: 'vertex' }));
    const padded = new Geometry();
    padded.setBuffer('position', new GpuBuffer(d.vec4f, { data: new Float32Array(12), usage: 'vertex' }));

    const f = frame(renderer);
    const pass = f.pass({ target: createRenderTarget(64, 64), camera });
    for (const geometry of [tight, padded]) {
        const mesh = new Mesh(geometry, material);
        mesh.updateWorldMatrix();
        pass.draw(mesh);
    }
    pass.end();
    f.submit();

    // Sharing one pipeline would give the second geometry the first's arrayStride.
    expect(renderer.backend.pipelines.renderPipelines.size).toBe(2);
});

test('replacing a geometry buffer with a different format is picked up', async () => {
    const { renderer } = await makeRenderer();
    const camera = makeCamera();
    const target = createRenderTarget(64, 64);

    const position = attribute('position', d.vec3f);
    const material = new Material({
        vertex: mul(cameraProjectionMatrix, mul(cameraViewMatrix, vec4(position, f32(1)))),
        fragment: vec4(f32(1), f32(0), f32(0), f32(1)),
    });
    const geometry = new Geometry();
    geometry.setBuffer('position', new GpuBuffer(d.vec3f, { data: new Float32Array(9), usage: 'vertex' }));
    const mesh = new Mesh(geometry, material);
    mesh.updateWorldMatrix();

    const drawOnce = () => {
        const f = frame(renderer);
        const pass = f.pass({ target, camera });
        pass.draw(mesh);
        pass.end();
        f.submit();
    };

    drawOnce();
    const afterFirst = renderer.backend.pipelines.renderPipelines.size;

    // setBuffer only bumps `geometry.version` for a NEW name, so this triggers no recompile. The
    // arrayStride still changes, and the pipeline key carries it, which is what covers the gap.
    geometry.setBuffer('position', new GpuBuffer(d.vec4f, { data: new Float32Array(12), usage: 'vertex' }));
    drawOnce();

    expect(renderer.backend.pipelines.renderPipelines.size).toBe(afterFirst + 1);
});

test('a material change after the first draw rebuilds the pipeline', async () => {
    const { renderer } = await makeRenderer();
    const camera = makeCamera();
    const target = createRenderTarget(64, 64);
    const mesh = boxMesh();

    const drawOnce = () => {
        const f = frame(renderer);
        const pass = f.pass({ target, camera });
        pass.draw(mesh);
        pass.end();
        f.submit();
    };

    drawOnce();
    const afterFirst = renderer.backend.pipelines.renderPipelines.size;

    // depthWrite is pipeline state, so a resolved pipeline held past this change would be wrong.
    mesh.material.depthWrite = !mesh.material.depthWrite;
    mesh.material.version++;
    drawOnce();

    expect(renderer.backend.pipelines.renderPipelines.size).toBe(afterFirst + 1);
});

describe('read is an operation on the gpu, not a method on the target', () => {
    test('it refuses to read across an open frame, like the method it wraps', async () => {
        const { renderer } = await makeRenderer();
        const target = createRenderTarget(64, 64);

        const f = frame(renderer);
        const pass = f.pass({ target, camera: makeCamera() });
        pass.draw(boxMesh());
        pass.end();

        await expect(read(renderer, target)).rejects.toThrow(/submit\(\) first/);
        f.submit();
    });

    test('its options name the attachment and layer rather than positional indices', async () => {
        const { renderer } = await makeRenderer();
        const target = createRenderTarget(64, 64);
        const seen: [number, number][] = [];

        const spy = {
            _assertInitialized: () => {},
            _frameState: null,
            backend: {
                readPixels: (_t: RenderTarget, attachment: number, layer: number) => {
                    seen.push([attachment, layer]);
                    return Promise.resolve(new Uint8Array(0));
                },
            },
        };

        // `read` takes a Renderer; this stands in for one to watch what it forwards.
        const spyRenderer = spy as unknown as Renderer;
        await read(spyRenderer, target);
        await read(spyRenderer, target, { attachment: 2 });
        await read(spyRenderer, target, { layer: 4 });

        expect(seen).toEqual([
            [0, 0],
            [2, 0],
            [0, 4],
        ]);
        expect(renderer.api).toBe('webgpu');
    });
});

describe('a pass brackets its hooks even when it throws', () => {
    test('every beginRender is matched by a finishRender, and the render scope unwinds with it', async () => {
        const { renderer } = await makeRenderer();
        const inspector = new PassRecordingInspector();
        renderer.inspector = inspector;

        const camera = makeCamera();
        const exploding = boxMesh();
        // Preparing evaluates the graph, so a throwing node throws between beginRender and the GPU pass.
        (exploding as unknown as { material: { vertex: unknown } }).material.vertex = new Proxy(
            {},
            {
                get() {
                    throw new Error('node evaluation failed');
                },
            },
        );

        const f = frame(renderer);
        const pass = f.pass({ target: createRenderTarget(64, 64), camera, label: 'doomed' });
        pass.draw(exploding);
        expect(() => pass.end()).toThrow();

        expect(inspector.opened).toEqual(['doomed']);
        expect(inspector.closed).toEqual(['doomed']);

        // The render scope closed with it, so the next pass is not nested inside the dead one.
        const ok = f.pass({ target: createRenderTarget(64, 64), camera, label: 'after' });
        ok.draw(boxMesh());
        ok.end();
        f.submit();

        expect(inspector.opened).toEqual(['doomed', 'after']);
        expect(inspector.closed).toEqual(['doomed', 'after']);
    });
});
