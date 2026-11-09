import { describe, expect, test } from 'vitest';
import {
    attribute,
    compileGlsl,
    compileWgsl,
    d,
    dot,
    f32,
    i32,
    type Node,
    pack2x16snorm,
    pack2x16unorm,
    pack4x8snorm,
    pack4x8unorm,
    screenCoordinate,
    u32,
    vec2f,
    vec3i,
    vec4,
} from '../src/index';

// WGSL builtins GLSL ES 3.00 lacks or computes differently: pack4x8 has no GLSL form, the normalized packs round as
// floor(0.5 + scale * x) where GLSL's round() leaves ties open, abs takes a u32, and dot takes integer vectors.
// (The pack-and-integer-builtins render cases check the values on both backends.)

function compileBoth(value: Node<d.f32>): { wgsl: string; glsl: string } {
    const shader = {
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: vec4(value, f32(0), f32(0), f32(1)),
        depth: undefined,
    };
    return { wgsl: compileWgsl(shader).code, glsl: compileGlsl(shader).code };
}

const x = screenCoordinate.x;

describe('GLSL builtin lowering', () => {
    test.each([
        ['pack4x8unorm', () => pack4x8unorm(vec4(x, x, x, x))],
        ['pack4x8snorm', () => pack4x8snorm(vec4(x, x, x, x))],
        ['pack2x16unorm', () => pack2x16unorm(vec2f(x, x))],
        ['pack2x16snorm', () => pack2x16snorm(vec2f(x, x))],
    ])('%s is a WGSL builtin and a GLSL helper', (fn, build) => {
        const { wgsl, glsl } = compileBoth(f32(build()));
        expect(wgsl).toMatch(new RegExp(`\\b${fn}\\(`));
        expect(glsl).toMatch(
            new RegExp(
                `uint _${fn}\\(vec[24] e\\) \\{[^}]*floor\\(0\\.5 \\+|uint _${fn}\\(vec[24] e\\) \\{ uvec[24] b = uvec[24]\\(0\\.5 \\+`,
            ),
        );
        expect(glsl).not.toMatch(/packUnorm|packSnorm/);
    });

    test('abs of a u32 is the value itself in GLSL', () => {
        const { wgsl, glsl } = compileBoth(f32(u32(x).abs()));
        expect(wgsl).toMatch(/\babs\(/);
        expect(glsl).not.toMatch(/\babs\(/);
    });

    test('dot of integer vectors is typed by element and spelled out in GLSL', () => {
        const v = vec3i(i32(x), i32(2), i32(3));
        const product = dot(v, v);
        expect(product.type).toBe(d.i32);
        expect(v.dot(v).type).toBe(d.i32);
        const { wgsl, glsl } = compileBoth(f32(product));
        expect(wgsl).toMatch(/\bdot\(/);
        expect(glsl).toContain('int _dot(ivec3 a, ivec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }');
    });

    test('float dot stays a builtin on both', () => {
        const v = vec2f(x, x);
        expect(dot(v, v).type).toBe(d.f32);
        expect(compileBoth(dot(v, v)).glsl).toMatch(/\bdot\(/);
    });
});
