import type { Geometry } from '../../geometry/geometry';
import type { NodeFrame } from '../core/node-frame';
import type { NodeManagerState } from '../core/node-manager';
import type { RenderObject } from '../core/render-object';
import type { WebGPUBackend } from './webgpu-backend';
/**
 * Compile the node graph and build the pipeline / bind group layouts / geometry for one render
 * object, or throw naming it. The neutral collect/getRenderObject/updateBefore steps stay in the
 * render-loop orchestration.
 */
export declare function prepareRenderObject(b: WebGPUBackend, nodes: NodeManagerState, renderObject: RenderObject): void;
/**
 * Pre-warm half of the renderer's `compile()`: kick off async pipeline compilation for one render
 * object (node graph + bind group layouts compiled synchronously, pipeline may still be building),
 * pushing in-flight promises onto `promises`.
 */
export declare function compileRenderObject(b: WebGPUBackend, nodes: NodeManagerState, renderObject: RenderObject, promises: Promise<void>[]): void;
/**
 * Pre-warm upload half of `compile()`: upload storage/vertex/index buffers for a render object,
 * then (re)build its bind groups against the pre-warm frame.
 */
export declare function uploadRenderObjectResources(b: WebGPUBackend, renderObject: RenderObject, geometry: Geometry, frame: NodeFrame): void;
