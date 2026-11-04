import type { Uniform, UniformGroup } from '../../core/uniform';
import type { UniformGroupBlock, UniformMember } from '../../nodes/builder';
import type { UniformNode } from '../../nodes/lib/uniform';
import { layoutSizeOf, type MemoryLayout, packToView } from '../../schema/pack';
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
    freeRuns: { start: number; slots: number }[];
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
export type SharedPlacement = { readonly blocks: SharedBlocks; readonly maxBytes: number };

/** A renderer's shared blocks, by group, in its backend's uniform layout. */
export type SharedBlocks = { readonly layout: MemoryLayout; readonly groupToBlock: Map<UniformGroup, SharedBlock> };

export function createSharedBlocks(layout: MemoryLayout): SharedBlocks {
    return { layout, groupToBlock: new Map() };
}

/** The first node of each `Uniform` in `nodes`: a shared group's member is the uniform, however many nodes read it. */
export function uniqueByUniform(nodes: readonly UniformNode<d.Any>[]): UniformNode<d.Any>[] {
    const seen = new Set<Uniform<d.Any>>();
    const out: UniformNode<d.Any>[] = [];
    for (const node of nodes) {
        if (seen.has(node.uniform)) continue;
        seen.add(node.uniform);
        out.push(node);
    }
    return out;
}

/** `group`'s block, made empty on first need. */
function sharedBlockOf(blocks: SharedBlocks, group: UniformGroup): SharedBlock {
    let block = blocks.groupToBlock.get(group);
    if (block === undefined) {
        block = {
            group,
            layout: blocks.layout,
            block: {
                groupName: group.name,
                groupIndex: group.order,
                binding: 0,
                shared: true,
                members: [],
                totalBytes: 16,
                group,
            },
            uniformToMember: new Map(),
            freeRuns: [],
            slots: 0,
            mirror: new ArrayBuffer(16),
            dirtyStart: 0,
            dirtyEnd: 0,
            version: 0,
            syncedFrame: -1,
            syncedVersion: -1,
        };
        blocks.groupToBlock.set(group, block);
    }
    return block;
}

/**
 * The members `nodes` read, one per `Uniform`, joining a new one at the first free slots that fit, in slot order.
 * Throws when the block would pass `maxBytes`, the device's uniform block limit.
 */
export function placeSharedMembers(
    blocks: SharedBlocks,
    group: UniformGroup,
    nodes: readonly UniformNode<d.Any>[],
    maxBytes: number,
): SharedMember[] {
    const shared = sharedBlockOf(blocks, group);
    const placed: SharedMember[] = [];
    for (const node of nodes) {
        if (node.uniform.value === null) {
            throw new Error(
                `[gpucat] uniform '${node.name}' in shared group '${group.name}' reads its value from the material; a shared group's uniforms hold one value for every draw`,
            );
        }
        let member = shared.uniformToMember.get(node.uniform);
        if (member === undefined) member = joinMember(shared, node, maxBytes);
        else if (!member.nodes.includes(node)) member.nodes.push(node);
        if (!placed.includes(member)) placed.push(member);
    }
    return placed.sort((a, b) => a.offset - b.offset);
}

function joinMember(shared: SharedBlock, node: UniformNode<d.Any>, maxBytes: number): SharedMember {
    const size = layoutSizeOf(node.type, shared.layout);
    const slots = Math.ceil(size / 16);
    let start = -1;
    for (let index = 0; index < shared.freeRuns.length; index++) {
        const run = shared.freeRuns[index]!;
        if (run.slots < slots) continue;
        start = run.start;
        if (run.slots === slots) shared.freeRuns.splice(index, 1);
        else {
            run.start += slots;
            run.slots -= slots;
        }
        break;
    }
    if (start < 0) {
        start = shared.slots;
        shared.slots += slots;
    }
    const end = Math.max(shared.slots, start + slots) * 16;
    if (end > maxBytes) {
        throw new Error(
            `[gpucat] shared group '${shared.group.name}' would take ${end} bytes with '${node.name}' (${size}), past the device's ${maxBytes}-byte uniform block limit`,
        );
    }
    const member: SharedMember = {
        uniformId: node.name,
        schema: node.type,
        offset: start * 16,
        size,
        node,
        owner: shared,
        uniform: node.uniform,
        nodes: [node],
        slots,
        readers: 0,
        packedVersion: -1,
    };
    shared.uniformToMember.set(node.uniform, member);
    const members = shared.block.members as SharedMember[];
    members.push(member);
    members.sort((a, b) => a.offset - b.offset);
    growMirror(shared);
    shared.version++;
    return member;
}

