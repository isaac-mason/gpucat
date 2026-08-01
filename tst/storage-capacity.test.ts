import { describe, expect, test } from 'vitest';
import { attribute, compileGlsl, d, f32, GpuBuffer, storage, struct, u32, vec4 } from '../src/index';
import { createGlTexturesState, updateStorageBufferTexture } from '../src/renderer/webgl/textures';
import type { StorageBufferTextureSource } from '../src/nodes/lib/texture';

// Storage capacity: the storage() WebGL read-lowering picks a texel-grid width = min(totalTexels,
// maxTextureSize) and height = ceil (no exact-division requirement, no 2048 hardcap). `maxTextureSize`
// is threaded into compileGlsl and baked into the shader's addressing; the renderer pads the short last
// row and validates the grid against the real MAX_TEXTURE_SIZE. These exercise the pieces that the
// readback harness can't (a >2048 height or an over-cap grid would need infeasibly large buffers on a
// real 8192/16384-MAX context, so drive them with a tiny synthetic cap here).

const Instance = struct('Instance', { color: d.vec4f });

function storageReadSlots(totalTexels: number) {
    // One vec4f (= 1 rgba32uint texel) per element, so totalTexels === element count.
    const buf = new GpuBuffer(d.array(Instance), { data: new Float32Array(totalTexels * 4), usage: 'storage' });
    const store = storage(buf);
    return {
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: store.element(u32(0)).fields().color,
        depth: undefined,
    };
}

describe('storage() lowering — grid width threads maxTextureSize', () => {
    test('different maxTextureSize bakes a different grid width (so the emitted GLSL differs)', () => {
        const c4 = compileGlsl(storageReadSlots(64), { maxTextureSize: 4 }).code;
        const c8 = compileGlsl(storageReadSlots(64), { maxTextureSize: 8 }).code;
        expect(c4).not.toEqual(c8);
        // The baked width appears in the texel addressing (`... % Nu`, `... / Nu`).
        expect(c4).toContain('4u');
        expect(c8).toContain('8u');
    });

    test('no exact-division requirement: a non-dividing width compiles (width = min(N, cap))', () => {
        // 10 texels, cap 4 → width 4 (4 does NOT divide 10); the old path collapsed width to a divisor.
        expect(() => compileGlsl(storageReadSlots(10), { maxTextureSize: 4 })).not.toThrow();
    });

    test('no 2048 height cap: a small cap over a large buffer yields height > 2048 without throwing', () => {
        // 10000 texels, cap 4 → width 4, height 2500 (> 2048). The old path threw here.
        expect(() => compileGlsl(storageReadSlots(10000), { maxTextureSize: 4 })).not.toThrow();
    });

    test('default (no maxTextureSize): a small buffer stays a single row of width = totalTexels', () => {
        // ≤ 2048 texels → width = totalTexels, height 1 — byte-identical to the pre-capacity path.
        const code = compileGlsl(storageReadSlots(10)).code;
        expect(code).toContain('10u');
    });
});

describe('storage() lowering — renderer validates the grid against MAX_TEXTURE_SIZE', () => {
    test('a grid exceeding MAX_TEXTURE_SIZE throws a clear error at upload', () => {
        const state = createGlTexturesState();
        state.maxTextureSize = 4; // pre-seed the cap so no GL call is needed before the guard fires.
        const buf = new GpuBuffer(d.array(Instance), { data: new Float32Array(25 * 4), usage: 'storage' });
        const source: StorageBufferTextureSource = { buffer: buf, width: 5, height: 5 };
        // 5 > 4 → the validation throws before touching the (unused) GL context.
        expect(() => updateStorageBufferTexture({} as WebGL2RenderingContext, state, source)).toThrow(
            /MAX_TEXTURE_SIZE/,
        );
    });
});
