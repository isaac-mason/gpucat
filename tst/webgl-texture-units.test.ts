import { expect, test } from 'vitest';
import { createMemoryTally } from '../src/renderer/core/info';
import { createBufferCopies } from '../src/renderer/webgl/buffer-copies';
import {
    bindSamplerUnit,
    bindTextureUnit,
    bindUploadTexture,
    createTextureCache,
    deleteGlTexture,
} from '../src/renderer/webgl/textures';

const TEXTURE0 = 0x84c0;
const TEXTURE_2D = 0x0de1;
const TEXTURE_2D_ARRAY = 0x8c1a;
const TEXTURE_3D = 0x806f;

/** Enough GL to record the texture unit calls made, in order. */
function fakeGl() {
    const calls: string[] = [];
    const gl = {
        TEXTURE0,
        TEXTURE_2D,
        TEXTURE_2D_ARRAY,
        TEXTURE_3D,
        activeTexture: (unit: number) => void calls.push(`active ${unit - TEXTURE0}`),
        bindTexture: (target: number, texture: unknown) =>
            void calls.push(`texture ${target === TEXTURE_2D ? '2d' : target} ${texture}`),
        bindSampler: (unit: number, sampler: unknown) => void calls.push(`sampler ${unit} ${sampler}`),
        deleteTexture: (texture: unknown) => void calls.push(`delete ${texture}`),
    } as unknown as WebGL2RenderingContext;
    return { gl, calls };
}

const texture = (name: string) => name as unknown as WebGLTexture;
const sampler = (name: string) => name as unknown as WebGLSampler;

test('a texture already bound on its unit is not bound again, and the unit is made active only to bind', () => {
    const { gl, calls } = fakeGl();
    const state = createTextureCache(createMemoryTally(), createBufferCopies());
    bindTextureUnit(gl, state, 2, TEXTURE_2D, texture('atlas'));
    bindTextureUnit(gl, state, 2, TEXTURE_2D, texture('atlas'));
    bindTextureUnit(gl, state, 3, TEXTURE_2D, texture('noise'));
    bindTextureUnit(gl, state, 2, TEXTURE_2D, texture('atlas'));
    // another target on the same unit is a binding of its own
    bindTextureUnit(gl, state, 2, TEXTURE_2D_ARRAY, texture('layers'));
    expect(calls).toEqual([
        'active 2',
        'texture 2d atlas',
        'active 3',
        'texture 2d noise',
        'active 2',
        `texture ${TEXTURE_2D_ARRAY} layers`,
    ]);
});

// a context starts with unit 0 active, so binding there needs no activeTexture
test('an upload binds on its own unit, so the unit a draw samples keeps its texture', () => {
    const { gl, calls } = fakeGl();
    const state = createTextureCache(createMemoryTally(), createBufferCopies());
    bindTextureUnit(gl, state, 0, TEXTURE_2D, texture('atlas'));
    bindUploadTexture(gl, state, TEXTURE_2D, texture('fresh'));
    bindUploadTexture(gl, state, TEXTURE_2D, texture('fresh'));
    bindTextureUnit(gl, state, 0, TEXTURE_2D, texture('atlas'));
    expect(calls).toEqual(['texture 2d atlas', 'active 31', 'texture 2d fresh']);
});

test("a parameter set on a draw's texture makes that draw's unit active, the texture already on it", () => {
    const { gl, calls } = fakeGl();
    const state = createTextureCache(createMemoryTally(), createBufferCopies());
    bindTextureUnit(gl, state, 4, TEXTURE_2D, texture('atlas'));
    bindUploadTexture(gl, state, TEXTURE_2D, texture('fresh'));
    bindUploadTexture(gl, state, TEXTURE_2D, texture('atlas'), 4);
    expect(calls.slice(2)).toEqual(['active 31', 'texture 2d fresh', 'active 4']);
});

test('a deleted texture is forgotten: the same unit binds the next texture it is given', () => {
    const { gl, calls } = fakeGl();
    const state = createTextureCache(createMemoryTally(), createBufferCopies());
    bindTextureUnit(gl, state, 1, TEXTURE_2D, texture('old'));
    deleteGlTexture(gl, state, texture('old'));
    expect(state.units.textures.includes(texture('old'))).toBe(false);
    bindTextureUnit(gl, state, 1, TEXTURE_2D, texture('old'));
    expect(calls).toEqual(['active 1', 'texture 2d old', 'delete old', 'texture 2d old']);
});

test('a sampler already on its unit is not bound again; a unit past the tracked ones grows the record', () => {
    const { gl, calls } = fakeGl();
    const state = createTextureCache(createMemoryTally(), createBufferCopies());
    bindSamplerUnit(gl, state, 0, sampler('linear'));
    bindSamplerUnit(gl, state, 0, sampler('linear'));
    bindSamplerUnit(gl, state, 0, null);
    bindSamplerUnit(gl, state, 40, sampler('nearest'));
    bindSamplerUnit(gl, state, 40, sampler('nearest'));
    expect(calls).toEqual(['sampler 0 linear', 'sampler 0 null', 'sampler 40 nearest']);
    expect(state.units.samplers.length).toBe(41);
    expect(state.units.textures.length).toBe(41 * 4);
});
