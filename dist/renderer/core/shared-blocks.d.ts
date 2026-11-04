import type { Uniform, UniformGroup } from '../../core/uniform';
import type { UniformGroupBlock, UniformMember } from '../../nodes/builder';
import type { UniformNode } from '../../nodes/lib/uniform';
import { type MemoryLayout } from '../../schema/pack';
import type * as d from '../../schema/schema';
import type { NodeFrame } from './node-frame';
/**
 * One block per shared uniform group, which every shader reading the group's uniforms binds: each `Uniform` gets a
 * position the first time a shader declares it and keeps it, and each shader declares the members it reads at their
 * positions. So the group is one buffer, packed only where a value moved, bound once for every pipeline. Godot's
 * global shader uniforms work the same way (`GlobalShaderUniforms`); the difference is that a shader declares only its
 * own members, typed, with gaps between, so the buffer can grow without recompiling anything.
 *
 * Positions are 16-byte slots, as Godot's: every member starts on one, which satisfies the strictest alignment in
 * both the std140 and the WGSL uniform layouts. A member no live shader reads frees its slots for a later one.
 */
export type SharedBlock = {
    readonly group: UniformGroup;
    readonly layout: MemoryLayout;
    /** Every member joined, in slot order: the block the shared binding packs and uploads. */
    readonly block: UniformGroupBlock;
    readonly uniformToMember: Map<Uniform<d.Any>, SharedMember>;
    /** Runs of free slots, for first-fit reuse. */
    freeRuns: {
        start: number;
        slots: number;
    }[];
    /** Slots up to the highest in use. */
    slots: number;
    /** What the buffer holds once the dirty range is uploaded. */
    mirror: ArrayBuffer;
    /** The byte range packed since the last upload; empty when `dirtyEnd <= dirtyStart`. */
    dirtyStart: number;
    dirtyEnd: number;
    /** Moves when a member joins or leaves, so a use knows to sync again within a frame. */
    version: number;
    syncedFrame: number;
    syncedVersion: number;
};
export type SharedMember = UniformMember & {
    /** The block it's a member of. */
    readonly owner: SharedBlock;
    readonly uniform: Uniform<d.Any>;
    /** Every node read for the uniform, so each one's callbacks run. */
    readonly nodes: UniformNode<d.Any>[];
    readonly slots: number;
    /** Live compiled states reading it; at 0 its slots free. */
    readers: number;
    /** The `Uniform.version` last packed; -1 to pack. */
    packedVersion: number;
};
/** What a compile places shared members with: the renderer's blocks and the device's uniform block limit. */
export type SharedPlacement = {
    readonly blocks: SharedBlocks;
    readonly maxBytes: number;
};
/** A renderer's shared blocks, by group, in its backend's uniform layout. */
export type SharedBlocks = {
    readonly layout: MemoryLayout;
    readonly groupToBlock: Map<UniformGroup, SharedBlock>;
};
export declare function createSharedBlocks(layout: MemoryLayout): SharedBlocks;
/** The first node of each `Uniform` in `nodes`: a shared group's member is the uniform, however many nodes read it. */
export declare function uniqueByUniform(nodes: readonly UniformNode<d.Any>[]): UniformNode<d.Any>[];
/**
 * The members `nodes` read, one per `Uniform`, joining a new one at the first free slots that fit, in slot order.
 * Throws when the block would pass `maxBytes`, the device's uniform block limit.
 */
export declare function placeSharedMembers(blocks: SharedBlocks, group: UniformGroup, nodes: readonly UniformNode<d.Any>[], maxBytes: number): SharedMember[];
/** A compiled state reads `members`: each counts it. */
export declare function addSharedReaders(members: readonly SharedMember[]): void;
/**
 * A compiled state reading `members` was released: each stops counting it, and one read by none frees its slots. A
 * block left with no members leaves `blocks`, and its buffer, keyed by the block, goes to `releaseUniformBlock`.
 */
export declare function releaseSharedReaders(blocks: SharedBlocks, members: readonly SharedMember[], releaseUniformBlock: (key: object) => void): void;
/**
 * Brings the mirror up to date for this frame: runs each member's frame and render callbacks, and packs each member
 * whose version moved, widening the dirty range. Once a frame, and again within it after a member joins.
 */
export declare function syncSharedBlock(shared: SharedBlock, frame: NodeFrame): void;
/** The range to upload into `out`, then empties it; false when nothing is dirty. */
export declare function takeSharedDirty(shared: SharedBlock, out: {
    start: number;
    end: number;
}): boolean;
