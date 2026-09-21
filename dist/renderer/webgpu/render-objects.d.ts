/**
 * The device half of RenderObject init/update: compiling the node graph, building bind group layouts
 * and the pipeline, uploading geometry. The neutral cache is `../core/render-objects`, which callers
 * import directly. The backend arrives as one parameter, so this module holds no state.
 */
import type { CompileResult, CompileSlots } from '../../nodes/builder';
import type { NodeFrame } from '../core/node-frame';
import type { NodeManagerState } from '../core/node-manager';
import type { RenderObject } from '../core/render-object';
import type { BackendState } from './backend-state';
/**
 * Initialize a RenderObject for rendering.
 *
 * This ensures the RenderObject has:
 * - NodeBuilderState (compiled shader)
 * - Pipeline
 * - Bindings
 * - Geometry attributes uploaded
 *
 * Call this before rendering with a RenderObject.
 *
 * The `compile` render-shader emitter is supplied by the backend (WGSL/GLSL).
 *
 * @returns true if initialization succeeded
 */
export declare function initRenderObject(b: BackendState, nodes: NodeManagerState, renderObject: RenderObject, compile: (slots: CompileSlots) => CompileResult): boolean;
/**
 * Update a RenderObject for rendering.
 *
 * This is called each frame to:
 * - Update uniform buffers
 * - Rebuild bind groups if needed
 */
export declare function updateRenderObject(b: BackendState, renderObject: RenderObject, frame: NodeFrame): void;
/** `initRenderObject` for the pre-warm: pipeline compilation is pushed onto `promises` instead of awaited. */
export declare function initRenderObjectWithPromises(b: BackendState, nodes: NodeManagerState, renderObject: RenderObject, promises: Promise<void>[], compile: (slots: CompileSlots) => CompileResult): boolean;
