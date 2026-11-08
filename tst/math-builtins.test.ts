import { describe, expect, test } from 'vitest';
import {
    attribute,
    compileGlsl,
    compileWgsl,
    d,
    f32,
    faceForward,
    type Node,
    reflect,
    refract,
    round,
    saturate,
    vec3,
    vec4,
} from '../src/index';

// round, saturate, reflect, refract and faceForward: WGSL spells each as written, GLSL ES 3.00 renames two and has
// no saturate at all. (tst/glsl-compile runs the same calls through a real WebGL2 compiler, tst/wgsl-validate
// through naga.)

/** a fragment showing `rgb`, as WGSL and GLSL */
function compileBoth(rgb: Node<d.vec3f>): { wgsl: string; glsl: string } {
    const shader = { vertex: vec4(attribute('position', d.vec3f), f32(1)), fragment: vec4(rgb, f32(1)), depth: undefined };
    return { wgsl: compileWgsl(shader).code, glsl: compileGlsl(shader).code };
}

const i = vec3(f32(0.6), f32(-0.8), f32(0));
const n = vec3(f32(0), f32(1), f32(0));

describe('math builtins', () => {
    test('round rounds halves to even: WGSL round, GLSL roundEven', () => {
        const { wgsl, glsl } = compileBoth(round(i));
        expect(wgsl).toMatch(/\bround\(/);
        expect(glsl).toMatch(/\broundEven\(/);
        expect(glsl).not.toMatch(/\bround\(/);
    });

    test('saturate is native in WGSL and a clamp to [0, 1] in GLSL', () => {
        const { wgsl, glsl } = compileBoth(saturate(i).add(vec3(saturate(f32(1.5)), f32(0), f32(0))));
        expect(wgsl).toMatch(/\bsaturate\(/);
        expect(glsl).not.toMatch(/\bsaturate\(/);
        expect(glsl.match(/clamp\([^;]*?, 0\.0, 1\.0\)/g)?.length).toBe(2);
    });

    test('reflect and refract are spelled alike in both', () => {
        const { wgsl, glsl } = compileBoth(reflect(i, n).add(refract(i, n, f32(0.75))));
        for (const code of [wgsl, glsl]) {
            expect(code).toMatch(/\breflect\(/);
            expect(code).toMatch(/\brefract\(/);
        }
    });

    test('faceForward is GLSL faceforward', () => {
        const { wgsl, glsl } = compileBoth(faceForward(n, i, n));
        expect(wgsl).toMatch(/\bfaceForward\(/);
        expect(glsl).toMatch(/\bfaceforward\(/);
    });

    test('the method forms build the same calls', () => {
        const { wgsl } = compileBoth(
            i
                .reflect(n)
                .add(i.refract(n, f32(0.75)))
                .add(n.faceForward(i, n))
                .round()
                .saturate(),
        );
        for (const fn of ['reflect', 'refract', 'faceForward', 'round', 'saturate'])
            expect(wgsl).toMatch(new RegExp(`\\b${fn}\\(`));
    });

    test('each keeps its argument type', () => {
        expect(round(f32(1)).type).toBe(d.f32);
        expect(saturate(i).type).toBe(d.vec3f);
        expect(reflect(i, n).type).toBe(d.vec3f);
        expect(refract(i, n, f32(1)).type).toBe(d.vec3f);
        expect(faceForward(n, i, n).type).toBe(d.vec3f);
    });
});
