import { describe, expect, test } from 'vitest';
import { attribute, compileGlsl, compileWgsl, d, f32, i32, mod, screenCoordinate, vec3, vec4 } from '../src/index';

// WGSL's float `%` truncates, the result taking the sign of the left side. GLSL ES 3.00 has no float `%`, and its
// `mod()` floors, so the GLSL emitter spells WGSL's remainder out in a `_rem` helper. (The float-remainder render
// cases check the value on both backends.)

function compileBoth(fragment: ReturnType<typeof vec4>): { wgsl: string; glsl: string } {
    const shader = { vertex: vec4(attribute('position', d.vec3f), f32(1)), fragment, depth: undefined };
    return { wgsl: compileWgsl(shader).code, glsl: compileGlsl(shader).code };
}

describe('float remainder', () => {
    test('WGSL keeps its own %', () => {
        const { wgsl } = compileBoth(vec4(mod(screenCoordinate.x, f32(2)), f32(0), f32(0), f32(1)));
        expect(wgsl).toMatch(/ % 2\.0/);
    });

    test('GLSL truncates in a helper, never mod()', () => {
        const { glsl } = compileBoth(vec4(mod(screenCoordinate.x, f32(2)), f32(0), f32(0), f32(1)));
        expect(glsl).not.toMatch(/\bmod\(/);
        expect(glsl).toContain('float _rem(float x, float y) { return x - y * trunc(x / y); }');
        // the definition, and the call
        expect(glsl.match(/_rem\(/g)).toHaveLength(2);
    });

    test('one overload per operand type, emitted once however often it is called', () => {
        const x = screenCoordinate.x;
        const v = vec3(x, x, x);
        const { glsl } = compileBoth(
            vec4(mod(v, vec3(f32(2), f32(3), f32(4))).add(mod(v, v)), mod(x, f32(5)).add(mod(x, f32(7)))),
        );
        expect(glsl.match(/vec3 _rem\(vec3 x, vec3 y\)/g)).toHaveLength(1);
        expect(glsl.match(/float _rem\(float x, float y\)/g)).toHaveLength(1);
    });

    test('integer % stays an operator', () => {
        const { glsl } = compileBoth(vec4(f32(mod(i32(screenCoordinate.x), i32(3))), f32(0), f32(0), f32(1)));
        expect(glsl).toMatch(/ % 3\b/);
        expect(glsl).not.toContain('_rem');
    });
});
