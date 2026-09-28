/* The backend-neutral buffer-upload decision: precedence, range merging, and the resize guard. */

import { describe, expect, test } from 'vitest';
import { GpuBuffer } from '../src/core/gpu-buffer';
import { BufferUpload, planBufferUpload } from '../src/renderer/core/buffer-upload';
import { mergeUpdateRanges } from '../src/renderer/core/update-ranges';
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
        expect(b.updateRanges.slice(0, b.updateRangeCount)).toEqual([
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

describe('mergeUpdateRanges', () => {
    test('sorts and merges ranges queued in any order', () => {
        const starts = [40, 0, 90, 10, 30, 70, 20, 60, 50, 80];
        const ranges = starts.map((start) => ({ start, count: start === 90 ? 5 : 4 }));
        const count = mergeUpdateRanges(ranges, ranges.length);
        expect(ranges.slice(0, count).map((r) => r.start)).toEqual(starts.slice().sort((a, b) => a - b));

        const touching = [8, 4, 0].map((start) => ({ start, count: 4 }));
        expect(mergeUpdateRanges(touching, 3)).toBe(1);
        expect(touching[0]).toEqual({ start: 0, count: 12 });
    });

    test('leaves only the given count considered, and every record in the array once', () => {
        const ranges = [5, 0, 1, 99].map((start) => ({ start, count: 1 }));
        const records = new Set(ranges);
        const count = mergeUpdateRanges(ranges, 3);
        expect(ranges.slice(0, count)).toEqual([
            { start: 0, count: 2 },
            { start: 5, count: 1 },
        ]);
        expect(ranges[3]!.start).toBe(99);
        expect(new Set(ranges)).toEqual(records);
    });
});

describe('GpuBuffer update ranges', () => {
    test('reuse their records once uploaded, so queuing each frame allocates nothing', () => {
        const b = buffer(64);
        const held = uploaded(b);
        for (const start of [30, 0, 20, 10]) b.addUpdateRange(start, 2);
        planBufferUpload(b, held.exists, held.capacity, held.version);
        const records = b.updateRanges.slice();
        b.clearUpdateRanges();

        for (const start of [1, 3, 5, 7]) b.addUpdateRange(start, 1);
        expect(b.updateRanges).toHaveLength(4);
        expect(new Set(b.updateRanges)).toEqual(new Set(records));
        expect(b.updateRanges.slice(0, b.updateRangeCount).map((r) => r.start)).toEqual([1, 3, 5, 7]);
    });
});
