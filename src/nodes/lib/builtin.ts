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
