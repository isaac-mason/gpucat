import { afterEach, describe, expect, test, vi } from 'vitest';
import { attribute, compileGlsl, compileWgsl, d, f32, invariant, Material, varying, vec4 } from '../src/index';

const position = () => vec4(attribute('position', d.vec3f), f32(1));

describe('invariant', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('a marked position is the invariant vertex output on both backends', () => {
        const slots = { vertex: invariant(position()), fragment: vec4(1, 0, 0, 1), depth: undefined };
        expect(compileWgsl(slots).code).toContain('@builtin(position) @invariant position: vec4f,');
        expect(compileGlsl(slots).code).toContain('invariant gl_Position;');
    });

    test('an unmarked position is not', () => {
        const slots = { vertex: position(), fragment: vec4(1, 0, 0, 1), depth: undefined };
        expect(compileWgsl(slots).code).not.toContain('@invariant');
        expect(compileGlsl(slots).code).not.toContain('invariant gl_Position');
    });

    test('as a value it is the position it marks, and only the vertex output carries the mark', () => {
        const clip = invariant(position());
        const vDepth = varying(clip.z, 'vDepth');
        const plain = compileWgsl({ vertex: position(), fragment: vec4(vDepth, 0, 0, 1), depth: undefined }).code;
        expect(plain).not.toContain('@invariant');
        expect(plain).toMatch(/output\.vDepth = /);
    });

    test('testing depth for equality without an invariant position warns, naming the material', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        new Material({ name: 'leaves', vertex: position(), fragment: vec4(1, 0, 0, 1), depthCompare: 'equal' });
        expect(warn).toHaveBeenCalledOnce();
        expect(String(warn.mock.calls[0]![0])).toMatch(/'leaves'.*equality.*invariant\(\)/);

        warn.mockClear();
        new Material({ vertex: invariant(position()), fragment: vec4(1, 0, 0, 1), depthCompare: 'equal' });
        new Material({ vertex: position(), fragment: vec4(1, 0, 0, 1), depthCompare: 'less' });
        expect(warn).not.toHaveBeenCalled();
    });
});
