import { Object3D } from '../core/object3d';
import type { Geometry } from '../geometry/geometry';
import type { Material } from '../material/material';
import { type Intersection, type Raycaster } from '../math/raycaster';
/**
 * One sub-draw of a batched mesh: a plain instanced draw command over the mesh's (typically
 * merged) geometry, field-for-field a WebGPU indirect-draw arg struct. The mesh's geometry selects
 * the variant: indexed geometry uses {@link IndexedMeshDraw} (`GPUDrawIndexedIndirect`),
 * non-indexed uses {@link NonIndexedMeshDraw} (`GPUDrawIndirect`).
 *
 * When a `Mesh` has `draws` set, the renderer loops these instead of the single `drawRange` +
 * `count` draw. Per-instance data is expected to live in data textures indexed by `instanceIndex`
 * (base-inclusive: `firstInstance + gl_InstanceID` on WebGL, native `instance_index` on WebGPU).
 */
export type IndexedMeshDraw = {
    /** Indices to draw from the (merged) index buffer. */
    indexCount: number;
    /** Instances for this sub-draw (may differ per entry). `<= 0` skips the entry. */
    instanceCount: number;
    /** Offset into the index buffer, in ELEMENTS (converted to bytes at the WebGL call). */
    firstIndex: number;
    /** Base into the instance-index space; `instanceIndex` reads back `firstInstance + local`. */
    firstInstance: number;
    /** Added to each index before vertex fetch. WebGPU-only; ignored on WebGL2 (defaults 0). */
    baseVertex?: number;
};
/** Non-indexed batched sub-draw: the `GPUDrawIndirect` arg struct, used when the mesh's geometry has no index buffer. */
export type NonIndexedMeshDraw = {
    /** Vertices to draw from the (merged) vertex buffer(s). */
    vertexCount: number;
    /** Instances for this sub-draw (may differ per entry). `<= 0` skips the entry. */
    instanceCount: number;
    /** Offset of the first vertex. */
    firstVertex: number;
    /** Base into the instance-index space; `instanceIndex` reads back `firstInstance + local`. */
    firstInstance: number;
};
/** One batched sub-draw; the variant matches the mesh's geometry (indexed vs non-indexed). */
export type MeshDraw = IndexedMeshDraw | NonIndexedMeshDraw;
export declare class Mesh extends Object3D {
    readonly isMesh = true;
    geometry: Geometry;
    material: Material;
    count: number;
    /**
     * Optional batched draw list. When set, the renderer issues one instanced draw per entry
     * (a CPU loop) instead of the single `drawRange` + `count` draw, and `count`/`drawRange`
     * are ignored. All entries share this mesh's `geometry` + `material` (one pipeline). An
     * empty array draws nothing. Entries must match the mesh's geometry (indexed vs non-indexed).
     */
    draws?: MeshDraw[];
    frustumCulled: boolean;
    constructor(geometry: Geometry, material: Material);
    raycast(raycaster: Raycaster, intersects: Intersection[]): void;
}
