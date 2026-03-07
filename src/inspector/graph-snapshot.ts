/**
 * graph-snapshot.ts — Data types for the inspector Graph tab.
 *
 * A GraphSnapshot is a self-contained, serialisable description of a compiled
 * material node graph. It is produced once per compile (in render-objects.ts)
 * and consumed by the Graph tab (tabs/graph.ts) for layout and rendering.
 *
 * *** Isolation contract ***
 * All graph-tab code is isolated behind this type file. To remove the Graph tab
 * entirely, delete:
 *   - graph-snapshot.ts         (this file)
 *   - graph-layout.ts
 *   - tabs/graph.ts
 *   - The three `// [graph-tab]` comment-marked lines in:
 *       - inspector-base.ts
 *       - renderer-inspector.ts
 *       - render-objects.ts
 *       - inspector.ts
 */

import type { Node, NodeKind, WgslType } from '../nodes/nodes';
import type { NodeGraphInfo } from '../nodes/node-builder';

// Re-export NodeGraphInfo so consumers only import from graph-snapshot.ts.
export type { NodeGraphInfo };

// ---------------------------------------------------------------------------
// GraphSnapshot
// ---------------------------------------------------------------------------

/** One compiled material graph, ready for the Graph tab to display. */
export type GraphSnapshot = {
    /**
     * Human-readable label for the dropdown selector.
     * Currently the render-object cache key; improved to mesh name in future.
     */
    label: string;

    /** Every node visited by the compiler's setup pass for this material. */
    allNodes: ReadonlyMap<string, Node<WgslType>>;

    /**
     * DAG edges: nodeId → ids of its children (data flows from child to parent).
     * Only nodes that have ≥1 child appear as keys.
     */
    edges: ReadonlyMap<string, readonly string[]>;

    /**
     * Per-node compiler metadata: stages, CSE var name, usage count, expression.
     * Populated from the compiler's analyze + generate pass data.
     */
    info: ReadonlyMap<string, NodeGraphInfo>;

    /** IDs of nodes marked with .inspect() — highlighted in the graph. */
    inspectableIds: ReadonlySet<string>;
};

// ---------------------------------------------------------------------------
// Helpers — kind grouping for colour coding
// ---------------------------------------------------------------------------

export type NodeKindGroup =
    | 'input'       // const, uniform, attribute, buffer_attribute, builtin
    | 'resource'    // storage, texture, sampler
    | 'math'        // binop, call, construct, convert, cond
    | 'flow'        // stack, if, for, while, break, continue, return, fn, wgsl_fn
    | 'variable'    // var, assign, param
    | 'connector'   // varying, field, index, wgsl
    | 'output'      // output_struct
    | 'inspector';  // inspector

export function nodeKindGroup(kind: NodeKind): NodeKindGroup {
    switch (kind) {
        case 'const':
        case 'uniform':
        case 'attribute':
        case 'buffer_attribute':
        case 'builtin':
            return 'input';

        case 'storage':
        case 'texture':
        case 'sampler':
            return 'resource';

        case 'binop':
        case 'call':
        case 'construct':
        case 'convert':
        case 'cond':
            return 'math';

        case 'stack':
        case 'if':
        case 'loop':
        case 'fn':
        case 'wgsl_fn':
        case 'break':
        case 'continue':
        case 'return':
            return 'flow';

        case 'var':
        case 'assign':
        case 'param':
            return 'variable';

        case 'varying':
        case 'subBuild':
        case 'field':
        case 'index':
        case 'wgsl':
        case 'struct':
        case 'expression':
            return 'connector';

        case 'output_struct':
            return 'output';

        case 'inspector':
            return 'inspector';

        default: {
            const _exhaustive: never = kind;
            void _exhaustive;
            return 'math';
        }
    }
}

export const KIND_GROUP_COLORS: Record<NodeKindGroup, { fill: string; stroke: string; text: string }> = {
    input:     { fill: '#1a2d4a', stroke: '#3a6da0', text: '#7ab8f5' },
    resource:  { fill: '#2a1a3a', stroke: '#7a3a9a', text: '#c97af5' },
    math:      { fill: '#1a2a1a', stroke: '#3a7a3a', text: '#7af57a' },
    flow:      { fill: '#2a2a1a', stroke: '#8a7a20', text: '#f5d07a' },
    variable:  { fill: '#2a1a1a', stroke: '#8a3a3a', text: '#f57a7a' },
    connector: { fill: '#1a2a2a', stroke: '#2a7a7a', text: '#7af5f5' },
    output:    { fill: '#2a1a1a', stroke: '#aa4400', text: '#ff8855' },
    inspector: { fill: '#2a2000', stroke: '#c87a00', text: '#f5c040' },
};
