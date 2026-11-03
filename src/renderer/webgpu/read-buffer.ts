import { type GpuBuffer, type GpuTypedArray, schemaArrayCtor } from '../../core/gpu-buffer';
import * as Buffers from './buffers';
import type { WebGPUBackend } from './webgpu-backend';

/**
 * `count` elements of `buffer` from element `offset`, copied into a staging buffer the CPU maps for reading. The buffer
 * must have been uploaded, by a write or by a pass that bound it.
 */
export async function readBuffer(
    backend: WebGPUBackend,
    buffer: GpuBuffer,
    offset: number,
    count: number,
): Promise<GpuTypedArray> {
    const ArrayCtor = schemaArrayCtor(buffer.schema);
    const result = new ArrayCtor(count * buffer.itemSize);
    if (count === 0) return result;
    const source = Buffers.getUploaded(backend.buffers, buffer);
    if (source === undefined) {
        throw new Error('[readBuffer] the buffer has no GPU copy yet: nothing has written or bound it.');
    }
    const elementBytes = buffer.itemSize * ArrayCtor.BYTES_PER_ELEMENT;
    const device = backend.device;
    const staging = device.createBuffer({
        label: 'readBuffer/staging',
        size: result.byteLength,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, offset * elementBytes, staging, 0, result.byteLength);
    device.queue.submit([encoder.finish()]);
    try {
        await backend.mapForRead(staging);
        result.set(new ArrayCtor(staging.getMappedRange()));
        staging.unmap();
    } finally {
        staging.destroy();
    }
    return result;
}
