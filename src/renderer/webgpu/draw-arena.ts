import type { UniformGroup } from '../../core/uniform';
import {
    type Allocation,
    clearAllocation,
    createAllocation,
    type MemoryTally,
    type RendererInfo,
    recordBufferWrite,
    setAllocation,
} from '../core/info';
import {
    allocateOffset,
    createOffsetAllocator,
    type OffsetAllocation,
    type OffsetAllocator,
    releaseOffset,
} from '../core/offset-allocator';
import { type BindGroupCache, releaseGroupsNaming } from './bind-group-cache';

// Each render object's and dispatch's own uniform block (model matrices, per-object uniforms) lives in a slot of a few
// large uniform buffers, as PlayCanvas and Unity's SRP Batcher keep per-draw data. A draw binds its page at its slot's
// offset, so the draws of one block layout in a page share one bind group and differ only in that offset. A slot is
// held for its block's life, placed by an offset allocator per page (Aaltonen's: O(1), merging freed neighbours, so
// blocks of mixed sizes coming and going do not fragment a page). A block's changed bytes go to its page's CPU copy and
// reach the GPU before the frame's submit, nearby slots in one write, so no write lands in a buffer a draw has read.
// WebGL has no such point: its draws run as they are issued, so it keeps a buffer per block (see webgl/buffers.ts).

/** Bytes in a page. Pages are added, never grown, so no slot moves and no bind group over a page is rebuilt. */
const PAGE_BYTES = 1024 * 1024;

/** Dirty slots this close are written in one call: a write call costs the GPU process more than these bytes do. */
const MERGE_GAP_BYTES = 4096;

export type ArenaSlot = {
    page: ArenaPage;
    allocation: OffsetAllocation;
    offset: number;
    /** the slot's size, a multiple of the device's uniform offset alignment */
    bytes: number;
    /** queued in its page's `dirty` */
    dirty: boolean;
};

/** A bind group whose one binding is a uniform block read from `buffer` at a dynamic offset. */
export type SharedGroup = { layout: GPUBindGroupLayout; binding: number; size: number; group: GPUBindGroup };

export type ArenaPage = {
    buffer: GPUBuffer;
    /** what the GPU buffer holds once the dirty slots are written */
    mirror: Uint8Array<ArrayBuffer>;
    /** where the slots are, in units of the device's uniform offset alignment */
    allocator: OffsetAllocator;
    /** slots written since the last flush; a released one may stay, its bytes harmless to write */
    dirty: ArenaSlot[];
    groups: SharedGroup[];
    allocation: Allocation;
    /** slots held in it; at 0 it is released after the next submit, as the frame's draws may still read it */
    liveSlots: number;
};

export type DrawArena = {
    pages: ArenaPage[];
    /** each block's slot, by the block's buffer key */
    slots: WeakMap<object, ArenaSlot>;
    liveSlots: number;
    /** pages left with no slots, released after the submit if none were taken again */
    emptyPages: ArenaPage[];
    /** the bind group cache, whose entries naming a page's buffer go with the page */
    bindGroups: BindGroupCache;
    tally: MemoryTally;
    info: RendererInfo;
};

/**
 * Whether a group's block lives in the arena: one of a render object's or dispatch's own groups, rewritten as often as
 * per draw. A shared block bound at an offset (the view block) is packed into the dynamic uniform ring at every use,
 * and a per-frame one, which binds with no offset, keeps its own buffer.
 */
export function inDrawArena(group: UniformGroup): boolean {
    return !group.shared && group.updateType !== 'frame';
}

export function createDrawArena(info: RendererInfo, tally: MemoryTally, bindGroups: BindGroupCache): DrawArena {
    return { pages: [], slots: new WeakMap(), liveSlots: 0, emptyPages: [], bindGroups, tally, info };
}

/** The slot `key`'s block holds, if it has one. */
export function arenaSlot(arena: DrawArena, key: object): ArenaSlot | undefined {
    return arena.slots.get(key);
}

/**
 * A slot of at least `size` bytes for `key`'s block, replacing a smaller one it held: in the first page with room, so
 * pages stay full and one added for a peak empties out.
 */
export function takeSlot(arena: DrawArena, device: GPUDevice, key: object, size: number): ArenaSlot {
    const align = device.limits.minUniformBufferOffsetAlignment;
    const units = Math.ceil(size / align);
    if (units * align > PAGE_BYTES) {
        throw new Error(`[gpucat] a ${size}-byte uniform block is larger than a ${PAGE_BYTES}-byte draw arena page`);
    }
    releaseSlot(arena, key);
    let page: ArenaPage | undefined;
    let allocation: OffsetAllocation | null = null;
    for (const candidate of arena.pages) {
        allocation = allocateOffset(candidate.allocator, units);
        if (allocation !== null) {
            page = candidate;
            break;
        }
    }
    if (page === undefined) {
        page = addPage(arena, device, align);
        allocation = allocateOffset(page.allocator, units)!;
    }
    const slot: ArenaSlot = {
        page,
        allocation: allocation!,
        offset: allocation!.offset * align,
        bytes: units * align,
        dirty: false,
    };
    arena.slots.set(key, slot);
    arena.liveSlots++;
    page.liveSlots++;
    return slot;
}

