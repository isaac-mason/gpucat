/// <reference types="@webgpu/types" />

import { beforeAll, expect, test } from 'vitest';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

beforeAll(() => {
    installWebGPUPolyfills();
});

import { createRenderTarget } from '../src/core/render-target';
import { compileGlsl, compileWgsl } from '../src/nodes/builder';
import { f32, frameGroup, Uniform, uniform, vec4 } from '../src/nodes/nodes';
import { fullscreen } from '../src/objects/fullscreen';
import { frame } from '../src/renderer/core/frame';
import { createMemoryTally, createRendererInfo } from '../src/renderer/core/info';
import { NodeFrame } from '../src/renderer/core/node-frame';
import { setSharedPlacement } from '../src/renderer/core/node-manager';
import { getBindings } from '../src/renderer/core/render-object';
import { Renderer } from '../src/renderer/core/renderer';
import { createSharedBlocks, placeSharedMembers, syncSharedBlock } from '../src/renderer/core/shared-blocks';
import { createBufferCache, uploadSharedBlock as uploadSharedBlockGl } from '../src/renderer/webgl/buffers';
import { createGlState } from '../src/renderer/webgl/state';
import { WebGPUBackend } from '../src/renderer/webgpu/webgpu-backend';
import * as d from '../src/schema/schema';

async function setup() {
    const stub = createStubGPU();
    const renderer = new Renderer(new WebGPUBackend(stub.getRendererOptions()));
    await renderer.init();
    const target = createRenderTarget(16, 16, { colorFormat: 'rgba8unorm' });
    const draw = (...meshes: ReturnType<typeof fullscreen>[]) => {
        const f = frame(renderer);
        const pass = f.pass({ target, clear: [0, 0, 0, 1] });
        for (const mesh of meshes) pass.draw(mesh);
        pass.end();
        f.submit();
    };
    return { stub, renderer, draw };
}

/** A fullscreen draw whose colour reads `uniforms`, so its frame block holds each of them. */
function reading(...uniforms: Uniform<d.f32>[]) {
    let red = f32(0);
    for (const u of uniforms) red = red.add(uniform(u));
    const mesh = fullscreen(vec4(red, f32(0), f32(0), f32(1)));
    mesh.material.depthTest = false;
    mesh.updateWorldMatrix();
    return mesh;
}

/** The renderer's frame block. */
const frameBlock = (renderer: Renderer<WebGPUBackend>) => renderer._nodes.sharedBlocks.groupToBlock.get(frameGroup)!;

test('shaders reading different frame uniforms share one binding over one block holding all of them', async () => {
    const { renderer, draw } = await setup();
    const a = new Uniform(d.f32, 0.25, frameGroup, 'a');
    const b = new Uniform(d.f32, 0.5, frameGroup, 'b');
    const c = new Uniform(d.f32, 0.75, frameGroup, 'c');
    const first = reading(a, b);
    const second = reading(b, c);
    draw(first, second);

    const block = frameBlock(renderer);
    expect(block.block.members.map((m) => m.node.uniform.label).sort()).toEqual(['a', 'b', 'c']);
    // one cached group, so one binding and one buffer, for both shaders' draws
    const objects = [...renderer._renderObjects.renderObjects];
    const frameGroups = objects.map((object) =>
        getBindings(object).find((group) => group.shared && group.name.includes('frame')),
    );
    expect(frameGroups[0]).toBeDefined();
    expect(frameGroups[0]).toBe(frameGroups[1]);
});

test('a frame with no frame uniform written uploads nothing to the block, and one written uploads its slot alone', async () => {
    const { renderer, draw } = await setup();
    const a = new Uniform(d.f32, 0.25, frameGroup, 'a');
    const b = new Uniform(d.f32, 0.5, frameGroup, 'b');
    const mesh = reading(a, b);
    renderer.info.buffers.detailedWrites = true;
    draw(mesh);
    const blockWrites = () =>
        renderer.info.buffers.writes.slice(0, renderer.info.buffers.writeCount).filter((w) => w.label === 'shared-frame');

    draw(mesh);
    expect(blockWrites()).toEqual([]);

    b.value = 0.6;
    draw(mesh);
    expect(blockWrites().map((w) => w.bytes)).toEqual([16]);
});

test('a Uniform read through two nodes is one member', async () => {
    const { renderer, draw } = await setup();
    const a = new Uniform(d.f32, 0.25, frameGroup, 'a');
    const mesh = fullscreen(vec4(uniform(a), uniform(a), f32(0), f32(1)));
    mesh.material.depthTest = false;
    mesh.updateWorldMatrix();
    draw(mesh);
    expect(frameBlock(renderer).block.members).toHaveLength(1);
});

