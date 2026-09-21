import type { ComputeNode } from '../../nodes/lib/core';
import type { Mesh } from '../../objects/mesh';
import { compileTargets } from './renderer-ops';
import type { Renderer } from './renderer';
import type { Target } from './target';
import type { View } from './view';

/**
 * What `compile` needs of a renderer. Render pre-warm is orchestration and lives on the renderer;
 * compute pre-warm is a device batch and lives on the backend, which is why this reaches both.
 */

/**
 * Pre-warms the pipelines, bind groups and uploads a later pass would build on its first frame.
 * `target` and `camera` are the pass it is warming for: a key built against anything else warms
 * something no pass will look up.
 */
export function compile(renderer: Renderer, drawables: Mesh | Mesh[], target: Target, camera: View): Promise<void> {
    renderer._assertInitialized('compile');
    const list = Array.isArray(drawables) ? drawables : [drawables];
    if (list.length === 0) return Promise.resolve();
    const { context, objects } = compileTargets(renderer, list, target, camera);
    return renderer.backend.compileObjects(objects, context);
}

/** Pre-warms compute pipelines. Throws on WebGL2, which cannot run them at all. */
export function compileCompute(renderer: Renderer, nodes: ComputeNode | ComputeNode[]): Promise<void> {
    return renderer.backend.compileCompute(Array.isArray(nodes) ? nodes : [nodes]);
}
