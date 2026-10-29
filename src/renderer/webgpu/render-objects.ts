/**
 * The device half of RenderObject init: compiling the node graph, building bind group layouts and the
 * pipeline. The neutral cache is `../core/render-objects`, which callers
 * import directly. The backend arrives as one parameter, so this module holds no state.
 */

import type { CompileResult, CompileSlots } from '../../nodes/builder';
import type { NodeManagerState } from '../core/node-manager';
import { compileNodeState, needsNodeUpdate } from '../core/node-manager';
import type { RenderObject } from '../core/render-object';
import { getBindings } from '../core/render-object';
import { assertDynamicUniformLimit } from './bind-group-layout';
import { getRenderBindGroupLayouts, initRenderBindings } from './bindings';
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
    // Check if we need to (re)compile using fast version comparison
    const stale = needsNodeUpdate(nodes, renderObject);
    if (stale) compileNodeState(nodes, renderObject, compile);

    const nodeState = renderObject.nodeBuilderState;
    if (!nodeState) {
        console.warn('[RenderObjects] Failed to compile NodeBuilderState');
        return false;
    }

    // Check if we need to create/update pipeline
    const gpu = getRenderObjectGpu(renderObjectGpuCache, renderObject);
    // A material or geometry version change moves the pipeline key, so the resolved pipeline is stale. The bind group
    // layouts are only what a new pipeline is built against: a draw's own bindings initialise theirs as they update,
    // and its vertex and index buffers upload as the draw binds them, so neither repeats here every draw.
    if (!gpu.pipeline || stale) {
        initRenderBindings(bindingsState, renderObject, device);
        const bindGroupLayouts = getRenderBindGroupLayouts(bindingsState, renderObject);
        assertDynamicUniformLimit(device, getBindings(renderObject), pipelineName(renderObject));
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

    return true;
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
    // Check if we need to (re)compile using fast version comparison
    const stale = needsNodeUpdate(nodes, renderObject);
    if (stale) compileNodeState(nodes, renderObject, compile);

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
        assertDynamicUniformLimit(device, getBindings(renderObject), pipelineName(renderObject));
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

    return true;
}

/** What a pipeline error names: the material, else the mesh drawing it. */
function pipelineName(renderObject: RenderObject): string {
    return renderObject.material.name || renderObject.mesh.name || 'material';
}
