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
import { compileNodeState, needsNodeUpdate } from '../core/node-manager';
import { computeRenderObjectCacheKey } from '../core/render-object';
import type { RenderObject } from '../core/render-object';
import type { BindingsState } from './bindings';
import { getRenderBindGroupLayouts, initRenderBindings, updateRenderBindings } from './bindings';
import type { BufferCache } from './buffers';
import type { GeometriesState } from './geometries';
import { updateForRender as updateGeometry } from './geometries';
import * as pipelines from './pipelines';
import type { RenderObjectGpuCache } from './render-object-gpu';
import { getRenderObjectGpu } from './render-object-gpu';
import type { TextureCache } from './textures';

// Re-export the neutral RenderObject cache so existing webgpu-side imports keep working.
export type { RenderObjectsState } from '../core/render-objects';
export {
    createRenderObjectsState,
    disposeAllRenderObjects,
    disposeRenderObjectsForMaterial,
    disposeRenderObjectsForMesh,
    getRenderObject,
    getRenderObjectsStats,
} from '../core/render-objects';

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
export function initRenderObject(
    nodes: NodeManagerState,
    geometriesState: GeometriesState,
    bindingsState: BindingsState,
    pipelinesState: pipelines.PipelinesState,
    device: GPUDevice,
    bufferCache: BufferCache,
    renderObjectGpuCache: RenderObjectGpuCache,
    renderObject: RenderObject,
    compile: (slots: CompileSlots) => CompileResult,
): boolean {
    const material = renderObject.material;
    const geometry = renderObject.geometry;
    const renderContext = renderObject.renderContext;

    // Check if we need to (re)compile using fast version comparison
    if (needsNodeUpdate(nodes, renderObject)) {
        // Only compute cache key when we actually need to recompile
        const cacheKey = computeRenderObjectCacheKey(material, geometry, renderContext);
        // Compile node graph
        compileNodeState(nodes, renderObject, cacheKey, compile);
    }

    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) {
        console.warn('[RenderObjects] Failed to compile NodeBuilderState');
        return false;
    }

    // Initialize bindings (creates bind group layouts)
    initRenderBindings(bindingsState, renderObject, device);

    // Get bind group layouts for pipeline creation
    const bindGroupLayouts = getRenderBindGroupLayouts(bindingsState, renderObject);

    // Check if we need to create/update pipeline
    const gpu = getRenderObjectGpu(renderObjectGpuCache, renderObject);
    if (!gpu.pipeline) {
        // Create pipeline using the unified pipelines system (sync)
        const entry = pipelines.getForRender(
            pipelinesState,
            device,
            renderObject,
            bindGroupLayouts,
            null, // sync
        );
        gpu.pipeline = entry.pipeline;
    }

    // Update geometry attributes
    updateGeometry(geometriesState, bufferCache, device, renderObject);

    return true;
}

/**
 * Update a RenderObject for rendering.
 *
 * This is called each frame to:
 * - Update uniform buffers
 * - Rebuild bind groups if needed
 */
export function updateRenderObject(
    bindingsState: BindingsState,
    geometriesState: GeometriesState,
    device: GPUDevice,
    bufferCache: BufferCache,
    textureCache: TextureCache,
    renderObjectGpuCache: RenderObjectGpuCache,
    renderObject: RenderObject,
    frame: NodeFrame,
): void {
    // Update bindings (uniforms, bind groups)
    updateRenderBindings(bindingsState, renderObject, frame, device, bufferCache, textureCache, renderObjectGpuCache);

    // Update geometry if needed
    updateGeometry(geometriesState, bufferCache, device, renderObject);
}

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
export function initRenderObjectWithPromises(
    nodes: NodeManagerState,
    geometriesState: GeometriesState,
    bindingsState: BindingsState,
    pipelinesState: pipelines.PipelinesState,
    device: GPUDevice,
    bufferCache: BufferCache,
    renderObjectGpuCache: RenderObjectGpuCache,
    renderObject: RenderObject,
    promises: Promise<void>[],
    compile: (slots: CompileSlots) => CompileResult,
): boolean {
    const material = renderObject.material;
    const geometry = renderObject.geometry;
    const renderContext = renderObject.renderContext;

    // Check if we need to (re)compile using fast version comparison
    if (needsNodeUpdate(nodes, renderObject)) {
        // Only compute cache key when we actually need to recompile
        const cacheKey = computeRenderObjectCacheKey(material, geometry, renderContext);
        // Compile node graph (sync - this is fast)
        compileNodeState(nodes, renderObject, cacheKey, compile);
    }

    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) {
        console.warn('[RenderObjects] Failed to compile NodeBuilderState');
        return false;
    }

    // Initialize bindings (creates bind group layouts)
    initRenderBindings(bindingsState, renderObject, device);

    // Get bind group layouts for pipeline creation
    const bindGroupLayouts = getRenderBindGroupLayouts(bindingsState, renderObject);

    // Check if we need to create/update pipeline
    const gpu = getRenderObjectGpu(renderObjectGpuCache, renderObject);
    if (!gpu.pipeline) {
        // Create pipeline asynchronously using the unified pipelines system
        const entry = pipelines.getForRender(
            pipelinesState,
            device,
            renderObject,
            bindGroupLayouts,
            promises, // async - will push promise to array
        );
        // Pipeline will be set when promise resolves, but we track the entry
        // The actual pipeline assignment happens after promises resolve
        promises.push(
            Promise.resolve().then(() => {
                if (entry.pipeline) {
                    gpu.pipeline = entry.pipeline;
                }
            }),
        );
    }

    // Update geometry attributes
    updateGeometry(geometriesState, bufferCache, device, renderObject);

    return true;
}
