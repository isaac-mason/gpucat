import type { Material } from '../../material/material';
import type { UniformGroupBlock } from '../../nodes/builder';
import { type MemoryLayout } from '../../schema/pack';
import { type UniformBinding } from './bind-group';
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
export declare function resolvedThisScope(binding: UniformBinding, frame: NodeFrame): boolean;
/** What a stamp check found: the block's values hold since its last pack, or a pack is due, with or without a stamp. */
export type StampCheck = 'kept' | 'stamped' | 'unstamped';
/**
 * Whether `binding`'s block can skip its pack because every value it was packed from has kept its version, counting
 * the keep. Only a block with a stamp can: one whose members all carry versions (see `readBlockStamp`).
 */
export declare function checkUniformStamp(binding: UniformBinding, frame: NodeFrame, material: Material | null, info: StateInfo): StampCheck;
/** After a pack the block's buffer holds: the stamp checked names its bytes now, or none does. */
export declare function commitUniformStamp(binding: UniformBinding, check: StampCheck): void;
/** Writes every member that has a value, from the uniform or else the material, at its offset in `layout`. */
export declare function packUniformMembers(block: UniformGroupBlock, view: DataView, material: Material | null, layout: MemoryLayout): void;
/**
 * Packs `block` into `scratch`, seeded with `current` so a member with no value this time keeps its last one rather
 * than reading as a change, and gives how many bytes differ from `current`.
 */
export declare function packAndCompare(block: UniformGroupBlock, current: ArrayBuffer, scratch: ArrayBuffer, material: Material | null, layout: MemoryLayout): number;
/**
 * Bytes differing between two equally sized blocks, compared word by word. A count, not a flag: a large block where a
 * few bytes moved (a per-frame value dragging a static payload up with it) is a different problem from one that
 * genuinely changed.
 */
export declare function changedByteCount(a: ArrayBuffer, b: ArrayBuffer): number;
