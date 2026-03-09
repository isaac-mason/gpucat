# Uniform Group Update Gating — Inconsistencies and Implementation Plan

This document catalogues every inconsistency between the current gpucat
implementation and the intended Three.js-aligned design for uniform group
update gating. It covers both the render path and the compute path and
serves as the single source of truth for the work to be done.

---

## Background

Three.js gates uniform uploads using two orthogonal mechanisms:

1. **Node-level deduplication** (`NodeFrame.updateNode`): tracks `frameId` /
   `renderId` per node so that FRAME-type nodes run once per animation frame,
   RENDER-type nodes once per `render()` call, and OBJECT-type nodes once per
   draw call.

2. **Group-level binding deduplication** (`NodeManager.updateGroup`): maintains a
   `ChainMap<[UniformGroupNode, nodeUniformsGroup], { version }>`. Before
   doing any work on a binding, `Bindings._update()` calls
   `nodes.updateGroup(binding)`. The gate compares `groupData.version` against
   `groupNode.version`. For shared singletons (`frameGroup`, `renderGroup`),
   `groupNode.version` stays at `0` permanently — nothing ever bumps it. The
   gate works via **object-identity deduplication**: all meshes sharing a group
   share the same `nodeUniformsGroup` binding object. The first mesh in a frame
   passes the gate (cached version `undefined !== 0`), does the work, and
   stores `groupData.version = 0`. All subsequent meshes find `0 === 0` and
   skip. For per-object groups, each object has its own binding object, so the
   gate always returns `true` and every object is processed.

gpucat has the data structures for both mechanisms but only partially
implements the first. The second mechanism is entirely absent.

---

## Issue 1 — `frameGroup` and `renderGroup` share `order: 0` (collision)

**File:** `src/nodes/lib/core/uniform.ts` lines 49 and 59

Both singleton groups are created with `order: 0`:

```ts
// line 49
export const frameGroup  = sharedUniformGroup('frame',  0, NodeUpdateType.FRAME);
// line 59
export const renderGroup = sharedUniformGroup('render', 0, NodeUpdateType.RENDER);
```

`order` maps directly to the WGSL `@group(N)` index. Two distinct groups with
the same order would collide into the same bind group slot, which is a latent
correctness bug for any shader that uses both groups simultaneously.

The comment on line 47–48 says "gpucat currently merges frame uniforms into
renderGroup for simplicity", but no code enforces this merge — callers can
reference either singleton freely and nothing prevents them from ending up in
the same `@group(0)`.

**Resolution:** Assign `frameGroup` a distinct order so the groups occupy
separate `@group` slots:

| Group         | `order` | `@group` | `updateType` |
|---------------|---------|----------|--------------|
| `renderGroup` | 0       | @group(0) | RENDER      |
| `objectGroup` | 1       | @group(1) | OBJECT      |
| `frameGroup`  | 2       | @group(2) | FRAME       |

This follows the Three.js approach where each distinct group maps to a unique
bind group index.

---

## Issue 2 — `UniformGroupNode.version` is never bumped, and the doc's original resolution was wrong

**File:** `src/nodes/lib/core/uniform.ts` lines 97–100  
**Also affects:** `src/renderer/bindings.ts`

### What gpucat currently has

gpucat's `UniformGroupNode` has a plain `version` field (starts at 0) and an
`update()` method that sets `this.needsUpdate = true` and does
`this.version++`. Neither is ever called by the renderer on the shared
singletons, so `version` stays at 0 forever.

### What Three.js actually does (corrected)

**Three.js's `Renderer.js` never calls `frameGroup.update()` or
`renderGroup.update()` either.** There is no renderer-side version bump for
the shared group singletons. Confirmed by searching the entire
`three.js/src/renderers/` tree: zero occurrences.

Instead, Three.js's `UniformGroupNode.update()` only sets
`this.needsUpdate = true` (line 84–88 of `UniformGroupNode.js`):

```js
// three.js UniformGroupNode.js — update() only sets needsUpdate
update() {
    this.needsUpdate = true;
}
```

`version` is not incremented in `update()` directly. It is incremented by the
`set needsUpdate(value)` setter inherited from `Node` base class
(`Node.js` line 177–184):

```js
// three.js Node.js — needsUpdate setter
set needsUpdate( value ) {
    if ( value === true ) {
        this.version ++;
    }
}
```

