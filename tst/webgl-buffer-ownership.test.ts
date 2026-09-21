import { expect, test } from 'vitest';
import { GpuBuffer } from '../src/core/gpu-buffer';
import { d } from '../src/index';
import { createRendererInfo } from '../src/renderer/core/info';
import { createBufferCache, ensureUploaded, getUploaded } from '../src/renderer/webgl/buffers';

const ARRAY_BUFFER = 0x8892;

/** Enough GL to watch buffer objects come and go; every call the cache makes is recorded. */
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
    return { gl, deleted, created: () => next - 1 };
}

function cacheAndBuffer() {
    const cache = createBufferCache(createRendererInfo());
    const buffer = new GpuBuffer(d.vec3f, { data: new Float32Array(9), usage: 'vertex' });
    return { cache, buffer };
}

/** The cache owns the GL object, so disposing the `GpuBuffer` has to release it. */
test('disposing a standalone GpuBuffer deletes its GL buffer', () => {
    const { gl, deleted } = fakeGl();
    const { cache, buffer } = cacheAndBuffer();

    const glBuffer = ensureUploaded(gl, cache, buffer, ARRAY_BUFFER, 'position');
    expect(cache.bufferCount).toBe(1);

    buffer.dispose();
    expect(deleted).toEqual([glBuffer]);
    expect(cache.bufferCount).toBe(0);
    expect(getUploaded(cache, buffer)).toBeUndefined();
});

/** One `GpuBuffer` is one GL buffer however many ways it reaches the device. */
test('a buffer uploaded twice keeps one GL object', () => {
    const { gl, created } = fakeGl();
    const { cache, buffer } = cacheAndBuffer();

    const first = ensureUploaded(gl, cache, buffer, ARRAY_BUFFER, 'position');
    const second = ensureUploaded(gl, cache, buffer, ARRAY_BUFFER, 'tfOutput');

    expect(second).toBe(first);
    expect(created()).toBe(1);
    expect(cache.bufferCount).toBe(1);
});
