import { expect, test } from 'vitest';
import { Uniform } from '../src/core/uniform';
import { d, struct } from '../src/index';

/** Reading `.value` back used to give `number[] | Float32Array | tuple`, so every caller narrowed. */
test('a plain array is stored as the typed array the schema calls for', () => {
    const colour = new Uniform(d.vec4f, [1, 0, 0, 1]);

    expect(colour.value).toBeInstanceOf(Float32Array);
    expect(Array.from(colour.value as Float32Array)).toEqual([1, 0, 0, 1]);
});

test('an integer schema normalises to its own array type, not Float32Array', () => {
    expect(new Uniform(d.vec2i, [3, 4]).value).toBeInstanceOf(Int32Array);
});

/** Adopting by reference is what lets a caller keep a handle and write through it each frame. */
test('a typed array is adopted, not copied', () => {
    const direction = new Float32Array([5, 8, 6]);
    const uniform = new Uniform(d.vec3f, direction);

    expect(uniform.value).toBe(direction);
    direction[0] = 1;
    expect((uniform.value as Float32Array)[0]).toBe(1);
});

test('a scalar schema keeps its number', () => {
    expect(new Uniform(d.f32, 2.5).value).toBe(2.5);
});

/**
 * An array-of-vectors value is already `Infer<T>`. Packing it as a flat run gave `Float32Array(2)` of
 * NaN, which reaches the GPU as a silently wrong uniform block rather than an error.
 */
test('an array of vectors is left alone, not flattened', () => {
    const directions = new Uniform(d.sizedArray(d.vec3f, 2), [
        [1, 2, 3],
        [4, 5, 6],
    ] as never);

    expect(directions.value).toEqual([
        [1, 2, 3],
        [4, 5, 6],
    ]);
});

test('an array of matrices is left alone too', () => {
    const transforms = [new Array(16).fill(1), new Array(16).fill(2)];
    expect(new Uniform(d.sizedArray(d.mat4x4f, 2), transforms as never).value).toEqual(transforms);
});

/** A struct value is an object, so it must pass through whatever the schema's array type would be. */
test('a struct value passes through unchanged', () => {
    const schema = struct('Light', { colour: d.vec3f, intensity: d.f32 });
    const light = { colour: [1, 1, 1] as [number, number, number], intensity: 2 };

    expect(new Uniform(schema, light as never).value).toBe(light);
});

/** A per-object matrix is set every draw, so packing it must not allocate each time. */
test('plain arrays set one after another pack into the same array', () => {
    const matrix = new Uniform(d.mat4x4f, new Array(16).fill(0));
    const first = matrix.value;

    matrix.value = new Array(16).fill(1);

    expect(matrix.value).toBe(first);
    expect((matrix.value as Float32Array)[0]).toBe(1);
});

test('a plain array set after an adopted typed array never writes into the adopted one', () => {
    const adopted = new Float32Array([5, 8, 6]);
    const uniform = new Uniform(d.vec3f, adopted);

    uniform.value = [1, 2, 3];

    expect(Array.from(adopted)).toEqual([5, 8, 6]);
    expect(Array.from(uniform.value as ArrayLike<number>)).toEqual([1, 2, 3]);
});

test('a plain array of a new length packs into a new array', () => {
    const uniform = new Uniform(d.vec4f, [1, 2]);
    const first = uniform.value;

    uniform.value = [1, 2, 3];

    expect(uniform.value).not.toBe(first);
    expect(Array.from(uniform.value as Float32Array)).toEqual([1, 2, 3]);
});
