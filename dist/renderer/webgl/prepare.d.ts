import { type CompileGlslOptions } from '../../nodes/builder';
import { type NodeManagerState } from '../core/node-manager';
import { type RenderObject } from '../core/render-object';
import type { WebGLBackend } from './webgl-backend';
/**
 * Everything an object needs once: GLSL, bind groups, a linked program. VAOs and UBO uploads depend
 * on per-object frame state, so they stay in the draw loop. Throws naming the object it cannot draw.
 */
export declare function prepareRenderObject(gl: WebGL2RenderingContext, b: WebGLBackend, nodes: NodeManagerState, renderObject: RenderObject, glslOptions?: CompileGlslOptions): void;
/**
 * {@link prepareRenderObject}'s GLSL and bind groups, with its program's compile and link only issued, so a prewarm
 * can start every program before it reads any.
 */
export declare function startRenderObject(gl: WebGL2RenderingContext, b: WebGLBackend, nodes: NodeManagerState, renderObject: RenderObject, glslOptions?: CompileGlslOptions): void;
