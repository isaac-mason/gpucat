import { expect, test } from 'vitest';
import { attribute, compileGlsl, createStructTexture, f32, struct, texture, u32, vec4 } from '../src/index';
import * as d from '../src/schema/schema';

// Golden for decodeField's scalar/vector branches: a raw-u32 lane, bitcast i32/f32 scalars, a vec2
// (component-offset addressing within a texel), a vec3 (lanes 0..2), a vec4 (all four lanes), and the
// vec4u whole-texel shortcut (returns the texel directly, no reconstruction). This pins the emitted GLSL
// so a refactor of the decode ladder to read the descriptor scalar/len fields stays byte-identical.
// Correctness of the decoded VALUES is separately proven by the struct-texture readback cases in
// tst/webgl-render.
test('struct-texture decode: emitted GLSL across scalar/vector field kinds', () => {
    const Rec = struct('DecodeGolden', {
        u: d.u32,
        i: d.i32,
        f: d.f32,
        v2: d.vec2f,
        v3: d.vec3f,
        v4: d.vec4f,
        v4u: d.vec4u,
    });
    const rec = texture(createStructTexture(Rec, 1)).load(Rec, u32(0));
    const fragment = vec4(rec.f.add(f32(rec.u)).add(f32(rec.i)).add(rec.v2.x).add(rec.v3.y), rec.v4.z, f32(rec.v4u.w), f32(1));
    const result = compileGlsl({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment,
        depth: undefined,
    });
    expect(result.code).toMatchSnapshot();
});
