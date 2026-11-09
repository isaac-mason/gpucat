import { describe, expect, expectTypeOf, test } from 'vitest';
import {
    add,
    attribute,
    clamp,
    compileGlsl,
    compileWgsl,
    d,
    div,
    f32,
    i32,
    lessThan,
    max,
    min,
    mix,
    mod,
    mul,
    type Node,
    pow,
    refract,
    screenCoordinate,
    select,
    shiftLeft,
    smoothstep,
    step,
    sub,
    u32,
    uniform,
    vec3,
    vec3i,
    vec3u,
    vec4,
} from '../src/index';

// Plain numbers and booleans as operands. A number takes the type of the node it meets and is accepted exactly where
// WGSL accepts a literal: beside a vector only in arithmetic, otherwise beside a scalar. Where WGSL would reject it,
// it throws where it's written, and most of those are type errors too.

function compileBoth(value: Node<d.f32>): { wgsl: string; glsl: string } {
    const shader = {
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: vec4(value, f32(0), f32(0), f32(1)),
        depth: undefined,
    };
    return { wgsl: compileWgsl(shader).code, glsl: compileGlsl(shader).code };
}

const x = screenCoordinate.x;
const v = vec3(x, x, x);
const i = i32(x);
const u = u32(x);
const c = x.greaterThan(f32(0));
const m = uniform('m', d.mat4x4f);

