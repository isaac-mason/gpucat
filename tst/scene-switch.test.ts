/// <reference types="@webgpu/types" />

import { beforeAll, expect, test } from 'vitest';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

beforeAll(() => {
    installWebGPUPolyfills();
});

import { PerspectiveCamera } from '../src/camera/perspective-camera';
import type { Geometry } from '../src/geometry/geometry';
import { createBoxGeometry } from '../src/geometry/geometry-helpers';
import { Material } from '../src/material/material';
import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    f32,
    frameGroup,
    modelWorldMatrix,
    mul,
    texture,
    Uniform,
    uniform,
    vec2,
    vec4,
} from '../src/nodes/nodes';
import { Mesh } from '../src/objects/mesh';
import { createCanvasTarget } from '../src/renderer/core/canvas-target';
import { frame } from '../src/renderer/core/frame';
import { Renderer } from '../src/renderer/core/renderer';
import { getDrawArenaStats } from '../src/renderer/webgpu/draw-arena';
import { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import { drawScene } from '../src/scene/draw-scene';
import { Scene } from '../src/scene/scene';
import * as d from '../src/schema/schema';
import { createDataTexture, type DataTexture } from '../src/texture/data-texture';

/** What a scene was built from, to dispose: a level's own materials, geometries and textures. */
type Built = { scene: Scene; materials: Material[]; geometries: Geometry[]; textures: DataTexture[] };

/**
 * A level: `kinds` materials, each its own shader (a fragment of its own), reading a frame uniform of its own and one
 * the level shares, and a texture of its own, drawn over `perKind` meshes of their own geometry.
 */
function buildLevel(name: string, kinds: number, perKind: number): Built {
    const scene = new Scene();
    const materials: Material[] = [];
    const geometries: Geometry[] = [];
    const textures: DataTexture[] = [];
    const shared = new Uniform(d.f32, 0.5, frameGroup, `${name}Shared`);
    const position = attribute('position', d.vec3f);
    const clip = mul(cameraProjectionMatrix, mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(position, f32(1)))));
    for (let kind = 0; kind < kinds; kind++) {
        const own = new Uniform(d.f32, kind / kinds, frameGroup, `${name}Own${kind}`);
        const tex = createDataTexture(new Uint8Array([255, kind, 0, 255]), 1, 1);
        textures.push(tex);
        const sampled = texture(tex).sample(vec2(f32(0.5), f32(0.5)));
        const material = new Material({
            vertex: clip,
            fragment: vec4(sampled.x.mul(uniform(shared)), uniform(own), f32(kind), f32(1)),
        });
        materials.push(material);
        for (let index = 0; index < perKind; index++) {
            const geometry = createBoxGeometry(1, 1, 1);
            geometries.push(geometry);
            const mesh = new Mesh(geometry, material);
            // inside the view, so the cull keeps every one and each takes its block
            mesh.position[0] = (index % 5) - 2;
            scene.add(mesh);
        }
    }
    scene.updateWorldMatrix();
    return { scene, materials, geometries, textures };
}

function disposeLevel(level: Built): void {
    for (const material of level.materials) material.dispose();
    for (const geometry of level.geometries) geometry.dispose();
    for (const tex of level.textures) tex.dispose();
}

async function newRenderer() {
    const stub = createStubGPU();
    const renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));
    await renderer.init();
    const view = createCanvasTarget(stub.canvas);
    const camera = new PerspectiveCamera(Math.PI / 4, 1, 0.1, 100);
    camera.position[2] = 5;
    camera.updateWorldMatrix();
    camera.updateViewMatrix();
    /** A frame, then a turn of the event loop so a remapped staging buffer comes back, as between real frames. */
    const render = async (scene: Scene) => {
        const f = frame(renderer);
        const pass = f.pass({ target: view, camera });
        drawScene(renderer, pass, scene, camera);
        pass.end();
        f.submit();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    };
    return { renderer, render };
}

/** Everything the renderer holds that a scene put there, by count. */
function held(renderer: Renderer<WebGPUBackend>) {
    const backend = renderer.backend;
    const memory = renderer.info.memory;
    return {
        renderObjects: renderer._renderObjects.renderObjects.size,
        shaderStates: renderer._nodes.renderStates.size,
        renderPipelines: backend.pipelines.renderPipelines.size,
        bindGroups: backend.bindGroupCache.groups.size,
        arena: getDrawArenaStats(backend.buffers.drawArena),
        buffers: memory.buffers,
        buffersSize: memory.buffersSize,
        textures: memory.textures,
        geometries: memory.geometries,
        samplers: memory.samplers,
    };
}

test('a renderer that built a level, disposed it and built another holds what a fresh one with the second does', async () => {
    const fresh = await newRenderer();
    const level = buildLevel('b', 3, 4);
    await fresh.render(level.scene);
    await fresh.render(level.scene);
    const freshHeld = held(fresh.renderer);

    const switched = await newRenderer();
    const a = buildLevel('a', 6, 8);
    await switched.render(a.scene);
    await switched.render(a.scene);
    disposeLevel(a);
    const b = buildLevel('b', 3, 4);
    await switched.render(b.scene);
    await switched.render(b.scene);
    expect(held(switched.renderer)).toEqual(freshHeld);
});

test('a level disposed and built again holds what it held the first time', async () => {
    const renderer = await newRenderer();
    const first = buildLevel('a', 4, 4);
    await renderer.render(first.scene);
    await renderer.render(first.scene);
    const once = held(renderer.renderer);
    disposeLevel(first);
    const again = buildLevel('a', 4, 4);
    await renderer.render(again.scene);
    await renderer.render(again.scene);
    expect(held(renderer.renderer)).toEqual(once);
});

test('a level that needed many draw arena pages leaves none behind once disposed', async () => {
    const fresh = await newRenderer();
    const small = buildLevel('b', 1, 4);
    await fresh.render(small.scene);
    await fresh.render(small.scene);

    const switched = await newRenderer();
    // past one page: a page holds 1 MB of 256-byte slots
    const big = buildLevel('a', 1, 5000);
    await switched.render(big.scene);
    expect(held(switched.renderer).arena.pages).toBeGreaterThan(1);
    disposeLevel(big);
    const again = buildLevel('b', 1, 4);
    await switched.render(again.scene);
    await switched.render(again.scene);
    expect(held(switched.renderer)).toEqual(held(fresh.renderer));
});
