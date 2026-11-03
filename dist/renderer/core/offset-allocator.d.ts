export type OffsetAllocation = {
    /** Byte/slot offset into the managed space. */
    readonly offset: number;
    /** Internal node index, required by `releaseOffset`. */
    readonly node: number;
};
export type OffsetAllocator = {
    readonly capacity: number;
    readonly maxAllocs: number;
    usedBinsTop: number;
    usedBins: Uint8Array;
    binIndices: Uint32Array;
    nodeOffset: Uint32Array;
    nodeSize: Uint32Array;
    binPrev: Uint32Array;
    binNext: Uint32Array;
    nbrPrev: Uint32Array;
    nbrNext: Uint32Array;
    nodeUsed: Uint8Array;
    freeNodes: Uint32Array;
    freeNodesTop: number;
    freeStorage: number;
};
export declare function createOffsetAllocator(capacity: number, maxAllocs: number): OffsetAllocator;
/** Whether `allocateOffset(a, size)` would succeed, without allocating: the same bin search, read only. */
export declare function offsetFits(a: OffsetAllocator, size: number): boolean;
/** Allocate `size` slots. Returns null on OOM (no space or node-pool exhausted). */
export declare function allocateOffset(a: OffsetAllocator, size: number): OffsetAllocation | null;
export declare function releaseOffset(a: OffsetAllocator, h: OffsetAllocation): void;
