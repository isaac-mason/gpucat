/**
 * render-objects.ts (webgpu) - device half of RenderObject init/update.
 *
 * The neutral cache (state + getRenderObject + dispose/stats) lives in `../core/render-objects`
 * and is re-exported here for existing call sites. This module keeps only the device-coupled
 * per-object work: compiling the node graph, creating bind group layouts + the pipeline, and
 * uploading geometry. Subsystem dependencies (nodes, geometries, bindings, pipelines, device,
 * bufferCache, textureCache) are passed as function parameters, not stored in state.
 */
import type { CompileResult, CompileSlots } from '../../nodes/builder';
import type { NodeFrame } from '../core/node-frame';
import type { NodeManagerState } from '../core/node-manager';
import type { RenderObject } from '../core/render-object';
import type { BindingsState } from './bindings';
import type { BufferCache } from './buffers';
import type { GeometriesState } from './geometries';
import * as pipelines from './pipelines';
import type { RenderObjectGpuCache } from './render-object-gpu';
import type { TextureCache } from './textures';
export type { RenderObjectsState } from '../core/render-objects';
export { createRenderObjectsState, disposeAllRenderObjects, disposeRenderObjectsForMaterial, disposeRenderObjectsForMesh, getRenderObject, getRenderObjectsStats, } from '../core/render-objects';
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
export declare function initRenderObject(nodes: NodeManagerState, geometriesState: GeometriesState, bindingsState: BindingsState, pipelinesState: pipelines.PipelinesState, device: GPUDevice, bufferCache: BufferCache, renderObjectGpuCache: RenderObjectGpuCache, renderObject: RenderObject, compile: (slots: CompileSlots) => CompileResult): boolean;
/**
 * Update a RenderObject for rendering.
 *
 * This is called each frame to:
 * - Update uniform buffers
 * - Rebuild bind groups if needed
 */
export declare function updateRenderObject(bindingsState: BindingsState, geometriesState: GeometriesState, device: GPUDevice, bufferCache: BufferCache, textureCache: TextureCache, renderObjectGpuCache: RenderObjectGpuCache, renderObject: RenderObject, frame: NodeFrame): void;
/**
 * Initialize a RenderObject for pre-warming with async pipeline compilation.
 *
 * This is similar to initRenderObject but collects pipeline compilation promises
 * for non-blocking compilation. Use this in renderer.compile() to pre-warm all
 * pipelines without blocking the main thread.
 *
 * The `compile` render-shader emitter is supplied by the backend (WGSL/GLSL).
 *
 * @returns true if initialization succeeded (pipeline may still be compiling)
 */
export declare function initRenderObjectWithPromises(nodes: NodeManagerState, geometriesState: GeometriesState, bindingsState: BindingsState, pipelinesState: pipelines.PipelinesState, device: GPUDevice, bufferCache: BufferCache, renderObjectGpuCache: RenderObjectGpuCache, renderObject: RenderObject, promises: Promise<void>[], compile: (slots: CompileSlots) => CompileResult): boolean;