/** Frees `key`'s slot for another block. A write it queued may still land: every write copies the page's CPU copy,
 *  which a block placed there since has already written. */
export function releaseSlot(arena: DrawArena, key: object): void {
    const slot = arena.slots.get(key);
    if (slot === undefined) return;
    arena.slots.delete(key);
    arena.liveSlots--;
    releaseOffset(slot.page.allocator, slot.allocation);
    slot.page.liveSlots--;
    if (slot.page.liveSlots === 0) arena.emptyPages.push(slot.page);
}

/**
 * After a submit: releases each page left with no slots and not taken again, so a scene that needed many pages leaves
 * none behind. Its buffer was read by the frame just submitted at the latest, which the submit has already queued.
 */
export function releaseEmptyPages(arena: DrawArena): void {
    for (const page of arena.emptyPages) {
        if (page.liveSlots > 0) continue;
        const at = arena.pages.indexOf(page);
        if (at < 0) continue;
        arena.pages.splice(at, 1);
        releaseGroupsNaming(arena.bindGroups, page.buffer);
        page.buffer.destroy();
        clearAllocation(arena.tally, page.allocation);
    }
    arena.emptyPages.length = 0;
}

/** `data` as the slot's bytes from the next submit on. */
export function writeSlot(slot: ArenaSlot, data: ArrayBuffer): void {
    slot.page.mirror.set(new Uint8Array(data), slot.offset);
    if (slot.dirty) return;
    slot.dirty = true;
    slot.page.dirty.push(slot);
}

/**
 * Writes every slot written since the last flush, nearby ones in one call. Called before the frame's submit; a frame
 * discarded instead leaves them queued for the next, since its blocks already count those bytes as uploaded.
 */
export function flushDrawArena(arena: DrawArena, device: GPUDevice): void {
    for (const page of arena.pages) {
        const dirty = page.dirty;
        if (dirty.length === 0) continue;
        dirty.sort(byOffset);
        let start = dirty[0]!.offset;
        let end = start;
        for (const slot of dirty) {
            slot.dirty = false;
            if (slot.offset - end > MERGE_GAP_BYTES) {
                writeRange(arena, device, page, start, end);
                start = slot.offset;
            }
            end = Math.max(end, slot.offset + slot.bytes);
        }
        writeRange(arena, device, page, start, end);
        dirty.length = 0;
    }
}

/** The bind group binding `slot`'s page for a group whose one binding is the uniform block `binding`, `size` bytes. */
export function pageGroup(
    device: GPUDevice,
    slot: ArenaSlot,
    layout: GPUBindGroupLayout,
    binding: number,
    size: number,
): GPUBindGroup {
    return sharedGroup(device, slot.page.groups, slot.page.buffer, layout, binding, size);
}

/** Pages and the slots held in them. */
export function getDrawArenaStats(arena: DrawArena): { pages: number; slots: number } {
    return { pages: arena.pages.length, slots: arena.liveSlots };
}

export function disposeDrawArena(arena: DrawArena): void {
    for (const page of arena.pages) {
        page.buffer.destroy();
        clearAllocation(arena.tally, page.allocation);
    }
    arena.pages.length = 0;
    arena.emptyPages.length = 0;
    arena.slots = new WeakMap();
    arena.liveSlots = 0;
}

function addPage(arena: DrawArena, device: GPUDevice, align: number): ArenaPage {
    const buffer = device.createBuffer({
        label: `draw-arena-${arena.pages.length}`,
        size: PAGE_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const allocation = createAllocation('buffer', 'uniform-arena', 'draw-arena');
    setAllocation(arena.tally, allocation, PAGE_BYTES);
    const units = PAGE_BYTES / align;
    const page: ArenaPage = {
        buffer,
        mirror: new Uint8Array(PAGE_BYTES),
        // a node per unit: the most a page's allocated and free runs can number
        allocator: createOffsetAllocator(units, units + 1),
        dirty: [],
        groups: [],
        allocation,
        liveSlots: 0,
    };
    arena.pages.push(page);
    return page;
}

/** The group in `groups` binding `buffer` at `binding` for `size` bytes over `layout`, made on first need. */
export function sharedGroup(
    device: GPUDevice,
    groups: SharedGroup[],
    buffer: GPUBuffer,
    layout: GPUBindGroupLayout,
    binding: number,
    size: number,
): GPUBindGroup {
    for (const entry of groups) {
        if (entry.layout === layout && entry.binding === binding && entry.size === size) return entry.group;
    }
    const group = device.createBindGroup({ layout, entries: [{ binding, resource: { buffer, size } }] });
    groups.push({ layout, binding, size, group });
    return group;
}

function writeRange(arena: DrawArena, device: GPUDevice, page: ArenaPage, start: number, end: number): void {
    device.queue.writeBuffer(page.buffer, start, page.mirror, start, end - start);
    recordBufferWrite(arena.info, end - start, 'uniform', false, 'draw-arena');
}

function byOffset(a: ArenaSlot, b: ArenaSlot): number {
    return a.offset - b.offset;
}
