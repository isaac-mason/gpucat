import { computeId, Node } from './core';
import type { Any } from '../schema';
import * as d from '../schema';

export type BuiltinKind = 'instance_index' | 'instance_data' |
    'vertex_index' | 'global_invocation_id' | 'local_invocation_id' |
    'local_invocation_index' | 'workgroup_id' | 'num_workgroups' |
    'position';

export class BuiltinNode<D extends Any> extends Node<D> {
    constructor(
        readonly builtinKind: BuiltinKind,
        desc: D
    ) {
        super(computeId('builtin', { builtinKind, type: desc.wgslType }), desc);
    }
}

export const builtin = <D extends Any>(builtinKind: BuiltinKind, desc: D) => new BuiltinNode(builtinKind, desc);

/** @builtin(instance_index) — the instance index for instanced draw calls. */
export const instanceIndex: BuiltinNode<d.u32> = /*@__PURE__*/ builtin('instance_index', d.u32);

/** @builtin(vertex_index) — the vertex index in the current draw call. */
export const vertexIndex: BuiltinNode<d.u32> = /*@__PURE__*/ builtin('vertex_index', d.u32);

/** @builtin(global_invocation_id) — unique thread ID across the entire dispatch. */
export const globalId: BuiltinNode<d.vec3u> = /*@__PURE__*/ builtin('global_invocation_id', d.vec3u);

/** @builtin(local_invocation_id) — thread ID within its workgroup. */
export const localId: BuiltinNode<d.vec3u> = /*@__PURE__*/ builtin('local_invocation_id', d.vec3u);

/** @builtin(local_invocation_index) — flat 1-D index within the workgroup. */
export const localIndex: BuiltinNode<d.u32> = /*@__PURE__*/ builtin('local_invocation_index', d.u32);

/** @builtin(workgroup_id) — workgroup coordinate in the dispatch grid. */
export const workgroupId: BuiltinNode<d.vec3u> = /*@__PURE__*/ builtin('workgroup_id', d.vec3u);

/** @builtin(num_workgroups) — total number of workgroups dispatched. */
export const numWorkgroups: BuiltinNode<d.vec3u> = /*@__PURE__*/ builtin('num_workgroups', d.vec3u);

/**
 * Fragment position in window/pixel coordinates.
 * @builtin(position) in the fragment shader — vec4f where xy are pixel coordinates.
 *
 * This is the raw fragment coordinate from the rasterizer.
 * Use screenCoordinate.xy for 2D pixel position.
 */
export const fragCoord: BuiltinNode<d.vec4f> = /*@__PURE__*/ builtin('position', d.vec4f);

/**
 * Linearized compute invocation index across the entire dispatch grid.
 * 
 * For a dispatch of size (Dx, Dy, Dz) workgroups with workgroup size (Wx, Wy, Wz),
 * this computes:
 *   globalId.x + globalId.y * (Wx * Dx) + globalId.z * (Wx * Dx) * (Wy * Dy)
 * 
 * This gives each thread a unique u32 index from 0 to (Dx*Wx * Dy*Wy * Dz*Wz - 1).
 * 
 * Use this in compute shaders where you need a linear index into a buffer,
 * similar to how instanceIndex works in vertex shaders.
 */
export class ComputeIndexNode extends Node<d.u32> {
    constructor() {
        super(computeId('compute_index', {}), d.u32);
    }
}

export const computeIndex: ComputeIndexNode = /*@__PURE__*/ new ComputeIndexNode();
