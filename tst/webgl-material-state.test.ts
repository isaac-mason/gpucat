import { expect, test } from 'vitest';
import { Material } from '../src/material/material';
import {
    applyMaterialState,
    createGlState,
    forgetGlState,
    setCapability,
    setClearColor,
    setViewport,
} from '../src/renderer/webgl/state';

/** `gl.polygonOffset` has no clamp, so honouring it would bias differently on the two backends. */
test('a material with depthBiasClamp is refused before any GL call, not quietly dropped', () => {
    const noGl = {} as WebGL2RenderingContext;

    expect(() =>
        applyMaterialState(
            noGl,
            createGlState(),
            new Material({ vertex: { id: 1 } as never, depthBiasClamp: 0.5 }),
            false,
            undefined,
        ),
    ).toThrow(/depthBiasClamp/);
});

/** Enough GL for the state record: every call it makes, by name and arguments. */
function recordingGl() {
    const calls: string[] = [];
    const constants: Record<string, number> = {
        DEPTH_TEST: 1,
        CULL_FACE: 2,
        BLEND: 3,
        STENCIL_TEST: 4,
        POLYGON_OFFSET_FILL: 5,
        SAMPLE_ALPHA_TO_COVERAGE: 6,
        SCISSOR_TEST: 7,
        RASTERIZER_DISCARD: 8,
        LESS: 10,
        ALWAYS: 11,
        EQUAL: 12,
        LEQUAL: 13,
        NEVER: 14,
        GREATER: 15,
        NOTEQUAL: 16,
        GEQUAL: 17,
        CCW: 20,
        FRONT: 21,
        BACK: 22,
        KEEP: 30,
        REPLACE: 31,
        ZERO: 32,
        ONE: 33,
        INVERT: 34,
        INCR: 35,
        DECR: 36,
        INCR_WRAP: 37,
        DECR_WRAP: 38,
        FUNC_ADD: 40,
    };
    const record =
        (name: string) =>
        (...args: unknown[]) =>
            void calls.push(`${name}(${args.join(',')})`);
    const gl = new Proxy(constants, {
        get: (target, key: string) => (key in target ? target[key] : record(key)),
    }) as unknown as WebGL2RenderingContext;
    return { gl, calls };
}

function stencilled(ref: number) {
    return new Material({
        vertex: { id: 1 } as never,
        stencilTest: true,
        stencilFunc: 'equal',
        stencilRef: ref,
        stencilZPass: 'replace',
    });
}

test('a material drawn again sets no state: every field is already as it wants', () => {
    const { gl, calls } = recordingGl();
    const state = createGlState();
    const material = stencilled(1);
    applyMaterialState(gl, state, material, true, undefined);
    const first = calls.length;
    applyMaterialState(gl, state, material, true, undefined);
    expect(first).toBeGreaterThan(0);
    expect(calls.length).toBe(first);
});

test('a stencil reference change sets the stencil func of each face, and nothing else', () => {
    const { gl, calls } = recordingGl();
    const state = createGlState();
    applyMaterialState(gl, state, stencilled(1), true, undefined);
    calls.length = 0;
    applyMaterialState(gl, state, stencilled(2), true, undefined);
    expect(calls).toEqual(['stencilFuncSeparate(21,12,2,255)', 'stencilFuncSeparate(22,12,2,255)']);
});

test('a back face of its own sets only the calls that differ from the front', () => {
    const { gl, calls } = recordingGl();
    const state = createGlState();
    const material = stencilled(1);
    material.stencilBack = { zPass: 'invert' };
    applyMaterialState(gl, state, material, true, undefined);
    expect(calls.filter((call) => call.startsWith('stencil'))).toEqual([
        'stencilMask(255)',
        'stencilFuncSeparate(21,12,1,255)',
        'stencilOpSeparate(21,30,30,31)',
        'stencilFuncSeparate(22,12,1,255)',
        'stencilOpSeparate(22,30,30,34)',
    ]);
});

test('a forgotten record sets everything again on the next draw', () => {
    const { gl, calls } = recordingGl();
    const state = createGlState();
    const material = stencilled(1);
    applyMaterialState(gl, state, material, true, undefined);
    const first = [...calls];
    forgetGlState(state);
    calls.length = 0;
    applyMaterialState(gl, state, material, true, undefined);
    expect(calls).toEqual(first);
});

test('viewport, scissor and clear values are set once until they change', () => {
    const { gl, calls } = recordingGl();
    const state = createGlState();
    setViewport(gl, state, 0, 0, 800, 600);
    setViewport(gl, state, 0, 0, 800, 600);
    setClearColor(gl, state, 0, 0, 0, 1);
    setClearColor(gl, state, 0, 0, 0, 1);
    setCapability(gl, state, 'scissorTest', false);
    setCapability(gl, state, 'scissorTest', false);
    setViewport(gl, state, 0, 0, 400, 600);
    expect(calls).toEqual(['viewport(0,0,800,600)', 'clearColor(0,0,0,1)', 'disable(7)', 'viewport(0,0,400,600)']);
});
