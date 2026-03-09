import { computeId, type WgslType, Node } from './core';

export type BuiltinKind = 'instance_index' | 'instance_data' |
    'vertex_index' | 'global_invocation_id' | 'local_invocation_id' |
    'local_invocation_index' | 'workgroup_id' | 'num_workgroups' |
    'position';

export class BuiltinNode<T extends WgslType> extends Node<T> {
    constructor(
        readonly builtinKind: BuiltinKind,
        type: T
    ) {
        super(computeId('builtin', { builtinKind, type }), type);
    }
}

export const builtin = <T extends WgslType>(builtinKind: BuiltinKind, type: T) => new BuiltinNode(builtinKind, type);

/** @builtin(instance_index) — the instance index for instanced draw calls. */
export const instanceIndex: BuiltinNode<'u32'> = /*@__PURE__*/ builtin('instance_index', 'u32');

/** @builtin(vertex_index) — the vertex index in the current draw call. */
export const vertexIndex: BuiltinNode<'u32'> = /*@__PURE__*/ builtin('vertex_index', 'u32');

/** @builtin(global_invocation_id) — unique thread ID across the entire dispatch. */
export const globalId: BuiltinNode<'vec3u'> = /*@__PURE__*/ builtin('global_invocation_id', 'vec3u');

/** @builtin(local_invocation_id) — thread ID within its workgroup. */
export const localId: BuiltinNode<'vec3u'> = /*@__PURE__*/ builtin('local_invocation_id', 'vec3u');

/** @builtin(local_invocation_index) — flat 1-D index within the workgroup. */
export const localIndex: BuiltinNode<'u32'> = /*@__PURE__*/ builtin('local_invocation_index', 'u32');

/** @builtin(workgroup_id) — workgroup coordinate in the dispatch grid. */
export const workgroupId: BuiltinNode<'vec3u'> = /*@__PURE__*/ builtin('workgroup_id', 'vec3u');

/** @builtin(num_workgroups) — total number of workgroups dispatched. */
export const numWorkgroups: BuiltinNode<'vec3u'> = /*@__PURE__*/ builtin('num_workgroups', 'vec3u');

/**
 * Fragment position in window/pixel coordinates.
 * @builtin(position) in the fragment shader — vec4f where xy are pixel coordinates.
 *
 * This is the raw fragment coordinate from the rasterizer.
 * Use screenCoordinate.xy for 2D pixel position.
 */
export const fragCoord: BuiltinNode<'vec4f'> = /*@__PURE__*/ builtin('position', 'vec4f');
