import { expect, test } from 'vitest';
import { Uniform, type UniformValue } from '../src/core/uniform';
import { d, struct } from '../src/index';
import { packToView } from '../src/schema/pack';
import type { Any } from '../src/schema/schema';
import { wgslSizeOf } from '../src/schema/schema';

/** The bytes a uniform reaches the GPU as, however its value was spelled. */
function packed<T extends Any>(schema: T, value: UniformValue<T>): number[] {
    const stored = new Uniform(schema, value).value;
    const buffer = new ArrayBuffer(wgslSizeOf(schema));
    packToView(schema, new DataView(buffer), 0, stored as never, 'wgsl-uniform');
    return [...new Uint8Array(buffer)];
}

/** One case per shape the schema language offers, since a shape with no case here is a shape nothing checks. */
const CASES: [string, Any, UniformValue<Any>, UniformValue<Any>][] = [
    ['f32', d.f32, 2.5, 2.5],
    ['vec2f', d.vec2f, [1, 2], new Float32Array([1, 2])],
    ['vec3f', d.vec3f, [1, 2, 3], new Float32Array([1, 2, 3])],
    ['vec4f', d.vec4f, [1, 2, 3, 4], new Float32Array([1, 2, 3, 4])],
    ['vec4i', d.vec4i, [1, -2, 3, -4], new Int32Array([1, -2, 3, -4])],
    ['vec4u', d.vec4u, [1, 2, 3, 4], new Uint32Array([1, 2, 3, 4])],
    ['mat3x3f', d.mat3x3f, Array.from({ length: 9 }, (_, i) => i), new Float32Array(9).map((_, i) => i)],
    ['mat4x4f', d.mat4x4f, Array.from({ length: 16 }, (_, i) => i), new Float32Array(16).map((_, i) => i)],
];

test.each(CASES)('a %s uniform packs the same from a plain array as from a typed array', (_name, schema, plain, typed) => {
    expect(packed(schema, plain)).toEqual(packed(schema, typed));
});

/** `Infer` here is an array of tuples, so packing it as one flat run gives NaN at the wrong length. */
test('an array of vectors packs its components, not NaN', () => {
    const schema = d.sizedArray(d.vec3f, 2);
    const bytes = packed(schema, [
        [1, 2, 3],
        [4, 5, 6],
    ] as never);

    expect(bytes.some((b) => b !== 0)).toBe(true);
    const floats = new Float32Array(new Uint8Array(bytes).buffer);
    expect([...floats].some(Number.isNaN)).toBe(false);
    expect([...floats].slice(0, 3)).toEqual([1, 2, 3]);
});

test('an array of scalars packs its values', () => {
    const bytes = packed(d.sizedArray(d.f32, 4), [1, 2, 3, 4] as never);
    const floats = new Float32Array(new Uint8Array(bytes).buffer);
    expect([...floats].some(Number.isNaN)).toBe(false);
});

test('a struct value packs its fields', () => {
    const schema = struct('Light', { colour: d.vec3f, intensity: d.f32 });
    const bytes = packed(schema, { colour: [1, 1, 1], intensity: 2 } as never);
    const floats = new Float32Array(new Uint8Array(bytes).buffer);

    expect([...floats].some(Number.isNaN)).toBe(false);
    expect(floats[0]).toBe(1);
});

/**
 * A consumer's real shape: four sky stops of three vec3 colours each, in the uniform address space
 * where a vec3 is padded to 16 bytes. Kept because this is the shape 6.132 broke in a live scene.
 */
test('an array of twelve vec3f packs at a 16-byte stride with no NaN', () => {
    const schema = d.sizedArray(d.vec3f, 12);
    const stops = Array.from({ length: 12 }, (_, i) => [i + 1, i + 2, i + 3]);
    const bytes = packed(schema, stops as never);

    expect(bytes.length).toBe(12 * 16);
    const floats = new Float32Array(new Uint8Array(bytes).buffer);
    expect([...floats].some(Number.isNaN)).toBe(false);
    expect([...floats].slice(0, 3)).toEqual([1, 2, 3]);
    expect([...floats].slice(4, 7)).toEqual([2, 3, 4]);
});
