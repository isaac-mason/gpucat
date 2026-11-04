import { DRAW_BASES_ENTRIES } from '../../nodes/builder';
import type { IndexedMeshDraw, MeshDraw, NonIndexedMeshDraw } from '../../objects/mesh';
import { type RendererInfo, recordBufferWrite } from '../core/info';
import { DRAW_BASES_BINDING } from './programs';
import { bindUniformBuffer, deleteBuffer, type GlState } from './state';

// A mesh's draw list as WEBGL_multi_draw calls, as three.js's BatchedMesh and PlayCanvas's DrawCommands issue theirs:
// one call per list, where without the extension each entry is a draw of its own with `u_drawBase` set before it.
// WebGL2 has no base instance, so an entry's `firstInstance` reaches the shader through a table its `gl_DrawID`
// indexes (`DrawBases`, see nodes/builder.ts). A pass writes every list's table into one buffer before any of its
// draws run, given fresh storage each pass (`bufferData`), so no draw reads storage written after it was issued: the
// rule PlayCanvas's WebGL buffers keep, and the one a shared page rewritten mid-frame broke (8 ms of Mac GPU time).

/** Bytes a list's table binds: the whole `DrawBases` block, whatever the list's length. */
const TABLE_BYTES = DRAW_BASES_ENTRIES * 4;

export type DrawBases = {
    extension: WEBGL_multi_draw;
    /** the pass's tables, re-allocated by each pass that draws a list */
    stream: WebGLBuffer;
    /** a table of zeroes: a single draw on a program that reads the table reads its entry 0 */
    zero: WebGLBuffer;
    /** `UNIFORM_BUFFER_OFFSET_ALIGNMENT`: where each list's table may start */
    align: number;
    /** the pass's tables as they are uploaded, grown as a pass needs */
    tables: Uint32Array<ArrayBuffer>;
    /** bytes of `tables` the pass has written, and the bytes its buffer must hold so every table binds whole */
    written: number;
    size: number;
    /** one list's counts, byte offsets (or first vertices) and instance counts, as the extension reads them */
    counts: Int32Array<ArrayBuffer>;
    offsets: Int32Array<ArrayBuffer>;
    instanceCounts: Int32Array<ArrayBuffer>;
};

/** The multi-draw state for `gl`, or null when the context has no WEBGL_multi_draw. */
export function createDrawBases(gl: WebGL2RenderingContext): DrawBases | null {
    const extension = gl.getExtension('WEBGL_multi_draw');
    if (extension === null) return null;
    const stream = gl.createBuffer();
    const zero = gl.createBuffer();
    if (!stream || !zero) throw new Error('[webgl] gl.createBuffer returned null (multi-draw tables).');
    // WebGL zero-fills a buffer allocated without data
    gl.bindBuffer(gl.UNIFORM_BUFFER, zero);
    gl.bufferData(gl.UNIFORM_BUFFER, TABLE_BYTES, gl.STATIC_DRAW);
    return {
        extension,
        stream,
        zero,
        align: gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT) as number,
        tables: new Uint32Array(DRAW_BASES_ENTRIES * 2),
        written: 0,
        size: 0,
        counts: new Int32Array(DRAW_BASES_ENTRIES),
        offsets: new Int32Array(DRAW_BASES_ENTRIES),
        instanceCounts: new Int32Array(DRAW_BASES_ENTRIES),
    };
}

export function disposeDrawBases(gl: WebGL2RenderingContext, bases: DrawBases, state: GlState): void {
    deleteBuffer(gl, state, bases.stream);
    deleteBuffer(gl, state, bases.zero);
}

/** A pass begins: no tables written. */
export function beginPassTables(bases: DrawBases): void {
    bases.written = 0;
    bases.size = 0;
}

/**
 * Writes `draws`' table into the pass's tables, the `firstInstance` of each entry that draws, in order, and returns the
 * byte offset it starts at. A list longer than the block takes one block-sized table after another.
 */
export function addListTable(bases: DrawBases, draws: readonly MeshDraw[]): number {
    const start = Math.ceil(bases.written / bases.align) * bases.align;
    let drawn = 0;
    for (const draw of draws) if (draw.instanceCount > 0) drawn++;
    const end = start + Math.max(drawn, 1) * 4;
    // the last block binds whole, so the buffer runs a block past the table's start
    const size = start + Math.ceil(Math.max(drawn, 1) / DRAW_BASES_ENTRIES) * TABLE_BYTES;
    if (size > bases.tables.byteLength) {
        const grown = new Uint32Array(Math.max(size / 4, bases.tables.length * 2));
        grown.set(bases.tables.subarray(0, bases.written / 4));
        bases.tables = grown;
    }
    let entry = start / 4;
    for (const draw of draws) if (draw.instanceCount > 0) bases.tables[entry++] = draw.firstInstance;
    bases.written = end;
    bases.size = Math.max(bases.size, size);
    return start;
}

