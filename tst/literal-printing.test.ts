import { describe, expect, test } from 'vitest';
import { attribute, compileGlsl, compileWgsl, d, f32, i32, type Node, u32, vec3, vec4 } from '../src/index';
import { floatLiteral } from '../src/nodes/backend/print';
import { constLiteral } from '../src/nodes/wgsl-utils';

// Literals print in a form WGSL and GLSL ES 3.00 both parse back to the same value. JS's own spellings broke three
// ways: `1e+21` took a `.0` after its exponent, a fraction that rounds to a whole f32 lost its `.` (`x * 1`, an int
// in GLSL), and the f32 maximum printed at its shortest overflows in Tint. WGSL also reads `-2147483648i` as minus
// applied to an i32 that already overflowed. (tst/glsl-compile and tst/wgsl-validate run them through real compilers;
// the literal-edges render cases through Tint and ANGLE.)

/** a fragment showing `rgb`, as WGSL and GLSL */
function compileBoth(rgb: Node<d.vec3f>): { wgsl: string; glsl: string } {
    const shader = { vertex: vec4(attribute('position', d.vec3f), f32(1)), fragment: vec4(rgb, f32(1)), depth: undefined };
    return { wgsl: compileWgsl(shader).code, glsl: compileGlsl(shader).code };
}

describe('float literals', () => {
    test.each([
        [0, '0.0'],
        [-0, '-0.0'],
        [2, '2.0'],
        [-2.5, '-2.5'],
        [1 / 12, '0.083333336'],
        [1e-6, '0.000001'],
        [1e-7, '1.0e-7'],
        [1e21, '1.0e+21'],
        [1.5e21, '1.5e+21'],
        [1e16, '1.0e+16'],
        [123456789, '123456790.0'],
    ])('%d prints as %s', (value, printed) => {
        expect(floatLiteral(value)).toBe(printed);
    });

    test('a fraction that rounds to a whole f32 keeps its point', () => {
        expect(floatLiteral(0.99999999999)).toBe('1.0');
        expect(floatLiteral(16777216.5)).toBe('16777216.0');
    });

    test('below the smallest f32 rounds to a zero of the same sign', () => {
        expect(floatLiteral(1e-50)).toBe('0.0');
        expect(floatLiteral(-1e-50)).toBe('-0.0');
    });

    test('the f32 maximum prints at the fewest digits that stay within it', () => {
        const printed = floatLiteral(3.4028234663852886e38);
        expect(Number(printed)).toBeLessThanOrEqual(3.4028234663852886e38);
        expect(Math.fround(Number(printed))).toBe(3.4028234663852886e38);
        // the shortest round-trip spelling, 3.4028235e+38, is past the maximum
        expect(printed).not.toBe('3.4028235e+38');
    });

    test('NaN, the infinities and values past the maximum throw', () => {
        expect(() => floatLiteral(Number.NaN)).toThrow(/NaN has no f32 literal/);
        expect(() => floatLiteral(-Infinity)).toThrow(/no f32 literal/);
        expect(() => floatLiteral(3.5e38)).toThrow(/beyond the largest f32/);
        expect(() => floatLiteral(65520, 'f16')).toThrow(/beyond the largest f16, 65504/);
    });

    test('f16 rounds at f16 precision, subnormals kept', () => {
        expect(floatLiteral(65504, 'f16')).toBe('65500.0');
        expect(floatLiteral(1 / 3, 'f16')).toBe('0.3333');
        expect(floatLiteral(2 ** -24, 'f16')).toBe('6.0e-8');
        expect(constLiteral('vec2h', [0.1, -0])).toBe('vec2h(0.1h, -0.0h)');
    });
});

describe('integer literals', () => {
    test('the smallest i32 is a conversion in WGSL and plain in GLSL', () => {
        expect(constLiteral('i32', -2147483648)).toBe('i32(-2147483648)');
        expect(constLiteral('vec2i', [-2147483648, 1])).toBe('vec2i(i32(-2147483648), 1i)');
        expect(constLiteral('i32', 2147483647)).toBe('2147483647i');
    });

    test('NaN has no integer literal', () => {
        expect(() => constLiteral('i32', Number.NaN)).toThrow(/no i32 literal/);
        expect(() => constLiteral('vec2u', [1, Infinity])).toThrow(/no u32 literal/);
    });
});

describe('in emitted shaders', () => {
    test('large and near-whole floats print the same valid spelling in both', () => {
        const { wgsl, glsl } = compileBoth(vec3(f32(1e21), f32(0.99999999999), f32(3.4028234663852886e38)));
        for (const code of [wgsl, glsl]) {
            expect(code).toContain('1.0e+21');
            expect(code).not.toMatch(/e\+21\.0/);
            expect(code).not.toContain('3.4028235e+38');
        }
        expect(wgsl).toContain('vec3f(1.0e+21, 1.0, 3.402823466e+38)');
    });

    test('the smallest i32 converted to f32 is folded into a float', () => {
        const { wgsl, glsl } = compileBoth(vec3(f32(i32(-2147483648)), f32(u32(4294967295)), f32(0)));
        expect(wgsl).not.toMatch(/-2147483648i/);
        expect(glsl).not.toMatch(/-2147483648i/);
    });

    test('negating -0 parenthesises it, as any negative literal', () => {
        const { wgsl, glsl } = compileBoth(vec3(f32(-0).negate(), f32(0), f32(0)));
        for (const code of [wgsl, glsl]) {
            expect(code).not.toContain('--0.0');
            expect(code).toContain('-(-0.0)');
        }
    });
});

describe('folded conversions', () => {
    // a conversion of a literal folds into one literal, converted as WGSL converts it, not printed from the JS value
    test.each([
        ['u32(i32(-1))', () => u32(i32(-1)), '4294967295u'],
        ['i32(u32(4294967295))', () => i32(u32(4294967295)), '-1i'],
        ['i32(f32(3e10))', () => i32(f32(3e10)), '2147483647i'],
        ['i32(f32(-3e10))', () => i32(f32(-3e10)), 'i32(-2147483648)'],
        ['u32(f32(-1.5))', () => u32(f32(-1.5)), '0u'],
        ['i32(f32(-2.7))', () => i32(f32(-2.7)), '-2i'],
    ])('%s folds to %s', (_, build, literal) => {
        const { wgsl } = compileBoth(vec3(f32(build() as Node<d.i32>), f32(0), f32(0)));
        expect(wgsl).toContain(`f32(${literal})`);
    });
});