So `groupNode.version` for the shared singletons (`frameGroup`, `renderGroup`)
stays at `0` — permanently — because nothing calls `.update()` on them from
the renderer. **The `version` counter is never used as a time-based cadence
signal for shared groups.**

### What `updateGroup` actually does

The `ChainMap` gate in `NodeManager.updateGroup()` (lines 111–134) works via
**object-identity deduplication**, not time-based version gating:

- The map is keyed by `[groupNode, nodeUniformsGroup]` where
  `nodeUniformsGroup` is the **binding object** (`NodeUniformsGroup`
  instance).
- For **shared groups** (`frameGroup`, `renderGroup`): all meshes using the
  same shared group share the **same `NodeUniformsGroup` binding object**.
  The first mesh to call `updateGroup` finds `groupData.version (undefined) !==
  groupNode.version (0)`, writes `groupData.version = 0`, and returns `true`.
  Every subsequent mesh in the same frame calls `updateGroup` on the same
  binding object, finds `groupData.version (0) === groupNode.version (0)`, and
  returns `false` — skipping all per-member work. This is the deduplication
  mechanism: **one upload per shared binding object per frame**, regardless of
  how many meshes reference it.
- For **per-object groups** (`objectGroup`): each object has its own
  `NodeUniformsGroup` instance. So `groupData` starts as `undefined` for
  every object's binding, `updateGroup` returns `true` on the first (and
  only) call per object per frame, and the binding is always processed.

### What is actually missing from gpucat

gpucat has no `updateGroup` / `groupsData` at all (Issue 4). The shared
`NodeUniformsGroup`-style binding object deduplication is the missing piece.
gpucat does not need to call `.update()` on group singletons from the
renderer — it just needs the ChainMap gate.

**Resolution:** No change needed to `UniformGroupNode.update()` or the
renderer's call sites for group singletons. The fix is entirely in Issue 4
(add `updateGroup` to `node-manager.ts` and wire it into `bindings.ts`).

---

## Issue 3 — `UniformGroupNode.needsUpdate` is a plain field, not a version-bumping setter

**File:** `src/nodes/lib/core/uniform.ts` line 78  
**Reference:** `three.js/src/nodes/core/Node.js` line 177

In Three.js, `needsUpdate` is **not a stored field** — it is a write-only
setter on the `Node` base class that immediately increments `this.version`:

```js
// three.js Node.js
set needsUpdate( value ) {
    if ( value === true ) {
        this.version ++;
    }
}
```

Setting `someNode.needsUpdate = true` is therefore equivalent to
`someNode.version++`. There is no stored boolean; the setter has no getter
counterpart.

gpucat's `UniformGroupNode` is not a `Node` subclass. Its `needsUpdate` is a
plain boolean field that is set by `update()` but never read by the renderer.
It is dead code — setting it has no effect on gating or uploads.

Additionally, gpucat's `update()` manually increments `version` in addition to
setting `needsUpdate`, whereas in Three.js the increment happens automatically
via the setter. This means gpucat increments `version` twice if the setter
pattern were ever added.

**Resolution:**

- Remove the plain `needsUpdate` field from `UniformGroupNode` (it is
  meaningless without the setter pattern).