/** Uploads the pass's tables, ahead of its draws, into fresh storage. Nothing when the pass wrote none. */
export function uploadPassTables(gl: WebGL2RenderingContext, bases: DrawBases, info: RendererInfo): void {
    if (bases.size === 0) return;
    gl.bindBuffer(gl.UNIFORM_BUFFER, bases.stream);
    gl.bufferData(gl.UNIFORM_BUFFER, bases.tables, gl.STREAM_DRAW, 0, bases.size / 4);
    recordBufferWrite(info, bases.size, 'uniform', true, 'draw-bases');
}

/** Binds the zero table, for a single draw on a program that reads the table. */
export function bindZeroTable(gl: WebGL2RenderingContext, bases: DrawBases, state: GlState): void {
    bindUniformBuffer(gl, state, DRAW_BASES_BINDING, bases.zero, 0, TABLE_BYTES);
}

/**
 * Draws an indexed list as one call per block of entries, each block's table bound first when the program reads it
 * (`table` is the list's start from {@link addListTable}, or -1).
 */
export function drawIndexedList(
    gl: WebGL2RenderingContext,
    bases: DrawBases,
    state: GlState,
    draws: readonly IndexedMeshDraw[],
    indexType: number,
    bytesPerIndex: number,
    table: number,
): void {
    let drawn = 0;
    for (const draw of draws) {
        if (draw.instanceCount <= 0) continue;
        drawn = growLists(bases, drawn);
        bases.counts[drawn] = draw.indexCount;
        bases.offsets[drawn] = draw.firstIndex * bytesPerIndex;
        bases.instanceCounts[drawn] = draw.instanceCount;
        drawn++;
    }
    for (let first = 0; first < drawn; first += DRAW_BASES_ENTRIES) {
        if (table >= 0) bindTable(gl, bases, state, table + first * 4);
        bases.extension.multiDrawElementsInstancedWEBGL(
            gl.TRIANGLES,
            bases.counts,
            first,
            indexType,
            bases.offsets,
            first,
            bases.instanceCounts,
            first,
            Math.min(DRAW_BASES_ENTRIES, drawn - first),
        );
    }
}

/** As {@link drawIndexedList}, for a non-indexed list. */
export function drawList(
    gl: WebGL2RenderingContext,
    bases: DrawBases,
    state: GlState,
    draws: readonly NonIndexedMeshDraw[],
    table: number,
): void {
    let drawn = 0;
    for (const draw of draws) {
        if (draw.instanceCount <= 0) continue;
        drawn = growLists(bases, drawn);
        bases.counts[drawn] = draw.vertexCount;
        bases.offsets[drawn] = draw.firstVertex;
        bases.instanceCounts[drawn] = draw.instanceCount;
        drawn++;
    }
    for (let first = 0; first < drawn; first += DRAW_BASES_ENTRIES) {
        if (table >= 0) bindTable(gl, bases, state, table + first * 4);
        bases.extension.multiDrawArraysInstancedWEBGL(
            gl.TRIANGLES,
            bases.offsets,
            first,
            bases.counts,
            first,
            bases.instanceCounts,
            first,
            Math.min(DRAW_BASES_ENTRIES, drawn - first),
        );
    }
}

/** The pass's table from byte `offset`, one block. */
function bindTable(gl: WebGL2RenderingContext, bases: DrawBases, state: GlState, offset: number): void {
    bindUniformBuffer(gl, state, DRAW_BASES_BINDING, bases.stream, offset, TABLE_BYTES);
}

/** `drawn`, with the lists grown to hold one more entry. */
function growLists(bases: DrawBases, drawn: number): number {
    if (drawn < bases.counts.length) return drawn;
    const length = bases.counts.length * 2;
    const counts = new Int32Array(length);
    const offsets = new Int32Array(length);
    const instanceCounts = new Int32Array(length);
    counts.set(bases.counts);
    offsets.set(bases.offsets);
    instanceCounts.set(bases.instanceCounts);
    bases.counts = counts;
    bases.offsets = offsets;
    bases.instanceCounts = instanceCounts;
    return drawn;
}
