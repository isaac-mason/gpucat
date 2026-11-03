/// <reference types="@webgpu/types" />

import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { Renderer } from '../src/renderer/core/renderer';
import { createStubGPU, installWebGPUPolyfills, type StubGPUResult } from './stub-gpu';

beforeAll(() => {
    installWebGPUPolyfills();
});

import { PerspectiveCamera } from '../src/camera/perspective-camera';
import { Object3D } from '../src/core/object3d';
import { createBoxGeometry } from '../src/geometry/geometry-helpers';
import { Material } from '../src/material/material';
import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    f32,
    modelWorldMatrix,
    mul,
    objectGroup,
    Uniform,
    UniformNode,
    uniform,
    vec4,
} from '../src/nodes/nodes';
import { Mesh } from '../src/objects/mesh';
import { type CanvasTarget, createCanvasTarget } from '../src/renderer/core/canvas-target';
import { frame } from '../src/renderer/core/frame';
import { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import { drawScene } from '../src/scene/draw-scene';
import { Scene } from '../src/scene/scene';
import * as d from '../src/schema/schema';

let stub: StubGPUResult;
let renderer: Renderer<WebGPUBackend>;
let view: CanvasTarget;
let scene: Scene;
let camera: PerspectiveCamera;

beforeEach(async () => {
    stub = createStubGPU();
    renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));
    await renderer.init();
    view = createCanvasTarget(stub.canvas);
    scene = new Scene();
    camera = new PerspectiveCamera(Math.PI / 4, 800 / 600, 0.1, 100);
    camera.position[2] = 5;
    scene.add(camera);
    scene.updateWorldMatrix();
    camera.updateViewMatrix();
});

function renderFrame(): void {
    const f = frame(renderer);
    const pass = f.pass({ target: view, camera });
    drawScene(renderer, pass, scene, camera);
    pass.end();
    f.submit();
}

/** A mesh whose block holds its world matrix (the built-in, filled from the object) and a value uniform; an optional
 *  object callback counts its own runs. */
function addMesh(tint: Uniform<d.f32>, withCallback: boolean) {
    let runs = 0;
    const position = attribute('position', d.vec3f);
    const clip = mul(cameraProjectionMatrix, mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(position, f32(1)))));
    let fragment = vec4(uniform(tint), f32(0), f32(0), f32(1));
    if (withCallback) {
        const counted = new UniformNode(new Uniform(d.f32, 0, objectGroup), 'counted').onObjectUpdate((f) => {
            runs++;
            return f.object!.position[0];
        });
        fragment = vec4(uniform(tint), counted, f32(0), f32(1));
    }
    const mesh = new Mesh(createBoxGeometry(1, 1, 1), new Material({ vertex: clip, fragment }));
    scene.add(mesh);
    mesh.updateWorldMatrix();
    return { mesh, runs: () => runs };
}

/** How often a pack fills the built-in world matrix in, which a block that is not packed again never does. */
let packs = 0;
const worldUniform = modelWorldMatrix.uniform;
const valueProperty = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(worldUniform), 'value')!;
beforeEach(() => {
    packs = 0;
    Object.defineProperty(worldUniform, 'value', {
        configurable: true,
        get: () => valueProperty.get!.call(worldUniform),
        set: (value) => {
            packs++;
            valueProperty.set!.call(worldUniform, value);
        },
    });
});
afterEach(() => {
    delete (worldUniform as { value?: unknown }).value;
});

/** Recomputes the scene's world matrices, draws a frame, and gives the packs it made. */
function updateAndRender(): number {
    scene.updateWorldMatrix();
    packs = 0;
    renderFrame();
    return packs;
}

test('an object nothing changed is not packed again, and nothing is written', () => {
    const tint = new Uniform(d.f32, 0.5, objectGroup);
    addMesh(tint, false);
    expect(updateAndRender()).toBe(1);
    stub.stats.reset();
    expect(updateAndRender()).toBe(0);
    expect(updateAndRender()).toBe(0);
    expect(stub.stats.bufferWrites).toBe(0);
    // the frame's counters say the same: the object's block was kept; the view block packed, as it does at every pass
    expect(renderer.info.state.kept).toBe(1);
    expect(renderer.info.state.packed).toBe(1);
});

