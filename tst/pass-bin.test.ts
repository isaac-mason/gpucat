/// <reference types="@webgpu/types" />

import { beforeAll, expect, test } from 'vitest';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

beforeAll(() => {
    installWebGPUPolyfills();
});

import { PerspectiveCamera } from '../src/camera/perspective-camera';
import { createRenderTarget } from '../src/core/render-target';
import { renderGroup } from '../src/core/uniform';
import { createBoxGeometry } from '../src/geometry/geometry-helpers';
import { Material } from '../src/material/material';
import { attribute, cameraProjectionMatrix, cameraViewMatrix, f32, modelWorldMatrix, mul, vec4 } from '../src/nodes/nodes';
import { Mesh } from '../src/objects/mesh';
import { frame } from '../src/renderer/core/frame';
import type { PassOrder } from '../src/renderer/core/pass-order';
import type { PreparedRenderObject } from '../src/renderer/core/render-types';
import { Renderer } from '../src/renderer/core/renderer';
import { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import { Scene } from '../src/scene/scene';
import * as d from '../src/schema/schema';

/** A material whose fragment is `red`, so each red is a shader, and so a pipeline, of its own. */
function material(red: number): Material {
    const position = attribute('position', d.vec3f);
    const clip = mul(cameraProjectionMatrix, mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(position, f32(1)))));
    return new Material({ vertex: clip, fragment: vec4(f32(red), f32(0), f32(0), f32(1)) });
}

function box(name: string, mat: Material, z = 0): Mesh {
    const mesh = new Mesh(createBoxGeometry(1, 1, 1), mat);
    mesh.name = name;
    mesh.position[2] = z;
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

type OpenPassSlots = { _frame: { openByDepth: { prepared: PreparedRenderObject[]; order: PassOrder }[] } };

async function setup() {
    const stub = createStubGPU();
    const renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));
    await renderer.init();
    const target = createRenderTarget(64, 64, { colorFormat: 'rgba8unorm' });
    const camera = cameraAt(10);
    /** The names of the meshes the last outermost pass encoded, in the order it encoded them. */
    const encoded = () => {
        const open = (renderer.backend as unknown as OpenPassSlots)._frame.openByDepth[0]!;
        const names: string[] = [];
        for (let blockIndex = 0; blockIndex < open.order.blockCount; blockIndex++) {
            const block = open.order.blocks[blockIndex]!;
            for (let at = 0; at < block.count; at++) names.push(open.prepared[block.draws[at]!]!.mesh.name);
        }
        return names;
    };
    const record = (body: (pass: ReturnType<ReturnType<typeof frame>['pass']>) => void) => {
        const f = frame(renderer);
        const pass = f.pass({ target, camera });
        body(pass);
        pass.end();
        f.submit();
    };
    return { stub, renderer, record, encoded };
}

test("a 'state' bin groups draws by pipeline, in the order each was first drawn, keeping the drawn order within one", async () => {
    const { record, encoded } = await setup();
    const red = material(1);
    const blue = material(0.5);
    record((pass) => {
        const opaque = pass.bin({ key: 'state' });
        opaque.draw(box('red-0', red));
        opaque.draw(box('blue-0', blue));
        opaque.draw(box('red-1', red));
        opaque.draw(box('blue-1', blue));
    });
    expect(encoded()).toEqual(['red-0', 'red-1', 'blue-0', 'blue-1']);
});

test('a sortKey ranks above every other field, lowest first', async () => {
    const { record, encoded } = await setup();
    const red = material(1);
    const blue = material(0.5);
    record((pass) => {
        const opaque = pass.bin({ key: 'state' });
        opaque.draw(box('red-late', red), { sortKey: 1 });
        opaque.draw(box('blue', blue));
        opaque.draw(box('red', red));
    });
    expect(encoded()).toEqual(['red', 'blue', 'red-late']);
});

test("a 'back-to-front' bin draws the farthest from its camera first", async () => {
    const { record, encoded } = await setup();
    const glass = material(1);
    record((pass) => {
        const blended = pass.bin({ key: 'back-to-front' });
        blended.draw(box('middle', glass, 0));
        blended.draw(box('near', glass, 3));
        blended.draw(box('far', glass, -5));
    });
    expect(encoded()).toEqual(['far', 'middle', 'near']);
});

test("a 'submission' bin keeps the order its draws were drawn in", async () => {
    const { record, encoded } = await setup();
    const red = material(1);
    const blue = material(0.5);
    record((pass) => {
        const kept = pass.bin({ key: 'submission' });
        kept.draw(box('red-0', red));
        kept.draw(box('blue', blue));
        kept.draw(box('red-1', red));
    });
    expect(encoded()).toEqual(['red-0', 'blue', 'red-1']);
});

test("a bin's draws run where the bin was made, between the pass's own draws before and after it", async () => {
    const { record, encoded } = await setup();
    const red = material(1);
    record((pass) => {
        pass.draw(box('before', red));
        const bin = pass.bin({ key: 'state' });
        pass.draw(box('after', red));
        bin.draw(box('binned', red));
    });
    expect(encoded()).toEqual(['before', 'binned', 'after']);
});

