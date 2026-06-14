/**
 * render-objects.ts - RenderObject manager with ChainMap caching.
 *
 * Coordinates initialization of NodeBuilderState, pipeline, bindings.
 * Subsystem dependencies (nodes, geometries, bindings, pipelines, device,
 * bufferCache, textureCache) are passed as function parameters, not stored
 * in state.
 */
import type { Camera } from '../camera/camera';
import type { Material } from '../material/material';
import type { Mesh } from '../objects/mesh';
import type { Object3D } from '../core/object3d';
import type { BindingsState } from './bindings';
import type { BufferCache } from './buffers';
import * as chainMap from './chain-map';
import type { GeometriesState } from './geometries';
import type { NodeFrame } from './node-frame';
import type { NodeManagerState } from './node-manager';
import * as pipelines from './pipelines';
import type { RenderContext } from './pass-context';
import type { RenderObject } from './render-object';
import type { TextureCache } from './textures';
/**
 * RenderObjects state, owns only the caching structures.
 * All subsystem deps are passed to functions that need them.
 */
export type RenderObjectsState = {
    /**
     * Per-pass ChainMaps for RenderObject caching.
     * Each passId (e.g., 'default', 'shadow', 'reflection') gets its own ChainMap.
     */
    chainMaps: Map<string, chainMap.ChainMap<RenderObject>>;
    /** All active RenderObjects (for iteration/disposal). */
    renderObjects: Set<RenderObject>;
};
/**
 * Create a new RenderObjects state.
 */
export declare function createRenderObjectsState(): RenderObjectsState;
/**
 * Get or create a RenderObject for the given parameters.
 *
 * This is the main entry point for obtaining a RenderObject. It:
 * 1. Looks up existing RenderObject in ChainMap cache
 * 2. Creates new RenderObject if not found
 */
export declare function getRenderObject(state: RenderObjectsState, mesh: Mesh, material: Material, scene: Object3D, camera: Camera, renderContext: RenderContext, passId?: string): RenderObject;
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
 * @returns true if initialization succeeded
 */
export declare function initRenderObject(nodes: NodeManagerState, geometriesState: GeometriesState, bindingsState: BindingsState, pipelinesState: pipelines.PipelinesState, device: GPUDevice, bufferCache: BufferCache, renderObject: RenderObject): boolean;
/**
 * Update a RenderObject for rendering.
 *
 * This is called each frame to:
 * - Update uniform buffers
 * - Rebuild bind groups if needed
 */
export declare function updateRenderObject(bindingsState: BindingsState, geometriesState: GeometriesState, device: GPUDevice, bufferCache: BufferCache, textureCache: TextureCache, renderObject: RenderObject, frame: NodeFrame): void;
/**
 * Initialize a RenderObject for pre-warming with async pipeline compilation.
 *
 * This is similar to initRenderObject but collects pipeline compilation promises
 * for non-blocking compilation. Use this in renderer.compile() to pre-warm all
 * pipelines without blocking the main thread.
 *
 * @returns true if initialization succeeded (pipeline may still be compiling)
 */
export declare function initRenderObjectWithPromises(nodes: NodeManagerState, geometriesState: GeometriesState, bindingsState: BindingsState, pipelinesState: pipelines.PipelinesState, device: GPUDevice, bufferCache: BufferCache, renderObject: RenderObject, promises: Promise<void>[]): boolean;
/** Dispose all RenderObjects for a specific mesh. */
export declare function disposeRenderObjectsForMesh(state: RenderObjectsState, mesh: Mesh): void;
/** Dispose all RenderObjects for a specific material. */
export declare function disposeRenderObjectsForMaterial(state: RenderObjectsState, material: Material): void;
/** Dispose all RenderObjects. */
export declare function disposeAllRenderObjects(state: RenderObjectsState): void;
/** Get statistics about RenderObjects. */
export declare function getRenderObjectsStats(state: RenderObjectsState): {
    total: number;
    perPass: Record<string, number>;
};
