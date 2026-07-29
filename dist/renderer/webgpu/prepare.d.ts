/**
 * prepare.ts (webgpu) - the device half of per-object preparation + the `compile()` pre-warm.
 *
 * These free functions sit just above `render-objects.ts`: they run the compile → pipeline → bind
 * group → geometry init/upload for a single RenderObject. Called by `WebGPURenderer`'s `render()`
 * (per-object prepare) and `compile()` (pre-warm) methods with explicit device + cache params.
 */
import type { Geometry } from '../../geometry/geometry';
import type { NodeFrame } from '../core/node-frame';
import type { NodeManagerState } from '../core/node-manager';
import type { RenderObject } from '../core/render-object';
import * as Bindings from './bindings';
import * as Buffers from './buffers';
import * as Geometries from './geometries';
import type * as Pipelines from './pipelines';
import * as RenderObjectGpu from './render-object-gpu';
import type * as Textures from './textures';
/**
 * Compile the node graph and build the pipeline / bind group layouts / geometry for one render
 * object. Returns whether it is drawable (initialized, pipeline present, node state present). The
 * neutral collect/getRenderObject/updateBefore steps stay in the render-loop orchestration.
 */
export declare function prepareRenderObject(device: GPUDevice, geometries: Geometries.GeometriesState, bindings: Bindings.BindingsState, pipelines: Pipelines.PipelinesState, buffers: Buffers.BufferCache, renderObjectGpu: RenderObjectGpu.RenderObjectGpuCache, nodes: NodeManagerState, renderObject: RenderObject): boolean;
/**
 * Pre-warm half of the renderer's `compile()`: kick off async pipeline compilation for one render
 * object (node graph + bind group layouts compiled synchronously, pipeline may still be building),
 * pushing in-flight promises onto `promises`.
 */
export declare function compileRenderObject(device: GPUDevice, geometries: Geometries.GeometriesState, bindings: Bindings.BindingsState, pipelines: Pipelines.PipelinesState, buffers: Buffers.BufferCache, renderObjectGpu: RenderObjectGpu.RenderObjectGpuCache, nodes: NodeManagerState, renderObject: RenderObject, promises: Promise<void>[]): void;
/**
 * Pre-warm upload half of `compile()`: upload storage/vertex/index buffers for a render object,
 * then (re)build its bind groups against the pre-warm frame.
 */
export declare function uploadRenderObjectResources(device: GPUDevice, bindings: Bindings.BindingsState, geometries: Geometries.GeometriesState, buffers: Buffers.BufferCache, textures: Textures.TextureCache, renderObjectGpu: RenderObjectGpu.RenderObjectGpuCache, renderObject: RenderObject, geometry: Geometry, frame: NodeFrame): void;
