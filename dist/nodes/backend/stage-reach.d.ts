import type * as d from '../../schema/schema';
import { type Node } from '../lib/core';
import type { TracedFn } from './wgsl/emit';
/** a binding's stages as a mask, with the bit values WebGPU's `GPUShaderStage` gives them. */
export declare const STAGE_VERTEX = 1;
export declare const STAGE_FRAGMENT = 2;
export declare const STAGE_COMPUTE = 4;
/** the bindings one stage reads: storage buffers by node id, textures and storage textures by texture id, samplers by
 *  settings key, the keys each is bound under. */
export type StageReach = {
    storages: Set<number>;
    textures: Set<string>;
    samplers: Set<string>;
};
/** what a render pipeline's vertex and fragment stages each read. */
export type RenderStageReach = {
    vertex: StageReach;
    fragment: StageReach;
};
/**
 * The bindings reachable from `roots`, into the `Fn` bodies they call (as `fnDefs` traced them, so the nodes found are
 * the ones bound). A varying is where the stages meet: the fragment reads its value and never what produced it, so the
 * walk stops there, and a vertex walk is seeded with each varying's source instead.
 */
export declare function reachBindings(roots: readonly (Node<d.Any> | null | undefined)[], fnDefs: ReadonlyMap<string, {
    traced: TracedFn;
}>): StageReach;
/** the stages of a render pipeline reading a binding, as `reads` tells each stage's reach. */
export declare function renderStagesOf(stages: RenderStageReach, reads: (reach: StageReach) => boolean): number;
