/**
 * collect.ts — Graph walk, topological sort, and ref counting.
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
// depsOf — returns direct dependency nodes for any node kind
// ---------------------------------------------------------------------------

/**
 * Returns the immediate dependency nodes of `node`.
 * The returned array is in the order they should be visited (left-to-right).
 */
export function depsOf(node: Node<WgslType>): Node<WgslType>[] {
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
        for (const dep of depsOf(node)) {
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

// ---------------------------------------------------------------------------
// topoSort — Kahn's algorithm
// ---------------------------------------------------------------------------

/**
 * Returns node IDs in topological evaluation order (all deps before dependents).
 * `nodes` should be the full reachable subgraph (from collectGraph).
 * `rootId` is used to anchor the traversal but Kahn's algorithm processes all nodes.
 *
 * Throws if a cycle is detected (shouldn't happen with content-addressed IDs
 * since cycles would require a node to hash its own ID before it exists).
 */
export function topoSort(nodes: ReadonlyMap<string, Node<WgslType>>, rootId: string): string[] {
    // In Kahn's algorithm:
    //   in-degree[X] = number of nodes that have X as a direct dependency
    //   (i.e. number of nodes that "point to" X, meaning X must come before them)
    //
    // Nodes with in-degree 0 have no dependents — they are safe to emit first (leaves).
    // Each time we emit a node, we decrement the in-degree of every node that depends on it.
    //
    // We also build a reverse-edge map: dep → [nodes that use dep] for O(1) neighbour lookup.

    const inDegree = new Map<string, number>();
    // dependents[id] = list of node IDs that list `id` as a direct dep
    const dependents = new Map<string, string[]>();

    for (const id of nodes.keys()) {
        inDegree.set(id, 0);
        dependents.set(id, []);
    }

    // For each node, increment in-degree of each of its deps' dependents
    // i.e. "node X depends on dep D" → D is referenced by X → X's count goes up
    for (const [id, node] of nodes) {
        for (const dep of depsOf(node)) {
            if (!nodes.has(dep.id)) continue;
            // dep must come before id, so id's in-degree increases
            inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
            dependents.get(dep.id)!.push(id);
        }
    }

    // Seed queue with nodes that have no deps (can be emitted immediately)
    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
        if (deg === 0) queue.push(id);
    }

    const sorted: string[] = [];

    while (queue.length > 0) {
        const id = queue.shift()!;
        sorted.push(id);
        // For each node that depends on the just-emitted node, decrement its in-degree
        for (const dependentId of dependents.get(id) ?? []) {
            const deg = (inDegree.get(dependentId) ?? 0) - 1;
            inDegree.set(dependentId, deg);
            if (deg === 0) queue.push(dependentId);
        }
    }

    if (sorted.length !== nodes.size) {
        throw new Error(`topoSort: cycle detected in node graph (sorted ${sorted.length} of ${nodes.size} nodes)`);
    }

    // The root should naturally end up last (highest reverse-dep depth).
    // If for some reason it doesn't (e.g. isolated sub-graphs), move it to the end.
    const rootIdx = sorted.indexOf(rootId);
    if (rootIdx !== -1 && rootIdx !== sorted.length - 1) {
        sorted.splice(rootIdx, 1);
        sorted.push(rootId);
    }

    return sorted;
}

// ---------------------------------------------------------------------------
// refCount — how many times each node is referenced
// ---------------------------------------------------------------------------

/**
 * Returns a map of node id → reference count within the subgraph.
 * Nodes with count > 1 should be extracted to `let` bindings by the compiler
 * to avoid duplicating work.
 */
export function refCount(nodes: ReadonlyMap<string, Node<WgslType>>): Map<string, number> {
    const counts = new Map<string, number>();

    for (const id of nodes.keys()) {
        counts.set(id, 0);
    }

    for (const node of nodes.values()) {
        for (const dep of depsOf(node)) {
            if (counts.has(dep.id)) {
                counts.set(dep.id, (counts.get(dep.id) ?? 0) + 1);
            }
        }
    }

    return counts;
}
