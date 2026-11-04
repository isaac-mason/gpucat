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

export function createPassOrder(): PassOrder {
    return {
        views: [],
        viewCount: 0,
        viewChanged: true,
        drawViews: [],
        blocks: [],
        blockCount: 0,
        binBlocks: [],
        directOpen: false,
        keys: new Float64Array(64),
        codes: new Float64Array(64),
        values: new Float64Array(64),
        positions: new Uint32Array(64),
        drawnViews: [],
        reordered: [],
        identityToCode: new Map(),
    };
}

/** A pass begins: no views, blocks or draws. */
export function resetPassOrder(order: PassOrder): void {
    order.viewCount = 0;
    order.viewChanged = true;
    order.blockCount = 0;
    order.binBlocks.length = 0;
    order.directOpen = false;
}

/** The pass's camera or a rect changed: the next draw takes a new view. */
export function markViewChanged(order: PassOrder): void {
    order.viewChanged = true;
}

/** A draw at `drawIndex` in the pass's own order, under the view `params` holds. */
export function addPassDraw(order: PassOrder, drawIndex: number, params: RenderPassParams): void {
    order.drawViews[drawIndex] = currentView(order, params);
    if (!order.directOpen) {
        openBlock(order, null, null);
        order.directOpen = true;
    }
    pushDraw(order.blocks[order.blockCount - 1]!, drawIndex);
}

/** A bin made here: its draws encode at this point. */
export function addBin(order: PassOrder, bin: Bin): void {
    order.binBlocks[bin.index] = order.blockCount;
    openBlock(order, bin, null);
    order.directOpen = false;
}

/**
 * A draw at `drawIndex` into `bin`, under the view `params` holds, with what its key reads: the `pipeline` the backend
 * resolved it to, its material and geometry, its `sortKey`, and the depth of `mesh` from the view's camera.
 */
export function addBinDraw(
    order: PassOrder,
    drawIndex: number,
    bin: Bin,
    pipeline: object,
    material: Material,
    geometry: Geometry,
    sortKey: number,
    mesh: Mesh,
    params: RenderPassParams,
): void {
    order.drawViews[drawIndex] = currentView(order, params);
    const block = order.blocks[order.binBlocks[bin.index]!]!;
    const at = block.count;
    pushDraw(block, drawIndex);
    block.pipelines[at] = pipeline;
    block.materials[at] = material;
    block.geometries[at] = geometry;
    block.sortKeys[at] = sortKey;
    block.depths[at] = bin.usesDepth ? viewDepth(mesh, params.camera) : 0;
}

/** A bundle's draws, `start` to `start + count`, under the view `params` holds. */
export function addBundle(order: PassOrder, bundle: RenderBundle, start: number, count: number, params: RenderPassParams): void {
    if (count === 0) return;
    const view = currentView(order, params);
    const block = openBlock(order, null, bundle);
    for (let drawIndex = start; drawIndex < start + count; drawIndex++) {
        order.drawViews[drawIndex] = view;
        pushDraw(block, drawIndex);
    }
    order.directOpen = false;
}

/** At `end()`: each bin's draws into the order its key gives. */
export function orderBins(order: PassOrder, label: string): void {
    for (let index = 0; index < order.blockCount; index++) {
        const block = order.blocks[index]!;
        if (block.bin !== null && block.count > 1 && block.bin.fields.length > 0) orderBin(order, block, label);
    }
}

function currentView(order: PassOrder, params: RenderPassParams): number {
    if (!order.viewChanged && order.viewCount > 0) return order.viewCount - 1;
    let view = order.views[order.viewCount];
    if (view === undefined) {
        view = {
            camera: null,
            viewport: false,
            viewportValue: { x: 0, y: 0, width: 0, height: 0, minDepth: 0, maxDepth: 1 },
            scissor: false,
            scissorValue: { x: 0, y: 0, width: 0, height: 0 },
        };
        order.views[order.viewCount] = view;
    }
    writeView(view, params);
    order.viewChanged = false;
    return order.viewCount++;
}

