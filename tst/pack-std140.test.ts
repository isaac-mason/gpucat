import { describe, expect, test } from 'vitest';
import { struct } from '../src/nodes/nodes';
import {
    layoutAlignOf,
    layoutSizeOf,
    layoutStrideOf,
    pack,
    unpack,
} from '../src/schema/pack';
import * as d from '../src/schema/schema';

// std140 == WGSL 'wgsl-uniform' layout EXCEPT every matrix column is padded to a vec4 (16-byte column
// stride), for ALL matrices including 2-row ones. These tests assert std140 against spec-known
// values, and confirm WGSL 'wgsl-uniform'/'std430' matrix layout is unchanged.

describe('std140 scalar / vector layout (same as uniform)', () => {
    test('f32 size 4 align 4', () => {
        expect(layoutSizeOf(d.f32, 'std140')).toBe(4);
        expect(layoutAlignOf(d.f32, 'std140')).toBe(4);
    });

    test('vec3f align 16 size 12', () => {
        expect(layoutAlignOf(d.vec3f, 'std140')).toBe(16);
        expect(layoutSizeOf(d.vec3f, 'std140')).toBe(12);
    });

    test('vec4f align 16 size 16', () => {
        expect(layoutAlignOf(d.vec4f, 'std140')).toBe(16);
        expect(layoutSizeOf(d.vec4f, 'std140')).toBe(16);
    });
});

describe('std140 array element stride rounds to 16 (same as uniform)', () => {
    test('f32 array element stride 16', () => {
        const arr = d.sizedArray(d.f32, 4);
        // 4 elements each rounded to a 16-byte stride = 64 total.
        expect(layoutSizeOf(arr, 'std140')).toBe(64);
        expect(layoutStrideOf(d.f32, 'std140')).toBe(4); // scalar strideOf unchanged; array path rounds
    });
});

describe('std140 matrix layout (columns padded to vec4)', () => {
    test('mat2x2f size 32 align 16 (the fix)', () => {
        expect(layoutSizeOf(d.mat2x2f, 'std140')).toBe(32);
        expect(layoutAlignOf(d.mat2x2f, 'std140')).toBe(16);
    });

    test('mat3x2f size 48', () => {
        expect(layoutSizeOf(d.mat3x2f, 'std140')).toBe(48);
        expect(layoutAlignOf(d.mat3x2f, 'std140')).toBe(16);
    });

    test('mat4x2f size 64', () => {
        expect(layoutSizeOf(d.mat4x2f, 'std140')).toBe(64);
    });

    test('mat3x3f size 48', () => {
        expect(layoutSizeOf(d.mat3x3f, 'std140')).toBe(48);
    });

    test('mat4x4f size 64', () => {
        expect(layoutSizeOf(d.mat4x4f, 'std140')).toBe(64);
    });
});

describe('WGSL uniform/storage matrix layout unchanged', () => {
    test("mat2x2f uniform size 16 (2-row column stride stays 8)", () => {
        expect(layoutSizeOf(d.mat2x2f, 'wgsl-uniform')).toBe(16);
        expect(layoutAlignOf(d.mat2x2f, 'wgsl-uniform')).toBe(8);
    });

    test('mat2x2f storage size 16', () => {
        expect(layoutSizeOf(d.mat2x2f, 'std430')).toBe(16);
        expect(layoutAlignOf(d.mat2x2f, 'std430')).toBe(8);
    });

    test('mat3x2f uniform size 24', () => {
        expect(layoutSizeOf(d.mat3x2f, 'wgsl-uniform')).toBe(24);
    });
});

describe('std140 struct layout', () => {
    test('{ vec3f; f32 } packs the f32 tight after the vec3 (16 total)', () => {
        const S = struct('VecScalar', { a: d.vec3f, b: d.f32 });
        // vec3f occupies bytes 0..12 (align 16), f32 fits at offset 12, total rounds to 16.
        expect(layoutSizeOf(S, 'std140')).toBe(16);
        expect(layoutAlignOf(S, 'std140')).toBe(16);
    });

    test('struct with a mat2x2f member uses 32-byte matrix', () => {
        const S = struct('MatBox', { m: d.mat2x2f, tail: d.f32 });
        // mat2x2f std140 = 32 bytes (align 16), then f32 at offset 32, round to 48.
        expect(layoutSizeOf(S, 'std140')).toBe(48);
        expect(layoutAlignOf(S, 'std140')).toBe(16);
    });
});

describe('std140 write/read round-trip places matrix columns at 16-byte stride', () => {
    test('mat2x2f columns land at offsets 0 and 16', () => {
        const value = [1, 2, 3, 4]; // column-major: col0=(1,2), col1=(3,4)
        const buf = pack(d.mat2x2f, value as never, 'std140');
        expect(buf.byteLength).toBe(32);
        const f32 = new Float32Array(buf);
        expect(f32[0]).toBe(1);
        expect(f32[1]).toBe(2);
        // padding at [2],[3]
        expect(f32[4]).toBe(3); // offset 16
        expect(f32[5]).toBe(4);
        // round-trip
        expect(unpack(d.mat2x2f, buf, 0, 'std140')).toEqual([1, 2, 3, 4]);
    });
});
