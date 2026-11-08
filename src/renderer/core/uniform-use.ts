import type { Material } from '../../material/material';
import type { UniformGroupBlock } from '../../nodes/builder';
import { type MemoryLayout, packToView } from '../../schema/pack';
import { readBlockStamp, sameStamp, type UniformBinding } from './bind-group';
import type { StateInfo } from './info';
import type { NodeFrame } from './node-frame';

/**
 * The steps both backends take for one use of a uniform block, before deciding where its bytes go: whether a shared
 * block was already resolved in its scope, whether a per-object block's values moved since its last pack, packing the
 * members in the backend's layout, and comparing the result with what the block held.
 */

/**
 * Whether a shared block updated per frame or per render was already resolved in this frame or render, marking it
 * resolved otherwise. A per-object block, or one updated per object, is resolved at every use.
 */
export function resolvedThisScope(binding: UniformBinding, frame: NodeFrame): boolean {
    const group = binding.block.group;
    if (!group.shared) return false;
    if (group.updateType === 'frame') {
        if (binding.lastFrameId === frame.frameId) return true;
        binding.lastFrameId = frame.frameId;
    } else if (group.updateType === 'render') {
        if (binding.lastRenderId === frame.renderId) return true;
        binding.lastRenderId = frame.renderId;
    }
    return false;
}

/** What a stamp check found: the block's values hold since its last pack, or a pack is due, with or without a stamp. */
export type StampCheck = 'kept' | 'stamped' | 'unstamped';

/** The stamp the last check read, until the next check: one at a time, read before the next draw's. */
const _stamp: number[] = [];

/**
 * Whether `binding`'s block can skip its pack because every value it was packed from has kept its version, counting
 * the keep. Only a block with a stamp can: one whose members all carry versions (see `readBlockStamp`).
 */
export function checkUniformStamp(binding: UniformBinding, frame: NodeFrame, material: Material | null, info: StateInfo): StampCheck {
    if (!readBlockStamp(binding.block, frame, material, _stamp)) return 'unstamped';
    if (!sameStamp(_stamp, binding.stamp)) return 'stamped';
    info.kept++;
    return 'kept';
}

/** After a pack the block's buffer holds: the stamp checked names its bytes now, or none does. */
export function commitUniformStamp(binding: UniformBinding, check: StampCheck): void {
    if (check !== 'stamped') {
        binding.stamp.length = 0;
        return;
    }
    for (let index = 0; index < _stamp.length; index++) binding.stamp[index] = _stamp[index]!;
    binding.stamp.length = _stamp.length;
}

/** Writes every member that has a value, from the uniform or else the material, at its offset in `layout`. */
export function packUniformMembers(block: UniformGroupBlock, view: DataView, material: Material | null, layout: MemoryLayout): void {
    for (const m of block.members) {
        let value = m.node.uniform.value;
        if (value === null && material) {
            const materialUniform = material.parameters.uniform(m.node.name);
            if (materialUniform) value = materialUniform.value;
        }
        if (value === null || value === undefined) continue;
        // UniformValue is broader than the schema's type but matches it at runtime
        packToView(m.schema, view, m.offset, value as never, layout);
    }
}

/**
 * Packs `block` into `scratch`, seeded with `current` so a member with no value this time keeps its last one rather
 * than reading as a change, and gives how many bytes differ from `current`.
 */
export function packAndCompare(
    block: UniformGroupBlock,
    current: ArrayBuffer,
    scratch: ArrayBuffer,
    material: Material | null,
    layout: MemoryLayout,
): number {
    new Uint32Array(scratch).set(new Uint32Array(current));
    packUniformMembers(block, new DataView(scratch), material, layout);
    return changedByteCount(current, scratch);
}

/**
 * Bytes differing between two equally sized blocks, compared word by word. A count, not a flag: a large block where a
 * few bytes moved (a per-frame value dragging a static payload up with it) is a different problem from one that
 * genuinely changed.
 */
export function changedByteCount(a: ArrayBuffer, b: ArrayBuffer): number {
    const av = new Uint32Array(a);
    const bv = new Uint32Array(b);
    let changed = 0;
    for (let index = 0; index < av.length; index++) {
        if (av[index] !== bv[index]) changed += 4;
    }
    return changed;
}
