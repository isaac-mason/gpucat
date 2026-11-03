// TypeScript port of sebbbi/OffsetAllocator (MIT): https://github.com/sebbbi/OffsetAllocator
// O(1) allocation and coalescing free over one range, sizes binned on a small float scale.

const MANTISSA_BITS = 3;
const MANTISSA_VALUE = 1 << MANTISSA_BITS; // 8
const MANTISSA_MASK = MANTISSA_VALUE - 1; // 0x7

const NUM_TOP_BINS = 32;
const BINS_PER_LEAF = 8;
const TOP_BINS_INDEX_SHIFT = 3;
const LEAF_BINS_INDEX_MASK = 0x7;
const NUM_LEAF_BINS = NUM_TOP_BINS * BINS_PER_LEAF; // 256

const UNUSED = 0xffffffff;
const NO_SPACE = 0xffffffff;

// SmallFloat: piecewise-linear log approximation. Sizes < 8 are stored exactly
// (denorm), larger sizes use 3 mantissa bits relative to the highest set bit.
// Per-bin quantization step is <=1/8 of the bin midpoint (<=12.5% rounding overhead).

/** Rounds `size` up to the smallest bin guaranteed to fit it. Used at allocate. */
function uintToFloatRoundUp(size: number): number {
    if (size < MANTISSA_VALUE) {
        // Denorm: exact mapping 0..7 → bin 0..7.
        return size;
    }
    const leadingZeros = Math.clz32(size);
    const highestSetBit = 31 - leadingZeros;
    const mantissaStartBit = highestSetBit - MANTISSA_BITS;
    const exp = mantissaStartBit + 1;
    let mantissa = (size >>> mantissaStartBit) & MANTISSA_MASK;
    const lowBitsMask = (1 << mantissaStartBit) - 1;
    // Round up if any bits below the kept mantissa are set.
    if ((size & lowBitsMask) !== 0) mantissa++;
    // mantissa overflow (=8) naturally carries into exp via `+` rather than `|`.
    return (exp << MANTISSA_BITS) + mantissa;
}

/** Rounds `size` down to the largest bin that fits inside it. Used at free. */
function uintToFloatRoundDown(size: number): number {
    if (size < MANTISSA_VALUE) return size;
    const leadingZeros = Math.clz32(size);
    const highestSetBit = 31 - leadingZeros;
    const mantissaStartBit = highestSetBit - MANTISSA_BITS;
    const exp = mantissaStartBit + 1;
    const mantissa = (size >>> mantissaStartBit) & MANTISSA_MASK;
    return (exp << MANTISSA_BITS) | mantissa;
}

/** Lowest set bit at index >= startBitIndex; NO_SPACE if none. */
function findLowestSetBitAfter(bitMask: number, startBitIndex: number): number {
    const maskBeforeStartIndex = (1 << startBitIndex) - 1;
    const maskAfterStartIndex = ~maskBeforeStartIndex;
    const bitsAfter = bitMask & maskAfterStartIndex;
    if (bitsAfter === 0) return NO_SPACE;
    // tzcnt: lowest set bit of x is 31 - clz(x & -x).
    return 31 - Math.clz32(bitsAfter & -bitsAfter);
}

export type OffsetAllocation = {
    /** Byte/slot offset into the managed space. */
    readonly offset: number;
    /** Internal node index, required by `releaseOffset`. */
    readonly node: number;
};

export type OffsetAllocator = {
    readonly capacity: number;
    readonly maxAllocs: number;

    // usedBinsTop is a single u32 stored as a JS number: bits, not value-comparable
    // when bit 31 is set, only used with bitwise ops.
    usedBinsTop: number;
    usedBins: Uint8Array; // length NUM_TOP_BINS
    binIndices: Uint32Array; // length NUM_LEAF_BINS, head node per bin

    nodeOffset: Uint32Array;
    nodeSize: Uint32Array;
    binPrev: Uint32Array;
    binNext: Uint32Array;
    nbrPrev: Uint32Array;
    nbrNext: Uint32Array;
    nodeUsed: Uint8Array;

    freeNodes: Uint32Array;
    freeNodesTop: number; // top of stack; -1 == empty (out of nodes)

    freeStorage: number; // sum of all free-node sizes
};

export function createOffsetAllocator(capacity: number, maxAllocs: number): OffsetAllocator {
    if (capacity <= 0) throw new Error('[gpucat] offset allocator: capacity must be > 0');
    if (maxAllocs <= 0) throw new Error('[gpucat] offset allocator: maxAllocs must be > 0');

    const a: OffsetAllocator = {
        capacity,
        maxAllocs,
        usedBinsTop: 0,
        usedBins: new Uint8Array(NUM_TOP_BINS),
        binIndices: new Uint32Array(NUM_LEAF_BINS),
        nodeOffset: new Uint32Array(maxAllocs),
        nodeSize: new Uint32Array(maxAllocs),
        binPrev: new Uint32Array(maxAllocs),
        binNext: new Uint32Array(maxAllocs),
        nbrPrev: new Uint32Array(maxAllocs),
        nbrNext: new Uint32Array(maxAllocs),
        nodeUsed: new Uint8Array(maxAllocs),
        freeNodes: new Uint32Array(maxAllocs),
        freeNodesTop: 0,
        freeStorage: 0,
    };
    reset(a);
    return a;
}

