# Fix: PassNode updateBefore ownership

## Problem

When a `PassTextureNode` (or `PassMultipleTextureNode`) is used in a material, the **texture node itself** gets registered as the `updateBefore` node during compilation. This is wrong for two reasons:

1. **Double renders**: If the same PassNode produces multiple texture outputs (e.g. `pass.getTextureNode('output')` + `pass.getTextureNode('depth')`), each `PassMultipleTextureNode` is a separate object with a separate `id`. The `NodeFrame.updateBeforeNode()` deduplicates by node identity, so each one triggers a separate call to `passNode.updateBefore()`, rendering the inner scene multiple times per frame.

2. **Wrong responsibility**: The texture node is a data accessor. The PassNode owns the render lifecycle. In Three.js, `PassTextureNode` has no `updateBeforeType` at all — `PassNode` is the sole updateBefore node.

## Root cause

`PassNode` (which has `updateBeforeType = 'frame'` and the actual `updateBefore()` logic) is never reachable during graph traversal. Here's why:

- The user's graph contains `PassTextureNode` (from `pass.getTextureNode()`).
- `getChildren(PassTextureNode)` returns `bindingNode`, `samplerNode`, `uvNode`, etc. — the `TextureNode` branch. It does NOT return `passNode`.
- `getChildren(PassNode)` returns the `PassTextureNode` — but that edge only exists when `PassNode` itself is a root. In a render-to-texture-in-material scenario, `PassNode` is never a root.
- So `discover()` never visits `PassNode`, never sees its `updateBeforeType = 'frame'`.

