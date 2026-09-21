import type { ComputeNode } from '../../nodes/lib/core';
import type { Mesh } from '../../objects/mesh';
import { resolvePassParams } from './pass-desc';
import { createPassParams } from './render-types';
import type { Renderer } from './renderer';
import { compileTargets } from './renderer-ops';
import type { Target } from './target';
import type { View } from './view';

/**
 * Pre-warms the pipelines, bind groups and uploads a later pass would build on its first frame.
 * `target` and `camera` are the pass it is warming for: a key built against anything else warms
 * something no pass will look up.
 */
export function compile(renderer: Renderer, drawables: readonly Mesh[], target: Target, camera: View): Promise<void> {
    renderer._assertInitialized('compile');
    if (drawables.length === 0) return Promise.resolve();
    const { objects } = compileTargets(renderer, drawables, target, camera);
    return renderer.backend.compileObjects(objects, resolvePassParams({ target, camera }, createPassParams()));
}

/** Pre-warms compute pipelines. Throws on WebGL2, which cannot run them at all. */
export function compileCompute(renderer: Renderer, nodes: readonly ComputeNode[]): Promise<void> {
    return renderer.backend.compileCompute(nodes);
}
