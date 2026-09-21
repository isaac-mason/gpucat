import { expect, test } from 'vitest';
import { blendFactor } from '../src/renderer/webgl/state';

/** Only the constants the table reads; each is distinct so a wrong branch is visible. */
const gl = {
    ZERO: 1,
    ONE: 2,
    SRC_COLOR: 3,
    ONE_MINUS_SRC_COLOR: 4,
    SRC_ALPHA: 5,
    ONE_MINUS_SRC_ALPHA: 6,
    DST_COLOR: 7,
    ONE_MINUS_DST_COLOR: 8,
    DST_ALPHA: 9,
    ONE_MINUS_DST_ALPHA: 10,
    SRC_ALPHA_SATURATE: 11,
} as unknown as WebGL2RenderingContext;

const SUPPORTED: [GPUBlendFactor, number][] = [
    ['zero', 1],
    ['one', 2],
    ['src', 3],
    ['one-minus-src', 4],
    ['src-alpha', 5],
    ['one-minus-src-alpha', 6],
    ['dst', 7],
    ['one-minus-dst', 8],
    ['dst-alpha', 9],
    ['one-minus-dst-alpha', 10],
    ['src-alpha-saturated', 11],
];

test.each(SUPPORTED)('%s maps to its own GL constant', (factor, expected) => {
    expect(blendFactor(gl, factor)).toBe(expected);
});

/** These reached `default: return gl.ONE`, so a dual-source blend rendered as factor one, silently. */
test.each([
    'src1',
    'one-minus-src1',
    'src1-alpha',
    'one-minus-src1-alpha',
] as GPUBlendFactor[])('%s is refused, WebGL2 having no dual-source blending', (factor) => {
    expect(() => blendFactor(gl, factor)).toThrow(/dual-source blending/);
});

/** A constant-factor blend would read a blend colour gpucat never sets, so it is refused too. */
test.each(['constant', 'one-minus-constant'] as GPUBlendFactor[])('%s is refused', (factor) => {
    expect(() => blendFactor(gl, factor)).toThrow(/does not\s+model a blend constant/);
});
