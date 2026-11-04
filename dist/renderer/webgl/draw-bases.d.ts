import type { IndexedMeshDraw, MeshDraw, NonIndexedMeshDraw } from '../../objects/mesh';
import { type RendererInfo } from '../core/info';
import { type GlState } from './state';
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
export declare function createDrawBases(gl: WebGL2RenderingContext): DrawBases | null;
export declare function disposeDrawBases(gl: WebGL2RenderingContext, bases: DrawBases, state: GlState): void;
/** A pass begins: no tables written. */
export declare function beginPassTables(bases: DrawBases): void;
/**
 * Writes `draws`' table into the pass's tables, the `firstInstance` of each entry that draws, in order, and returns the
 * byte offset it starts at. A list longer than the block takes one block-sized table after another.
 */
export declare function addListTable(bases: DrawBases, draws: readonly MeshDraw[]): number;
/** Uploads the pass's tables, ahead of its draws, into fresh storage. Nothing when the pass wrote none. */
export declare function uploadPassTables(gl: WebGL2RenderingContext, bases: DrawBases, info: RendererInfo): void;
/** Binds the zero table, for a single draw on a program that reads the table. */
export declare function bindZeroTable(gl: WebGL2RenderingContext, bases: DrawBases, state: GlState): void;
/**
 * Draws an indexed list as one call per block of entries, each block's table bound first when the program reads it
 * (`table` is the list's start from {@link addListTable}, or -1).
 */
export declare function drawIndexedList(gl: WebGL2RenderingContext, bases: DrawBases, state: GlState, draws: readonly IndexedMeshDraw[], indexType: number, bytesPerIndex: number, table: number): void;
/** As {@link drawIndexedList}, for a non-indexed list. */
export declare function drawList(gl: WebGL2RenderingContext, bases: DrawBases, state: GlState, draws: readonly NonIndexedMeshDraw[], table: number): void;
