import { describe, expect, test } from 'vitest';
import { Uniform } from '../src/core/uniform';
import { struct } from '../src/nodes/nodes';
import { layoutSizeOf, type MemoryLayout, pack, packToView, unpackFromView } from '../src/schema/pack';
import * as d from '../src/schema/schema';

// A typed array for a sized array is its components tightly packed, and the layout's padding goes in as it is
// written. The generated writer alone read it as nested (`value[i][j]`), so an array of vectors or matrices packed as
// all NaN: a vertex position read from one put the triangle nowhere, and the draw vanished without an error.

const LAYOUTS: MemoryLayout[] = ['std430', 'wgsl-uniform', 'std140'];

const N = 3;
const ELEMENTS: [name: string, element: d.Any, components: number][] = [
    ['f32', d.f32, 1],
    ['vec2f', d.vec2f, 2],
    ['vec3f', d.vec3f, 3],
    ['vec4f', d.vec4f, 4],
    ['mat3x3f', d.mat3x3f, 9],
    ['mat4x4f', d.mat4x4f, 16],
];

/** element `i` as the nested value the reader returns, numbered 1, 2, 3, … across the whole array */
function nested(components: number): number[][] {
    return Array.from({ length: N }, (_, i) => Array.from({ length: components }, (_, j) => i * components + j + 1));
}

describe('a typed array for a sized array packs as its components tightly packed', () => {
    for (const memLayout of LAYOUTS) {
        for (const [name, element, components] of ELEMENTS) {
            test(`array<${name}> under ${memLayout}`, () => {
                const schema = d.sizedArray(element, N);
                const expected = nested(components);
                const flat = new Float32Array(expected.flat());
                const view = new DataView(new ArrayBuffer(layoutSizeOf(schema, memLayout)));

                packToView(schema, view, 0, flat as never, memLayout);

                const out = unpackFromView(schema, view, 0, memLayout) as unknown as (number | number[])[];
                expect(out.map((e) => (typeof e === 'number' ? [e] : Array.from(e)))).toEqual(expected);
            });
        }
    }

    test('it packs the same bytes as the nested value', () => {
        const schema = d.sizedArray(d.vec3f, N);
        const expected = nested(3) as [number, number, number][];
        for (const memLayout of LAYOUTS) {
            const fromFlat = new Uint8Array(pack(schema, new Float32Array(expected.flat()) as never, memLayout));
            expect(fromFlat).toEqual(new Uint8Array(pack(schema, expected, memLayout)));
        }
    });

    test('integer arrays keep their integers', () => {
        const schema = d.sizedArray(d.vec2i, 2);
        const view = new DataView(new ArrayBuffer(layoutSizeOf(schema, 'wgsl-uniform')));
        packToView(schema, view, 0, new Int32Array([-1, 2, -3, 4]) as never, 'wgsl-uniform');
        expect(unpackFromView(schema, view, 0, 'wgsl-uniform')).toEqual([
            [-1, 2],
            [-3, 4],
        ]);
    });

    test('nested sized arrays read on through the one run', () => {
        const schema = d.sizedArray(d.sizedArray(d.vec2f, 2), 2);
        const view = new DataView(new ArrayBuffer(layoutSizeOf(schema, 'std430')));
        packToView(schema, view, 0, new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]) as never, 'std430');
        expect(unpackFromView(schema, view, 0, 'std430')).toEqual([
            [
                [1, 2],
                [3, 4],
            ],
            [
                [5, 6],
                [7, 8],
            ],
        ]);
    });

    test('a length other than the component count throws, naming it', () => {
        const schema = d.sizedArray(d.vec3f, N);
        const view = new DataView(new ArrayBuffer(layoutSizeOf(schema, 'wgsl-uniform')));
        // vec3s hand-padded to four floats each, as the uniform layout stores them
        expect(() => packToView(schema, view, 0, new Float32Array(N * 4) as never, 'wgsl-uniform')).toThrow(
            /tightly packed, 9 of them, but has 12/,
        );
        expect(() => packToView(schema, view, 0, new Float32Array(2) as never, 'wgsl-uniform')).toThrow(/9 of them/);
    });

    test('an array of structs from a typed array throws', () => {
        const schema = d.sizedArray(struct('S', { a: d.vec4f }), 2);
        const view = new DataView(new ArrayBuffer(layoutSizeOf(schema, 'std430')));
        expect(() => packToView(schema, view, 0, new Float32Array(8) as never, 'std430')).toThrow(/only an array of scalars/);
    });

    test('a uniform given a plain run of numbers packs the same way, in the element type', () => {
        const schema = d.sizedArray(d.vec2i, 2);
        const uniform = new Uniform(schema, [1, 2, 3, 4]);
        expect(uniform.value).toBeInstanceOf(Int32Array);
        const view = new DataView(new ArrayBuffer(layoutSizeOf(schema, 'wgsl-uniform')));
        packToView(schema, view, 0, uniform.value as never, 'wgsl-uniform');
        expect(unpackFromView(schema, view, 0, 'wgsl-uniform')).toEqual([
            [1, 2],
            [3, 4],
        ]);
    });
});
