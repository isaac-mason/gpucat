import { QuadMesh } from '../objects/quad-mesh';
import { Material } from '../material/material';
import { attribute, vec4f, f32 } from '../nodes/nodes';
import type { Node } from '../nodes/nodes';
import type { Any } from '../schema/schema';
import * as d from '../schema/schema';
import type { WebGPURenderer } from './renderer';

/**
 * RenderPipeline - manages the rendering pipeline for fullscreen effects.
 *
 * Usage:
 * ```ts
 * const renderPipeline = new RenderPipeline(renderer);
 *
 * const scenePass = pass(scene, camera);
 * renderPipeline.outputNode = scenePass;
 *
 * function frame() {
 *     renderPipeline.render();
 *     requestAnimationFrame(frame);
 * }
 *
 * // cleanup
 * renderPipeline.dispose();
 * ```
 */
export class RenderPipeline {
    /** reference to the renderer */
    readonly renderer: WebGPURenderer;

    /** the output node to render */
    outputNode: Node<Any>;

    /** set to `true` to rebuild the material, e.g. when the outputNode changes */
    needsUpdate = true;

    /** material used for rendering the fullscreen quad */
    private _material: Material;

    /** the QuadMesh used for fullscreen rendering */
    private _quadMesh: QuadMesh;

    /**
     * @param renderer the renderer.
     * @param outputNode output node. Defaults to solid blue.
     */
    constructor(renderer: WebGPURenderer, outputNode?: Node<Any>) {
        this.renderer = renderer;
        this.outputNode = outputNode ?? vec4f(f32(0), f32(0), f32(1), f32(1));

        // Create material with initial output node - will be updated in _update() when needsUpdate is true
        this._material = this._createMaterial(this.outputNode);

        this._quadMesh = new QuadMesh(this._material);
        this._quadMesh.name = 'RenderPipeline';
    }

    /**
     * Renders the output node to the renderer's current target.
     *
     * Each top-level `render()`/`compute()` call is a self-contained frame: it advances
     * the frame id and brackets inspector capture on its own. Example:
     * ```ts
     * renderer.compute([{ node: myCompute, dispatch: [n, 1, 1] }]);
     * renderPipeline.render();
     * ```
     */
    render(): void {
        this._update();
        this._quadMesh.render(this.renderer);
    }

    /**
     * Dispose of resources owned by this pipeline.
     */
    dispose(): void {
        this._material.dispose();
    }

    /**
     * Updates the material if outputNode has changed.
     * @internal
     */
    private _update(): void {
        if (this.needsUpdate) {
            this._material.dispose();
            this._material = this._createMaterial(this.outputNode);
            this._quadMesh.material = this._material;
            this.needsUpdate = false;
        }
    }

    /**
     * Creates a fullscreen material for the given output node.
     * @internal
     */
    private _createMaterial(outputNode: Node<Any>): Material {
        // position attribute - fullscreen triangle geometry provides clip-space positions
        const posAttr = attribute('position', d.vec3f);
        const posNode = vec4f(posAttr, f32(1));

        return new Material({
            name: 'RenderPipelineQuadMeshMaterial',
            vertex: posNode,
            fragment: outputNode,
            depthWrite: false,
            depthTest: false,
        });
    }
}
