import { type GpuBuffer, type GpuTypedArray, schemaArrayCtor } from '../../core/gpu-buffer';
import * as Buffers from './buffers';
import { clientWaitAsync } from './transform-feedback';

/**
 * `count` elements of `buffer` from element `offset`, read back through a fresh STREAM_READ staging buffer (reading
 * from a buffer bound to a transform-feedback binding point is illegal, and staging leaves the source as it was for
 * further ping-pong). The fence is polled across event-loop ticks rather than spun on: a synchronous busy-loop never
 * signals on a single-threaded GL backend. The buffer needs a GL buffer, which a transform feedback that wrote it
 * gives it; a storage buffer lives in a texture here and is not read back yet.
 */
export async function readBuffer(
    gl: WebGL2RenderingContext,
    buffers: Buffers.BufferCache,
    buffer: GpuBuffer,
    offset: number,
    count: number,
): Promise<GpuTypedArray> {
    const ArrayCtor = schemaArrayCtor(buffer.schema);
    const dst = new ArrayCtor(count * buffer.itemSize);
    if (count === 0) return dst;
    const src = Buffers.getUploaded(buffers, buffer) ?? null;
    if (!src) {
        throw new Error(
            '[webgl] readBuffer: no GL buffer backs this GpuBuffer. A transform feedback that writes it gives it one; a ' +
                'storage buffer lives in a texture on WebGL2 and is not read back yet.',
        );
    }
    const byteOffset = offset * buffer.itemSize * ArrayCtor.BYTES_PER_ELEMENT;
    const byteLength = dst.byteLength;

    const staging = gl.createBuffer();
    if (!staging) throw new Error('[webgl] readBuffer: gl.createBuffer returned null (staging).');

    gl.bindBuffer(gl.COPY_READ_BUFFER, src);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, staging);
    gl.bufferData(gl.COPY_WRITE_BUFFER, byteLength, gl.STREAM_READ);
    gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, byteOffset, 0, byteLength);

    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) throw new Error('[webgl] readBuffer: gl.fenceSync returned null.');
    gl.flush();
    try {
        await clientWaitAsync(gl, sync, 'readBuffer');
    } finally {
        gl.deleteSync(sync);
    }

    gl.bindBuffer(gl.COPY_WRITE_BUFFER, staging);
    gl.getBufferSubData(gl.COPY_WRITE_BUFFER, 0, dst);

    gl.deleteBuffer(staging);
    gl.bindBuffer(gl.COPY_READ_BUFFER, null);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);

    return dst;
}
