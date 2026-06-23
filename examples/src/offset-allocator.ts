// ── OffsetAllocator ────────────────────────────────────────────────
//
// TypeScript port of sebbbi/OffsetAllocator (MIT, (C) Sebastian Aaltonen 2023):
//   https://github.com/sebbbi/OffsetAllocator
//
// O(1) suballocator over a fixed-size address space. 256 bins with an 8-bit
// floating-point size distribution (3-bit mantissa + 5-bit exponent) bound the
// per-allocation internal fragmentation to ≤12.5% (≈6.25% average). Free
// segments are kept in per-bin LIFO lists; a 32-bit top-bin mask + 32×8-bit
// leaf-bin masks make "find the smallest fitting non-empty bin" cost two
// `clz32`s. `free()` coalesces with address-order neighbours.
//
// Storage is struct-of-arrays in Uint32Array/Uint8Array to avoid per-node JS
// object overhead. The allocator owns no GPU memory — it just hands out
// offsets. Use it under a wrapper that owns the actual buffers and writes by
// offset.

const MANTISSA_BITS = 3;
const MANTISSA_VALUE = 1 << MANTISSA_BITS;          // 8
const MANTISSA_MASK = MANTISSA_VALUE - 1;           // 0x7

const NUM_TOP_BINS = 32;
const BINS_PER_LEAF = 8;
const TOP_BINS_INDEX_SHIFT = 3;
const LEAF_BINS_INDEX_MASK = 0x7;
const NUM_LEAF_BINS = NUM_TOP_BINS * BINS_PER_LEAF; // 256

export const OA_UNUSED = 0xffffffff;
const NO_SPACE = 0xffffffff;

// ── SmallFloat ──────────────────────────────────────────────────────
//
// Piecewise-linear log approximation: sizes < 8 are stored exactly (denorm),
// larger sizes use 3 mantissa bits relative to the highest set bit. Per-bin
// quantization step is ≤1/8 of the bin midpoint → ≤12.5% rounding overhead.

/** Round `size` UP to the smallest bin guaranteed to fit it. Used at allocate. */
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

/** Round `size` DOWN to the largest bin that fits inside it. Used at free. */
function uintToFloatRoundDown(size: number): number {
    if (size < MANTISSA_VALUE) return size;
    const leadingZeros = Math.clz32(size);
    const highestSetBit = 31 - leadingZeros;
    const mantissaStartBit = highestSetBit - MANTISSA_BITS;
    const exp = mantissaStartBit + 1;
    const mantissa = (size >>> mantissaStartBit) & MANTISSA_MASK;
    return (exp << MANTISSA_BITS) | mantissa;
}

/** Inverse: bin index → its floor size. `>>> 0` keeps the result unsigned so
 *  large bins (≥ 2^31) don't decode as negative numbers. */
function floatToUint(binIndex: number): number {
    const exp = binIndex >>> MANTISSA_BITS;
    const mantissa = binIndex & MANTISSA_MASK;
    if (exp === 0) return mantissa;
    return ((mantissa | MANTISSA_VALUE) << (exp - 1)) >>> 0;
}

// ── bit helpers ─────────────────────────────────────────────────────

/** Lowest set bit at index ≥ startBitIndex; NO_SPACE if none. */
function findLowestSetBitAfter(bitMask: number, startBitIndex: number): number {
    const maskBeforeStartIndex = (1 << startBitIndex) - 1;
    const maskAfterStartIndex = ~maskBeforeStartIndex;
    const bitsAfter = bitMask & maskAfterStartIndex;
    if (bitsAfter === 0) return NO_SPACE;
    // tzcnt: lowest set bit of x is 31 - clz(x & -x).
    return 31 - Math.clz32(bitsAfter & -bitsAfter);
}

// ── allocator ───────────────────────────────────────────────────────

export type OAHandle = {
    /** Byte/slot offset into the managed space. */
    readonly offset: number;
    /** Internal node index — required by `oaFree`. */
    readonly node: number;
};

export type OffsetAllocator = {
    readonly capacity: number;
    readonly maxAllocs: number;

    // bin tier — usedBinsTop is a single u32 stored as a JS number (bits, not
    // value-comparable when bit 31 is set; only used with bitwise ops).
    usedBinsTop: number;
    usedBins: Uint8Array;          // length NUM_TOP_BINS
    binIndices: Uint32Array;       // length NUM_LEAF_BINS — head node per bin

    // node pool (SoA). `nodeUsed` is a flag, not packed into the index space
    // (kept simple — the C++ has the same TODO comment).
    nodeOffset: Uint32Array;
    nodeSize: Uint32Array;
    binPrev: Uint32Array;
    binNext: Uint32Array;
    nbrPrev: Uint32Array;
    nbrNext: Uint32Array;
    nodeUsed: Uint8Array;

    // freelist stack of unused node indices
    freeNodes: Uint32Array;
    freeOffset: number;            // top of stack; -1 == empty (out of nodes)

    freeStorage: number;           // sum of all free-node sizes
};