function growMirror(shared: SharedBlock): void {
    const bytes = Math.max(16, shared.slots * 16);
    (shared.block as { totalBytes: number }).totalBytes = bytes;
    if (shared.mirror.byteLength >= bytes) return;
    let capacity = shared.mirror.byteLength;
    while (capacity < bytes) capacity *= 2;
    const mirror = new ArrayBuffer(capacity);
    new Uint8Array(mirror).set(new Uint8Array(shared.mirror));
    shared.mirror = mirror;
    // a buffer as big as the new mirror uploads whole
    shared.dirtyStart = 0;
    shared.dirtyEnd = bytes;
}

/** A compiled state reads `members`: each counts it. */
export function addSharedReaders(members: readonly SharedMember[]): void {
    for (const member of members) member.readers++;
}

/**
 * A compiled state reading `members` was released: each stops counting it, and one read by none frees its slots. A
 * block left with no members leaves `blocks`, and its buffer, keyed by the block, goes to `releaseUniformBlock`.
 */
export function releaseSharedReaders(
    blocks: SharedBlocks,
    members: readonly SharedMember[],
    releaseUniformBlock: (key: object) => void,
): void {
    for (const member of members) {
        member.readers--;
        if (member.readers > 0) continue;
        const shared = member.owner;
        shared.uniformToMember.delete(member.uniform);
        const all = shared.block.members as SharedMember[];
        all.splice(all.indexOf(member), 1);
        freeSlots(shared, member.offset / 16, member.slots);
        shared.version++;
        if (shared.uniformToMember.size > 0 || blocks.groupToBlock.get(shared.group) !== shared) continue;
        blocks.groupToBlock.delete(shared.group);
        releaseUniformBlock(shared);
    }
}

function freeSlots(shared: SharedBlock, start: number, slots: number): void {
    shared.freeRuns.push({ start, slots });
    shared.freeRuns.sort((a, b) => a.start - b.start);
    // merge neighbours, then give the tail back
    for (let index = shared.freeRuns.length - 1; index > 0; index--) {
        const before = shared.freeRuns[index - 1]!;
        const run = shared.freeRuns[index]!;
        if (before.start + before.slots === run.start) {
            before.slots += run.slots;
            shared.freeRuns.splice(index, 1);
        }
    }
    const last = shared.freeRuns[shared.freeRuns.length - 1];
    if (last !== undefined && last.start + last.slots === shared.slots) {
        shared.slots = last.start;
        shared.freeRuns.pop();
        (shared.block as { totalBytes: number }).totalBytes = Math.max(16, shared.slots * 16);
    }
}

/**
 * Brings the mirror up to date for this frame: runs each member's frame and render callbacks, and packs each member
 * whose version moved, widening the dirty range. Once a frame, and again within it after a member joins.
 */
export function syncSharedBlock(shared: SharedBlock, frame: NodeFrame): void {
    if (shared.syncedFrame === frame.frameId && shared.syncedVersion === shared.version) return;
    shared.syncedFrame = frame.frameId;
    shared.syncedVersion = shared.version;
    const view = new DataView(shared.mirror);
    for (const member of shared.block.members as SharedMember[]) {
        for (const node of member.nodes) {
            if (node.update) frame.updateNode(node as unknown as Parameters<typeof frame.updateNode>[0]);
        }
        if (member.packedVersion === member.uniform.version) continue;
        member.packedVersion = member.uniform.version;
        const value = member.uniform.value;
        if (value === null || value === undefined) continue;
        packToView(member.schema, view, member.offset, value as never, shared.layout);
        if (shared.dirtyEnd <= shared.dirtyStart) {
            shared.dirtyStart = member.offset;
            shared.dirtyEnd = member.offset + member.slots * 16;
        } else {
            shared.dirtyStart = Math.min(shared.dirtyStart, member.offset);
            shared.dirtyEnd = Math.max(shared.dirtyEnd, member.offset + member.slots * 16);
        }
    }
}

/** The range to upload into `out`, then empties it; false when nothing is dirty. */
export function takeSharedDirty(shared: SharedBlock, out: { start: number; end: number }): boolean {
    if (shared.dirtyEnd <= shared.dirtyStart) return false;
    out.start = shared.dirtyStart;
    out.end = Math.min(shared.dirtyEnd, shared.block.totalBytes);
    shared.dirtyStart = 0;
    shared.dirtyEnd = 0;
    return out.end > out.start;
}
