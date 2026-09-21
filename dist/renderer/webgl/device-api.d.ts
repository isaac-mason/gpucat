import type { Renderer } from '../core/renderer';
import type { WebGLBackend } from './webgl-backend';
/**
 * The escape hatch, for GL work gpucat does not cover. Null until `init` acquires the context, which
 * is why it is not typed as always present.
 */
export declare function glContext(renderer: Renderer<WebGLBackend>): WebGL2RenderingContext | null;
