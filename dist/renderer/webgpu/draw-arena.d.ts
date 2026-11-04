import type { UniformGroup } from '../../core/uniform';
import { type Allocation, type MemoryTally, type RendererInfo } from '../core/info';
import { type OffsetAllocation, type OffsetAllocator } from '../core/offset-allocator';
import { type BindGroupCache } from './bind-group-cache';
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
export type SharedGroup = {
    layout: GPUBindGroupLayout;
    binding: number;
    size: number;
    group: GPUBindGroup;
};
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
export declare function inDrawArena(group: UniformGroup): boolean;
export declare function createDrawArena(info: RendererInfo, tally: MemoryTally, bindGroups: BindGroupCache): DrawArena;
/** The slot `key`'s block holds, if it has one. */
export declare function arenaSlot(arena: DrawArena, key: object): ArenaSlot | undefined;
/**
 * A slot of at least `size` bytes for `key`'s block, replacing a smaller one it held: in the first page with room, so
 * pages stay full and one added for a peak empties out.
 */
export declare function takeSlot(arena: DrawArena, device: GPUDevice, key: object, size: number): ArenaSlot;
/** Frees `key`'s slot for another block. A write it queued may still land: every write copies the page's CPU copy,
 *  which a block placed there since has already written. */
export declare function releaseSlot(arena: DrawArena, key: object): void;
/**
 * After a submit: releases each page left with no slots and not taken again, so a scene that needed many pages leaves
 * none behind. Its buffer was read by the frame just submitted at the latest, which the submit has already queued.
 */
export declare function releaseEmptyPages(arena: DrawArena): void;
/** `data` as the slot's bytes from the next submit on. */
export declare function writeSlot(slot: ArenaSlot, data: ArrayBuffer): void;
/**
 * Writes every slot written since the last flush, nearby ones in one call. Called before the frame's submit; a frame
 * discarded instead leaves them queued for the next, since its blocks already count those bytes as uploaded.
 */
export declare function flushDrawArena(arena: DrawArena, device: GPUDevice): void;
/** The bind group binding `slot`'s page for a group whose one binding is the uniform block `binding`, `size` bytes. */
export declare function pageGroup(device: GPUDevice, slot: ArenaSlot, layout: GPUBindGroupLayout, binding: number, size: number): GPUBindGroup;
/** Pages and the slots held in them. */
export declare function getDrawArenaStats(arena: DrawArena): {
    pages: number;
    slots: number;
};
export declare function disposeDrawArena(arena: DrawArena): void;
/** The group in `groups` binding `buffer` at `binding` for `size` bytes over `layout`, made on first need. */
export declare function sharedGroup(device: GPUDevice, groups: SharedGroup[], buffer: GPUBuffer, layout: GPUBindGroupLayout, binding: number, size: number): GPUBindGroup;