function reset(a: OffsetAllocator): void {
    a.usedBinsTop = 0;
    a.freeStorage = 0;
    a.usedBins.fill(0);
    a.binIndices.fill(UNUSED);
    a.nodeUsed.fill(0);

    // Nodes pushed in reverse so pop order is 0, 1, 2, ...
    a.freeNodesTop = a.maxAllocs - 1;
    for (let i = 0; i < a.maxAllocs; i++) a.freeNodes[i] = a.maxAllocs - i - 1;

    // One giant free node covering the whole address space.
    insertNodeIntoBin(a, a.capacity, 0);
}

/** Whether `allocateOffset(a, size)` would succeed, without allocating: the same bin search, read only. */
export function offsetFits(a: OffsetAllocator, size: number): boolean {
    if (size <= 0) throw new Error('[gpucat] offset allocator: size must be > 0');
    if (a.freeNodesTop === 0) return false;
    const minBinIndex = uintToFloatRoundUp(size);
    const minTopBinIndex = minBinIndex >>> TOP_BINS_INDEX_SHIFT;
    const minLeafBinIndex = minBinIndex & LEAF_BINS_INDEX_MASK;
    if ((a.usedBinsTop & (1 << minTopBinIndex)) !== 0) {
        if (findLowestSetBitAfter(a.usedBins[minTopBinIndex]!, minLeafBinIndex) !== NO_SPACE) return true;
    }
    return findLowestSetBitAfter(a.usedBinsTop, minTopBinIndex + 1) !== NO_SPACE;
}

/** Allocate `size` slots. Returns null on OOM (no space or node-pool exhausted). */
export function allocateOffset(a: OffsetAllocator, size: number): OffsetAllocation | null {
    if (size <= 0) throw new Error('[gpucat] offset allocator: size must be > 0');

    // Need at least one free node-pool entry to record the alloc and a possible split remainder.
    if (a.freeNodesTop === 0) return null;

    const minBinIndex = uintToFloatRoundUp(size);
    const minTopBinIndex = minBinIndex >>> TOP_BINS_INDEX_SHIFT;
    const minLeafBinIndex = minBinIndex & LEAF_BINS_INDEX_MASK;

    let topBinIndex = minTopBinIndex;
    let leafBinIndex = NO_SPACE;

    if ((a.usedBinsTop & (1 << topBinIndex)) !== 0) {
        leafBinIndex = findLowestSetBitAfter(a.usedBins[topBinIndex]!, minLeafBinIndex);
    }

    // Any leaf in a higher top bin fits, since the top bin was rounded up, so take its lowest.
    if (leafBinIndex === NO_SPACE) {
        topBinIndex = findLowestSetBitAfter(a.usedBinsTop, minTopBinIndex + 1);
        if (topBinIndex === NO_SPACE) return null;
        // tzcnt: lowest set bit of x is 31 - clz(x & -x).
        const lbBits = a.usedBins[topBinIndex]!;
        leafBinIndex = 31 - Math.clz32(lbBits & -lbBits);
    }

    const binIndex = (topBinIndex << TOP_BINS_INDEX_SHIFT) | leafBinIndex;

    const nodeIndex = a.binIndices[binIndex]!;
    const nodeTotalSize = a.nodeSize[nodeIndex]!;
    const nodeOffset = a.nodeOffset[nodeIndex]!;
    a.nodeSize[nodeIndex] = size;
    a.nodeUsed[nodeIndex] = 1;

    const nextHead = a.binNext[nodeIndex]!;
    a.binIndices[binIndex] = nextHead;
    if (nextHead !== UNUSED) a.binPrev[nextHead] = UNUSED;
    a.freeStorage -= nodeTotalSize;

    if (a.binIndices[binIndex] === UNUSED) {
        a.usedBins[topBinIndex] = a.usedBins[topBinIndex]! & ~(1 << leafBinIndex);
        if (a.usedBins[topBinIndex] === 0) {
            a.usedBinsTop = a.usedBinsTop & ~(1 << topBinIndex);
        }
    }

    const remainderSize = nodeTotalSize - size;
    if (remainderSize > 0) {
        const newNodeIndex = insertNodeIntoBin(a, remainderSize, nodeOffset + size);
        const oldNext = a.nbrNext[nodeIndex]!;
        if (oldNext !== UNUSED) a.nbrPrev[oldNext] = newNodeIndex;
        a.nbrPrev[newNodeIndex] = nodeIndex;
        a.nbrNext[newNodeIndex] = oldNext;
        a.nbrNext[nodeIndex] = newNodeIndex;
    }

    return { offset: nodeOffset, node: nodeIndex };
}

