import { expectTypeOf, test } from 'vitest';
import { createStructTexture, struct, texture, u32 } from '../src/index';
import type { Node } from '../src/nodes/lib/core';
import * as d from '../src/schema/schema';

// Type-level regression: a `d.bits({...})` struct field must decode to a sub-accessor whose named
// fields are `Node<u32>` WITHOUT a cast — the runtime `decodeField` bits branch returns exactly that.
// (Runtime correctness is proven by the `struct-texture-bits` readback case in tst/webgl-render.)
test('bits field decodes to a Node<u32> sub-accessor without a cast', () => {
    const Rec = struct('BitsTypeRec', { bf: d.bits({ a: 8, b: 8, c: 16 }), extra: d.f32 });
    const acc = texture(createStructTexture(Rec, 1)).load(Rec, u32(0));

    // Plain assignments — these fail `tsc` (independent of vitest --typecheck) unless the type is right.
    const _a: Node<d.u32> = acc.bf.a;
    const _b: Node<d.u32> = acc.bf.b;
    const _extra: Node<d.f32> = acc.extra;
    void _a;
    void _b;
    void _extra;

    // Each declared bit field is `Node<u32>` — no cast, statically named.
    expectTypeOf(acc.bf.a).toEqualTypeOf<Node<d.u32>>();
    expectTypeOf(acc.bf.b).toEqualTypeOf<Node<d.u32>>();
    expectTypeOf(acc.bf.c).toEqualTypeOf<Node<d.u32>>();

    // A non-bits field is unaffected — still a plain `Node`.
    expectTypeOf(acc.extra).toEqualTypeOf<Node<d.f32>>();

    // An undeclared bit-field name is a type error (proves the names are static, not `any`).
    // @ts-expect-error `z` was not declared in d.bits({ a, b, c })
    acc.bf.z;
});
