import type { Geometry } from '../../geometry/geometry';
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
export declare function createGeometriesState(): GeometriesState;
/**
 * Resolves into `gpu` the buffers a draw of `renderObject` binds, in vertex slot order, with the names
 * they upload under. Resolved against its compile and its geometry's buffer set, and kept until either
 * moves, so a draw only checks each buffer's version rather than looking it up again.
 */
export declare function resolveVertexBuffers(state: GeometriesState, gpu: RenderObjectGpu, renderObject: RenderObject): void;
/** Get geometry and buffer memory statistics */
export declare function getGeometriesStats(state: GeometriesState): {
    geometries: number;
};
