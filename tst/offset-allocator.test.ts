import { expect, test } from 'vitest';
import {
    allocateOffset,
    createOffsetAllocator,
    type OffsetAllocation,
    type OffsetAllocator,
    offsetFits,
    releaseOffset,
} from '../src/renderer/core/offset-allocator';

type Live = { offset: number; size: number; allocation: OffsetAllocation };

function allocate(allocator: OffsetAllocator, size: number): OffsetAllocation {
    const allocation = allocateOffset(allocator, size);
    if (allocation === null) throw new Error(`no room for ${size}`);
    return allocation;
}

function overlapping(live: Live[]): boolean {
    const sorted = [...live].sort((a, b) => a.offset - b.offset);
    for (let index = 1; index < sorted.length; index++) {
        if (sorted[index - 1]!.offset + sorted[index - 1]!.size > sorted[index]!.offset) return true;
    }
    return false;
}

test('allocations are disjoint and take from the free total', () => {
    const allocator = createOffsetAllocator(1024, 64);
    const sizes = [100, 50, 200, 75, 33];
    const live = sizes.map((size) => ({ offset: 0, size, allocation: allocate(allocator, size) }));
    for (const entry of live) entry.offset = entry.allocation.offset;
    expect(live[0]!.offset).toBe(0);
    expect(overlapping(live)).toBe(false);
    expect(allocator.freeStorage).toBe(1024 - 458);
});

test('a release merges with free neighbours on both sides', () => {
    const allocator = createOffsetAllocator(1024, 64);
    const first = allocate(allocator, 100);
    const middle = allocate(allocator, 100);
    const last = allocate(allocator, 100);
    releaseOffset(allocator, first);
    releaseOffset(allocator, last);
    releaseOffset(allocator, middle);
    expect(allocator.freeStorage).toBe(1024);
    expect(allocate(allocator, 1024).offset).toBe(0);
});

test('no room is null, and fits says so without allocating', () => {
    const allocator = createOffsetAllocator(128, 64);
    allocate(allocator, 128);
    expect(offsetFits(allocator, 1)).toBe(false);
    expect(allocateOffset(allocator, 1)).toBeNull();
});

test('free space split by a live allocation does not serve a request larger than either side', () => {
    const allocator = createOffsetAllocator(384, 64);
    const first = allocate(allocator, 128);
    allocate(allocator, 128);
    const last = allocate(allocator, 128);
    releaseOffset(allocator, first);
    releaseOffset(allocator, last);
    expect(offsetFits(allocator, 256)).toBe(false);
    expect(allocateOffset(allocator, 256)).toBeNull();
    expect(allocateOffset(allocator, 128)).not.toBeNull();
    expect(allocateOffset(allocator, 128)).not.toBeNull();
});

test('sizes under eight are binned exactly: a freed run serves a request of its own size', () => {
    const allocator = createOffsetAllocator(16, 16);
    for (const size of [1, 2, 3, 5, 7]) {
        const before = allocate(allocator, 16 - size);
        const run = allocate(allocator, size);
        releaseOffset(allocator, run);
        const again = allocate(allocator, size);
        expect(again.offset).toBe(run.offset);
        releaseOffset(allocator, before);
        releaseOffset(allocator, again);
    }
});

test('random churn never overlaps, never leaks, and drains to the full range', () => {
    // a power of two, a size the bins hold exactly: a run of another size is filed under the size below it
    const capacity = 1 << 17;
    const allocator = createOffsetAllocator(capacity, 4096);
    const live: Live[] = [];
    let seed = 0xc0ffee;
    const random = () => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return (seed >>> 0) / 0xffffffff;
    };
    for (let operation = 0; operation < 2000; operation++) {
        if (live.length === 0 || (random() < 0.6 && live.length < 200)) {
            const size = 1 + Math.floor(random() * 500);
            const allocation = allocateOffset(allocator, size);
            if (allocation !== null) {
                expect(allocation.offset + size).toBeLessThanOrEqual(capacity);
                live.push({ offset: allocation.offset, size, allocation });
            }
        } else {
            releaseOffset(allocator, live.splice(Math.floor(random() * live.length), 1)[0]!.allocation);
        }
        expect(overlapping(live)).toBe(false);
        expect(allocator.freeStorage).toBe(capacity - live.reduce((total, entry) => total + entry.size, 0));
    }
    while (live.length > 0) releaseOffset(allocator, live.pop()!.allocation);
    expect(allocator.freeStorage).toBe(capacity);
    expect(allocate(allocator, capacity).offset).toBe(0);
});
