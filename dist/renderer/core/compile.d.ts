import type { ComputeNode } from '../../nodes/lib/core';
import type { Mesh } from '../../objects/mesh';
import type { Target } from './target';
import type { View } from './view';
/**
 * What `compile` needs of a renderer. Render pre-warm is orchestration and lives on the renderer;
 * compute pre-warm is a device batch and lives on the backend, which is why this reaches both.
 */
export type CompilableRenderer = {
    compile(drawables: Mesh[], target: Target, camera: View): Promise<void>;
    backend: {
        compileCompute(nodes: ComputeNode[]): Promise<void>;
    };
};
/**
 * Pre-warms the pipelines, bind groups and uploads a later pass would build on its first frame.
 * `target` and `camera` are the pass it is warming for: a key built against anything else warms
 * something no pass will look up.
 */
export declare function compile(renderer: CompilableRenderer, drawables: Mesh | Mesh[], target: Target, camera: View): Promise<void>;
/** Pre-warms compute pipelines. Throws on WebGL2, which cannot run them at all. */
export declare function compileCompute(renderer: CompilableRenderer, nodes: ComputeNode | ComputeNode[]): Promise<void>;
