/* The buffer paths' memory tally: allocate, grow and dispose, uniform blocks released by their owner. */

import { describe, expect, test } from 'vitest';
import { GpuBuffer } from '../src/core/gpu-buffer';
import { d } from '../src/index';
import type { Material } from '../src/material/material';
import type { UniformGroupBlock } from '../src/nodes/builder';
import type { Mesh } from '../src/objects/mesh';
import { createUniformBindGroup, type UniformBinding } from '../src/renderer/core/bind-group';
import { createMemoryTally, createRendererInfo, type MemoryTally } from '../src/renderer/core/info';
import type { RenderContext } from '../src/renderer/core/pass-context';
import { disposeRenderObject } from '../src/renderer/core/render-object';
import * as RenderObjects from '../src/renderer/core/render-objects';
import type { View } from '../src/renderer/core/view';
import * as GlBuffers from '../src/renderer/webgl/buffers';
import * as GpuBuffers from '../src/renderer/webgpu/buffers';
import { installWebGPUPolyfills } from './stub-gpu';

installWebGPUPolyfills();

const ARRAY_BUFFER = 0x8892;

function fakeDevice() {
    const destroyed: number[] = [];
    let next = 1;
    const device = {
        createBuffer(desc: GPUBufferDescriptor): GPUBuffer {
            const id = next++;
            return { size: desc.size, destroy: () => void destroyed.push(id) } as unknown as GPUBuffer;
        },
        queue: { writeBuffer: () => {} },
    } as unknown as GPUDevice;
    return { device, destroyed };
}

function fakeGl() {
    let next = 1;
    const deleted: number[] = [];
    const gl = {
        createBuffer: () => next++ as unknown as WebGLBuffer,
        deleteBuffer: (b: WebGLBuffer) => void deleted.push(b as unknown as number),
        bindBuffer: () => {},
        bufferData: () => {},
        bufferSubData: () => {},
    } as unknown as WebGL2RenderingContext;
    return { gl, deleted };
}

function vertexBuffer(floats: number, label?: string) {
    return new GpuBuffer(d.vec3f, { data: new Float32Array(floats), usage: 'vertex', label });
}

function grow(buffer: GpuBuffer, floats: number) {
    buffer.array = new Float32Array(floats) as never;
    buffer.needsUpdate = true;
}

function expectEmpty(tally: MemoryTally) {
    expect(tally.buffers).toBe(0);
    expect(tally.buffersSize).toBe(0);
    expect(tally.byCategory.size).toBe(0);
    expect(tally.live.size).toBe(0);
}

describe('webgpu', () => {
    test('a buffer counts its device size under its usage and label, a grow moves the bytes, dispose clears it', () => {
        const { device } = fakeDevice();
        const tally = createMemoryTally();
        const cache = GpuBuffers.createBufferCache(createRendererInfo(), tally);
        const buffer = vertexBuffer(9, 'mesh/positions');

        GpuBuffers.ensureUploaded(cache, device, buffer, 'position');
        expect(tally.buffers).toBe(1);
        expect(tally.buffersSize).toBe(36);
        expect(tally.byCategory.get('buffer/vertex')).toBe(36);
        expect([...tally.live][0]!.label).toBe('mesh/positions');

        grow(buffer, 30);
        GpuBuffers.ensureUploaded(cache, device, buffer, 'position');
        expect(tally.buffers).toBe(1);
        expect(tally.buffersSize).toBe(120);

        buffer.dispose();
        expectEmpty(tally);
    });

    test('an unlabelled buffer takes the name its upload site gives it', () => {
        const { device } = fakeDevice();
        const tally = createMemoryTally();
        const cache = GpuBuffers.createBufferCache(createRendererInfo(), tally);
        GpuBuffers.ensureUploaded(cache, device, vertexBuffer(3), 'normal');
        expect([...tally.live][0]!.label).toBe('normal');
    });

    test('a uniform block counts until its owner releases it, and the release destroys it', () => {
        const { device, destroyed } = fakeDevice();
        const tally = createMemoryTally();
        const cache = GpuBuffers.createBufferCache(createRendererInfo(), tally);
        const key = {};

        GpuBuffers.uploadUniformBlock(cache, device, key, new ArrayBuffer(64), { material: 'water' });
        expect(tally.byCategory.get('buffer/uniform')).toBe(64);
        expect([...tally.live][0]!.label).toBe('water');
        expect(cache.rawCount).toBe(1);

        GpuBuffers.releaseUniformBlock(cache, key);
        expect(destroyed).toHaveLength(1);
        expect(cache.rawCount).toBe(0);
        expect(GpuBuffers.getRaw(cache, key)).toBeUndefined();
        expectEmpty(tally);

        GpuBuffers.releaseUniformBlock(cache, key);
        expect(destroyed).toHaveLength(1);
    });
});

describe('webgl', () => {
    test('a buffer counts its size under its usage and label, a grow moves the bytes, dispose clears it', () => {
        const { gl } = fakeGl();
        const tally = createMemoryTally();
        const cache = GlBuffers.createBufferCache(createRendererInfo(), tally);
        const buffer = vertexBuffer(9, 'mesh/positions');

        GlBuffers.ensureUploaded(gl, cache, buffer, ARRAY_BUFFER, 'position');
        expect(tally.buffers).toBe(1);
        expect(tally.buffersSize).toBe(36);
        expect(tally.byCategory.get('buffer/vertex')).toBe(36);

        grow(buffer, 30);
        GlBuffers.ensureUploaded(gl, cache, buffer, ARRAY_BUFFER, 'position');
        expect(tally.buffers).toBe(1);
        expect(tally.buffersSize).toBe(120);

        buffer.dispose();
        expectEmpty(tally);
    });

    test('a uniform block counts until its owner releases it, and the release deletes it', () => {
        const { gl, deleted } = fakeGl();
        const tally = createMemoryTally();
        const cache = GlBuffers.createBufferCache(createRendererInfo(), tally);
        const key = {};

        GlBuffers.uploadUniformBlock(gl, cache, key, new ArrayBuffer(64), { material: 'water' });
        expect(tally.byCategory.get('buffer/uniform')).toBe(64);

        GlBuffers.releaseUniformBlock(gl, cache, key);
        expect(deleted).toHaveLength(1);
        expect(cache.rawCount).toBe(0);
        expectEmpty(tally);
    });
});

describe('render objects', () => {
    test('disposing one releases the uniform blocks of its own groups, never the shared ones', () => {
        const released: object[] = [];
        const state = RenderObjects.createRenderObjectsState({ releaseUniformBlock: (key) => void released.push(key) });
        const mesh = { geometry: {} } as unknown as Mesh;
        const material = {} as unknown as Material;
        const renderObject = RenderObjects.getRenderObject(state, mesh, material, {} as View, {} as RenderContext);

        const own = createUniformBindGroup({ groupName: 'object', groupIndex: 2, shared: false } as UniformGroupBlock);
        const shared = createUniformBindGroup({ groupName: 'render', groupIndex: 0, shared: true } as UniformGroupBlock);
        const ownKey = {};
        (own.bindings[0] as UniformBinding).bufferKey = ownKey;
        (shared.bindings[0] as UniformBinding).bufferKey = {};
        renderObject._bindings = [shared, own];

        disposeRenderObject(renderObject);
        expect(released).toEqual([ownKey]);
        expect(state.renderObjects.size).toBe(0);
    });
});
