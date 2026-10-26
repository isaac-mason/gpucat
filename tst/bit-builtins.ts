import {
    countLeadingZeros,
    countOneBits,
    countTrailingZeros,
    d,
    firstLeadingBit,
    firstTrailingBit,
    i32,
    type Node,
    reverseBits,
    select,
    Uniform,
    u32,
    uniform,
    vec4,
} from '../src/index';

/**
 * Every integer bit builtin against WGSL's answers, scalar and vector, u32 and i32, with the zero, all-ones and
 * negative edges: green when all of them hold, red when any doesn't. The operands come from uniforms so no compiler
 * folds the calls away. WebGPU runs the builtins natively and WebGL through the GLSL emitter's helpers, so the one
 * material drawn on both proves they agree.
 */
export function bitBuiltinsFragment(): Node<d.vec4f> {
    const unsigned = uniform(new Uniform(d.vec4u, [0x00f00100, 0, 0x80000001, 0xffffffff]));
    const signed = uniform(new Uniform(d.vec4i, [-1, 0, -256, 0x7fff]));
    const mixed = unsigned.x;
    const zero = unsigned.y;
    const ends = unsigned.z;
    const full = unsigned.w;

    const counts = countOneBits(unsigned);
    const trailing = firstTrailingBit(unsigned);
    const leadingSigned = firstLeadingBit(signed);

    const checks: Node<d.bool>[] = [
        countOneBits(mixed).equal(u32(5)),
        countOneBits(zero).equal(u32(0)),
        countOneBits(full).equal(u32(32)),
        countOneBits(signed.x).equal(i32(32)),
        reverseBits(mixed).equal(u32(0x00800f00)),
        reverseBits(ends).equal(u32(0x80000001)),
        reverseBits(signed.z).equal(i32(0x00ffffff)),
        countLeadingZeros(mixed).equal(u32(8)),
        countLeadingZeros(zero).equal(u32(32)),
        countLeadingZeros(full).equal(u32(0)),
        countTrailingZeros(mixed).equal(u32(8)),
        countTrailingZeros(zero).equal(u32(32)),
        countTrailingZeros(ends).equal(u32(0)),
        countTrailingZeros(signed.y).equal(i32(32)),
        firstLeadingBit(mixed).equal(u32(23)),
        firstLeadingBit(zero).equal(u32(0xffffffff)),
        firstLeadingBit(ends).equal(u32(31)),
        firstTrailingBit(mixed).equal(u32(8)),
        firstTrailingBit(zero).equal(u32(0xffffffff)),
        firstTrailingBit(signed.z).equal(i32(8)),
        firstTrailingBit(signed.y).equal(i32(-1)),
        // a signed leading bit is the highest one that differs from the sign: none for 0 and -1
        leadingSigned.x.equal(i32(-1)),
        leadingSigned.y.equal(i32(-1)),
        leadingSigned.z.equal(i32(7)),
        leadingSigned.w.equal(i32(14)),
        counts.x.equal(u32(5)),
        counts.y.equal(u32(0)),
        counts.z.equal(u32(2)),
        counts.w.equal(u32(32)),
        trailing.x.equal(u32(8)),
        trailing.y.equal(u32(0xffffffff)),
        trailing.z.equal(u32(0)),
        trailing.w.equal(u32(0)),
    ];
    const pass = checks.reduce((all, check) => all.and(check));
    return select(vec4(1, 0, 0, 1), vec4(0, 1, 0, 1), pass);
}
