import { describe, expect, test } from 'vitest';
import {
    attribute,
    compileComputeWgsl,
    compileGlsl,
    d,
    Fn,
    f32,
    i32,
    Loop,
    type Node,
    Uniform,
    u32,
    uniform,
    vec4f,
} from '../src/index';

// A Loop's `update` steps its variable as three.js TSL's does; it was dropped, every loop stepping `++`.

/** the loop `build` makes, as WGSL (a compute kernel) and as GLSL (a fragment) */
function compileBoth(build: (sum: Node<d.f32>) => void): { wgsl: string; glsl: string } {
    const kernel = Fn(() => {
        const sum = f32(0).toVar('sum');
        build(sum);
    }).compute({ workgroupSize: [64, 1, 1] });
    const shade = Fn(
        () => {
            const sum = f32(0).toVar('sum');
            build(sum);
            return vec4f(sum, f32(0), f32(0), f32(1));
        },
        { name: 'shade', params: [] as const, return: d.vec4f },
    );
    const clip = vec4f(attribute('position', d.vec3f), f32(1));
    return {
        wgsl: compileComputeWgsl(kernel).code,
        glsl: compileGlsl({ vertex: clip, fragment: shade(), depth: undefined }).code,
    };
}

describe('Loop update', () => {
    test('a number adds itself, counting up', () => {
        const { wgsl, glsl } = compileBoth((sum) => {
            Loop({ start: u32(3), end: u32(40), type: d.u32, update: 16 }, ({ i }) => {
                sum.assign(sum.add(i.toF32()));
            });
        });
        expect(wgsl).toMatch(/for \(var i: u32 = 3u; i < 40u; i \+= 16u\)/);
        expect(glsl).toMatch(/for \(uint i = 3u; i < 40u; i \+= 16u\)/);
    });

    test('a number subtracts itself, counting down', () => {
        const { wgsl, glsl } = compileBoth((sum) => {
            Loop({ start: 40, end: 0, condition: '>', update: 4 }, ({ i }) => {
                sum.assign(sum.add(i.toF32()));
            });
        });
        expect(wgsl).toMatch(/for \(var i: i32 = 40i; i > 0i; i -= 4i\)/);
        expect(glsl).toMatch(/for \(int i = 40; i > 0; i -= 4\)/);
    });

    test('a node adds itself, its uniform bound', () => {
        const stride = uniform(new Uniform(d.u32, 16));
        const { wgsl, glsl } = compileBoth((sum) => {
            Loop({ start: u32(0), end: u32(64), type: d.u32, update: stride }, ({ i }) => {
                sum.assign(sum.add(i.toF32()));
            });
        });
        expect(wgsl).toMatch(/i \+= \w+/);
        expect(wgsl).toMatch(/var<uniform>/);
        expect(glsl).toMatch(/i \+= \w+/);
    });

    // a uniform read nowhere but a loop's bounds was left out of the uniform struct, so the loop read a member that
    // was never declared: `uniforms_object.uniform8 not found`
    test.each(['start', 'end'] as const)('a uniform read only as its %s is declared', (bound) => {
        const n = uniform(new Uniform(d.i32, 8));
        const { wgsl, glsl } = compileBoth((sum) => {
            Loop(bound === 'end' ? { end: n } : { start: n, end: 0, condition: '>' }, ({ i }) => {
                sum.assign(sum.add(i.toF32()));
            });
        });
        for (const code of [wgsl, glsl]) {
            const forLine = code.split('\n').find((line) => line.includes('for ('))!;
            const member = forLine.match(/\.(\w+)/)?.[1] ?? forLine.match(/[<>]=? (\w+)/)![1];
            const declarations = code.split('\n').filter((line) => !line.includes('for (')).join('\n');
            expect(declarations).toMatch(new RegExp(`\\b${member}\\b`));
        }
    });

    test('a string follows the variable as written', () => {
        const { wgsl, glsl } = compileBoth((sum) => {
            Loop({ start: 1, end: 256, update: '*= 2' }, ({ i }) => {
                sum.assign(sum.add(i.toF32()));
            });
        });
        expect(wgsl).toMatch(/for \(var i: i32 = 1i; i < 256i; i \*= 2\)/);
        expect(glsl).toMatch(/for \(int i = 1; i < 256; i \*= 2\)/);
    });

    test('a function is the step statement', () => {
        const { wgsl, glsl } = compileBoth((sum) => {
            Loop({ start: 1, end: 100, update: ({ i }) => i.assign(i.mul(i32(3))) }, ({ i }) => {
                sum.assign(sum.add(i.toF32()));
            });
        });
        expect(wgsl).toMatch(/for \(var i: i32 = 1i; i < 100i; i = i \* 3i\)/);
        expect(glsl).toMatch(/for \(int i = 1; i < 100; i = i \* 3\)/);
    });

    test('left out, the step follows the condition', () => {
        const { wgsl, glsl } = compileBoth((sum) => {
            Loop({ start: 10, end: 0 }, ({ i }) => {
                sum.assign(sum.add(i.toF32()));
            });
            Loop({ start: 5 }, ({ i }) => {
                sum.assign(sum.add(i.toF32()));
            });
        });
        // a start above its end counts down; a start with no end counts down from start - 1 to 0
        expect(wgsl).toMatch(/for \(var i: i32 = 10i; i >= 0i; i--\)/);
        expect(wgsl).toMatch(/= 5i - 1i; \w+ >= 0i; \w+--\)/);
        expect(glsl).toMatch(/for \(int i = 10; i >= 0; i--\)/);
        expect(glsl).toMatch(/= 5 - 1; \w+ >= 0; \w+--\)/);
    });
});