function writeView(out: PreparedView, params: RenderPassParams): void {
    out.camera = params.camera;
    out.viewport = params.viewport;
    const viewport = params.viewportValue;
    out.viewportValue.x = viewport.x;
    out.viewportValue.y = viewport.y;
    out.viewportValue.width = viewport.width;
    out.viewportValue.height = viewport.height;
    out.viewportValue.minDepth = viewport.minDepth;
    out.viewportValue.maxDepth = viewport.maxDepth;
    out.scissor = params.scissor;
    const scissor = params.scissorValue;
    out.scissorValue.x = scissor.x;
    out.scissorValue.y = scissor.y;
    out.scissorValue.width = scissor.width;
    out.scissorValue.height = scissor.height;
}

function openBlock(order: PassOrder, bin: Bin | null, bundle: RenderBundle | null): PassBlock {
    let block = order.blocks[order.blockCount];
    if (block === undefined) {
        block = { bin, bundle, draws: [], count: 0, pipelines: [], materials: [], geometries: [], sortKeys: [], depths: [] };
        order.blocks[order.blockCount] = block;
    }
    block.bin = bin;
    block.bundle = bundle;
    block.count = 0;
    order.blockCount++;
    return block;
}

function pushDraw(block: PassBlock, drawIndex: number): void {
    block.draws[block.count++] = drawIndex;
}

/** Distance in front of `camera` to the origin of `mesh`: the view-space depth, the camera looking down its -Z. */
function viewDepth(mesh: Mesh, camera: View | null): number {
    if (camera === null) return 0;
    const world = mesh.matrixWorld;
    const view = camera.matrixWorldInverse;
    return -(view[2]! * world[12]! + view[6]! * world[13]! + view[10]! * world[14]! + view[14]!);
}

const DEFAULT_DEPTH_BITS = 16;

/**
 * Orders `block`'s draws by its bin's key. Each field becomes a small integer per draw (an identity's dense number in
 * first-seen order, a `sortKey`'s rank, a depth quantized over the bin's range), packed most significant first. When
 * the draw's place in the block fits below the fields, it is packed too and the keys sort natively; otherwise the sort
 * compares keys, then places.
 */
function orderBin(order: PassOrder, block: PassBlock, label: string): void {
    const bin = block.bin!;
    const count = block.count;
    growScratch(order, count);
    const keys = order.keys;
    const codes = order.codes;
    keys.fill(0, 0, count);

    let totalBits = 0;
    for (let fieldIndex = 0; fieldIndex < bin.fields.length; fieldIndex++) {
        const field = bin.fields[fieldIndex]!;
        const given = bin.bits[fieldIndex]!;
        let bits: number;
        if (field === 'depthNear' || field === 'depthFar') {
            bits = given === 0 ? DEFAULT_DEPTH_BITS : given;
            quantizeDepths(block.depths, count, bits, field === 'depthFar', codes);
        } else {
            const distinct =
                field === 'sortKey'
                    ? rankSortKeys(order, block.sortKeys, count, codes)
                    : numberIdentities(order, identitiesOf(order, block, field), count, codes);
            const needed = bitsFor(distinct);
            if (given !== 0 && needed > given) {
                throw new Error(
                    `[pass ${label}] bin ${bin.desc.label ?? bin.index}: '${field}' has ${distinct} distinct values, past its ${given} bits`,
                );
            }
            bits = given === 0 ? needed : given;
        }
        if (bits === 0) continue;
        totalBits += bits;
        if (totalBits > 52) {
            throw new Error(
                `[pass ${label}] bin ${bin.desc.label ?? bin.index}: its key takes ${totalBits} bits by '${field}', past the 52 one key holds`,
            );
        }
        const scale = 2 ** bits;
        for (let at = 0; at < count; at++) keys[at] = keys[at]! * scale + codes[at]!;
    }

    const reordered = order.reordered;
    const placeBits = bitsFor(count);
    if (totalBits + placeBits <= 53) {
        const placeScale = 2 ** placeBits;
        for (let at = 0; at < count; at++) keys[at] = keys[at]! * placeScale + at;
        const sorted = keys.subarray(0, count).sort();
        for (let at = 0; at < count; at++) {
            const key = sorted[at]!;
            reordered[at] = key - Math.floor(key / placeScale) * placeScale;
        }
    } else {
        const positions = order.positions;
        for (let at = 0; at < count; at++) positions[at] = at;
        positions.subarray(0, count).sort((a, b) => keys[a]! - keys[b]! || a - b);
        for (let at = 0; at < count; at++) reordered[at] = positions[at]!;
    }
    // `reordered` holds places; the block takes the draws at them
    for (let at = 0; at < count; at++) reordered[at] = block.draws[reordered[at]!]!;
    for (let at = 0; at < count; at++) block.draws[at] = reordered[at]!;
}

