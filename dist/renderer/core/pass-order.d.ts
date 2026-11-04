import type { Geometry } from '../../geometry/geometry';
import type { Material } from '../../material/material';
import type { Mesh } from '../../objects/mesh';
import type { Bin, RenderBundle } from './frame';
import type { ScissorValue, ViewportValue } from './pass-context';
import type { RenderPassParams } from './render-types';
import type { View } from './view';
/**
 * The order a render pass encodes its draws in, built as they are recorded. Draws index the pass's prepared arrays.
 * Each carries the view (camera, viewport and scissor) it was recorded under, and belongs to a block: a run of the
 * pass's own draws, a bin, or a bundle. Blocks encode in the order they were opened; a bin's draws encode in the order
 * its key gives, at `end()`. The key packs each field into bits of one double, as Ericson's and bgfx's sort keys do,
 * with identities numbered densely within the bin so each takes only the bits it needs.
 */
/** The camera and rects a draw was recorded under. */
export type PreparedView = {
    camera: View | null;
    viewport: boolean;
    viewportValue: ViewportValue;
    scissor: boolean;
    scissorValue: ScissorValue;
};
export type PassBlock = {
    /** The bin it holds, or null for the pass's own draws or a bundle's. */
    bin: Bin | null;
    /** The bundle it holds, whose draws are contiguous and all under one view. */
    bundle: RenderBundle | null;
    /** Its draws, by index into the pass's prepared arrays: in recorded order, and a bin's in key order once ordered. */
    draws: number[];
    count: number;
    /** A bin's key inputs, parallel to `draws` while recording. */
    pipelines: object[];
    materials: Material[];
    geometries: Geometry[];
    sortKeys: number[];
    depths: number[];
};
export type PassOrder = {
    /** The first `viewCount` are this pass's. */
    views: PreparedView[];
    viewCount: number;
    /** Whether the pass's camera or a rect changed since the last view was written. */
    viewChanged: boolean;
    /** Each draw's view, by draw index. */
    drawViews: number[];
    /** The first `blockCount` are this pass's. */
    blocks: PassBlock[];
    blockCount: number;
    /** The block each of the pass's bins draws into, by its index among them. */
    binBlocks: number[];
    /** Whether the last block takes the pass's own draws. */
    directOpen: boolean;
    /** Ordering scratch, grown to the largest bin. */
    keys: Float64Array;
    codes: Float64Array;
    values: Float64Array;
    positions: Uint32Array;
    drawnViews: number[];
    reordered: number[];
    identityToCode: Map<unknown, number>;
};
export declare function createPassOrder(): PassOrder;
/** A pass begins: no views, blocks or draws. */
export declare function resetPassOrder(order: PassOrder): void;
/** The pass's camera or a rect changed: the next draw takes a new view. */
export declare function markViewChanged(order: PassOrder): void;
/** A draw at `drawIndex` in the pass's own order, under the view `params` holds. */
export declare function addPassDraw(order: PassOrder, drawIndex: number, params: RenderPassParams): void;
/** A bin made here: its draws encode at this point. */
export declare function addBin(order: PassOrder, bin: Bin): void;
/**
 * A draw at `drawIndex` into `bin`, under the view `params` holds, with what its key reads: the `pipeline` the backend
 * resolved it to, its material and geometry, its `sortKey`, and the depth of `mesh` from the view's camera.
 */
export declare function addBinDraw(order: PassOrder, drawIndex: number, bin: Bin, pipeline: object, material: Material, geometry: Geometry, sortKey: number, mesh: Mesh, params: RenderPassParams): void;
/** A bundle's draws, `start` to `start + count`, under the view `params` holds. */
export declare function addBundle(order: PassOrder, bundle: RenderBundle, start: number, count: number, params: RenderPassParams): void;
/** At `end()`: each bin's draws into the order its key gives. */
export declare function orderBins(order: PassOrder, label: string): void;
