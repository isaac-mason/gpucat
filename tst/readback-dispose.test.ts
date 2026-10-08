import { describe, expect, test } from 'vitest';
import { init } from '../src/renderer/core/init';
import { webgpu } from '../src/renderer/webgpu/backend';
import { createStubGPU, installWebGPUPolyfills } from './stub-gpu';

installWebGPUPolyfills();

/** A read-back buffer as a real device treats one: its map settles only when the GPU is done, or rejects
 *  once the buffer is destroyed. */
function readbackBuffer() {
    let reject: (err: Error) => void = () => {};
    let destroyed = 0;
    const buffer = {
        size: 1024,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        mapState: 'pending',
        mapAsync: () =>
            new Promise<void>((_, rejectMap) => {
                reject = rejectMap;
            }),
        getMappedRange: () => new ArrayBuffer(1024),
        unmap: () => {},
        destroy: () => {
            destroyed++;
            reject(new Error('buffer destroyed'));
        },
    } as unknown as GPUBuffer;
    return { buffer, destroyedCount: () => destroyed };
}

describe('read maps and dispose', () => {
    // Firefox's wgpu crashes when a device is destroyed with a read map pending, so a renderer
    // disposed mid-readback releases the buffer before the device goes.
    test('dispose destroys a buffer whose read map is still in flight, and the read rejects', async () => {
        const gpu = await init(webgpu(createStubGPU().getRendererOptions()));
        const { buffer, destroyedCount } = readbackBuffer();
        const read = gpu.backend.mapForRead(buffer);
        expect(gpu.backend._readbacks.has(buffer)).toBe(true);
        gpu.dispose();
        expect(destroyedCount()).toBe(1);
        await expect(read).rejects.toThrow('buffer destroyed');
        expect(gpu.backend._readbacks.size).toBe(0);
    });

    test('a read that lands is no longer held', async () => {
        const gpu = await init(webgpu(createStubGPU().getRendererOptions()));
        const settled = { ...readbackBuffer().buffer, mapAsync: async () => {} } as unknown as GPUBuffer;
        await gpu.backend.mapForRead(settled);
        expect(gpu.backend._readbacks.size).toBe(0);
    });
});
