import { describe, expect, test } from 'vitest';
import { attribute, compileGlsl, d, f32, mrt, vec4 } from '../src/index';

const vertex = () => vec4(attribute('position', d.vec3f), f32(1));

function fragmentMain(glsl: string): string {
    const fragment = glsl.slice(glsl.lastIndexOf('#version'));
    return fragment.slice(fragment.indexOf('void main()'));
}

describe('GLSL fragment outputs', () => {
    test("a var named like the output doesn't shadow it, so the output is still written", () => {
        // a local `vec4 fragColor` would take the final assignment, leaving the output unwritten: WebGL then
        // drops the draw with "Active draw buffers with missing fragment shader outputs"
        const fragment = vec4(f32(1), f32(0.5), f32(0.25), f32(1)).toVar('fragColor');
        const main = fragmentMain(compileGlsl({ vertex: vertex(), fragment, depth: undefined }).code);

        expect(main).not.toMatch(/\bvec4 fragColor\b/);
        expect(main).toMatch(/\n\s+fragColor = /);
    });

    test("a var named like one of several outputs doesn't shadow it", () => {
        const albedo = vec4(f32(1), f32(0), f32(0), f32(1)).toVar('albedo');
        const fragment = mrt({ albedo, normal: vec4(f32(0), f32(1), f32(0), f32(1)) });
        const main = fragmentMain(compileGlsl({ vertex: vertex(), fragment, depth: undefined }).code);

        expect(main).not.toMatch(/\bvec4 albedo\b/);
        expect(main).toMatch(/\n\s+albedo = /);
    });
});
