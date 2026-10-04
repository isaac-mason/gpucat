import type { GpuBuffer, GpuTypedArray } from '../../core/gpu-buffer';
import type { Renderer } from './renderer';

/** copies `data` into a `cpu: false` buffer at `byteOffset` before returning; `dataOffset` and `size` count elements of `data`. */
export function writeBuffer(
    renderer: Renderer,
    buffer: GpuBuffer,
    byteOffset: number,
    data: GpuTypedArray,
    dataOffset = 0,
    size = data.length - dataOffset,
): void {
    renderer._assertInitialized('writeBuffer');
    const what = `[writeBuffer] buffer '${buffer.label ?? 'unlabelled'}'`;
    if (buffer.cpu) {
        throw new Error(`${what} keeps a CPU array; write the array and queue a range instead, or make it \`cpu: false\`.`);
    }
    if (buffer.disposed) throw new Error(`${what} is disposed.`);
    if (dataOffset < 0 || size < 0 || dataOffset + size > data.length) {
        throw new Error(`${what}: elements ${dataOffset}..${dataOffset + size} are outside the ${data.length}-element data.`);
    }
    const byteSize = size * data.BYTES_PER_ELEMENT;
    if (byteOffset % 4 !== 0 || byteSize % 4 !== 0) {
        throw new Error(`${what}: byte offset ${byteOffset} and byte size ${byteSize} must be multiples of 4.`);
    }
    if (byteOffset < 0 || byteOffset + byteSize > buffer.byteLength) {
        throw new Error(`${what}: bytes ${byteOffset}..${byteOffset + byteSize} overrun its ${buffer.byteLength} bytes.`);
    }
    if (byteSize === 0) return;
    renderer.backend.writeBuffer(buffer, byteOffset, data, dataOffset * data.BYTES_PER_ELEMENT, byteSize);
}
