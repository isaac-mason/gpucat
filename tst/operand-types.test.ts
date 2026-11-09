import { describe, expect, test } from 'vitest';
import {
    attribute,
    clamp,
    compileGlsl,
    compileWgsl,
    d,
    f32,
    i32,
    If,
    Fn,
    mix,
    mul,
    type Node,
    refract,
    screenCoordinate,
    select,
    shiftLeft,
    u32,
    uniform,
    vec2,
    vec3,
    vec3i,
    vec4,
} from '../src/index';

// Two nodes meet only as WGSL lets them: of one element type, with a scalar beside a vector the only mix of shapes,
// and matrices by their shapes in `*`. Both emitters used to convert a mismatch quietly, to different types: WGSL to
// the result's (`i + x` truncated x), GLSL to float (it didn't), so one node computed two values. Now it throws where
// it's written, naming the conversion.

const x = screenCoordinate.x;
const i = i32(x);
const u = u32(x);
const v = vec3(x, x, x);
const vi = vec3i(i, i, i);
const c = x.greaterThan(0);

/** the node's untyped self, as a JS caller or a `Node<Any>` would pass it */
const loose = <D extends d.Any>(n: Node<D>) => n as unknown as Node<never>;

describe('mismatched nodes throw where they meet', () => {
    test('arithmetic across kinds', () => {
        expect(() => i.add(loose(x))).toThrow(
            /add: an i32 meets only an i32, not an f32; convert one, with i32\(…\) or f32\(…\)/,
        );
        expect(() => u.sub(loose(i))).toThrow(/sub: a u32 meets only a u32, not an i32/);
        expect(() => vi.mul(loose(x))).toThrow(/mul: a vec3i meets only a vec3i, not an f32/);
        expect(() => v.add(loose(vec2(x, x)))).toThrow(/add: a vec3f meets only a vec3f, not a vec2f/);
        expect(() => c.add(loose(c))).toThrow(/add: takes numbers, not a bool/);
    });

    test('comparisons, builtins, select and assignment', () => {
        expect(() => i.lessThan(loose(u))).toThrow(/lessThan: an i32 meets only an i32, not a u32/);
        expect(() => clamp(x, loose(i), loose(u))).toThrow(/clamp: an f32 meets only an f32, not an i32/);
        expect(() => select(x, loose(i), c)).toThrow(/select: an f32 meets only an f32, not an i32/);
        expect(() => i.bitwiseAnd(loose(u))).toThrow(/bitwiseAnd: an i32/);
        // a Fn's body runs as it's built
        expect(() =>
            Fn(() => {
                f32(0).toVar('t').assign(loose(i));
            }),
        ).toThrow(/assign: an f32 meets only an f32, not an i32/);
    });

    test('factors, shift amounts and conditions', () => {
        expect(() => mix(v, v, loose(i))).toThrow(/mix: the factor beside a vec3f is an f32 or a vec3f, not an i32/);
        expect(() => refract(v, v, loose(v))).toThrow(/refract: the factor beside a vec3f is an f32, not a vec3f/);
        expect(() => shiftLeft(i, loose(i))).toThrow(/shiftLeft: an i32 shifts by a u32, not an i32/);
        expect(() => shiftLeft(loose(x), loose(u32(1)))).toThrow(/shiftLeft: shifts an integer, not an f32/);
        expect(() => select(x, x, loose(x))).toThrow(/select: takes a bool, not an f32/);
        expect(() => Fn(() => If(loose(i), () => {}))).toThrow(/If: takes a bool, not an i32/);
    });

    test('matrices by their shapes', () => {
        const m43 = uniform('m43', d.mat4x3f);
        const m34 = uniform('m34', d.mat3x4f);
        expect(mul(m43, vec4(x, x, x, x)).type).toBe(d.vec3f);
        expect(mul(vec3(x, x, x), m43).type).toBe(d.vec4f);
        expect(mul(m43, m34).type).toBe(d.mat3x3f);
        expect(mul(m34, m43).type).toBe(d.mat4x4f);
        expect(() => mul(m43, loose(v))).toThrow(/mul: mat4x3f \* vec3f needs a vec4/);
        expect(() => m43.add(loose(m34))).toThrow(/add: a mat4x3f meets only a mat4x3f, not a mat3x4f/);
    });
});

describe('what WGSL accepts still builds', () => {
    test('a scalar beside a vector, either side, and conversions written out', () => {
        expect(v.mul(x).type).toBe(d.vec3f);
        expect(x.mul(v).type).toBe(d.vec3f);
        expect(vi.add(i).type).toBe(d.vec3i);
        expect(mix(v, v, v).type).toBe(d.vec3f);
        const shader = {
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: vec4(vec3(f32(i).add(x), f32(u.add(u32(i))), f32(shiftLeft(i, u))), f32(1)),
            depth: undefined,
        };
        expect(() => compileWgsl(shader)).not.toThrow();
        expect(() => compileGlsl(shader)).not.toThrow();
    });
});
