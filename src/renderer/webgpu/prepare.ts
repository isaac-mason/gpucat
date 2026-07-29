/**
 * prepare.ts (webgpu) - the device half of per-object preparation + the `compile()` pre-warm.
 *
 * These free functions sit just above `render-objects.ts`: they run the compile → pipeline → bind
 * group → geometry init/upload for a single RenderObject. Called by `WebGPURenderer`'s `render()`
 * (per-object prepare) and `compile()` (pre-warm) methods with explicit device + cache params.
 */

import type { Geometry } from '../../geometry/geometry';
import { compile } from '../../nodes/builder';
import type { NodeFrame } from '../core/node-frame';
import type { NodeManagerState } from '../core/node-manager';
import type { RenderObject } from '../core/render-object';
import * as Bindings from './bindings';
import * as Buffers from './buffers';
import * as Geometries from './geometries';
import type * as Pipelines from './pipelines';
import * as RenderObjectGpu from './render-object-gpu';
import * as RenderObjects from './render-objects';
import type * as Textures from './textures';

/**
 * Compile the node graph and build the pipeline / bind group layouts / geometry for one render
 * object. Returns whether it is drawable (initialized, pipeline present, node state present). The
 * neutral collect/getRenderObject/updateBefore steps stay in the render-loop orchestration.
 */
export function prepareRenderObject(
    device: GPUDevice,
    geometries: Geometries.GeometriesState,
    bindings: Bindings.BindingsState,
    pipelines: Pipelines.PipelinesState,
    buffers: Buffers.BufferCache,
    renderObjectGpu: RenderObjectGpu.RenderObjectGpuCache,
    nodes: NodeManagerState,
    renderObject: RenderObject,
): boolean {
    const initialized = RenderObjects.initRenderObject(
        nodes,
        geometries,
        bindings,
        pipelines,
        device,
        buffers,
        renderObjectGpu,
        renderObject,
        compile,
    );
    const gpu = RenderObjectGpu.getRenderObjectGpu(renderObjectGpu, renderObject);
    if (!initialized || !gpu.pipeline) {
        console.warn('[gpucat] initRenderObject failed or pipeline missing', {
            initialized,
            pipeline: gpu.pipeline,
        });
        return false;
    }
    if (!renderObject.nodeBuilderState) {
        console.warn('[gpucat] no nodeBuilderState');
        return false;
    }
    return true;
}

/**
 * Pre-warm half of the renderer's `compile()`: kick off async pipeline compilation for one render
 * object (node graph + bind group layouts compiled synchronously, pipeline may still be building),
 * pushing in-flight promises onto `promises`.
 */
export function compileRenderObject(
    device: GPUDevice,
    geometries: Geometries.GeometriesState,
    bindings: Bindings.BindingsState,
    pipelines: Pipelines.PipelinesState,
    buffers: Buffers.BufferCache,
    renderObjectGpu: RenderObjectGpu.RenderObjectGpuCache,
    nodes: NodeManagerState,
    renderObject: RenderObject,
    promises: Promise<void>[],
): void {
    RenderObjects.initRenderObjectWithPromises(
        nodes,
        geometries,
        bindings,
        pipelines,
        device,
        buffers,
        renderObjectGpu,
        renderObject,
        promises,
        compile,
    );
}

/**
 * Pre-warm upload half of `compile()`: upload storage/vertex/index buffers for a render object,
 * then (re)build its bind groups against the pre-warm frame.
 */
export function uploadRenderObjectResources(
    device: GPUDevice,
    bindings: Bindings.BindingsState,
    geometries: Geometries.GeometriesState,
    buffers: Buffers.BufferCache,
    textures: Textures.TextureCache,
    renderObjectGpu: RenderObjectGpu.RenderObjectGpuCache,
    renderObject: RenderObject,
    geometry: Geometry,
    frame: NodeFrame,
): void {
    const nodeState = renderObject.nodeBuilderState;

    if (nodeState) {
        // upload storage buffers
        for (const s of nodeState.storage) {
            const buffer = Buffers.resolveStorageBuffer(s.node, geometry, null);
            Buffers.ensureUploaded(buffers, device, buffer);
        }

        // upload vertex buffers
        for (const attrEntry of nodeState.attributes) {
            if (attrEntry.kind === 'geometry') {
                const bufAttr = geometry.buffers.get(attrEntry.name!);
                if (bufAttr) {
                    Buffers.ensureUploaded(buffers, device, bufAttr);
                }
            } else {
                const gpuBuffer = attrEntry.node.buffer;
                if (!gpuBuffer) {
                    throw new Error(`[gpucat] AttributeNode has no buffer for ${attrEntry.shaderName}`);
                }
                const arr = gpuBuffer.array;
                if (arr) {
                    Buffers.uploadRaw(
                        buffers,
                        device,
                        attrEntry.node,
                        arr,
                        GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                    );
                }
            }
        }

        // upload index buffer if present
        if (geometry.index) {
            Buffers.ensureUploaded(buffers, device, geometry.index);
        }
    }

    // upload uniforms and rebuild bind groups
    // (must be after texture upload so bind groups can reference GPU resources)
    RenderObjects.updateRenderObject(
        bindings,
        geometries,
        device,
        buffers,
        textures,
        renderObjectGpu,
        renderObject,
        frame,
    );
}