describe('accepted, as WGSL accepts a literal', () => {
    test('arithmetic takes the element type, beside a scalar or a vector', () => {
        expectTypeOf(v.mul(2)).toEqualTypeOf<Node<d.vec3f>>();
        expectTypeOf(x.add(1)).toEqualTypeOf<Node<d.f32>>();
        expectTypeOf(u.add(1)).toEqualTypeOf<Node<d.u32>>();
        const { wgsl, glsl } = compileBoth(v.mul(2).x.add(i.add(-1).toF32()).add(u.add(1).toF32()));
        expect(wgsl).toMatch(/ \* 2\.0/);
        expect(wgsl).toMatch(/ \+ -1i/);
        expect(wgsl).toMatch(/ \+ 1u/);
        expect(glsl).toMatch(/ \* 2\.0/);
        expect(glsl).toMatch(/ \+ 1u/);
    });

    test('a number on the left keeps its place', () => {
        expectTypeOf(sub(1, v)).toEqualTypeOf<Node<d.vec3f>>();
        expectTypeOf(add(1, u)).toEqualTypeOf<Node<d.u32>>();
        const { wgsl } = compileBoth(sub(1, x).add(div(2, x)));
        expect(wgsl).toMatch(/1\.0 - /);
        expect(wgsl).toMatch(/2\.0 \/ /);
    });

    test('oneMinus keeps its node type', () => {
        expect(i.oneMinus().type).toBe(d.i32);
        expect(compileBoth(f32(i.oneMinus())).wgsl).toMatch(/1i - /);
    });

    test('a matrix scales by a number', () => {
        expectTypeOf(m.mul(2)).toEqualTypeOf<Node<d.mat4x4f>>();
        expect(mul(m, 2).type).toBe(d.mat4x4f);
    });

    test('mix and refract take scalar factors beside vectors', () => {
        expect(compileBoth(mix(v, v, 0.5).x).wgsl).toMatch(/mix\([^;]*, 0\.5\)/);
        expect(compileBoth(refract(v, v, 1.5).x).wgsl).toMatch(/refract\([^;]*, 1\.5\)/);
        expect(mix(0, 1, x).type).toBe(d.f32);
    });

    test('a scalar node meets a number anywhere', () => {
        expectTypeOf(clamp(x, 0, 1)).toEqualTypeOf<Node<d.f32>>();
        expectTypeOf(x.lessThan(0.5)).toEqualTypeOf<Node<d.bool>>();
        const value = clamp(x, 0, 1)
            .add(smoothstep(0, 1, x))
            .add(step(0.5, x))
            .add(min(x, 0))
            .add(max(0, x))
            .add(pow(x, 2))
            .add(select(f32(0), 1, lessThan(0.5, x)));
        const { wgsl, glsl } = compileBoth(value);
        expect(wgsl).toMatch(/clamp\([^;]*, 0\.0, 1\.0\)/);
        expect(wgsl).toMatch(/smoothstep\(0\.0, 1\.0, /);
        expect(wgsl).toMatch(/0\.5 < /);
        expect(glsl).toMatch(/clamp\([^;]*, 0\.0, 1\.0\)/);
    });

    test('integer scalars shift by a number, as a u32, and mask by one', () => {
        const { wgsl } = compileBoth(f32(i.shiftLeft(3).bitwiseAnd(255)));
        expect(wgsl).toMatch(/<< 3u/);
        expect(wgsl).toMatch(/& 255i/);
    });

    test('booleans are bools wherever one is expected', () => {
        expectTypeOf(select(true, false, c)).toEqualTypeOf<Node<d.bool>>();
        const { wgsl } = compileBoth(select(f32(0), f32(1), c.and(true).or(false)));
        expect(wgsl).toMatch(/&& true/);
        expect(wgsl).toMatch(/\|\| false/);
    });

    test('vector arithmetic and remainder take a scalar number', () => {
        expectTypeOf(v.mod(2)).toEqualTypeOf<Node<d.vec3f>>();
        expect(compileBoth(v.mod(2).x).wgsl).toMatch(/ % 2\.0/);
        expect(mod(vec3i(i, i, i), 3).type).toBe(d.vec3i);
    });
});

describe('rejected, as WGSL rejects them', () => {
    test('a vector meets a number only in arithmetic', () => {
        // @ts-expect-error a vec3f's bounds are vec3fs
        expect(() => clamp(v, 0, 1)).toThrow(/clamp: a vec3f meets only a vec3f, not 0; write vec3f\(0\) to splat it/);
        // @ts-expect-error
        expect(() => v.lessThan(0.5)).toThrow(/lessThan: a vec3f meets only a vec3f/);
        // @ts-expect-error
        expect(() => step(0.5, v)).toThrow(/step: a vec3f/);
        // @ts-expect-error
        expect(() => min(v, 0)).toThrow(/min: a vec3f/);
        // @ts-expect-error
        expect(() => select(v, 0, c)).toThrow(/select: a vec3f/);
        // @ts-expect-error
        expect(() => vec3i(i, i, i).bitwiseAnd(1)).toThrow(/bitwiseAnd: a vec3i/);
        // @ts-expect-error
        expect(() => vec3u(u, u, u).shiftLeft(2)).toThrow(/shiftLeft: a vec3u shifts by a vec3u; write vec3u\(2\)/);
    });

    test('numbers alone name no type', () => {
        // @ts-expect-error
        expect(() => add(1, 2)).toThrow(/add: 1 and 2 are both numbers, which name no type/);
        // @ts-expect-error
        expect(() => select(0, 1, c)).toThrow(/select: only numbers/);
        // @ts-expect-error
        expect(() => mix(0, 1, 0.5)).toThrow(/mix: only numbers/);
        // @ts-expect-error
        expect(() => shiftLeft(1, u)).toThrow(/shiftLeft: a number shifted names no type; write u32\(1\) or i32\(1\)/);
    });

    test('a number must be exactly a value of the type it takes', () => {
        // whether a number is whole, or in range, is a runtime fact, so these type-check
        expect(() => i.mul(0.5)).toThrow(/mul: 0.5 is not an i32, which takes whole numbers/);
        expect(() => u.add(-1)).toThrow(/add: -1 is not a u32, which takes no negatives/);
        expect(() => u.greaterThan(-1)).toThrow(/greaterThan: -1 is not a u32/);
        expect(() => i.add(3e9)).toThrow(/add: 3000000000 is outside the i32 range/);
        expect(() => x.mul(Number.NaN)).toThrow(/mul: NaN has no f32 literal/);
        expect(() => x.mul(1e39)).toThrow(/mul: 1e\+39 is beyond the largest f32/);
        // @ts-expect-error a bool in a number slot
        expect(() => x.add(true)).toThrow();
        // @ts-expect-error a number in a bool slot
        expect(() => c.and(1)).toThrow(/and: takes true, false or a bool node, not 1/);
    });

    test('a matrix meets a number only in mul', () => {
        // @ts-expect-error
        expect(() => m.add(1)).toThrow(/add: a mat4x4f meets only a mat4x4f, not a number; scale it with mul/);
        // @ts-expect-error
        expect(() => m.div(2)).toThrow(/div: a mat4x4f/);
    });

    test('constant expressions WGSL fails when the shader is created', () => {
        expect(() => i.div(0)).toThrow(/div: an integer \/ by a literal 0 fails when the shader is created/);
        expect(() => u.mod(0)).toThrow(/mod: an integer % by a literal 0/);
        expect(() => vec3i(i, i, i).div(0)).toThrow(/by a literal 0/);
        expect(() => i.shiftRight(-1)).toThrow(/shiftRight: -1 is not a u32/);
        expect(() => i32(1).shiftLeft(31)).toThrow(/shiftLeft: 1 << 31 overflows an i32/);
        expect(() => i32(-2147483648).div(-1)).toThrow(/div: -2147483648 \/ -1 overflows an i32/);
        expect(() => f32(3e38).mul(10)).toThrow(/mul: 3e\+38 \* 10 is beyond an f32/);
        // integer arithmetic on literals wraps, as WGSL's does
        expect(() => i32(2147483647).add(1)).not.toThrow();
    });
});

describe('constructors convert as WGSL converts', () => {
    test.each([
        ['i32(1.7)', () => i32(1.7), 1],
        ['i32(-2.5)', () => i32(-2.5), -2],
        ['u32(-1)', () => u32(-1), 0],
        ['i32(3e10)', () => i32(3e10), 2147483647],
    ])('%s is %s', (_, build, value) => {
        expect(build().value).toBe(value);
    });

    test('vector constructors too, and NaN converts to nothing', () => {
        const ints = vec3i(1.7, -2.5, 3);
        expect(ints.args.map((a) => (a as unknown as { value: number }).value)).toEqual([1, -2, 3]);
        expect((vec3u(-1, 0, 0).args[0] as unknown as { value: number }).value).toBe(0);
        expect(() => i32(Number.NaN)).toThrow(/i32\(NaN\): no i32 has that value/);
    });
});
