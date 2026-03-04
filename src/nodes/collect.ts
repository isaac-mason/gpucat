/**
 * collect.ts — Graph walk utilities.
 *
 * Functions here are pure: they take node objects and return plain data.
 * No GPU calls, no side effects.
 */

import type {
    AssignNode,
    BinopNode,
    CallNode,
    CondNode,
    ConstructNode,
    FieldNode,
    FnNode,
    ForNode,
    IfNode,
    IndexNode,
    Node,
    RawNode,
    ReturnNode,
    StackNode,
    VarNode,
    WhileNode,
    WgslType,
} from './nodes.js';

// ---------------------------------------------------------------------------
// getChildren — returns direct dependency nodes for any node kind
// ---------------------------------------------------------------------------

/**
 * Returns the immediate dependency nodes of `node`.
 * The returned array is in the order they should be visited (left-to-right).
 */
export function getChildren(node: Node<WgslType>): Node<WgslType>[] {
    switch (node.kind) {
        case 'const':
        case 'uniform':
        case 'attribute':
        case 'instanced_buffer_attribute':
        case 'storage':
        case 'texture':
        case 'sampler':
        case 'builtin':
            return [];

        case 'varying': {
            // A VaryingNode is a fragment-stage leaf — it reads from the interpolated input struct.
            // Its `.source` is vertex-side only; the compiler handles it separately via
            // findVaryingNodeByName. Do NOT traverse source here or it would pull vertex-only
            // nodes (attributes, instanced attributes) into the fragment graph.
            return [];
        }

        case 'binop': {
            const n = node as BinopNode<WgslType>;
            return [n.left, n.right];
        }

        case 'call': {
            const n = node as CallNode<WgslType>;
            return n.args;
        }

        case 'raw': {
            const n = node as RawNode<WgslType>;
            return n.deps;
        }

        case 'assign': {
            const n = node as AssignNode;
            return [n.target, n.value];
        }

        case 'construct': {
            const n = node as ConstructNode<WgslType>;
            return n.args;
        }

        case 'struct':
            return [];

        case 'field': {
            const n = node as FieldNode<WgslType>;
            return [n.object];
        }

        case 'index': {
            const n = node as IndexNode<WgslType>;
            return [n.array, n.index];
        }

        case 'stack': {
            const n = node as StackNode;
            return n.body;
        }

        case 'cond': {
            const n = node as CondNode<WgslType>;
            return n.ifFalse !== undefined ? [n.condition, n.ifTrue, n.ifFalse] : [n.condition, n.ifTrue];
        }

        case 'var': {
            const n = node as VarNode<WgslType>;
            return [n.init];
        }

        case 'if': {
            const n = node as IfNode;
            const deps: Node<WgslType>[] = [n.condition, n.thenBody];
            if (n.elseBody !== null) deps.push(n.elseBody);
            return deps;
        }

        case 'for': {
            const n = node as ForNode;
            const deps: Node<WgslType>[] = [n.indexVar, n.body];
            if (n.range.start !== undefined && typeof n.range.start !== 'number') deps.push(n.range.start);
            if (n.range.end !== undefined && typeof n.range.end !== 'number') deps.push(n.range.end);
            if (n.range.update !== undefined && typeof n.range.update !== 'number') deps.push(n.range.update as Node<WgslType>);
            return deps;
        }

        case 'while': {
            const n = node as WhileNode;
            return [n.condition, n.body];
        }

        case 'break':
        case 'continue':
            return [];

        case 'param':
            // Parameters have no deps — they are leaf nodes (placeholders).
            return [];

        case 'return': {
            const n = node as ReturnNode<WgslType>;
            return [n.value];
        }

        case 'fn': {
            // FnNode itself has no deps in the call graph — the compiler traces it
            // separately. CallNodes referencing this fn carry the deps via their args.
            const _n = node as FnNode<WgslType>;
            void _n;
            return [];
        }

        default: {
            // exhaustive check — TypeScript will error if a case is missing
            const _exhaustive: never = node.kind;
            return _exhaustive;
        }
    }
}

// ---------------------------------------------------------------------------
// collectGraph — full reachable subgraph from a root node
// ---------------------------------------------------------------------------

export type NodeGraph = {
    /** All reachable nodes keyed by their content-addressed ID. */
    readonly nodes: ReadonlyMap<string, Node<WgslType>>;
    /** The root node's ID. */
    readonly rootId: string;
};

/**
 * Walks the graph depth-first from `root`, collecting all reachable nodes.
 * Returns a map of id → node and the root id.
 */
export function collectGraph(root: Node<WgslType>): NodeGraph {
    const nodes = new Map<string, Node<WgslType>>();

    function walk(node: Node<WgslType>): void {
        if (nodes.has(node.id)) return;
        nodes.set(node.id, node);
        for (const dep of getChildren(node)) {
            walk(dep);
        }
    }

    walk(root);
    return { nodes, rootId: root.id };
}

/**
 * Merges multiple graphs into one (for compiling vertex + fragment together).
 * Duplicate nodes (same id) are deduplicated — only one copy is kept.
 */
export function mergeGraphs(...graphs: NodeGraph[]): Map<string, Node<WgslType>> {
    const merged = new Map<string, Node<WgslType>>();
    for (const g of graphs) {
        for (const [id, node] of g.nodes) {
            if (!merged.has(id)) merged.set(id, node);
        }
    }
    return merged;
}

/**
 * @deprecated Use `getChildren` instead.
 * Kept as an alias for backward compatibility with existing code and tests.
 */
export const depsOf = getChildren;
