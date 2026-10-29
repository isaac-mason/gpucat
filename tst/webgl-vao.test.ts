import { expect, test } from 'vitest';
import { createBoxGeometry } from '../src/geometry/geometry-helpers';
import { createIndexBuffer, d } from '../src/index';
import { compileGlsl } from '../src/nodes/builder';
import { attribute, f32, vec4 } from '../src/nodes/nodes';
import { createMemoryTally, createRendererInfo } from '../src/renderer/core/info';
import type { NodeBuilderState } from '../src/renderer/core/node-builder-state';
import { createBufferCache } from '../src/renderer/webgl/buffers';
import { createGeometriesState, prepareGeometry, type VaoBinding } from '../src/renderer/webgl/geometries';
import type { WebGLBackend } from '../src/renderer/webgl/webgl-backend';

/** Enough GL to build VAOs, recording which VAO each bind leaves bound and every index-buffer write. */
function fakeGl() {
    let next = 1;
    const binds: (number | null)[] = [];
    let boundVao: number | null = null;
    const indexWritesUnder: (number | null)[] = [];
    const gl = {
        ARRAY_BUFFER: 0x8892,
        ELEMENT_ARRAY_BUFFER: 0x8893,
        FLOAT: 0x1406,
        UNSIGNED_SHORT: 0x1403,
        UNSIGNED_INT: 0x1405,
        STATIC_DRAW: 0x88e4,
        MAX_VERTEX_ATTRIBS: 0x8869,
        createBuffer: () => next++,
        createVertexArray: () => next++,
        deleteVertexArray: () => {},
        deleteBuffer: () => {},
        bindVertexArray: (vao: number | null) => {
            boundVao = vao;
            binds.push(vao);
        },
        bindBuffer: () => {},
        bufferData: (target: number) => {
            if (target === 0x8893) indexWritesUnder.push(boundVao);
        },
        bufferSubData: (target: number) => {
            if (target === 0x8893) indexWritesUnder.push(boundVao);
        },
        getParameter: () => 16,
        enableVertexAttribArray: () => {},
        vertexAttribPointer: () => {},
        vertexAttribIPointer: () => {},
        vertexAttribDivisor: () => {},
    } as unknown as WebGL2RenderingContext;
    return { gl, binds, indexWritesUnder, bound: () => boundVao };
}

function setup() {
    const { gl, binds, indexWritesUnder, bound } = fakeGl();
    const b = {
        geometries: createGeometriesState(),
        buffers: createBufferCache(createRendererInfo(), createMemoryTally()),
    } as unknown as WebGLBackend;
    const compiled = compileGlsl({
        vertex: vec4(attribute('position', d.vec3f), f32(1)),
        fragment: vec4(1, 0, 0, 1),
    });
    const nodeState = compiled as unknown as NodeBuilderState;
    const program = {} as WebGLProgram;
    const geometry = createBoxGeometry(1, 1, 1);
    const binding: VaoBinding = { vao: null };
    /** What a draw does: prepare, then bind the VAO only if it is not the one bound. */
    const draw = () => {
        const info = prepareGeometry(gl, b, geometry, nodeState, program, 'box', binding);
        if (binding.vao !== info.vao) {
            gl.bindVertexArray(info.vao);
            binding.vao = info.vao;
        }
        return info;
    };
    return { gl, binds, indexWritesUnder, bound, geometry, draw };
}

test('a geometry drawn again under its own VAO binds nothing', () => {
    const { binds, draw } = setup();
    draw();
    const after = binds.length;

    draw();
    draw();

    expect(binds.length).toBe(after);
});

test('an index upload under a bound VAO first unbinds it, so the VAO keeps its own element buffer', () => {
    const { indexWritesUnder, bound, geometry, draw } = setup();
    const { vao } = draw();
    expect(bound()).toBe(vao);
    indexWritesUnder.length = 0;

    geometry.index!.needsUpdate = true;
    draw();

    expect(indexWritesUnder).toEqual([null]);
    expect(bound()).toBe(vao);
});

test('swapping the index buffer builds a new VAO over it', () => {
    const { geometry, draw } = setup();
    const { vao } = draw();

    geometry.setIndex(createIndexBuffer(new Uint16Array(geometry.index!.array as Uint16Array)));

    expect(draw().vao).not.toBe(vao);
});
