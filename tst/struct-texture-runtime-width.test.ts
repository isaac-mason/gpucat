import { expect, test } from 'vitest';
import { attribute, compile, compileGlsl, createStructTexture, f32, struct, texture, u32, vec4 } from '../src/index';
import * as d from '../src/schema/schema';

// A real `texture(t).load(schema, i)` maps a linear record index to (x, y) using the texture's
// texels-per-row width. That width is read at RUNTIME via textureSize()/textureDimensions() — never
// baked as a constant — so the SAME addressing serves a real texture and the WebGL storage() mirror
// (one path, mirroring three.js's PBO indexing) and the shader stays correct if the texture is resized
// under a cached program. This pins that both backends emit the runtime query, not a literal width.
test('real-texture load addresses texels with runtime width (both backends)', () => {
    const Rec = struct('RuntimeWidthRec', { color: d.vec4f });
    const record = texture(createStructTexture(Rec, 4)).load(Rec, u32(0));

    const vertex = vec4(attribute('position', d.vec3f), f32(1));

    const glsl = compileGlsl({ vertex, fragment: record.color, depth: undefined });
    expect(glsl.code).toContain('textureSize(');
    // No baked texels-per-row constant: the width comes only from the runtime query.
    expect(glsl.code).not.toMatch(/[%/]\s*4u/);

    const wgsl = compile({ vertex, fragment: record.color });
    expect(wgsl.code).toContain('textureDimensions(');
});