test('a draw ordered away from its view still draws into the viewport it was drawn under', async () => {
    const { stub, record, encoded } = await setup();
    const red = material(1);
    const blue = material(0.5);
    stub.stats.reset();
    record((pass) => {
        const casters = pass.bin({ key: ['pipeline', 'view'] });
        pass.setViewport({ x: 0, y: 0, width: 32, height: 64 });
        casters.draw(box('red-left', red));
        casters.draw(box('blue-left', blue));
        pass.setViewport({ x: 32, y: 0, width: 32, height: 64 });
        casters.draw(box('red-right', red));
        casters.draw(box('blue-right', blue));
    });
    expect(encoded()).toEqual(['red-left', 'red-right', 'blue-left', 'blue-right']);
    expect(stub.stats.passCommands.filter((command) => command !== 'draw' && !command.startsWith('scissor'))).toEqual([
        'viewport 0 0 32 64',
        'viewport 32 0 32 64',
        'viewport 0 0 32 64',
        'viewport 32 0 32 64',
    ]);
});

test("a draw ordered away from its camera binds that camera's view block, packed once for the camera", async () => {
    const { stub, record } = await setup();
    const red = material(1);
    const blue = material(0.5);
    const near = cameraAt(4);
    const far = cameraAt(20);
    stub.stats.reset();
    record((pass) => {
        const casters = pass.bin({ key: ['pipeline'] });
        pass.setCamera(near);
        casters.draw(box('red-near', red));
        casters.draw(box('blue-near', blue));
        pass.setCamera(far);
        casters.draw(box('red-far', red));
        casters.draw(box('blue-far', blue));
    });
    // the view block is the render group's, bound at its camera's ring offset: red-near, red-far, blue-near, blue-far
    const viewOffsets = stub.stats.bindGroupSets.filter((set) => set.index === renderGroup.order).map((set) => set.offsets[0]);
    expect(viewOffsets).toHaveLength(4);
    expect(new Set(viewOffsets).size).toBe(2);
    expect(viewOffsets[0]).not.toBe(viewOffsets[1]);
    expect(viewOffsets[0]).toBe(viewOffsets[2]);
    expect(viewOffsets[1]).toBe(viewOffsets[3]);
});

test('a bin key refuses a field it does not know, one named twice, and a preset that does not exist', async () => {
    const { record } = await setup();
    record((pass) => {
        expect(() => pass.bin({ key: ['pipeline', 'pipeline'] })).toThrow(/names 'pipeline' twice/);
        expect(() => pass.bin({ key: ['shader' as never] })).toThrow(/'shader' is not a bin key field/);
        expect(() => pass.bin({ key: 'front-to-back' as never })).toThrow(/is none of/);
        expect(() => pass.bin({ key: [{ depthNear: 60 }] })).toThrow(/1 to 52 bits/);
    });
});

test('a field with more distinct values than its bits fails at end(), naming the field', async () => {
    const { renderer } = await setup();
    const target = createRenderTarget(64, 64, { colorFormat: 'rgba8unorm' });
    const f = frame(renderer);
    const pass = f.pass({ target, camera: cameraAt(10) });
    const bin = pass.bin({ key: [{ material: 1 }] });
    for (let index = 0; index < 3; index++) bin.draw(box(`box-${index}`, material(index / 4)));
    expect(() => pass.end()).toThrow(/'material' has 3 distinct values, past its 1 bits/);
    f.abandon();
});

test('a sortKey on a draw outside a bin, and a draw into a bin after its pass ended, are refused', async () => {
    const { renderer } = await setup();
    const target = createRenderTarget(64, 64, { colorFormat: 'rgba8unorm' });
    const red = material(1);
    const f = frame(renderer);
    const pass = f.pass({ target, camera: cameraAt(10) });
    expect(() => pass.draw(box('keyed', red), { sortKey: 1 } as never)).toThrow(/a sortKey orders draws in a bin/);
    const bin = pass.bin({ key: 'state' });
    pass.end();
    expect(() => bin.draw(box('late', red))).toThrow(/after end\(\)/);
    f.submit();
});

/** A scene of `meshes`, their world matrices current. */
function sceneOf(...meshes: Mesh[]): Scene {
    const scene = new Scene();
    for (const mesh of meshes) scene.add(mesh);
    scene.updateWorldMatrix();
    return scene;
}

function transparent(red: number): Material {
    const mat = material(red);
    mat.transparent = true;
    return mat;
}

test('pass.scene draws transparent meshes farthest first, after every opaque one', async () => {
    const { record, encoded } = await setup();
    const glass = transparent(1);
    const scene = sceneOf(box('glass-near', glass, 3), box('solid', material(1), 0), box('glass-far', glass, -5));
    record((pass) => pass.scene(scene));
    expect(encoded()).toEqual(['solid', 'glass-far', 'glass-near']);
});

test('pass.scene groups opaque meshes by pipeline, nearest first within one', async () => {
    const { record, encoded } = await setup();
    const red = material(1);
    const blue = material(0.5);
    const scene = sceneOf(box('red-far', red, -5), box('blue-near', blue, 3), box('red-near', red, 3), box('blue-far', blue, -5));
    record((pass) => pass.scene(scene));
    expect(encoded()).toEqual(['red-near', 'red-far', 'blue-near', 'blue-far']);
});

test("pass.scene puts a mesh's renderOrder above its pipeline and depth", async () => {
    const { record, encoded } = await setup();
    const red = material(1);
    const last = box('last', red, 3);
    last.renderOrder = 1;
    const scene = sceneOf(last, box('red', red, 0), box('blue', material(0.5), -5));
    record((pass) => pass.scene(scene));
    expect(encoded()).toEqual(['red', 'blue', 'last']);
});