export function createOffsetAllocator(capacity: number, maxAllocs: number): OffsetAllocator {
    if (capacity <= 0) throw new Error('OffsetAllocator: capacity must be > 0');
    if (maxAllocs <= 0) throw new Error('OffsetAllocator: maxAllocs must be > 0');

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
        freeOffset: 0,
        freeStorage: 0,
    };
    oaReset(a);
    return a;
}

export function oaReset(a: OffsetAllocator): void {
    a.usedBinsTop = 0;
    a.freeStorage = 0;
    a.usedBins.fill(0);
    a.binIndices.fill(OA_UNUSED);
    a.nodeUsed.fill(0);

    // Freelist is a stack with `freeOffset` pointing at the top entry.
    // Nodes pushed in reverse so that pop order is 0, 1, 2, …
    a.freeOffset = a.maxAllocs - 1;
    for (let i = 0; i < a.maxAllocs; i++) a.freeNodes[i] = a.maxAllocs - i - 1;

    // Seed: one giant free node covering the whole address space.
    insertNodeIntoBin(a, a.capacity, 0);
}

/** Allocate `size` slots. Returns null on OOM (no space or node-pool exhausted). */
export function oaAllocate(a: OffsetAllocator, size: number): OAHandle | null {
    if (size <= 0) throw new Error('OffsetAllocator: size must be > 0');

    // Out of node-pool entries? (we need at least one to record the alloc and
    // potentially a split remainder)
    if (a.freeOffset === 0) return null;

    const minBinIndex = uintToFloatRoundUp(size);
    const minTopBinIndex = minBinIndex >>> TOP_BINS_INDEX_SHIFT;
    const minLeafBinIndex = minBinIndex & LEAF_BINS_INDEX_MASK;

    let topBinIndex = minTopBinIndex;
    let leafBinIndex = NO_SPACE;

    // Try the requested top bin first.
    if ((a.usedBinsTop & (1 << topBinIndex)) !== 0) {
        leafBinIndex = findLowestSetBitAfter(a.usedBins[topBinIndex]!, minLeafBinIndex);
    }

    // Fall through to higher top bins. Any leaf there fits (top bin was
    // rounded up), so take its lowest.
    if (leafBinIndex === NO_SPACE) {
        topBinIndex = findLowestSetBitAfter(a.usedBinsTop, minTopBinIndex + 1);
        if (topBinIndex === NO_SPACE) return null;
        // tzcnt: lowest set bit of x is 31 - clz(x & -x).
        const lbBits = a.usedBins[topBinIndex]!;
        leafBinIndex = 31 - Math.clz32(lbBits & -lbBits);
    }

    const binIndex = (topBinIndex << TOP_BINS_INDEX_SHIFT) | leafBinIndex;

    // Pop the bin's head node.
    const nodeIndex = a.binIndices[binIndex]!;
    const nodeTotalSize = a.nodeSize[nodeIndex]!;
    const nodeOffset = a.nodeOffset[nodeIndex]!;
    a.nodeSize[nodeIndex] = size;
    a.nodeUsed[nodeIndex] = 1;

    const nextHead = a.binNext[nodeIndex]!;
    a.binIndices[binIndex] = nextHead;
    if (nextHead !== OA_UNUSED) a.binPrev[nextHead] = OA_UNUSED;
    a.freeStorage -= nodeTotalSize;

    // If bin is empty, clear its mask bits.
    if (a.binIndices[binIndex] === OA_UNUSED) {
        a.usedBins[topBinIndex] = a.usedBins[topBinIndex]! & ~(1 << leafBinIndex);
        if (a.usedBins[topBinIndex] === 0) {
            a.usedBinsTop = a.usedBinsTop & ~(1 << topBinIndex);
        }
    }

    // Split off the remainder and thread it into address-order list.
    const remainderSize = nodeTotalSize - size;
    if (remainderSize > 0) {
        const newNodeIndex = insertNodeIntoBin(a, remainderSize, nodeOffset + size);
        const oldNext = a.nbrNext[nodeIndex]!;
        if (oldNext !== OA_UNUSED) a.nbrPrev[oldNext] = newNodeIndex;
        a.nbrPrev[newNodeIndex] = nodeIndex;
        a.nbrNext[newNodeIndex] = oldNext;
        a.nbrNext[nodeIndex] = newNodeIndex;
    }

    return { offset: nodeOffset, node: nodeIndex };
}

