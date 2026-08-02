import { describe, expect, test } from 'vitest';
import { attribute, compileGlsl, d, f32, GpuBuffer, storage, struct, u32, vec4 } from '../src/index';
import type { ResolvedStorageBufferTexture } from '../src/nodes/lib/texture';
import { createGlTexturesState, updateStorageBufferTexture } from '../src/renderer/webgl/textures';

// Storage capacity: the storage() WebGL read-lowering reinterprets a read-only buffer as an rgba32uint
// texture. The texel-grid width = min(totalTexels, maxTextureSize) and height = ceil is RENDERER-side
// metadata (on the mirror binding); the SHADER reads the row width back at runtime via `textureSize()`,
// so the emitted GLSL is independent of buffer size AND of value-vs-name binding — both compile the same,
// and the compile cache no longer varies with maxTextureSize. The renderer pads the short last row and
// validates the grid against the real MAX_TEXTURE_SIZE. These exercise pieces the readback harness can't.

const Instance = struct('Instance', { color: d.vec4f });

function storageReadSlots(totalTexels: number) {
    // One vec4f (= 1 rgba32uint texel) per element, so totalTexels === element count. Value-based.
    const buf = new GpuBuffer(d.array(Instance), { data: new Float32Array(totalTexels * 4), usage: 'storage' });
    const store = storage(buf);
    return {
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: store.element(u32(0)).fields().color,
        depth: undefined,
    };
}

// Name-based counterpart: `storage('slots', …)`, resolved from `geometry.setBuffer('slots', …)` at draw.
function namedStorageReadSlots() {
    const store = storage('slots', d.array(Instance), 'read');
    return {
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: store.element(u32(0)).fields().color,
        depth: undefined,
    };
}

describe('storage() lowering — runtime textureSize addressing (size- + binding-independent GLSL)', () => {
    test('maxTextureSize does NOT change the emitted GLSL (width is read via textureSize, not baked)', () => {
        // Same graph, two caps → the width is a runtime texture query, so the code is byte-identical.
        const graph = storageReadSlots(64);
        const c4 = compileGlsl(graph, { maxTextureSize: 4 }).code;
        const c8 = compileGlsl(graph, { maxTextureSize: 8 }).code;
        expect(c4).toEqual(c8);
        // The row width is a runtime texture query in the texel addressing, not a compile-time constant.
        expect(c4).toContain('textureSize(');
        expect(c4).not.toMatch(/% 4u|% 8u/); // no baked grid width
    });

    test('value-based and name-based storage compile to identical GLSL (binding style is bind-time only)', () => {
        // Modulo the storage node id in the uniform name (`u_storage<id>`), the two are byte-identical:
        // the value-vs-name distinction lives entirely on the mirror binding, never in the shader.
        const norm = (code: string) => code.replace(/u_storage\d+/g, 'u_storageN');
        const value = norm(compileGlsl(storageReadSlots(64)).code);
        const named = norm(compileGlsl(namedStorageReadSlots()).code);
        expect(named).toEqual(value);
        expect(value).toContain('textureSize(');
    });

    test('name-based storage compiles (no compile-time buffer required)', () => {
        // The buffer is unknown until bind; compileGlsl must not need it.
        expect(() => compileGlsl(namedStorageReadSlots())).not.toThrow();
    });

    test('no exact-division requirement: a non-dividing width compiles (width = min(N, cap))', () => {
        // 10 texels, cap 4 → width 4 (4 does NOT divide 10); the renderer pads the short last row.
        expect(() => compileGlsl(storageReadSlots(10), { maxTextureSize: 4 })).not.toThrow();
    });

    test('no 2048 height cap: a small cap over a large buffer yields height > 2048 without throwing', () => {
        // 10000 texels, cap 4 → width 4, height 2500 (> 2048). The old path threw here.
        expect(() => compileGlsl(storageReadSlots(10000), { maxTextureSize: 4 })).not.toThrow();
    });
});

describe('storage() lowering — renderer validates the grid against MAX_TEXTURE_SIZE', () => {
    test('a grid exceeding MAX_TEXTURE_SIZE throws a clear error at upload', () => {
        const state = createGlTexturesState();
        state.maxTextureSize = 4; // pre-seed the cap so no GL call is needed before the guard fires.
        const buf = new GpuBuffer(d.array(Instance), { data: new Float32Array(25 * 4), usage: 'storage' });
        const source: ResolvedStorageBufferTexture = { buffer: buf, width: 5, height: 5 };
        // 5 > 4 → the validation throws before touching the (unused) GL context.
        expect(() => updateStorageBufferTexture({} as WebGL2RenderingContext, state, source)).toThrow(/MAX_TEXTURE_SIZE/);
    });
});
