import { describe, expect, test } from 'vitest';
import { compileGlsl, compileWgsl } from '../src/index';
import { voidFragmentMaterial } from './void-fragment';

describe('a void fragment', () => {
    test('runs its statements and declares no colour output, on both backends', () => {
        const material = voidFragmentMaterial();
        const slots = { vertex: material.vertex, fragment: material.fragment, depth: undefined };

        const wgsl = compileWgsl(slots);
        expect(wgsl.fragmentEntryPoint).toBe('fs_main');
        expect(wgsl.code).toContain('fn fs_main(input: FragmentInput) {');
        expect(wgsl.code).toContain('discard;');
        expect(wgsl.code).not.toContain('@location(0) vec4f');

        const glsl = compileGlsl(slots);
        expect(glsl.code).toContain('discard;');
        expect(glsl.code).not.toContain('out vec4 fragColor');
    });
});
