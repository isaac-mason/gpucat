/**
 * compute-node.ts — ComputeNode and factory function.
 *
 * A ComputeNode describes a single @compute dispatch: its workgroup size,
 * dispatch dimensions, storage buffers, and the JS body callback that is
 * traced at compile time to produce the WGSL body.
 *
 * Usage:
 *   const updateParticles = compute({ ... });
 *   await renderer.compile(updateParticles);
 *
 *   function frame() {
 *       renderer.compute(updateParticles);
 *       renderer.render(outputNode);
 *       requestAnimationFrame(frame);
 *   }
 */

import {
    StackNode,
    type StorageNode,
    type WgslType,
} from './nodes.js';
import { builtin, type BuiltinNode } from './nodes.js';

// ---------------------------------------------------------------------------
// Monotonic counter — ComputeNode uses a stable monotonic ID (not content-
// addressed) because two identical-looking compute shaders are always distinct.
// ---------------------------------------------------------------------------

let _computeCounter = 0;

// ---------------------------------------------------------------------------
// ComputeBuiltins — passed to the body callback
// ---------------------------------------------------------------------------

export type ComputeBuiltins = {
    readonly globalId: BuiltinNode<'vec3u'>;
    readonly localId: BuiltinNode<'vec3u'>;
    readonly localIndex: BuiltinNode<'u32'>;
    readonly workgroupId: BuiltinNode<'vec3u'>;
    readonly numWorkgroups: BuiltinNode<'vec3u'>;
};

// ---------------------------------------------------------------------------
// ComputeNodeOptions
// ---------------------------------------------------------------------------

export type ComputeNodeOptions = {
    /**
     * Workgroup size tuple [x, y, z].
     * Defaults to [64, 1, 1].
     */
    workgroupSize?: [number, number, number];
    /**
     * Dispatch dimensions [x, y, z] — number of workgroups to dispatch.
     * Trailing 1s may be omitted: [N] = [N, 1, 1], [N, M] = [N, M, 1].
     */
    dispatch: [number, number, number] | [number, number] | [number];
    /**
     * Storage buffers read or written by this compute shader.
     * These are bound at group 0, binding 0, 1, … in the compute pass.
     */
    storage: StorageNode<WgslType>[];
    /**
     * Body callback — called once during compilation (tracing).
     * Use the DSL (toVar, If, For, assign, etc.) inside. The builtins argument
     * provides @builtin nodes for the compute shader entry point.
     */
    body: (builtins: ComputeBuiltins) => void;
};

// ---------------------------------------------------------------------------
// ComputeNode
// ---------------------------------------------------------------------------

/**
 * A plain (non-Node) object representing a single WebGPU compute dispatch.
 *
 * Use `renderer.compile(node)` to pre-warm the pipeline, then call
 * `renderer.compute(node)` each frame to encode the dispatch.
 */
export class ComputeNode {
    /** Stable monotonic ID — unique per instance. */
    readonly id: string;
    readonly workgroupSize: [number, number, number];
    readonly dispatch: [number, number, number];
    /** Storage buffers bound to this compute shader (group 0, bindings 0, 1, …). */
    readonly storage: StorageNode<WgslType>[];
    readonly body: (builtins: ComputeBuiltins) => void;

    constructor(opts: ComputeNodeOptions) {
        this.id = `_compute_${_computeCounter++}`;
        this.workgroupSize = opts.workgroupSize ?? [64, 1, 1];
        // Normalise dispatch to always be a 3-tuple.
        const d = opts.dispatch;
        this.dispatch = [d[0], d[1] ?? 1, d[2] ?? 1];
        this.storage = opts.storage;
        this.body = opts.body;
    }

    /**
     * Trace the body callback with fresh builtin nodes and a fresh StackNode.
     * Returns the traced StackNode (the compute body statements).
     * Called once by compileCompute() — do not call more than once per instance.
     */
    trace(): { builtins: ComputeBuiltins; body: StackNode } {
        const builtins: ComputeBuiltins = {
            globalId:      builtin('global_invocation_id',   'vec3u'),
            localId:       builtin('local_invocation_id',    'vec3u'),
            localIndex:    builtin('local_invocation_index', 'u32'),
            workgroupId:   builtin('workgroup_id',           'vec3u'),
            numWorkgroups: builtin('num_workgroups',         'vec3u'),
        };

        const stack = new StackNode();
        _traceComputeBody(stack, () => this.body(builtins));

        return { builtins, body: stack };
    }
}

// ---------------------------------------------------------------------------
// _traceComputeBody — thin shim to drive tracing with an external stack.
// ---------------------------------------------------------------------------

import { FnNode, type ConstNode } from './nodes.js';
import { konst } from './nodes.js';

function _traceComputeBody(stack: StackNode, body: () => void): void {
    const fn = new FnNode<'void'>(
        'void',
        [],
        (): ConstNode<'void'> => {
            body();
            return konst('u32', 0) as unknown as ConstNode<'void'>;
        },
    );

    const traced = fn.trace();
    for (const stmt of traced.body.body) {
        stack.push(stmt);
    }
}

// ---------------------------------------------------------------------------
// compute() — factory function
// ---------------------------------------------------------------------------

/**
 * Create a ComputeNode.
 *
 * @example
 * const particles = storageArray(N, S.array(S.vec4f()), 'read_write');
 *
 * const updateParticles = compute({
 *     workgroupSize: [64, 1, 1],
 *     dispatch: [Math.ceil(N / 64)],
 *     storage: [particles],
 *     body: ({ globalId }) => {
 *         const idx = toVar('u32', globalId.x, 'idx');
 *         const pos = toVar('vec4f', index('vec4f', particles, idx), 'pos');
 *         // ... update pos ...
 *         index('vec4f', particles, idx).assign(pos);
 *     },
 * });
 */
export function compute(opts: ComputeNodeOptions): ComputeNode {
    return new ComputeNode(opts);
}
