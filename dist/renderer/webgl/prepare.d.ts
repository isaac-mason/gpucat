/**
 * prepare.ts (webgl) - the device half of per-object preparation.
 *
 * Mirrors `webgpu/prepare.ts`: `WebGLRenderer.render()` hands this to the neutral
 * `prepareRenderObjects` loop as its per-object `prepare` callback (via a closure that supplies the
 * `gl` context + caches). For each object it compiles the node graph to GLSL (once, version-gated),
 * ensures the RenderObject's bind groups exist, and compiles + links the GL program (cached by
 * source). The VAO + UBO uploads happen per-draw in the render pass (they depend on per-object frame
 * state), just as the WebGPU path updates bindings/geometry in its draw loop.
 *
 * Returns whether the object is drawable (compiled + program present).
 */
import { type CompileGlslOptions } from '../../nodes/builder';
import { type NodeManagerState } from '../core/node-manager';
import { type RenderObject } from '../core/render-object';
import type { GeometriesState } from './geometries';
import { type ProgramCache } from './programs';
import { type RenderObjectGlCache } from './render-object-gl';
/**
 * Compile the GLSL program + prepare the RenderObject for drawing. Returns whether it is drawable.
 *
 * @param gl the WebGL2 context
 * @param nodes the node manager (owns compilation + the NodeFrame)
 * @param programs the program cache
 * @param _geometries the geometries cache (VAOs built lazily at draw time)
 * @param renderObjectGl the per-RenderObject GL payload cache
 * @param renderObject the object to prepare
 * @param glslOptions GLSL emitter options (e.g. shader `precision`), threaded into compileGlsl
 */
export declare function prepareRenderObject(gl: WebGL2RenderingContext, nodes: NodeManagerState, programs: ProgramCache, _geometries: GeometriesState, renderObjectGl: RenderObjectGlCache, renderObject: RenderObject, glslOptions?: CompileGlslOptions): boolean;
