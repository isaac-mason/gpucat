/* The backend-neutral buffer-upload decision: precedence, range merging, and the resize guard. */

import { describe, expect, test } from 'vitest';
import { BufferUpload, planBufferUpload } from '../src/renderer/core/buffer-upload';
import { GpuBuffer } from '../src/core/gpu-buffer';
import * as d from '../src/schema/schema';

function buffer(count: number): GpuBuffer<d.f32> {
    return new GpuBuffer(d.f32, { count, usage: 'vertex' });
}

/** what a backend holds for a buffer it has already uploaded once. */
function uploaded(b: GpuBuffer<d.f32>) {
    return { exists: true, capacity: b.array!.byteLength, version: b.version };
}

describe('planBufferUpload', () => {
    test('a buffer the backend has never seen is allocated', () => {
        const b = buffer(4);
        expect(planBufferUpload(b, false, 0, -1)).toBe(BufferUpload.Allocate);
    });

    test('an unchanged buffer does nothing', () => {
        const b = buffer(4);
        const held = uploaded(b);
        expect(planBufferUpload(b, held.exists, held.capacity, held.version)).toBe(BufferUpload.Skip);
    });

    test('a version bump with no ranges rewrites the whole array', () => {
        const b = buffer(4);
        const held = uploaded(b);
        b.needsUpdate = true;
        expect(planBufferUpload(b, held.exists, held.capacity, held.version)).toBe(BufferUpload.Full);
    });

    test('queued ranges are a partial write, with no version bump needed', () => {
        const b = buffer(8);
        const held = uploaded(b);
        b.addUpdateRange(2, 2);
        expect(planBufferUpload(b, held.exists, held.capacity, held.version)).toBe(BufferUpload.Partial);
    });

    test('ranges beat a version bump: the cheaper write wins when a caller does both', () => {
        const b = buffer(8);
        const held = uploaded(b);
        b.addUpdateRange(2, 2);
        b.needsUpdate = true;
        expect(planBufferUpload(b, held.exists, held.capacity, held.version)).toBe(BufferUpload.Partial);
    });

    test('ranges are merged in place, so both backends write identical spans', () => {
        const b = buffer(16);
        const held = uploaded(b);
        // deliberately out of order and overlapping.
        b.addUpdateRange(8, 2);
        b.addUpdateRange(0, 2);
        b.addUpdateRange(2, 2);
        expect(planBufferUpload(b, held.exists, held.capacity, held.version)).toBe(BufferUpload.Partial);
        expect(b.updateRanges).toEqual([
            { start: 0, count: 4 },
            { start: 8, count: 2 },
        ]);
    });

    // keyed off size, not version, so a grow that skips the bump cannot write partially into a
    // buffer too small for it.
    test('a grow is allocated even when the version did not move', () => {
        const b = buffer(4);
        const held = uploaded(b);
        const grown = buffer(64);
        expect(planBufferUpload(grown, held.exists, held.capacity, grown.version)).toBe(BufferUpload.Allocate);
    });

    test('a grow beats queued ranges', () => {
        const b = buffer(4);
        const held = uploaded(b);
        const grown = buffer(64);
        grown.addUpdateRange(0, 2);
        expect(planBufferUpload(grown, held.exists, held.capacity, grown.version)).toBe(BufferUpload.Allocate);
    });

    test('a released CPU array skips: whatever is on the GPU is all there is', () => {
        const b = buffer(4);
        const held = uploaded(b);
        b.array = null as never;
        expect(planBufferUpload(b, held.exists, held.capacity, held.version)).toBe(BufferUpload.Skip);
    });
});
