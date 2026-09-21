import { type CompileGlslOptions } from '../../nodes/builder';
import { type NodeManagerState } from '../core/node-manager';
import { type RenderObject } from '../core/render-object';
import type { BackendState } from './backend-state';
/**
 * Compile the GLSL program + prepare the RenderObject for drawing. Returns whether it is drawable.
 *
 * @param gl the WebGL2 context
 * @param nodes the node manager (owns compilation + the NodeFrame)
 * @param b.programs the program cache
 * @param geometries the geometries cache (VAOs built lazily at draw time)
 * @param b.renderObjectGl the per-RenderObject GL payload cache
 * @param renderObject the object to prepare
 * @param glslOptions GLSL emitter options (e.g. shader `precision`), threaded into compileGlsl
 */
/** Everything an object needs once: GLSL, bind groups, a linked program. VAOs and UBO uploads
 *  depend on per-object frame state, so they stay in the draw loop. */
export declare function prepareRenderObject(gl: WebGL2RenderingContext, b: BackendState, nodes: NodeManagerState, renderObject: RenderObject, glslOptions?: CompileGlslOptions): boolean;