The current workaround puts `updateBeforeType = 'frame'` on `PassTextureNode` instead and delegates `updateBefore()` to `passNode`. This is wrong (see problem #1 and #2 above).

## How Three.js discovers PassNode

Three.js does NOT use `_beforeNodes` for this. Here's the actual mechanism:

1. `PassTextureNode.setup(builder)` stashes `this.passNode` into `builder.getNodeProperties(this)`:
   ```js
   setup(builder) {
       const properties = builder.getNodeProperties(this);
       properties.passNode = this.passNode;  // <-- key line
       return super.setup(builder);
   }
   ```

2. In `Node.build()`, after `setup()` runs, the builder iterates ALL values in `properties` and recursively builds any that are nodes:
   ```js
   properties.outputNode = this.setup(builder) || ...;
   for (const childNode of Object.values(properties)) {
       if (childNode && childNode.isNode === true) {
           childNode.build(builder);  // <-- PassNode.build() gets called here
       }
   }
   ```

3. When `PassNode.build()` runs, `builder.addSequentialNode(this)` is called. Since `PassNode.updateBeforeType === FRAME`, it gets added to `sequentialNodes`.

4. Later, `buildUpdateNodes()` moves all `sequentialNodes` with `updateBeforeType !== NONE` into `updateBeforeNodes`.

So Three.js discovers PassNode through the `setup()` → properties → recursive build pipeline. Every node that gets `build()`'d has `addSequentialNode` called, which checks `updateBeforeType`.

gpucat doesn't have Three.js's `setup()` / properties / recursive build mechanism. Our equivalent is `discover()` + `getChildren()`. We need a way to make `PassNode` reachable in our graph.

## Plan

### Principle: make the graph truthful, collect updateBefore generically

No special-casing for PassNode. The fix uses infrastructure that already exists on the base `Node` class:

- `Node._beforeNodes: Node<Any>[] | null` (core.ts:120)
- `Node.before(node)` method (core.ts:142-146)

Three.js has this same mechanism but doesn't use it for PassNode (it uses `setup()` instead). Since we don't have `setup()`, `_beforeNodes` is the right tool.

The fix is:
1. Make `PassNode` reachable in the graph via `_beforeNodes`.
2. Wire `_beforeNodes` into `getChildren()` so `discover()` traverses them.
3. Teach `discover()` to collect ALL nodes with `updateBeforeType !== 'none'`.
4. Remove the ad-hoc updateBefore registration from code generation.

### 1. `getChildren()` in `builder.ts` — include `_beforeNodes` for ALL nodes

`getChildren()` should include `_beforeNodes` for every node type. This is fully generic — no knowledge of PassNode.

At the TOP of `getChildren`, before the type-specific branches:
```ts
function getChildren(node: Node<d.Any>): Node<d.Any>[] {
    const children: Node<d.Any>[] = [];

    // _beforeNodes are dependencies that must be processed before this node.
    // They're part of the graph but don't generate sub-expressions for this node.
    if (node._beforeNodes) {
        children.push(...node._beforeNodes);
    }

    if (node instanceof BinopNode) {
    // ... rest unchanged
```

This creates a cycle: `PassTextureNode → PassNode → PassTextureNode`. This is safe:
- **`discover()`** has a `visited` set — the cycle terminates immediately.
- **`generateExpr()`** does NOT walk `getChildren`. It generates code based on node-type-specific logic. `PassNode`'s `generateExpr` delegates to its texture node, and `TextureNode`'s `generateExpr` does NOT call `generateExpr` on `_beforeNodes`. No infinite recursion.

### 2. `PassTextureNode` constructor — register passNode as a before-dependency

In the `PassTextureNode` constructor, call `this.before(passNode)`. This declares: "passNode must be discovered/processed before me."

```ts
constructor(passNode: PassNode, texture: Texture | null = null, textureId?: string) {
    const id = textureId ?? `_pass${passNode.passId}_output`;
    const bindingNode = new TextureBindingNode(d.texture2d(), id, objectGroup);
    super(bindingNode);
    this.passNode = passNode;
    this.before(passNode);
    // ...
}
```

### 3. Remove `updateBeforeType` and `updateBefore()` from `PassTextureNode`

**DONE** — already applied. `PassTextureNode` no longer has `updateBeforeType` or `updateBefore()`.

### 4. `discover()` — collect updateBefore/updateAfter/update nodes

Add three new collections to `DiscoverResult`:

```ts
interface DiscoverResult {
    // ... existing fields ...
    updateBeforeNodes: UpdateBeforeNode[];
    updateAfterNodes: UpdateAfterNode[];
    updateNodes: UpdateNode[];
}
```

In the `visit()` function, after adding to `allNodes`:

```ts
// collect update lifecycle nodes
if (node.updateBeforeType !== 'none' && (node as any).updateBefore) {
    const beforeNode = node as unknown as UpdateBeforeNode;
    if (!updateBeforeNodes.find(n => n.id === beforeNode.id)) {
        updateBeforeNodes.push(beforeNode);
    }
}
if (node.updateAfterType !== 'none' && (node as any).updateAfter) {
    const afterNode = node as unknown as UpdateAfterNode;
    if (!updateAfterNodes.find(n => n.id === afterNode.id)) {
        updateAfterNodes.push(afterNode);
    }
}
if (node.updateType !== 'none' && (node as any).update) {
    const updateNode = node as unknown as UpdateNode;
    if (!updateNodes.find(n => n.id === updateNode.id)) {
        updateNodes.push(updateNode);
    }
}
```

This is completely generic. Any node in the graph with `updateBeforeType !== 'none'` gets registered. `PassNode` will now be found because it's reachable via `_beforeNodes`.

We check for the method too (`(node as any).updateBefore`) because the base `Node` class sets `updateBeforeType = 'none'` by default — but if someone overrides `updateBeforeType` without providing the method, we shouldn't register it.

### 5. Remove ad-hoc updateBefore/update registration from code generation

In `generateTexture()` (builder.ts ~line 1121-1139), remove both the `updateNodes` and `updateBeforeNodes` registration blocks.

Also remove the `updateNodes` registration from `generateUniform()` (~line 1042-1048) — these are now handled by `discover()`.

### 6. Wire discovered collections into compile results

In `compileMaterial()`, instead of merging from vertex/fragment contexts:

Before:
```ts
updateBeforeNodes: [...vertexCtx.updateBeforeNodes, ...fragmentCtx.updateBeforeNodes],
updateAfterNodes: [...vertexCtx.updateAfterNodes, ...fragmentCtx.updateAfterNodes],
updateNodes: [...vertexCtx.updateNodes, ...fragmentCtx.updateNodes],
```

After:
```ts
updateBeforeNodes: discovered.updateBeforeNodes,
updateAfterNodes: discovered.updateAfterNodes,
updateNodes: discovered.updateNodes,
```

The `BuildContext` type no longer needs `updateBeforeNodes`, `updateAfterNodes`, or `updateNodes` fields. They can be removed from `createContext()`.

## Why this is correct

1. **No special-casing**: `getChildren` includes `_beforeNodes` for ALL nodes. `discover()` collects ALL updateBefore nodes. Nothing knows about PassNode specifically.
2. **Deduplication**: Multiple `PassMultipleTextureNode`s from the same `PassNode` each have `this.before(passNode)`. `discover()` visits `PassNode` once (visited set). Registers it once for updateBefore. Inner scene renders exactly once per frame.
3. **No cycle problems**: The `PassTextureNode ↔ PassNode` cycle is handled by `discover()`'s visited set. `generateExpr` doesn't walk `_beforeNodes` — it doesn't know about them. No code generation cycle.
4. **Extensible**: Any future node type that needs updateBefore just sets `updateBeforeType` and implements `updateBefore()`. If it's reachable in the graph (directly or via `_beforeNodes`), it's automatically collected. No need to add registration logic in code gen functions.

## Files changed

| File | Change |
|---|---|
| `src/nodes/lib/display/pass-node.ts` | Remove `updateBeforeType` + `updateBefore()` from `PassTextureNode` (done). Add `this.before(passNode)` in constructor. |
| `src/nodes/builder.ts` | (1) `getChildren()`: include `_beforeNodes`. (2) `discover()`: collect updateBefore/After/update nodes. (3) Remove ad-hoc registration from `generateTexture()` and `generateUniform()`. (4) Wire discovered collections into compile result. (5) Remove update fields from `BuildContext`. |

## Verification

- All existing examples using `pass(scene, camera).getTextureNode()` → `renderOutput()` still work: PassNode is discovered via `_beforeNodes`, registered for updateBefore, renders the inner scene, updates texture resources.
- Multiple texture outputs from the same pass (MRT) correctly render the inner scene only once.
- Any node with `updateBeforeType` set is automatically discovered — no registration boilerplate needed in code gen.
- Build should pass with no new type errors.
