import type { Geometry } from '../../geometry/geometry';
import type { NodeFrame } from '../core/node-frame';
import type { NodeManagerState } from '../core/node-manager';
import type { RenderObject } from '../core/render-object';
import type { BackendState } from './backend-state';
/**
 * Compile the node graph and build the pipeline / bind group layouts / geometry for one render
 * object. Returns whether it is drawable (initialized, pipeline present, node state present). The
 * neutral collect/getRenderObject/updateBefore steps stay in the render-loop orchestration.
 */
export declare function prepareRenderObject(b: BackendState, nodes: NodeManagerState, renderObject: RenderObject): boolean;
/**
 * Pre-warm half of the renderer's `compile()`: kick off async pipeline compilation for one render
 * object (node graph + bind group layouts compiled synchronously, pipeline may still be building),
 * pushing in-flight promises onto `promises`.
 */
export declare function compileRenderObject(b: BackendState, nodes: NodeManagerState, renderObject: RenderObject, promises: Promise<void>[]): void;
/**
 * Pre-warm upload half of `compile()`: upload storage/vertex/index buffers for a render object,
 * then (re)build its bind groups against the pre-warm frame.
 */
export declare function uploadRenderObjectResources(b: BackendState, renderObject: RenderObject, geometry: Geometry, frame: NodeFrame): void;
