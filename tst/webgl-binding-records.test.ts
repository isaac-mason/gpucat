import { expect, test } from 'vitest';
import { createIndexBuffer } from '../src/index';
import { createMemoryTally, createRendererInfo } from '../src/renderer/core/info';
import { createBufferCache, writeBufferBytes } from '../src/renderer/webgl/buffers';
import {
    bindUniformBuffer,
    bindVertexArray,
    createGlState,
    deleteBuffer,
    deleteProgram,
    deleteVertexArray,
    forgetGlState,
    resetGlState,
    useProgram,
} from '../src/renderer/webgl/state';

const UNIFORM_BUFFER = 0x8a11;
const ELEMENT_ARRAY_BUFFER = 0x8893;

/** Enough GL to record the program, VAO and buffer calls made, in order. */
function fakeGl() {
    const calls: string[] = [];
    let next = 1;
    const gl = {
        UNIFORM_BUFFER,
        ELEMENT_ARRAY_BUFFER,
        COPY_WRITE_BUFFER: 0x8f37,
        STATIC_DRAW: 0x88e4,
        DYNAMIC_DRAW: 0x88e8,
        useProgram: (program: unknown) => void calls.push(`program ${program}`),
        deleteProgram: (program: unknown) => void calls.push(`delete program ${program}`),
        bindVertexArray: (vao: unknown) => void calls.push(`vao ${vao}`),
        deleteVertexArray: (vao: unknown) => void calls.push(`delete vao ${vao}`),
        bindBufferBase: (_target: number, point: number, buffer: unknown) => void calls.push(`ubo ${point} ${buffer}`),
        bindBufferRange: (_target: number, point: number, buffer: unknown, offset: number) =>
            void calls.push(`ubo ${point} ${buffer} @${offset}`),
        deleteBuffer: (buffer: unknown) => void calls.push(`delete buffer ${buffer}`),
        createBuffer: () => `buffer${next++}`,
        bindBuffer: (target: number, buffer: unknown) =>
            void calls.push(`bind ${target === ELEMENT_ARRAY_BUFFER ? 'index' : target} ${buffer}`),
        bufferData: () => {},
        bufferSubData: () => {},
        getParameter: () => {
            calls.push('getParameter');
            return null;
        },
    } as unknown as WebGL2RenderingContext;
    return { gl, calls };
}

const program = (name: string) => name as unknown as WebGLProgram;
const vao = (name: string) => name as unknown as WebGLVertexArrayObject;
const buffer = (name: string) => name as unknown as WebGLBuffer;

test('a program in use is not used again, whichever pass asks; deleting it current unbinds it first', () => {
    const { gl, calls } = fakeGl();
    const state = createGlState();
    useProgram(gl, state, program('terrain'));
    // a later pass's first draw reads the same program
    useProgram(gl, state, program('terrain'));
    useProgram(gl, state, program('sprites'));
    deleteProgram(gl, state, program('sprites'));
    useProgram(gl, state, program('sprites'));
    expect(calls).toEqual(['program terrain', 'program sprites', 'program null', 'delete program sprites', 'program sprites']);
});

test('a VAO bound is not bound again; deleting the bound one leaves the record at VAO 0', () => {
    const { gl, calls } = fakeGl();
    const state = createGlState();
    bindVertexArray(gl, state, vao('box'));
    bindVertexArray(gl, state, vao('box'));
    deleteVertexArray(gl, state, vao('box'));
    bindVertexArray(gl, state, null);
    bindVertexArray(gl, state, vao('box'));
    expect(calls).toEqual(['vao box', 'delete vao box', 'vao box']);
});

test('an index upload under a bound VAO unbinds it through the record, with no query', () => {
    const { gl, calls } = fakeGl();
    const state = createGlState();
    const cache = createBufferCache(createRendererInfo(), createMemoryTally(), state);
    bindVertexArray(gl, state, vao('box'));
    calls.length = 0;
    const index = createIndexBuffer(new Uint16Array([0, 1, 2]));
    writeBufferBytes(gl, cache, index, 0, new Uint16Array([2, 1, 0]), 0, 6);
    expect(calls.includes('getParameter')).toBe(false);
    expect(calls.indexOf('vao null')).toBeLessThan(calls.findIndex((call) => call.startsWith('bind index')));
    expect(state.vao).toBe(null);

    // with VAO 0 already bound, a second index upload sends no unbind
    calls.length = 0;
    const other = createIndexBuffer(new Uint16Array([0, 1, 2]));
    writeBufferBytes(gl, cache, other, 0, new Uint16Array([2, 1, 0]), 0, 6);
    expect(calls.includes('vao null')).toBe(false);
});

test('a binding point keeps its buffer and range; deleting a buffer forgets every point holding it', () => {
    const { gl, calls } = fakeGl();
    const state = createGlState();
    bindUniformBuffer(gl, state, 1, buffer('view'), -1, 0);
    bindUniformBuffer(gl, state, 1, buffer('view'), -1, 0);
    bindUniformBuffer(gl, state, 23, buffer('table'), 256, 16384);
    bindUniformBuffer(gl, state, 23, buffer('table'), 256, 16384);
    bindUniformBuffer(gl, state, 23, buffer('table'), 512, 16384);
    bindUniformBuffer(gl, state, 2, buffer('view'), -1, 0);
    deleteBuffer(gl, state, buffer('view'));
    bindUniformBuffer(gl, state, 1, buffer('view'), -1, 0);
    expect(calls).toEqual([
        'ubo 1 view',
        'ubo 23 table @256',
        'ubo 23 table @512',
        'ubo 2 view',
        'delete buffer view',
        'ubo 1 view',
    ]);
});

test('after a reset everything is at GL defaults; after a forget the next use binds even the same object', () => {
    const { gl, calls } = fakeGl();
    const state = createGlState();
    useProgram(gl, state, program('terrain'));
    bindVertexArray(gl, state, vao('box'));
    bindUniformBuffer(gl, state, 1, buffer('view'), -1, 0);

    forgetGlState(state);
    calls.length = 0;
    useProgram(gl, state, program('terrain'));
    bindVertexArray(gl, state, vao('box'));
    bindUniformBuffer(gl, state, 1, buffer('view'), -1, 0);
    expect(calls).toEqual(['program terrain', 'vao box', 'ubo 1 view']);

    const resetGl = Object.assign(gl, {
        enable: () => {},
        disable: () => {},
        depthFunc: () => {},
        depthMask: () => {},
        colorMask: () => {},
        frontFace: () => {},
        cullFace: () => {},
        blendFuncSeparate: () => {},
        blendEquationSeparate: () => {},
        polygonOffset: () => {},
        stencilMask: () => {},
        stencilFunc: () => {},
        stencilOp: () => {},
        viewport: () => {},
        depthRange: () => {},
        scissor: () => {},
        clearColor: () => {},
        clearDepth: () => {},
        clearStencil: () => {},
    });
    resetGlState(resetGl, state, 64, 64);
    expect(state.program).toBe(null);
    expect(state.vao).toBe(null);
    expect(state.uniformBuffers.every((bound) => bound === null)).toBe(true);
    calls.length = 0;
    useProgram(gl, state, null);
    bindVertexArray(gl, state, null);
    expect(calls).toEqual([]);
});
