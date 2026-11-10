import { describe, expect, test } from 'vitest';
import {
    attribute,
    compileGlsl,
    compileWgsl,
    createData3DTexture,
    createDataTexture,
    d,
    f32,
    i32,
    type Node,
    texture,
    vec2i,
    vec3i,
    vec3u,
    vec4,
} from '../src/index';

// A texel is read at one integer coordinate per dimension of the texture, as WGSL's textureLoad takes it. `.load`
// was typed for a vec2i alone, so a 3D texture's vec3i took a cast, and a 2D coordinate on it failed only when the
// shader was created.

function compileBoth(value: Node<d.f32>): { wgsl: string; glsl: string } {
    const shader = {
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: vec4(value, f32(0), f32(0), f32(1)),
        depth: undefined,
    };
    return { wgsl: compileWgsl(shader).code, glsl: compileGlsl(shader).code };
}

const volume = texture(createData3DTexture(new Uint8Array(4 * 8), 2, 2, 2));
const flat = texture(createDataTexture(new Uint8Array(4 * 4), 2, 2));

describe('load takes a coordinate per dimension', () => {
    test('a 3D texture reads at a vec3i', () => {
        const { wgsl, glsl } = compileBoth(volume.load(vec3i(1, 0, 1)).x);
        expect(wgsl).toMatch(/textureLoad\(\w+, vec3i\(1i, 0i, 1i\), 0\)/);
        expect(glsl).toMatch(/texelFetch\(\w+, /);
    });

    test('a 2D texture still reads at a vec2i', () => {
        expect(compileBoth(flat.load(vec2i(1, 1)).x).wgsl).toMatch(/textureLoad\(\w+, vec2i\(1i, 1i\), 0\)/);
    });

    test('the wrong count throws where it is written', () => {
        // @ts-expect-error a texture_3d takes a vec3i
        expect(() => volume.load(vec2i(1, 1))).toThrow(/load: a texture_3d is read at a vec3i, not a vec2i/);
        // @ts-expect-error a texture_2d takes a vec2i
        expect(() => flat.load(vec3i(1, 1, 1))).toThrow(/load: a texture_2d is read at a vec2i, not a vec3i/);
        // @ts-expect-error
        expect(() => flat.load(i32(1))).toThrow(/not an i32/);
    });

    test('unsigned coordinates count too, as textureLoad takes them', () => {
        // typed signed alone, as the other texture coordinates are
        expect(compileBoth(volume.load(vec3u(1, 0, 1) as never).x).wgsl).toMatch(/textureLoad\(\w+, vec3u\(1u, 0u, 1u\), 0\)/);
    });
});
