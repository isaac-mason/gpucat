import { describe, expect, test } from 'vitest';
import {
    attribute,
    compileGlsl,
    compileWgsl,
    d,
    div,
    f32,
    i32,
    mod,
    type Node,
    screenCoordinate,
    shiftLeft,
    shiftRight,
    u32,
    vec3i,
    vec4,
} from '../src/index';

// WGSL defines integer `/` and `%` everywhere, truncating: a / 0 = a, a % 0 = 0, MIN / -1 = MIN, and the remainder
// takes the sign of a. GLSL ES 3.00 leaves division by zero and a negative `%` operand undefined (SwiftShader gives
// -7 % 3 = 2), so the GLSL emitter lowers them to helpers. WGSL also shifts by the amount's low five bits, which GLSL
// leaves undefined from 32 up. (The integer-division render cases check the values on both backends.)

function compileBoth(value: Node<d.f32>): { wgsl: string; glsl: string } {
    const shader = {
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: vec4(value, f32(0), f32(0), f32(1)),
        depth: undefined,
    };
    return { wgsl: compileWgsl(shader).code, glsl: compileGlsl(shader).code };
}

const xi = i32(screenCoordinate.x);
const xu = u32(screenCoordinate.x);

describe('integer division', () => {
    test('WGSL keeps its operators', () => {
        const { wgsl } = compileBoth(f32(div(xi, i32(3)).add(mod(xi, i32(3)))));
        expect(wgsl).toMatch(/ \/ 3i/);
        expect(wgsl).toMatch(/ % 3i/);
        expect(wgsl).not.toMatch(/_idiv|_irem/);
    });

    test('signed / and % lower to helpers in GLSL, whatever the divisor', () => {
        const { glsl } = compileBoth(f32(div(xi, i32(3)).add(mod(xi, i32(3)))));
        expect(glsl).toContain('int _idiv(int a, int b)');
        expect(glsl).toContain('int _irem(int a, int b)');
        expect(glsl).toMatch(/_idiv\([^;]*, 3\)/);
    });

    test('unsigned ones only when the divisor could be zero', () => {
        expect(compileBoth(f32(div(xu, u32(4)).add(mod(xu, u32(4))))).glsl).not.toMatch(/_udiv|_urem/);
        const { glsl } = compileBoth(f32(div(xu, xu).add(mod(xu, xu))));
        expect(glsl).toContain('uint _udiv(uint a, uint b) { return b == 0u ? a : a / b; }');
        expect(glsl).toContain('uint _urem(uint a, uint b) { return b == 0u ? 0u : a % b; }');
    });

    test('vector overloads apply the scalar one per component, defined after it', () => {
        const v = vec3i(xi, xi, xi);
        const { glsl } = compileBoth(f32(mod(v, vec3i(i32(3), i32(-3), xi)).x.add(div(v, xi).y)));
        expect(glsl).toContain(
            'ivec3 _irem(ivec3 a, ivec3 b) { return ivec3(_irem(a.x, b.x), _irem(a.y, b.y), _irem(a.z, b.z)); }',
        );
        expect(glsl).toContain('ivec3 _idiv(ivec3 a, int b) { return ivec3(_idiv(a.x, b), _idiv(a.y, b), _idiv(a.z, b)); }');
        expect(glsl.indexOf('int _irem(int a, int b)')).toBeLessThan(glsl.indexOf('ivec3 _irem('));
    });
});

describe('shifts', () => {
    test('a runtime amount is masked to its low five bits in GLSL', () => {
        const { wgsl, glsl } = compileBoth(f32(shiftLeft(xu, xu).add(u32(shiftRight(xi, xu)))));
        expect(glsl).toMatch(/<< \([^;]*& 31u\)/);
        expect(glsl).toMatch(/>> \([^;]*& 31u\)/);
        expect(wgsl).not.toContain('& 31u');
    });

    test('a literal amount within 31 is left as it is', () => {
        const { glsl } = compileBoth(f32(shiftLeft(xu, u32(3))));
        expect(glsl).toMatch(/<< 3u/);
        expect(glsl).not.toContain('& 31u');
    });

    test('a literal amount of 32 or more throws where it is written', () => {
        expect(() => shiftLeft(xu, u32(32))).toThrow(/shiftLeft: a shift of 32 is past a 32-bit integer/);
        expect(() => xi.shiftRight(u32(40))).toThrow(/shiftRight: a shift of 40/);
        expect(() => shiftLeft(xu, u32(31))).not.toThrow();
    });
});
