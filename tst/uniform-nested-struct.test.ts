import { describe, expect, test } from 'vitest';
import { attribute, compile, d, f32, struct, vec4 } from '../src/index';
import { fields, frameGroup, Uniform, UniformNode } from '../src/nodes/nodes';

// End-to-end: a nested struct bound as a uniform. A member following a nested struct must sit on a
// 16-byte boundary in the uniform address space. Without d.align the compile fails eagerly (on every
// backend), with an actionable message; with d.align it compiles and the WGSL pins the field's @align.
describe('nested struct in a UBO', () => {
    const Inner = struct('Inner', { a: d.f32, b: d.f32 }); // 8 bytes, so a following member lands at 8

    function compileWithOuter(Outer: ReturnType<typeof struct>) {
        const outer = fields(
            new UniformNode(new Uniform(Outer, { inner: { a: 0, b: 0 }, tail: 0 }, frameGroup), 'uniform_outer') as never,
        ) as never as { tail: ReturnType<typeof f32> };
        return compile({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: vec4(outer.tail, outer.tail, outer.tail, outer.tail),
            depth: undefined,
        });
    }

    test('throws with an actionable d.align message when the trailing member is not aligned', () => {
        const Outer = struct('OuterBad', { inner: Inner, tail: d.f32 });
        expect(() => compileWithOuter(Outer)).toThrow(/d\.align/);
    });

    test('compiles once the trailing member is d.align(16) and pins @align(16) in the WGSL', () => {
        const Outer = struct('OuterGood', { inner: Inner, tail: d.align(16, d.f32) });
        const result = compileWithOuter(Outer);
        expect(result.code).toContain('@align(16) tail');
    });
});
