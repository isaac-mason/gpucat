import { expect, test } from 'vitest';
import { GpuBuffer } from '../src/core/gpu-buffer';
import { d } from '../src/index';
import { BufferUpload, planBufferUpload } from '../src/renderer/core/buffer-upload';

const CAPACITY = 4096 * 4;

function batchBuffer(): GpuBuffer<typeof d.vec4f> {
    return new GpuBuffer(d.vec4f, { data: new Float32Array(CAPACITY * 4), usage: 'vertex' });
}

/**
 * A per-frame batch writes a prefix and leaves the rest of its capacity untouched, so the upload has
 * to follow the prefix rather than the allocation.
 */
test('a dirty range plans a partial upload, whatever the version says', () => {
    const buffer = batchBuffer();
    const uploadedBytes = buffer.array!.byteLength;

    expect(planBufferUpload(buffer, false, 0, -1)).toBe(BufferUpload.Allocate);

    buffer.addUpdateRange(0, 64 * 4);
    expect(planBufferUpload(buffer, true, uploadedBytes, buffer.version)).toBe(BufferUpload.Partial);
});

/** Bumping the version instead is what uploads the whole capacity every frame. */
test('a version bump with no range plans a full upload', () => {
    const buffer = batchBuffer();
    const uploadedBytes = buffer.array!.byteLength;

    buffer.needsUpdate = true;
    expect(planBufferUpload(buffer, true, uploadedBytes, buffer.version - 1)).toBe(BufferUpload.Full);
});

test('an unchanged buffer plans nothing', () => {
    const buffer = batchBuffer();
    expect(planBufferUpload(buffer, true, buffer.array!.byteLength, buffer.version)).toBe(BufferUpload.Skip);
});

/** Ranges are flat component indices, so a consumer sizes them in components and not bytes. */
test('ranges are recorded in components and merge before upload', () => {
    const buffer = batchBuffer();
    buffer.addUpdateRange(0, 12);
    buffer.addUpdateRange(12, 12);

    planBufferUpload(buffer, true, buffer.array!.byteLength, buffer.version);
    expect(buffer.updateRanges).toEqual([{ start: 0, count: 24 }]);
});