test('a shader reading only a later member declares the slots before it as a gap, in both languages', () => {
    const a = new Uniform(d.f32, 0.25, frameGroup, 'a');
    const b = new Uniform(d.vec2f, [1, 2], frameGroup, 'b');
    const fragmentFor = (...us: Uniform<d.Any>[]) =>
        vec4(...([...us.map((u) => uniform(u)), f32(0), f32(1)].slice(0, 4) as [any, any, any, any]));
    for (const [layout, compile] of [
        ['wgsl-uniform', (slots: Parameters<typeof compileWgsl>[0], shared: any) => compileWgsl(slots, { shared }).code],
        ['std140', (slots: Parameters<typeof compileGlsl>[0], shared: any) => compileGlsl(slots, { shared }).code],
    ] as const) {
        const shared = { blocks: createSharedBlocks(layout), maxBytes: 65536 };
        compile({ vertex: vec4(0, 0, 0, 1), fragment: vec4(uniform(a), f32(0), f32(0), f32(1)) }, shared);
        const code = compile({ vertex: vec4(0, 0, 0, 1), fragment: fragmentFor(b) }, shared);
        expect(code).toMatch(layout === 'std140' ? /uvec4 _gap0\[1\];/ : /_gap0: array<vec4<u32>, 1>/);
    }
});

test('a shared member past the device uniform block limit fails at compile, naming the sizes', async () => {
    const { renderer, draw } = await setup();
    setSharedPlacement(renderer._nodes, 32);
    const big = new Uniform(d.vec4f, [0, 0, 0, 0], frameGroup, 'big');
    const more = new Uniform(d.vec4f, [0, 0, 0, 0], frameGroup, 'more');
    const third = new Uniform(d.vec4f, [0, 0, 0, 0], frameGroup, 'third');
    const mesh = fullscreen(vec4(uniform(big).x, uniform(more).x, uniform(third).x, f32(1)));
    mesh.material.depthTest = false;
    mesh.updateWorldMatrix();
    expect(() => draw(mesh)).toThrow(/48 bytes.*32-byte uniform block limit/);
});

test("releasing a member's last reader frees its slots, and a new member takes them", async () => {
    const { renderer, draw } = await setup();
    const a = new Uniform(d.f32, 0.25, frameGroup, 'a');
    const b = new Uniform(d.f32, 0.5, frameGroup, 'b');
    const keep = reading(a);
    const drop = reading(b);
    draw(keep, drop);
    const bOffset = frameBlock(renderer).uniformToMember.get(b)!.offset;

    drop.material.dispose();
    expect(frameBlock(renderer).uniformToMember.has(b)).toBe(false);

    const c = new Uniform(d.f32, 0.75, frameGroup, 'c');
    draw(keep, reading(c));
    expect(frameBlock(renderer).uniformToMember.get(c)!.offset).toBe(bOffset);
});

test('a block outgrowing its buffer moves to a bigger one, the old one destroyed after the submit', async () => {
    const { stub, renderer, draw } = await setup();
    const first = new Uniform(d.f32, 0.25, frameGroup, 'first');
    draw(reading(first));
    const bigger = Array.from({ length: 8 }, (_, index) => new Uniform(d.vec4f, [index, 0, 0, 0], frameGroup, `v${index}`));
    stub.stats.reset();
    const f = frame(renderer);
    const target = createRenderTarget(16, 16, { colorFormat: 'rgba8unorm' });
    const pass = f.pass({ target, clear: [0, 0, 0, 1] });
    pass.draw(reading(first));
    const wide = fullscreen(vec4(...(bigger.slice(0, 4).map((u) => uniform(u).x) as [any, any, any, any])));
    wide.material.depthTest = false;
    wide.updateWorldMatrix();
    pass.draw(wide);
    pass.end();
    // replaced during the frame, still held for it
    expect(stub.stats.bufferDestroys).toBe(0);
    f.submit();
    expect(stub.stats.bufferDestroys).toBe(1);
    expect(frameBlock(renderer).block.totalBytes).toBeGreaterThan(16);
});

test('on WebGL a shared block uploads whole once, then only the slots that moved, and grows its UBO in place', () => {
    const calls: string[] = [];
    const gl = {
        UNIFORM_BUFFER: 0x8a11,
        DYNAMIC_DRAW: 0x88e8,
        createBuffer: () => 'ubo',
        bindBuffer: () => {},
        bufferData: (_target: number, data: ArrayBuffer) => void calls.push(`data ${data.byteLength}`),
        bufferSubData: (_target: number, offset: number, data: Uint8Array) => void calls.push(`sub ${offset} ${data.byteLength}`),
    } as unknown as WebGL2RenderingContext;
    const cache = createBufferCache(createRendererInfo(), createMemoryTally(), createGlState());
    const blocks = createSharedBlocks('std140');
    const a = new Uniform(d.f32, 0.25, frameGroup, 'a');
    const b = new Uniform(d.f32, 0.5, frameGroup, 'b');
    placeSharedMembers(blocks, frameGroup, [uniform(a), uniform(b)], 16384);
    const shared = blocks.groupToBlock.get(frameGroup)!;
    const nodeFrame = new NodeFrame();
    const sync = () => {
        nodeFrame.frameId++;
        syncSharedBlock(shared, nodeFrame);
        uploadSharedBlockGl(gl, cache, shared);
    };

    sync();
    expect(calls.splice(0)).toEqual(['data 32']);
    sync();
    expect(calls.splice(0)).toEqual([]);
    b.value = 0.6;
    sync();
    expect(calls.splice(0)).toEqual(['sub 16 16']);

    placeSharedMembers(blocks, frameGroup, [uniform(new Uniform(d.vec4f, [1, 2, 3, 4], frameGroup, 'c'))], 16384);
    sync();
    expect(calls.splice(0)).toEqual(['data 64']);
});