export function releaseOffset(a: OffsetAllocator, h: OffsetAllocation): void {
    const nodeIndex = h.node;
    if (nodeIndex === UNUSED) throw new Error('[gpucat] offset allocator: free of NO_SPACE handle');
    if (a.nodeUsed[nodeIndex] !== 1) throw new Error('[gpucat] offset allocator: double free');

    let offset = a.nodeOffset[nodeIndex]!;
    let size = a.nodeSize[nodeIndex]!;

    const prev = a.nbrPrev[nodeIndex]!;
    if (prev !== UNUSED && a.nodeUsed[prev] === 0) {
        offset = a.nodeOffset[prev]!;
        size += a.nodeSize[prev]!;
        removeNodeFromBin(a, prev);
        a.nbrPrev[nodeIndex] = a.nbrPrev[prev]!;
    }

    const next = a.nbrNext[nodeIndex]!;
    if (next !== UNUSED && a.nodeUsed[next] === 0) {
        size += a.nodeSize[next]!;
        removeNodeFromBin(a, next);
        a.nbrNext[nodeIndex] = a.nbrNext[next]!;
    }

    const neighborNext = a.nbrNext[nodeIndex]!;
    const neighborPrev = a.nbrPrev[nodeIndex]!;

    a.nodeUsed[nodeIndex] = 0;
    a.freeNodes[++a.freeNodesTop] = nodeIndex;

    const combinedIndex = insertNodeIntoBin(a, size, offset);
    if (neighborNext !== UNUSED) {
        a.nbrNext[combinedIndex] = neighborNext;
        a.nbrPrev[neighborNext] = combinedIndex;
    }
    if (neighborPrev !== UNUSED) {
        a.nbrPrev[combinedIndex] = neighborPrev;
        a.nbrNext[neighborPrev] = combinedIndex;
    }
}

function insertNodeIntoBin(a: OffsetAllocator, size: number, dataOffset: number): number {
    const binIndex = uintToFloatRoundDown(size);
    const topBinIndex = binIndex >>> TOP_BINS_INDEX_SHIFT;
    const leafBinIndex = binIndex & LEAF_BINS_INDEX_MASK;

    if (a.binIndices[binIndex] === UNUSED) {
        a.usedBins[topBinIndex] = a.usedBins[topBinIndex]! | (1 << leafBinIndex);
        a.usedBinsTop = a.usedBinsTop | (1 << topBinIndex);
    }

    const topNodeIndex = a.binIndices[binIndex]!;
    const nodeIndex = a.freeNodes[a.freeNodesTop--]!;

    a.nodeOffset[nodeIndex] = dataOffset;
    a.nodeSize[nodeIndex] = size;
    a.nodeUsed[nodeIndex] = 0;
    a.binPrev[nodeIndex] = UNUSED;
    a.binNext[nodeIndex] = topNodeIndex;
    a.nbrPrev[nodeIndex] = UNUSED;
    a.nbrNext[nodeIndex] = UNUSED;
    if (topNodeIndex !== UNUSED) a.binPrev[topNodeIndex] = nodeIndex;
    a.binIndices[binIndex] = nodeIndex;

    a.freeStorage += size;
    return nodeIndex;
}

function removeNodeFromBin(a: OffsetAllocator, nodeIndex: number): void {
    const prev = a.binPrev[nodeIndex]!;
    const next = a.binNext[nodeIndex]!;

    if (prev !== UNUSED) {
        a.binNext[prev] = next;
        if (next !== UNUSED) a.binPrev[next] = prev;
    } else {
        // Head of its bin: recompute bin index from size, round down to match insert.
        const binIndex = uintToFloatRoundDown(a.nodeSize[nodeIndex]!);
        const topBinIndex = binIndex >>> TOP_BINS_INDEX_SHIFT;
        const leafBinIndex = binIndex & LEAF_BINS_INDEX_MASK;

        a.binIndices[binIndex] = next;
        if (next !== UNUSED) a.binPrev[next] = UNUSED;

        if (a.binIndices[binIndex] === UNUSED) {
            a.usedBins[topBinIndex] = a.usedBins[topBinIndex]! & ~(1 << leafBinIndex);
            if (a.usedBins[topBinIndex] === 0) {
                a.usedBinsTop = a.usedBinsTop & ~(1 << topBinIndex);
            }
        }
    }

    a.nodeUsed[nodeIndex] = 0;
    a.freeNodes[++a.freeNodesTop] = nodeIndex;
    a.freeStorage -= a.nodeSize[nodeIndex]!;
}
