/**
 * The device half of RenderObject init/update: compiling the node graph, building bind group layouts
 * and the pipeline, uploading geometry. The neutral cache is `../core/render-objects`, which callers
 * import directly. The backend arrives as one parameter, so this module holds no state.
 */

import type { CompileResult, CompileSlots } from '../../nodes/builder';
import type { NodeFrame } from '../core/node-frame';
import type { NodeManagerState } from '../core/node-manager';
import { compileNodeState, needsNodeUpdate } from '../core/node-manager';
import type { RenderObject } from '../core/render-object';
import { computeRenderObjectCacheKey } from '../core/render-object';
import { getRenderBindGroupLayouts, initRenderBindings, updateRenderBindings } from './bindings';
import { updateForRender as updateGeometry } from './geometries';
import * as pipelines from './pipelines';
import { getRenderObjectGpu } from './render-object-gpu';
import type { WebGPUBackend } from './webgpu-backend';

// Re-export the neutral RenderObject cache so existing webgpu-side imports keep working.
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
    b: WebGPUBackend,
    nodes: NodeManagerState,
    renderObject: RenderObject,
    compile: (slots: CompileSlots) => CompileResult,
): boolean {
    const { bindings: bindingsState, pipelines: pipelinesState, device, renderObjectGpu: renderObjectGpuCache } = b;
    const material = renderObject.material;
    const geometry = renderObject.geometry;
    const renderContext = renderObject.renderContext;

    // Check if we need to (re)compile using fast version comparison
    const stale = needsNodeUpdate(nodes, renderObject);
    if (stale) {
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
    // A material or geometry version change moves the pipeline key, so the resolved pipeline is stale.
    if (!gpu.pipeline || stale) {
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
    updateGeometry(b, renderObject);

    return true;
}

/**
 * Update a RenderObject for rendering.
 *
 * This is called each frame to:
 * - Update uniform buffers
 * - Rebuild bind groups if needed
 */
export function updateRenderObject(b: WebGPUBackend, renderObject: RenderObject, frame: NodeFrame): void {
    updateRenderBindings(b, renderObject, frame);
    updateGeometry(b, renderObject);
}

/** `initRenderObject` for the pre-warm: pipeline compilation is pushed onto `promises` instead of awaited. */
export function initRenderObjectWithPromises(
    b: WebGPUBackend,
    nodes: NodeManagerState,
    renderObject: RenderObject,
    promises: Promise<void>[],
    compile: (slots: CompileSlots) => CompileResult,
): boolean {
    const { bindings: bindingsState, pipelines: pipelinesState, device, renderObjectGpu: renderObjectGpuCache } = b;
    const material = renderObject.material;
    const geometry = renderObject.geometry;
    const renderContext = renderObject.renderContext;

    // Check if we need to (re)compile using fast version comparison
    const stale = needsNodeUpdate(nodes, renderObject);
    if (stale) {
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
    // A material or geometry version change moves the pipeline key, so the resolved pipeline is stale.
    if (!gpu.pipeline || stale) {
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
    updateGeometry(b, renderObject);

    return true;
}
