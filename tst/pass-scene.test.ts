import { expect, test } from 'vitest';
import { PerspectiveCamera } from '../src/camera/perspective-camera';
import { createRenderTarget } from '../src/core/render-target';
import { createBoxGeometry } from '../src/geometry/geometry-helpers';
import { Material } from '../src/material/material';
import { positionClip, vec4f } from '../src/nodes/nodes';
import { Mesh } from '../src/objects/mesh';
import {
    type BackendName,
    beginFrame,
    createFrame,
    type DrawRecord,
    type FrameBackend,
    type PassDesc,
    type PassEntry,
} from '../src/renderer/core/frame';
import { collectRenderList, createRenderListsState } from '../src/renderer/core/render-list';
import { Scene } from '../src/scene/scene';

function recorder(name: BackendName = 'webgpu'): FrameBackend {
    return {
        name,
        deviceCanvasTarget: null,
        awaitCompletion: () => Promise.resolve(),
        beginFrame: () => {},
        encodePass: (_d: PassDesc, _r: readonly DrawRecord[], _c: number) => {},
        encodeComputePass: () => {},
        encodeTransformFeedbackPass: () => undefined,
        submitFrame: () => {},
        discardFrame: () => {},
    };
}

const target = createRenderTarget(8, 8);

/** `pass.scene()` is the tree walk as a verb on the pass, beside `draw` and `execute`. */
test('a frame opened without a renderer refuses scene(), naming what it needs', () => {
    const frame = createFrame(recorder());
    beginFrame(frame);
    const pass = frame.pass({ target });

    expect(() => pass.scene({} as never)).toThrow(/frame\(renderer\)/);
});

/** The camera comes from the pass unless one is handed in, so the common call takes a tree alone. */
test('scene() refuses a pass with no camera and no camera argument', () => {
    const frame = createFrame(recorder());
    beginFrame(frame);
    frame.renderer = {} as never;
    const pass = frame.pass({ target });

    expect(() => pass.scene({} as never)).toThrow(/needs a camera/);
});

test('draw, execute and scene are all verbs on the pass', () => {
    const frame = createFrame(recorder());
    beginFrame(frame);
    const pass = frame.pass({ target });

    expect(typeof pass.draw).toBe('function');
    expect(typeof pass.execute).toBe('function');
    expect(typeof pass.scene).toBe('function');
});

function capturing(into: PassEntry[][]): FrameBackend {
    return { ...recorder(), encodePass: (_d, records, count) => into.push(records.slice(0, count)) };
}

function offCameraBox(): Mesh {
    const mesh = new Mesh(createBoxGeometry(1, 1, 1), new Material({ vertex: positionClip, fragment: vec4f(1, 0, 0, 1) }));
    mesh.position[2] = 500;
    mesh.updateWorldMatrix();
    return mesh;
}

function lookingAtOrigin(): PerspectiveCamera {
    const camera = new PerspectiveCamera(Math.PI / 3, 1, 0.1, 100);
    camera.position[2] = 5;
    camera.lookAt([0, 0, 0]);
    camera.updateWorldMatrix();
    camera.updateViewMatrix();
    camera.updateProjectionMatrix();
    return camera;
}

/** lib draws its world batches with `draw`, so neither walk flag may reach it. */
test('draw() ignores visible and frustumCulled, and the walk reads both', () => {
    const encoded: PassEntry[][] = [];
    const frame = createFrame(capturing(encoded));
    beginFrame(frame);

    const mesh = offCameraBox();
    mesh.visible = false;
    const pass = frame.pass({ target });
    pass.draw(mesh);
    pass.end();

    expect(encoded[0]).toHaveLength(1);

    const scene = new Scene();
    scene.add(mesh);
    scene.updateWorldMatrix();
    const camera = lookingAtOrigin();
    const walk = () => collectRenderList(createRenderListsState(), scene, camera).opaque.length;

    expect(walk(), 'invisible').toBe(0);
    mesh.visible = true;
    expect(walk(), 'visible but outside the frustum').toBe(0);
    mesh.frustumCulled = false;
    expect(walk(), 'frustum culling opted out of').toBe(1);
});