- Remove the explicit `this.version++` from `update()` and instead replace
  `update()` with a `set needsUpdate(value)` setter that bumps `version`
  (matching Three.js's `Node` base class pattern):

```ts
// uniform.ts — aligned with Three.js Node setter pattern
set needsUpdate(value: boolean) {
    if (value === true) this.version++;
}
```

- Or, since gpucat's `UniformGroupNode.version` stays 0 and the `updateGroup`
  gate works without ever bumping it (see Issue 2 correction), simply remove
  both `update()` and `needsUpdate` entirely from `UniformGroupNode` to match
  the effective Three.js behaviour for shared singletons. The setter pattern
  in Three.js is inherited from `Node` for general node use; the shared group
  singletons never have it called in practice.

---

## Issue 4 — No group-level version gate in `bindings.ts`

**File:** `src/renderer/bindings.ts` lines 332–368 (`updateUniformBinding`)

The current function always invokes callbacks and always packs data,
gating only the buffer upload behind a `versionSum` check:

```ts
// bindings.ts updateUniformBinding — current behaviour
invokeUniformGroupCallbacks(block, frame);   // always called

let versionSum = ...;
for (const m of block.members) versionSum += m.node.version;

if (versionSum !== binding.versionSum) {     // upload gated here only
    const packed = packUniformGroup(block);
    uploadRaw(...);
    binding.versionSum = versionSum;
}
```

Callbacks are invoked unconditionally on every draw call for every object,
even for `FRAME`-type groups whose data hasn't changed since the previous
frame. For `renderGroup` (camera matrices), this means redundant matrix
writes on every draw call for every mesh in the scene.

### The Three.js mechanism: object-identity deduplication, not version gating

Three.js solves this with `NodeManager.updateGroup()` consulted before the
inner loop (`Bindings.js` line 256):

```js
// three.js Bindings._update — reference
if (this.nodes.updateGroup(binding) === false) continue;
```

`updateGroup` uses a `ChainMap` keyed by `[groupNode, nodeUniformsGroup]`
where the second key is the **binding object itself** (a `NodeUniformsGroup`
instance). The gate compares `groupData.version` against `groupNode.version`.
Since `groupNode.version` stays at `0` for the shared singletons (as described
in Issue 2), the gate effectively checks: **has this exact binding object been
processed yet this frame?**

- **Shared groups** (`frameGroup`, `renderGroup`): all `RenderObject`s referencing
  the same shared group share a **single** `NodeUniformsGroup` binding object.
  The first `RenderObject` in a frame passes the gate (cached version
  `undefined !== 0`), sets `groupData.version = 0`, and does the work.
  Every subsequent `RenderObject` hits `0 === 0` and skips. Result: **one
  callback invocation + one upload per shared group per frame**, regardless of
  scene size.
- **Per-object groups** (`objectGroup`): each `RenderObject` has its own
  `NodeUniformsGroup` instance. Its `groupData` starts as `undefined`, so
  `updateGroup` always returns `true` on the first (and only) call per object.
  Every object is always processed. This is correct and intentional — per-object
  data changes per object.

### gpucat's equivalent structure

In gpucat, `BindGroup` (from `src/renderer/bind-group.ts`) is the equivalent of
Three.js's `NodeUniformsGroup`. Shared groups reuse the same `BindGroup` object
across all `RenderObject`s (`shared: true`); per-object groups are cloned via
`cloneBindGroup`. The `groupNode` is `block.groupNode` on the `UniformBinding`.

So the two-key gate maps directly:
- Three.js: `ChainMap<[UniformGroupNode, NodeUniformsGroup], {version}>`
- gpucat equivalent: `Map<UniformGroupNode, WeakMap<UniformBinding, {version}>>`
  (or `Map<UniformGroupNode, Map<BindGroup, {version}>>` keyed on the
  *parent* `BindGroup` object, since a `BindGroup` is shared but its
  `UniformBinding` child is embedded and equally unique)

### Resolution

Add `updateGroup()` to `node-manager.ts` and call it from
`updateUniformBinding` before any per-member work:

```ts
// node-manager.ts (to add)
const groupsData = new Map<UniformGroupNode, WeakMap<UniformBinding, { version: number }>>();

function updateGroup(groupNode: UniformGroupNode, binding: UniformBinding): boolean {
    let byBinding = groupsData.get(groupNode);
    if (!byBinding) { byBinding = new WeakMap(); groupsData.set(groupNode, byBinding); }

    let data = byBinding.get(binding);
    if (!data) { byBinding.set(binding, data = { version: -1 }); }

    if (data.version !== groupNode.version) {
        data.version = groupNode.version;
        return true;
    }
    return false;
}
```

`NodeManagerState` must be threaded into `bindings.ts` (currently absent) —
either via a parameter added to `updateBindings` / `updateUniformBinding` or
by storing a reference on `BindingsState`.

**Important:** The dedup only works correctly for shared groups because shared
groups reuse the **same** `UniformBinding` object. Per-object groups have a
unique `UniformBinding` per `RenderObject`, so `updateGroup` always returns
`true` for them — which is the correct behaviour. No special-casing needed.

---

## Issue 5 — `packUniformGroup` and `invokeUniformGroupCallbacks` are duplicated verbatim

**Files:**  
- `src/renderer/bindings.ts` lines 513–528 and 536–568  
- `src/renderer/renderer.ts` lines 1628–1660 and 1668–1682

The two functions are byte-for-byte identical. The `renderer.ts` copies are
used only by `_dispatchComputeNode`; the `bindings.ts` copies by the render
path. Any future fix to the packing logic (e.g. adding `mat4x3f` padding)
must be applied in two places.

**Resolution:** Extract both functions into a new shared module
`src/renderer/uniform-utils.ts` and import from both call sites. No
behaviour change.

---

## Issue 6 — `buildLayoutEntries` always emits `VERTEX | FRAGMENT` visibility

**File:** `src/renderer/bindings.ts` lines 253–299

```ts
const vis = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
```

All uniform and storage buffer entries are declared with vertex+fragment
visibility regardless of where they are actually used. This prevents the
compute path from ever being routed through `bindings.ts` correctly (compute
shaders require `GPUShaderStage.COMPUTE` visibility for their bindings).

**Resolution:** Accept a `visibility` parameter (or a `shaderStage` hint) in
`buildLayoutEntries` so the compute path can pass `GPUShaderStage.COMPUTE`.
As part of migrating compute bind groups into `bindings.ts` (Issue 7), the
calling code in `_dispatchComputeNode` can supply the correct visibility.

---

## Issue 7 — Compute path bypasses `bindings.ts` entirely and is rebuilt every frame

**File:** `src/renderer/renderer.ts` lines 855–922 (`_dispatchComputeNode`)

The compute dispatch has its own ad-hoc bind group construction that:

1. Creates a new `GPUBindGroup` for the storage group **every frame** with no
   caching (line 879–885).
2. Creates a new `GPUBindGroup` for the render/time group **every frame** with
   no caching (line 908–913).
3. Calls the local duplicated `invokeUniformGroupCallbacks` and `packUniformGroup`
   rather than the canonical versions (Issue 5).
4. Does not use the `bindings.ts` subsystem at all — no layout cache, no
   `BindGroupData`, no version-sum deduplication.
5. Uploads the render group uniform buffer to a bare `{}` key
   (`_computeRenderGroupKey`, line 135) that is completely separate from the
   render path's buffer management.
6. The `NodeFrame` context may be stale for compute if `compute()` is called
   before `render()` in the same JS tick — `frame.update()` (which increments
   `frameId` and updates `time`) is only called from inside `render()`, so
   time uniforms seen by compute shaders would be one frame behind.

**Resolution:** Migrate compute bind group construction into `bindings.ts`:

- Give `BindingsState` a concept of compute bind groups (or introduce a thin
  `ComputeBindingsState` that shares the same layout cache and buffer cache).
- Thread `GPUShaderStage.COMPUTE` visibility through `buildLayoutEntries`
  (see Issue 6).
- Cache `BindGroupData` per compute `BindGroup` in the existing `WeakMap`.
- Call `frame.update()` (or at minimum ensure `frame.time` / `frame.frameId`
  are current) before dispatching compute, so time uniforms are correct when
  `compute()` is called before `render()`.

---

## Issue 8 — `compileComputeNode` duplicates the callback-wiring logic

**File:** `src/renderer/node-manager.ts` lines 268–285

At compile time, `compileComputeNode` manually iterates uniform group members
to find nodes with `.update` callbacks and wraps them into `UpdateNode`
entries:

```ts
for (const ug of compileResult.uniformGroups) {
    for (const member of ug.members) {
        const node = member.node;
        if (node.update) {
            updateNodes.push({
                id: node.id,
                updateType: node.updateType ?? 'frame',
                update: (frame) => {
                    const result = node.update!(frame);
                    if (result !== undefined) {
                        node.value = result as typeof node.value;
                        node.version++;
                    }
                    return true;
                },
            });
        }
    }
}
```

This is effectively duplicating what `invokeUniformGroupCallbacks` does at
runtime, just wired up at compile time through the `UpdateNode` / `NodeFrame`
path instead. The result is that compute uniform callbacks can fire through
two different code paths depending on how the compute path is wired, making
it hard to reason about update ordering.

**Resolution:** Once compute is migrated to `bindings.ts` (Issue 7),
`compileComputeNode` should not need to build `updateNodes` for uniform
callbacks at all — `bindings.ts updateUniformBinding` handles them via
`invokeUniformGroupCallbacks`. The `updateNodes` list for compute should only
contain non-uniform update hooks (if any), matching the render path.

---

## Issue 9 — `updateReference` indirection missing from `NodeFrame`

**File:** `src/renderer/node-frame.ts` line 203  
**Reference:** `three.js/src/nodes/core/NodeFrame.js` line 256

Three.js's `updateNode` calls `node.updateReference(this)` before the
`WeakMap` lookup to obtain the deduplication key. This indirection allows
nodes that share a common resource (e.g. two nodes backed by the same
`UniformGroup`) to deduplicate on the shared resource rather than the node
object identity.

gpucat's `updateNode` uses the node object itself as the key, which is
correct for all current use cases but is a divergence from the Three.js
contract. If a node type is added in the future that overrides
`updateReference` to return a shared object, gpucat would update it once
per node instance rather than once per shared resource.

**Resolution:** This is lower priority than Issues 1–8 but should be noted.
Add `updateReference(frame: NodeFrame): object` to the `UpdateNode` interface
(returning `this` by default) and use the result as the `WeakMap` key in
`updateNode`, `updateBeforeNode`, and `updateAfterNode`.

---

## Summary Table

| # | Issue | Files | Severity |
|---|-------|-------|----------|
| 1 | `frameGroup` and `renderGroup` both `order: 0` — bind group slot collision | `uniform.ts` | High |
| 2 | `updateGroup` dedup missing — real mechanism is binding-object identity, not version cadence calls | `bindings.ts`, `node-manager.ts` | High |
| 3 | `UniformGroupNode.needsUpdate` is a plain field, not a version-bumping setter; `update()` double-increments if setter pattern added | `uniform.ts` | Medium |
| 4 | No `updateGroup` gate in `bindings.ts` — callbacks fire on every draw for every object | `bindings.ts`, `node-manager.ts` | High |
| 5 | `packUniformGroup` and `invokeUniformGroupCallbacks` duplicated verbatim | `bindings.ts`, `renderer.ts` | Medium |
| 6 | `buildLayoutEntries` hardcodes `VERTEX \| FRAGMENT` — blocks compute path | `bindings.ts` | Medium |
| 7 | Compute path bypasses `bindings.ts`; bind groups rebuilt every frame | `renderer.ts` | High |
| 8 | `compileComputeNode` re-implements uniform callback wiring at compile time | `node-manager.ts` | Medium |
| 9 | `updateReference` indirection missing from `NodeFrame` | `node-frame.ts` | Low |

---

## Recommended Implementation Order

1. **Issue 5** — Create `src/renderer/uniform-utils.ts`, deduplicate
   `packUniformGroup` and `invokeUniformGroupCallbacks`. Purely mechanical,
   zero behaviour change, unblocks everything else.

2. **Issue 1** — Change `frameGroup` to `order: 2` in `uniform.ts`.
   One-line fix; resolves the latent `@group` collision.

3. **Issues 3 + 4** — Implement group-level binding-object dedup:
   - Replace `UniformGroupNode.needsUpdate` plain field + `update()` with the
     Three.js `set needsUpdate(value)` setter pattern (or remove entirely —
     since the shared singletons' `version` stays 0, the gate still works).
   - Add `groupsData` map and `updateGroup()` to `node-manager.ts`.
   - Thread `NodeManagerState` (or just the `updateGroup` function) into
     `bindings.ts::updateUniformBinding`.
   - Wire the gate: skip entire binding when `updateGroup` returns `false`.
   - **Do not** add renderer-side calls to `frameGroup.update()` or
     `renderGroup.update()` — Three.js does not do this and the dedup mechanism
     does not require it.

4. **Issues 6 + 7 + 8** — Migrate compute into `bindings.ts`:
   - Add a `visibility` parameter to `buildLayoutEntries`.
   - Port compute bind group construction from `_dispatchComputeNode` into
     `bindings.ts` with proper caching.
   - Ensure `frame.update()` / time state is current before compute dispatch.
   - Remove the now-redundant `updateNodes` uniform callback wiring from
     `compileComputeNode`.

5. **Issue 9** — Add `updateReference` to `UpdateNode` interface and use it
   as the `WeakMap` key in all three `NodeFrame` update methods.
