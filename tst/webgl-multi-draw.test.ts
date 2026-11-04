import { expect, test } from 'vitest';
import { attribute, compileGlsl, d, f32, instanceIndex, storage, vec4 } from '../src/index';
import type { IndexedMeshDraw } from '../src/objects/mesh';
import { createRendererInfo } from '../src/renderer/core/info';
import {
    addListTable,
    beginPassTables,
    bindZeroTable,
    createDrawBases,
    drawIndexedList,
    uploadPassTables,
} from '../src/renderer/webgl/draw-bases';
import { DRAW_BASES_BINDING } from '../src/renderer/webgl/programs';
import { createGlState } from '../src/renderer/webgl/state';

const UNIFORM_BUFFER = 0x8a11;
const UNIFORM_BUFFER_OFFSET_ALIGNMENT = 0x8a34;
const TRIANGLES = 0x0004;
const UNSIGNED_INT = 0x1405;

/** A vertex stage that reads per-instance data by the instance index. */
function instancedVertex() {
    const offsets = storage('offsets', d.array(d.vec4f), 'read');
    return offsets.element(instanceIndex).add(vec4(attribute('position', d.vec3f), f32(1)));
}

test('under multi-draw, the instance index reads its base from the table gl_DrawID indexes', () => {
    const { code } = compileGlsl({ vertex: instancedVertex(), fragment: vec4(f32(1)), depth: undefined }, { multiDraw: true });
    const vertex = code.slice(0, code.indexOf('#version', 1));
    expect(vertex.startsWith('#version 300 es\n#extension GL_ANGLE_multi_draw : require')).toBe(true);
    expect(vertex).toContain('uniform DrawBases');
    expect(vertex).toContain('u_drawBases[gl_DrawID >> 2][gl_DrawID & 3] + uint(gl_InstanceID)');
    expect(vertex).not.toContain('u_drawBase;');
});

test('without multi-draw, the instance index reads u_drawBase and no extension is named', () => {
    const { code } = compileGlsl({ vertex: instancedVertex(), fragment: vec4(f32(1)), depth: undefined });
    expect(code).toContain('uniform highp uint u_drawBase;');
    expect(code).not.toContain('GL_ANGLE_multi_draw');
    expect(code).not.toContain('DrawBases');
});

/** Enough GL and WEBGL_multi_draw to watch the tables upload and the lists draw. */
function fakeGl() {
    let next = 1;
    const uploads: [number, number][] = [];
    const ranges: [number, number, number, number][] = [];
    const multiDraws: { counts: number[]; offsets: number[]; instanceCounts: number[] }[] = [];
    let bound = 0;
    const extension = {
        multiDrawElementsInstancedWEBGL: (
            _mode: number,
            counts: Int32Array,
            countsOffset: number,
            _type: number,
            offsets: Int32Array,
            offsetsOffset: number,
            instanceCounts: Int32Array,
            instanceCountsOffset: number,
            drawCount: number,
        ) =>
            void multiDraws.push({
                counts: [...counts.subarray(countsOffset, countsOffset + drawCount)],
                offsets: [...offsets.subarray(offsetsOffset, offsetsOffset + drawCount)],
                instanceCounts: [...instanceCounts.subarray(instanceCountsOffset, instanceCountsOffset + drawCount)],
            }),
    } as unknown as WEBGL_multi_draw;
    const gl = {
        TRIANGLES,
        UNIFORM_BUFFER,
        UNIFORM_BUFFER_OFFSET_ALIGNMENT,
        STATIC_DRAW: 0x88e4,
        STREAM_DRAW: 0x88e0,
        getExtension: (name: string) => (name === 'WEBGL_multi_draw' ? extension : null),
        getParameter: (name: number) => (name === UNIFORM_BUFFER_OFFSET_ALIGNMENT ? 256 : 0),
        createBuffer: () => next++ as unknown as WebGLBuffer,
        bindBuffer: (_target: number, buffer: WebGLBuffer) => {
            bound = buffer as unknown as number;
        },
        bufferData: (_target: number, data: number | ArrayBufferView, _usage: number, _offset = 0, length?: number) =>
            void uploads.push([bound, typeof data === 'number' ? data : (length ?? 0) * 4]),
        bindBufferRange: (_target: number, point: number, buffer: WebGLBuffer, offset: number, size: number) =>
            void ranges.push([point, buffer as unknown as number, offset, size]),
        bindBufferBase: () => {},
    } as unknown as WebGL2RenderingContext;
    return { gl, uploads, ranges, multiDraws };
}

