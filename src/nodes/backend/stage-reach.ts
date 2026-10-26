import type * as d from '../../schema/schema';
import { type AnyNode, getChildren } from '../graph';
import { type CallNode, type Node, NodeKind } from '../lib/core';
import type { TracedFn } from './wgsl/emit';

/** a binding's stages as a mask, with the bit values WebGPU's `GPUShaderStage` gives them. */
export const STAGE_VERTEX = 1;
export const STAGE_FRAGMENT = 2;
export const STAGE_COMPUTE = 4;

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
export function reachBindings(
    roots: readonly (Node<d.Any> | null | undefined)[],
    fnDefs: ReadonlyMap<string, { traced: TracedFn }>,
): StageReach {
    const reach: StageReach = { storages: new Set(), textures: new Set(), samplers: new Set() };
    const seen = new Set<number>();
    const walked = new Set<string>();
    const walk = (rawNode: Node<d.Any> | null | undefined): void => {
        if (!rawNode) return;
        const node = rawNode as AnyNode;
        if (seen.has(node.id)) return;
        seen.add(node.id);
        if (node.kind === NodeKind.Varying) return;
        if (node.kind === NodeKind.Storage) reach.storages.add(node.id);
        else if (node.kind === NodeKind.TextureBinding || node.kind === NodeKind.StorageTextureBinding) {
            reach.textures.add(node.textureId);
        } else if (node.kind === NodeKind.Sampler) reach.samplers.add(node.settingsKey);
        else if (node.kind === NodeKind.Call) {
            const fnNode = (node as CallNode<d.Any>).fnNode;
            if (fnNode && !walked.has(fnNode.fnName)) {
                walked.add(fnNode.fnName);
                const traced = fnDefs.get(fnNode.fnName)?.traced ?? fnNode.trace();
                walk(traced.body);
                walk(traced.output);
            }
        }
        for (const child of getChildren(node)) walk(child);
    };
    for (const root of roots) walk(root);
    return reach;
}

/** the stages of a render pipeline reading a binding, as `reads` tells each stage's reach. */
export function renderStagesOf(stages: RenderStageReach, reads: (reach: StageReach) => boolean): number {
    return (reads(stages.vertex) ? STAGE_VERTEX : 0) | (reads(stages.fragment) ? STAGE_FRAGMENT : 0);
}
