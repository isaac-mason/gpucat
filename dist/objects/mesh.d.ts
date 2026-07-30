import { Object3D } from '../core/object3d';
import type { Geometry } from '../geometry/geometry';
import type { Material } from '../material/material';
import { type Intersection, type Raycaster } from '../math/raycaster';
/**
 * One sub-draw of a batched mesh — a plain draw command over the mesh's (typically merged)
 * geometry. Field-for-field the WebGPU `GPUDrawIndexedIndirect` arg struct.
 *
 * When a `Mesh` has `draws` set, the renderer loops these instead of the single
 * `drawRange` + `count` draw. Per-instance data is expected to live in data textures indexed
 * by `instanceIndex` (which is base-inclusive: `firstInstance + gl_InstanceID` on WebGL,
 * native `instance_index` on WebGPU).
 *
 * Phase 1: indexed geometry only.
 */
export type MeshDraw = {
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
/** `u32`s per packed sub-draw (the `DrawIndexedIndirect` layout: indexCount, instanceCount, firstIndex, baseVertex, firstInstance). */
export declare const MESH_DRAW_STRIDE = 5;
/**
 * Pack a `MeshDraw[]` into the WebGPU `DrawIndexedIndirect` byte layout — 5 × `u32` per draw:
 * `[indexCount, instanceCount, firstIndex, baseVertex, firstInstance]`. The result is directly
 * uploadable as a GPU indirect buffer (WebGPU `drawIndexedIndirect`) or consumable by a WebGL
 * multi-draw path, with zero reshaping — same shape as `DrawIndexedIndirect` (`draw-indirect.ts`).
 */
export declare function packDraws(draws: MeshDraw[]): Uint32Array;
export declare class Mesh extends Object3D {
    readonly isMesh = true;
    geometry: Geometry;
    material: Material;
    count: number;
    /**
     * Optional batched draw list. When set, the renderer issues one instanced draw per entry
     * (a CPU loop) instead of the single `drawRange` + `count` draw, and `count`/`drawRange`
     * are ignored. All entries share this mesh's `geometry` + `material` (one pipeline). An
     * empty array draws nothing. Phase 1: requires indexed geometry.
     */
    draws?: MeshDraw[];
    frustumCulled: boolean;
    constructor(geometry: Geometry, material: Material);
    raycast(raycaster: Raycaster, intersects: Intersection[]): void;
}