function list(
    entries: [indexCount: number, instanceCount: number, firstIndex: number, firstInstance: number][],
): IndexedMeshDraw[] {
    return entries.map(([indexCount, instanceCount, firstIndex, firstInstance]) => ({
        indexCount,
        instanceCount,
        firstIndex,
        firstInstance,
    }));
}

test('a context without WEBGL_multi_draw draws each entry on its own', () => {
    const gl = { getExtension: () => null } as unknown as WebGL2RenderingContext;
    expect(createDrawBases(gl)).toBeNull();
});

test("a pass's lists upload once, each table at an aligned start, and a list draws in one call", () => {
    const { gl, uploads, ranges, multiDraws } = fakeGl();
    const bases = createDrawBases(gl)!;
    uploads.length = 0;
    const bound = createGlState();
    const terrain = list([
        [6, 1, 0, 0],
        [12, 1, 6, 40],
        [6, 0, 18, 90],
        [6, 1, 24, 120],
    ]);
    const bins = list([[36, 8, 0, 7]]);

    beginPassTables(bases);
    const terrainTable = addListTable(bases, terrain);
    const binsTable = addListTable(bases, bins);
    uploadPassTables(gl, bases, createRendererInfo());

    expect([terrainTable, binsTable]).toEqual([0, 256]);
    // the entry with no instances is left out of both the table and the call
    expect([...bases.tables.subarray(0, 3)]).toEqual([0, 40, 120]);
    expect(bases.tables[64]).toBe(7);
    // one upload, long enough for the last table to bind a whole block
    expect(uploads).toEqual([[bases.stream as unknown as number, 256 + 16384]]);

    drawIndexedList(gl, bases, bound, terrain, UNSIGNED_INT, 4, terrainTable);
    drawIndexedList(gl, bases, bound, bins, UNSIGNED_INT, 4, binsTable);
    expect(multiDraws).toEqual([
        { counts: [6, 12, 6], offsets: [0, 24, 96], instanceCounts: [1, 1, 1] },
        { counts: [36], offsets: [0], instanceCounts: [8] },
    ]);
    const stream = bases.stream as unknown as number;
    expect(ranges).toEqual([
        [DRAW_BASES_BINDING, stream, 0, 16384],
        [DRAW_BASES_BINDING, stream, 256, 16384],
    ]);
});

test('a list past the block draws in a call per block, each with its block of the table', () => {
    const { gl, ranges, multiDraws } = fakeGl();
    const bases = createDrawBases(gl)!;
    const bound = createGlState();
    const long = list(Array.from({ length: 4100 }, (_, index) => [6, 1, index * 6, index] as [number, number, number, number]));

    beginPassTables(bases);
    const table = addListTable(bases, long);
    drawIndexedList(gl, bases, bound, long, UNSIGNED_INT, 4, table);

    expect(multiDraws.map((call) => call.counts.length)).toEqual([4096, 4]);
    expect(ranges.map(([, , offset]) => offset)).toEqual([0, 16384]);
    expect(bases.tables[4096]).toBe(4096);
    expect(bases.size).toBe(2 * 16384);
});

test('a single draw binds the zero table, and a repeat bind is skipped', () => {
    const { gl, ranges } = fakeGl();
    const bases = createDrawBases(gl)!;
    const bound = createGlState();
    bindZeroTable(gl, bases, bound);
    bindZeroTable(gl, bases, bound);
    expect(ranges).toEqual([[DRAW_BASES_BINDING, bases.zero as unknown as number, 0, 16384]]);
});
