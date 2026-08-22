import { describe, expect, test } from 'vitest';
import { d, struct } from '../src/index';
import { assertSchemaUniformValid, assertUniformLayoutConformant, type LayoutMember } from '../src/schema/validate-layout';

// The validator is the emit-time backstop for the uniform address-space rules. These tests pin that it
// accepts a conformant layout and rejects each way a layout can violate the rules — including the exact
// shape of the Firefox break (a struct member packed at offset 8 after another struct).
describe('assertUniformLayoutConformant', () => {
    const EnvTime = struct('EnvTime', { time: d.f32, wallTime: d.f32 });
    const EnvConfig = struct('EnvConfig', { enabled: d.u32, sunIntensity: d.f32 });

    const check = (members: LayoutMember[], totalBytes: number) =>
        assertUniformLayoutConformant('Uniforms_frame', members, totalBytes, 'wgsl-uniform');

    test('accepts a conformant layout (structs 16-aligned, block padded to 16)', () => {
        expect(() =>
            check(
                [
                    { uniformId: 'time', schema: EnvTime, offset: 0 },
                    { uniformId: 'config', schema: EnvConfig, offset: 16 },
                ],
                32,
            ),
        ).not.toThrow();
    });

    test('rejects a struct member at offset 8 (the Firefox break)', () => {
        expect(() =>
            check(
                [
                    { uniformId: 'time', schema: EnvTime, offset: 0 },
                    { uniformId: 'config', schema: EnvConfig, offset: 8 },
                ],
                32,
            ),
        ).toThrow(/config/);
    });

    test('rejects a scalar packed at offset 8 right after a struct', () => {
        // f32 has align 4, so offset 8 satisfies plain alignment — only the "member after a struct/array
        // must be 16-aligned" rule catches this.
        expect(() =>
            check(
                [
                    { uniformId: 'time', schema: EnvTime, offset: 0 },
                    { uniformId: 'tail', schema: d.f32, offset: 8 },
                ],
                16,
            ),
        ).toThrow(/multiple of 16/);
    });

    test('rejects a block size that is not a multiple of 16', () => {
        expect(() => check([{ uniformId: 'v', schema: d.vec2f, offset: 0 }], 8)).toThrow(/multiple of 16/);
    });

    test('rejects a raw scalar array (tight stride 4 is uniform-invalid without d.align)', () => {
        // In the one WGSL layout f32[4] packs tight (stride 4), which a uniform forbids — the author
        // must d.align the element or use vec4. The validator catches the raw case.
        expect(() => check([{ uniformId: 'arr', schema: d.sizedArray(d.f32, 4), offset: 0 }], 16)).toThrow(/stride/);
    });

    test('accepts a d.align(16) scalar array (16-byte stride)', () => {
        const arr = d.sizedArray(d.align(16, d.f32), 4);
        expect(() => check([{ uniformId: 'arr', schema: arr, offset: 0 }], 64)).not.toThrow();
    });

    test('std430 layout is exempt (storage packs tight)', () => {
        expect(() =>
            assertUniformLayoutConformant('S', [{ uniformId: 'tail', schema: d.f32, offset: 8 }], 12, 'std430'),
        ).not.toThrow();
    });
});

// The schema-level check is the backend-independent gate: it runs on every uniform-bound struct so a
// WebGL build still catches a WebGPU-breaking layout, and it is where the d.align guidance is surfaced.
describe('assertSchemaUniformValid', () => {
    const Inner = struct('Inner', { a: d.f32, b: d.f32 }); // 8 bytes, natural align 4

    test('rejects a member that follows a nested struct without d.align', () => {
        const Outer = struct('Outer', { inner: Inner, tail: d.f32 }); // tail lands at 8, must be 16
        expect(() => assertSchemaUniformValid('Outer', Outer)).toThrow(/d\.align/);
    });

    test('accepts it once the following member is d.aligned to 16', () => {
        const Outer = struct('Outer', { inner: Inner, tail: d.align(16, d.f32) });
        expect(() => assertSchemaUniformValid('Outer', Outer)).not.toThrow();
    });

    test('accepts a flat scalar struct (naturally uniform-valid)', () => {
        const Flat = struct('Flat', { a: d.u32, b: d.f32, c: d.f32 });
        expect(() => assertSchemaUniformValid('Flat', Flat)).not.toThrow();
    });

    test('accepts a vec4-packed struct with no d.align (the well-designed case)', () => {
        const Packed = struct('Packed', { color: d.vec4f, params: d.vec4f });
        expect(() => assertSchemaUniformValid('Packed', Packed)).not.toThrow();
    });

    test('rejects a nested scalar array without d.align', () => {
        const Outer = struct('Outer2', { data: d.sizedArray(d.f32, 4), count: d.u32 });
        expect(() => assertSchemaUniformValid('Outer2', Outer)).toThrow(/d\.align|stride/);
    });

    test('scalars/vectors/matrices are always valid (nothing to align)', () => {
        expect(() => assertSchemaUniformValid('v', d.vec3f)).not.toThrow();
        expect(() => assertSchemaUniformValid('m', d.mat4x4f)).not.toThrow();
    });
});
