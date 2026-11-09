import { describe, expect, test } from 'vitest';
import {
    attribute,
    compileGlsl,
    d,
    f32,
    pack2x16float,
    pack2x16snorm,
    pack2x16unorm,
    u32,
    unpack2x16unorm,
    vec2f,
    vec4,
} from '../src/index';

const vertex = () => vec4(attribute('position', d.vec3f), f32(1));

describe('GLSL 2x16 packing', () => {
    test('packs and unpacks under their GLSL ES 3.00 names, the normalized packs through WGSL-rounding helpers', () => {
        const v = vec2f(f32(0.25), f32(0.75));
        const packed = pack2x16unorm(v).add(pack2x16snorm(v)).add(pack2x16float(v)).toVar('packed');
        const back = unpack2x16unorm(packed.bitwiseAnd(u32(0xffff)));
        const { code } = compileGlsl({ vertex: vertex(), fragment: vec4(back, f32(0), f32(1)), depth: undefined });

        expect(code).toContain('_pack2x16unorm(');
        expect(code).toContain('_pack2x16snorm(');
        expect(code).toContain('packHalf2x16(');
        expect(code).toContain('unpackUnorm2x16(');
        expect(code).not.toMatch(/\bpack2x16|\bunpack2x16/);
    });
});
