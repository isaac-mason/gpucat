// Emits the WGSL for a representative matrix of shaders (reusing the glsl-compile case set) plus
// uniform-layout cases that exercise the hardening directly. run.mjs validates each with naga (the
// validator Firefox uses — stricter than Chrome's Tint, which is what let the original bug ship).

import { attribute, compile, d, f32, struct, vec4 } from '../../src/index';
import { fields, frameGroup, Uniform, UniformNode } from '../../src/nodes/nodes';
import { cases } from '../glsl-compile/cases';

export function emitAll(): { name: string; code: string }[] {
    const out: { name: string; code: string }[] = [];

    for (const c of cases) {
        try {
            out.push({ name: c.name, code: compile(c.build()).code });
        } catch (e) {
            // An emit-time throw (e.g. the layout validator firing) is itself a failure to surface.
            out.push({ name: c.name, code: `// EMIT ERROR: ${e instanceof Error ? e.message : String(e)}` });
        }
    }

    // Uniform-layout cases: the exact class this hardening targets. A nested struct in a UBO, made
    // valid with d.align, must pass naga (and would have been rejected pre-fix).
    const Inner = struct('Inner', { a: d.f32, b: d.f32 });
    const Frame = struct('Frame', { inner: Inner, tail: d.align(16, d.f32) });
    const outer = fields(
        new UniformNode(new Uniform(Frame, { inner: { a: 0, b: 0 }, tail: 0 }, frameGroup), 'uniform_frame') as never,
    ) as never as { tail: ReturnType<typeof f32> };
    out.push({
        name: 'nested struct uniform (d.align)',
        code: compile({
            vertex: vec4(attribute('position', d.vec3f), f32(1)),
            fragment: vec4(outer.tail, outer.tail, outer.tail, outer.tail),
            depth: undefined,
        }).code,
    });

    return out;
}
