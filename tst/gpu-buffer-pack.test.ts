import { describe, expect, test } from 'vitest';
import { GpuBuffer, createStorageBuffer } from '../src/core/gpu-buffer';
import { struct } from '../src/nodes/lib/core';
import { layoutStrideOf, unpack, unpackArray } from '../src/schema/pack';
import * as d from '../src/schema/schema';

// GpuBuffer pack family — the CPU-side schema-typed write parallel to DataTexture. Round-trip through
// the buffer's own `array` (std430) and check the queued partial-upload range + version bump.
// packAtIndex = by element index, packAtByte = by raw byte offset, pack = bulk whole-array.

describe('GpuBuffer.packAtIndex — array<mat4x4f> (the makecat instance-transform shape)', () => {
    const N = 4;
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

    test('writes element i at its std430 offset, leaving neighbours untouched', () => {
        const buf = createStorageBuffer(d.array(d.mat4x4f), new Float32Array(N * 16));
        const m2 = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1];
        buf.packAtIndex(d.mat4x4f, 2, m2);

        const all = unpackArray(d.mat4x4f, buf.array!.buffer, N);
        expect(all[2]).toEqual(m2);
        // Neighbours stay zero (not clobbered by the element-2 write).
        expect(all[0]).toEqual(new Array(16).fill(0));
        expect(all[1]).toEqual(new Array(16).fill(0));
        expect(all[3]).toEqual(new Array(16).fill(0));
    });

    test('queues a component-index update range for exactly element i and bumps version', () => {
        const buf = createStorageBuffer(d.array(d.mat4x4f), new Float32Array(N * 16));
        const v0 = buf.version;
        buf.packAtIndex(d.mat4x4f, 1, identity);
        // mat4x4f std430 stride = 64B = 16 components; element 1 starts at component 16.
        expect(layoutStrideOf(d.mat4x4f, 'std430')).toBe(64);
        expect(buf.updateRanges).toEqual([{ start: 16, count: 16 }]);
        expect(buf.version).toBeGreaterThan(v0);
    });
});

describe('GpuBuffer.packAtIndex — array<Struct>', () => {
    const Instance = struct('Instance', { transform: d.mat4x4f, color: d.vec4f, id: d.u32 });

    test('round-trips a struct record at element i', () => {
        const stride = layoutStrideOf(Instance, 'std430');
        const count = 3;
        const buf = new GpuBuffer(d.array(Instance), { data: new Float32Array((count * stride) / 4), usage: 'storage' });
        const rec = {
            transform: [9, 0, 0, 0, 0, 9, 0, 0, 0, 0, 9, 0, 1, 2, 3, 1],
            color: [0.25, 0.5, 0.75, 1],
            id: 42,
        };
        buf.packAtIndex(Instance, 1, rec);
        const back = unpack(Instance, buf.array!.buffer, 1 * stride);
        expect(back).toEqual(rec);
    });
});

describe('GpuBuffer.packAtIndex — guards', () => {
    test('throws when the schema std430 stride does not match the buffer element stride', () => {
        // array<vec4f> → element stride 16B; passing vec3f (stride 16B) matches, but vec2f (8B) does not.
        const buf = createStorageBuffer(d.array(d.vec4f), new Float32Array(2 * 4));
        expect(() => buf.packAtIndex(d.vec2f, 0, [1, 2])).toThrow(/element stride/);
    });

    test('throws when the CPU array was released', () => {
        const buf = createStorageBuffer(d.array(d.vec4f), new Float32Array(2 * 4));
        buf.array = null;
        expect(() => buf.packAtIndex(d.vec4f, 0, [1, 2, 3, 4])).toThrow(/no CPU `array`/);
    });
});

describe('GpuBuffer.packAtByte — byte-addressed primitive', () => {
    test('packAtIndex(i) === packAtByte(i · strideBytes)', () => {
        const a = createStorageBuffer(d.array(d.vec4f), new Float32Array(4 * 4));
        const b = createStorageBuffer(d.array(d.vec4f), new Float32Array(4 * 4));
        a.packAtIndex(d.vec4f, 3, [10, 20, 30, 40]);
        b.packAtByte(d.vec4f, 3 * 16, [10, 20, 30, 40]); // vec4f std430 stride = 16 bytes
        expect(Array.from(b.array!)).toEqual(Array.from(a.array!));
        expect(b.updateRanges).toEqual(a.updateRanges); // same component-range {start:12,count:4}
    });

    test('throws on a byteOffset that is not a multiple of the component size', () => {
        const buf = createStorageBuffer(d.array(d.vec4f), new Float32Array(4 * 4));
        // Float32Array components are 4 bytes; 6 is not a multiple of 4.
        expect(() => buf.packAtByte(d.vec4f, 6, [1, 2, 3, 4])).toThrow(/multiple of/);
    });
});

describe('GpuBuffer.pack — bulk whole-array write', () => {
    test('fills every element and flags a single full re-upload (no partial ranges)', () => {
        const N = 3;
        const buf = createStorageBuffer(d.array(d.vec4f), new Float32Array(N * 4));
        // Pre-dirty a partial range to prove pack() clears it (forces a full upload on both backends).
        buf.packAtIndex(d.vec4f, 0, [0, 0, 0, 0]);
        expect(buf.updateRanges.length).toBeGreaterThan(0);

        const v0 = buf.version;
        const values = [
            [1, 2, 3, 4],
            [5, 6, 7, 8],
            [9, 10, 11, 12],
        ];
        buf.pack(d.vec4f, values);

        expect(unpackArray(d.vec4f, buf.array!.buffer, N)).toEqual(values);
        expect(buf.updateRanges).toEqual([]); // cleared → renderer takes the full path
        expect(buf.version).toBeGreaterThan(v0);
    });

    test('throws when values exceed the buffer capacity', () => {
        const buf = createStorageBuffer(d.array(d.vec4f), new Float32Array(2 * 4));
        expect(() =>
            buf.pack(d.vec4f, [
                [1, 2, 3, 4],
                [5, 6, 7, 8],
                [9, 10, 11, 12],
            ]),
        ).toThrow(/capacity/);
    });
});
