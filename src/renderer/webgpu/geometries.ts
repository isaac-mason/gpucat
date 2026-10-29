import type { GpuBuffer } from '../../core/gpu-buffer';
import type { Geometry } from '../../geometry/geometry';
import type { Any } from '../../schema/schema';
import type { RenderObject } from '../core/render-object';
import type { RenderObjectGpu } from './render-object-gpu';

/** Which geometries have had a draw bind their buffers, for `renderer.info.memory`. */
export type GeometriesState = {
    resident: WeakSet<Geometry>;
    /** `resident` is a WeakSet, so it cannot be counted. */
    memory: {
        geometries: number;
    };
};

/** Create a new Geometries state. */
export function createGeometriesState(): GeometriesState {
    return {
        resident: new WeakSet(),
        memory: {
            geometries: 0,
        },
    };
}

/** Counts a geometry as resident from the first draw that binds its buffers until it is disposed. */
function trackGeometry(state: GeometriesState, geometry: Geometry): void {
    if (state.resident.has(geometry)) return;
    state.resident.add(geometry);
    state.memory.geometries++;
    geometry._onDispose = () => {
        if (state.resident.delete(geometry)) state.memory.geometries--;
    };
}

/**
 * Resolves into `gpu` the buffers a draw of `renderObject` binds, in vertex slot order, with the names
 * they upload under. Resolved against its compile and its geometry's buffer set, and kept until either
 * moves, so a draw only checks each buffer's version rather than looking it up again.
 */
export function resolveVertexBuffers(state: GeometriesState, gpu: RenderObjectGpu, renderObject: RenderObject): void {
    const { geometry, mesh } = renderObject;
    const nodeState = renderObject.nodeBuilderState!;
    if (
        gpu.vertexNodeState === nodeState &&
        gpu.vertexGeometry === geometry &&
        gpu.vertexGeometryBindings === geometry.bindingsVersion
    ) {
        return;
    }

    const buffers: GpuBuffer<Any>[] = [];
    const names: string[] = [];
    for (const group of nodeState.vertexBufferGroups) {
        if (group.name !== null) {
            const buffer = geometry.buffers.get(group.name);
            if (!buffer) {
                throw new Error(
                    `[gpucat] '${mesh.name || 'mesh'}' lost vertex buffer '${group.name}' after its pipeline was ` +
                        'built; the pipeline still has a layout for it and every later buffer would bind one slot off.',
                );
            }
            buffers.push(buffer);
            names.push(group.name);
        } else {
            const buffer = group.buffer;
            if (!buffer) throw new Error(`[gpucat] VertexBufferGroup has no buffer`);
            if (!buffer.array && buffer.cpu) throw new Error(`[gpucat] VertexBufferGroup buffer array is null`);
            buffers.push(buffer);
            names.push('vertex');
        }
    }

    gpu.vertexBuffers = buffers;
    gpu.vertexBufferNames = names;
    gpu.vertexNodeState = nodeState;
    gpu.vertexGeometry = geometry;
    gpu.vertexGeometryBindings = geometry.bindingsVersion;
    trackGeometry(state, geometry);
}

/** Get geometry and buffer memory statistics */
export function getGeometriesStats(state: GeometriesState): {
    geometries: number;
} {
    return { geometries: state.memory.geometries };
}
