import type { GpuBuffer } from '../../core/gpu-buffer';
import type { Renderer } from './renderer';

/**
 * copies `byteSize` bytes of `source` from `sourceByteOffset` into a `cpu: false` `destination` at
 * `destinationByteOffset`, on the GPU. Queued at once, like `writeBuffer`: after the writes before it,
 * ahead of any frame not yet submitted. Omitted offsets start at 0; an omitted size copies the rest of
 * `source`.
 */
export function copyBuffer(
    renderer: Renderer,
    source: GpuBuffer,
    destination: GpuBuffer,
    sourceByteOffset = 0,
    destinationByteOffset = 0,
    byteSize = source.byteLength - sourceByteOffset,
): void {
    renderer._assertInitialized('copyBuffer');
    const what = `[copyBuffer] '${source.label ?? 'unlabelled'}' into '${destination.label ?? 'unlabelled'}'`;
    if (destination.cpu) {
        throw new Error(`${what}: the destination keeps a CPU array, which the copy would leave stale; make it \`cpu: false\`.`);
    }
    if (source.disposed) throw new Error(`${what}: the source is disposed.`);
    if (destination.disposed) throw new Error(`${what}: the destination is disposed.`);
    if (sourceByteOffset % 4 !== 0 || destinationByteOffset % 4 !== 0 || byteSize % 4 !== 0) {
        throw new Error(
            `${what}: offsets (${sourceByteOffset}, ${destinationByteOffset}) and size (${byteSize}) must be multiples of 4.`,
        );
    }
    if (sourceByteOffset < 0 || byteSize < 0 || sourceByteOffset + byteSize > source.byteLength) {
        throw new Error(
            `${what}: bytes ${sourceByteOffset}..${sourceByteOffset + byteSize} overrun the source's ${source.byteLength} bytes.`,
        );
    }
    if (destinationByteOffset < 0 || destinationByteOffset + byteSize > destination.byteLength) {
        throw new Error(
            `${what}: bytes ${destinationByteOffset}..${destinationByteOffset + byteSize} overrun the destination's ` +
                `${destination.byteLength} bytes.`,
        );
    }
    if (
        source === destination &&
        sourceByteOffset < destinationByteOffset + byteSize &&
        destinationByteOffset < sourceByteOffset + byteSize
    ) {
        throw new Error(`${what}: the ranges overlap within one buffer.`);
    }
    if (byteSize === 0) return;
    renderer.backend.copyBuffer(source, sourceByteOffset, destination, destinationByteOffset, byteSize);
}