export function oaFree(a: OffsetAllocator, h: OAHandle): void {
    const nodeIndex = h.node;
    if (nodeIndex === OA_UNUSED) throw new Error('OffsetAllocator: free of NO_SPACE handle');
    if (a.nodeUsed[nodeIndex] !== 1) throw new Error('OffsetAllocator: double free');

    let offset = a.nodeOffset[nodeIndex]!;
    let size = a.nodeSize[nodeIndex]!;

    // Coalesce with prev free neighbour.
    const prev = a.nbrPrev[nodeIndex]!;
    if (prev !== OA_UNUSED && a.nodeUsed[prev] === 0) {
        offset = a.nodeOffset[prev]!;
        size += a.nodeSize[prev]!;
        removeNodeFromBin(a, prev);
        a.nbrPrev[nodeIndex] = a.nbrPrev[prev]!;
    }

    // Coalesce with next free neighbour.
    const next = a.nbrNext[nodeIndex]!;
    if (next !== OA_UNUSED && a.nodeUsed[next] === 0) {
        size += a.nodeSize[next]!;
        removeNodeFromBin(a, next);
        a.nbrNext[nodeIndex] = a.nbrNext[next]!;
    }

    const neighborNext = a.nbrNext[nodeIndex]!;
    const neighborPrev = a.nbrPrev[nodeIndex]!;

    // Recycle this node's slot.
    a.nodeUsed[nodeIndex] = 0;
    a.freeNodes[++a.freeOffset] = nodeIndex;

    // Insert combined free node.
    const combinedIndex = insertNodeIntoBin(a, size, offset);
    if (neighborNext !== OA_UNUSED) {
        a.nbrNext[combinedIndex] = neighborNext;
        a.nbrPrev[neighborNext] = combinedIndex;
    }
    if (neighborPrev !== OA_UNUSED) {
        a.nbrPrev[combinedIndex] = neighborPrev;
        a.nbrNext[neighborPrev] = combinedIndex;
    }
}

export function oaAllocationSize(a: OffsetAllocator, h: OAHandle): number {
    if (h.node === OA_UNUSED) return 0;
    return a.nodeSize[h.node]!;
}

export type StorageReport = {
    totalFree: number;
    largestFree: number;
};

export function oaStorageReport(a: OffsetAllocator): StorageReport {
    let largestFree = 0;
    if (a.freeOffset > 0 && a.usedBinsTop !== 0) {
        // Highest set bit of usedBinsTop → highest non-empty top bin.
        const topBinIndex = 31 - Math.clz32(a.usedBinsTop);
        const leafMask = a.usedBins[topBinIndex]!;
        const leafBinIndex = 31 - Math.clz32(leafMask);
        largestFree = floatToUint((topBinIndex << TOP_BINS_INDEX_SHIFT) | leafBinIndex);
    }
    return { totalFree: a.freeStorage, largestFree };
}

// ── internal: bin list maintenance ──────────────────────────────────

function insertNodeIntoBin(a: OffsetAllocator, size: number, dataOffset: number): number {
    const binIndex = uintToFloatRoundDown(size);
    const topBinIndex = binIndex >>> TOP_BINS_INDEX_SHIFT;
    const leafBinIndex = binIndex & LEAF_BINS_INDEX_MASK;

    if (a.binIndices[binIndex] === OA_UNUSED) {
        a.usedBins[topBinIndex] = a.usedBins[topBinIndex]! | (1 << leafBinIndex);
        a.usedBinsTop = a.usedBinsTop | (1 << topBinIndex);
    }

    const topNodeIndex = a.binIndices[binIndex]!;
    const nodeIndex = a.freeNodes[a.freeOffset--]!;

    a.nodeOffset[nodeIndex] = dataOffset;
    a.nodeSize[nodeIndex] = size;
    a.nodeUsed[nodeIndex] = 0;
    a.binPrev[nodeIndex] = OA_UNUSED;
    a.binNext[nodeIndex] = topNodeIndex;
    a.nbrPrev[nodeIndex] = OA_UNUSED;
    a.nbrNext[nodeIndex] = OA_UNUSED;
    if (topNodeIndex !== OA_UNUSED) a.binPrev[topNodeIndex] = nodeIndex;
    a.binIndices[binIndex] = nodeIndex;

    a.freeStorage += size;
    return nodeIndex;
}

function removeNodeFromBin(a: OffsetAllocator, nodeIndex: number): void {
    const prev = a.binPrev[nodeIndex]!;
    const next = a.binNext[nodeIndex]!;

    if (prev !== OA_UNUSED) {
        a.binNext[prev] = next;
        if (next !== OA_UNUSED) a.binPrev[next] = prev;
    } else {
        // Head of its bin. Recompute bin index from size (round down — matches insert).
        const binIndex = uintToFloatRoundDown(a.nodeSize[nodeIndex]!);
        const topBinIndex = binIndex >>> TOP_BINS_INDEX_SHIFT;
        const leafBinIndex = binIndex & LEAF_BINS_INDEX_MASK;

        a.binIndices[binIndex] = next;
        if (next !== OA_UNUSED) a.binPrev[next] = OA_UNUSED;

        if (a.binIndices[binIndex] === OA_UNUSED) {
            a.usedBins[topBinIndex] = a.usedBins[topBinIndex]! & ~(1 << leafBinIndex);
            if (a.usedBins[topBinIndex] === 0) {
                a.usedBinsTop = a.usedBinsTop & ~(1 << topBinIndex);
            }
        }
    }

    a.nodeUsed[nodeIndex] = 0;
    a.freeNodes[++a.freeOffset] = nodeIndex;
    a.freeStorage -= a.nodeSize[nodeIndex]!;
}