function growScratch(order: PassOrder, count: number): void {
    if (order.keys.length >= count) return;
    let length = order.keys.length;
    while (length < count) length *= 2;
    order.keys = new Float64Array(length);
    order.codes = new Float64Array(length);
    order.values = new Float64Array(length);
    order.positions = new Uint32Array(length);
}

/** Bits to tell `distinct` values apart: 0 for one. */
function bitsFor(distinct: number): number {
    return distinct <= 1 ? 0 : Math.ceil(Math.log2(distinct));
}

/** What `field` names per draw: an identity the bin groups by. */
function identitiesOf(
    order: PassOrder,
    block: PassBlock,
    field: 'pipeline' | 'material' | 'geometry' | 'view',
): readonly unknown[] {
    if (field === 'pipeline') return block.pipelines;
    if (field === 'material') return block.materials;
    if (field === 'geometry') return block.geometries;
    // a view is the index of the camera and rects a draw was recorded under
    const views = order.drawnViews;
    for (let at = 0; at < block.count; at++) views[at] = order.drawViews[block.draws[at]!]!;
    return views;
}

/** Each draw's identity as a dense number, in first-seen order, into `codes`; how many distinct there are. */
function numberIdentities(order: PassOrder, identities: readonly unknown[], count: number, codes: Float64Array): number {
    const identityToCode = order.identityToCode;
    for (let at = 0; at < count; at++) {
        const identity = identities[at];
        let code = identityToCode.get(identity);
        if (code === undefined) {
            code = identityToCode.size;
            identityToCode.set(identity, code);
        }
        codes[at] = code;
    }
    const distinct = identityToCode.size;
    identityToCode.clear();
    return distinct;
}

/** Each draw's `sortKey` as its rank among the distinct ones, lowest 0, into `codes`; how many distinct there are. */
function rankSortKeys(order: PassOrder, sortKeys: readonly number[], count: number, codes: Float64Array): number {
    const values = order.values;
    for (let at = 0; at < count; at++) values[at] = sortKeys[at]!;
    values.subarray(0, count).sort();
    let distinct = 0;
    for (let at = 0; at < count; at++) if (at === 0 || values[at] !== values[distinct - 1]) values[distinct++] = values[at]!;
    for (let at = 0; at < count; at++) {
        const value = sortKeys[at]!;
        let low = 0;
        let high = distinct - 1;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (values[middle]! < value) low = middle + 1;
            else high = middle;
        }
        codes[at] = low;
    }
    return distinct;
}

/** Each draw's depth quantized into `bits` over the bin's range, nearest 0, or farthest 0 when `farFirst`, into `codes`. */
function quantizeDepths(depths: readonly number[], count: number, bits: number, farFirst: boolean, codes: Float64Array): void {
    let near = Infinity;
    let far = -Infinity;
    for (let at = 0; at < count; at++) {
        const depth = depths[at]!;
        if (depth < near) near = depth;
        if (depth > far) far = depth;
    }
    const top = 2 ** bits - 1;
    const scale = far > near ? top / (far - near) : 0;
    for (let at = 0; at < count; at++) {
        const code = Math.floor((depths[at]! - near) * scale);
        codes[at] = farFirst ? top - code : code;
    }
}
