/**
 * render-objects.ts - RenderObject manager with ChainMap caching.
 *
 * Coordinates initialization of NodeBuilderState, pipeline, bindings.
 * Subsystem dependencies (nodes, geometries, bindings, pipelines, device,
 * bufferCache, textureCache) are passed as function parameters — not stored
 * in state.
 */
import type { Camera } from 'gpucat/dist/camera/camera';
import type { Material } from 'gpucat/dist/material/material';
import type { Mesh } from 'gpucat/dist/objects/mesh';
import type { Object3D } from 'gpucat/dist/core/object3d';
import type { BindingsState } from 'gpucat/dist/renderer/bindings';
import type { BufferCache } from 'gpucat/dist/renderer/buffers';
import * as chainMap from 'gpucat/dist/renderer/chain-map';
import type { GeometriesState } from 'gpucat/dist/renderer/geometries';
import type { NodeFrame } from 'gpucat/dist/renderer/node-frame';
import type { NodeManagerState } from 'gpucat/dist/renderer/node-manager';
import * as pipelines from 'gpucat/dist/renderer/pipelines';
import type { RenderContext } from 'gpucat/dist/renderer/pass-context';
import type { RenderObject } from 'gpucat/dist/renderer/render-object';
import type { TextureCache } from 'gpucat/dist/renderer/textures';
/**
 * RenderObjects state — owns only the caching structures.
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
export declare function initRenderObject(nodes: NodeManagerState, geometriesState: GeometriesState, bindingsState: BindingsState, pipelinesState: pipelines.PipelinesState, device: GPUDevice, bufferCache: BufferCache, renderObject: RenderObject, colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat | null): boolean;
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
export declare function initRenderObjectWithPromises(nodes: NodeManagerState, geometriesState: GeometriesState, bindingsState: BindingsState, pipelinesState: pipelines.PipelinesState, device: GPUDevice, bufferCache: BufferCache, renderObject: RenderObject, colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat | null, promises: Promise<void>[]): boolean;
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