test('a moved object is packed again, and so is a child its parent moved', () => {
    const tint = new Uniform(d.f32, 0.5, objectGroup);
    const parent = new Object3D();
    scene.add(parent);
    const { mesh } = addMesh(tint, false);
    parent.add(mesh);
    updateAndRender();
    expect(updateAndRender()).toBe(0);

    mesh.position[0] = 1;
    expect(updateAndRender()).toBe(1);
    expect(updateAndRender()).toBe(0);

    parent.position[1] = 1;
    expect(updateAndRender()).toBe(1);
});

test('assigning a value is seen; a change in place is seen only once needsUpdate is set', () => {
    const tint = new Uniform(d.f32, 0.5, objectGroup);
    const offset = new Uniform(d.vec4f, new Float32Array(4), objectGroup);
    const position = attribute('position', d.vec3f);
    const clip = mul(cameraProjectionMatrix, mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(position, f32(1)))));
    const material = new Material({ vertex: clip.add(uniform(offset)), fragment: vec4(uniform(tint), f32(0), f32(0), f32(1)) });
    const mesh = new Mesh(createBoxGeometry(1, 1, 1), material);
    scene.add(mesh);
    mesh.updateWorldMatrix();
    renderFrame();

    stub.stats.reset();
    tint.value = 0.75;
    renderFrame();
    expect(stub.stats.bufferWrites).toBe(1);

    stub.stats.reset();
    (offset.value as Float32Array)[0] = 2;
    renderFrame();
    expect(stub.stats.bufferWrites).toBe(0);

    offset.needsUpdate = true;
    renderFrame();
    expect(stub.stats.bufferWrites).toBe(1);
});

test('an object callback runs at every draw, since what it reads has no version', () => {
    const tint = new Uniform(d.f32, 0.5, objectGroup);
    const { runs } = addMesh(tint, true);
    renderFrame();
    renderFrame();
    renderFrame();
    expect(runs()).toBe(3);
});

test("updateWorldMatrix moves an object's world version only when the matrix changes", () => {
    const object = new Object3D();
    object.updateWorldMatrix();
    const still = object.worldMatrixVersion;
    object.updateWorldMatrix();
    expect(object.worldMatrixVersion).toBe(still);

    object.position[2] = 3;
    object.updateWorldMatrix();
    expect(object.worldMatrixVersion).not.toBe(still);
});

/** Draws one frame of a pass per camera, in order. */
function renderCameras(...cameras: PerspectiveCamera[]): void {
    const f = frame(renderer);
    for (const each of cameras) {
        const pass = f.pass({ target: view, camera: each });
        drawScene(renderer, pass, scene, each);
        pass.end();
    }
    f.submit();
}

/** A second camera behind and beside the first, looking at the same mesh. */
function addCamera(): PerspectiveCamera {
    const other = new PerspectiveCamera(Math.PI / 4, 800 / 600, 0.1, 100);
    other.position[0] = 1;
    other.position[2] = 6;
    scene.add(other);
    other.updateWorldMatrix();
    other.updateViewMatrix();
    return other;
}

test('a view block is packed at every pass into the ring, never written to a buffer of its own', () => {
    addMesh(new Uniform(d.f32, 0.5, objectGroup), false);
    const other = addCamera();
    renderCameras(camera, other);

    stub.stats.reset();
    renderCameras(camera, other);
    // both passes packed their view; the mesh's block was kept in both
    expect(renderer.info.state.packed).toBe(2);
    expect(renderer.info.state.kept).toBe(2);
    expect(renderer.info.buffers.dynamicAllocations).toBe(2);
    // the views reach the GPU through the ring's copy, and nothing else changed
    expect(stub.stats.bufferWrites).toBe(0);
    expect(stub.stats.bufferCopies).toBe(1);

    // a moved camera is the same: still no write of a buffer of its own
    stub.stats.reset();
    camera.position[2] = 7;
    camera.updateWorldMatrix();
    camera.updateViewMatrix();
    renderCameras(camera, other);
    expect(stub.stats.bufferWrites).toBe(0);
});

test("a pass's draws bind its view group at that pass's offset", () => {
    for (let index = 0; index < 3; index++) addMesh(new Uniform(d.f32, index, objectGroup), false);
    const other = addCamera();
    renderCameras(camera, other);
    stub.stats.reset();
    renderCameras(camera, other);

    const viewSets = stub.stats.bindGroupSets.filter((set) => set.index === 1);
    expect(viewSets.length).toBeGreaterThan(0);
    // one ring buffer holds both views: the same group, bound at each pass's own offset
    const groups = new Set(viewSets.map((set) => set.group));
    const offsets = new Set(viewSets.map((set) => set.offsets[0]));
    expect(groups.size).toBe(1);
    expect(offsets.size).toBe(2);
});
