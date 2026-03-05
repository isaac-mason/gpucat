# Builtin Uniforms Refactor: Dogfooding the Uniform Infrastructure

## Problem

Camera, time, and mesh builtins (`cameraViewMatrix`, `timeElapsed`, `meshModelMatrix`, etc.)
are currently plumbed through a **completely separate, hardcoded four-layer pipeline**:

| Layer | Builtins (hardcoded) | User uniforms (generic) |
|---|---|---|
| **Node** | `BuiltinNode` + `builtinsUsed: Set<string>` tag | `UniformNode` with `group`/`binding` |
| **Compile (WGSL emit)** | `if (builtinsUsed.has('camera')) { lines.push(...) }` | loop over `uniformNodes` |
| **Layout build** | `if (builtinsUsed.has('camera')) { entries.push(...) }` | loop over `cr.uniforms` |
| **Bind group / upload** | named `GPUBuffer` fields in `FrameBuffers`; `buildFrameBindGroup` | `BufferCache` + `packMaterialUBO` |

**Adding any new builtin** (e.g. `screenSize`, `frameCount`) currently requires touching all four
layers and keeping magic binding numbers in sync across `compile.ts`, `pipeline.ts`, `bindgroups.ts`,
and `renderer.ts`.

`UniformNode` already has `group: 'material' | 'frame'` — the `'frame'` group path exists but is
never used. The refactor completes what was already anticipated.

---

## Goal

Make builtins **first-class `UniformNode`s** that flow through the same infrastructure as
user-defined uniforms. After the refactor:

- `timeElapsed` is a `UniformNode<'f32'>` with `group: 'frame'`, `binding: 5`
- `cameraViewMatrix` is a `UniformNode<'mat4x4f'>` with `group: 'frame'`, `binding: 1`
- `meshModelMatrix` is a `UniformNode<'mat4x4f'>` with `group: 'mesh'`, `binding: 0`
- Adding a new builtin = adding one `UniformNode` constant + uploading a value in the renderer
- `builtinsUsed`, `BuiltinNode`, and all hardcoded `if (builtinsUsed.has(...))` blocks are deleted

---

## New Group Taxonomy

| Group name | WGSL `@group` | What lives here |
|---|---|---|
| `'frame'` | 0 | Camera uniforms (bindings 0–4), time uniforms (bindings 5–6) |
| `'mesh'` | 1, bindings 0–1 | meshModelMatrix, meshNormalMatrix |
| `'material'` | 1, bindings 2+ | user uniforms, storage, textures, samplers |
| `'compute_storage'` | 0 | compute storage buffers (unchanged) |
| `'compute_frame'` | 1 | time uniforms in compute shaders (unchanged slot, new name) |

The two-group physical layout is preserved exactly. Only the mechanism changes.

---

## Implementation Plan

### Phase 1 — Extend `UniformNode` / `UniformGroup` type

**File: `src/nodes/nodes.ts`**

1. Extend the group union type:
   ```ts
   // Before
   readonly group: 'material' | 'frame';
   
   // After
   readonly group: 'material' | 'frame' | 'mesh' | 'compute_frame';
   ```

2. Add a `binding` field to `UniformNode` (optional, defaults to `null` for `'material'`
   nodes whose binding is assigned dynamically):
   ```ts
   readonly binding: number | null;  // null = assigned by compiler in encounter order
   ```
   Constructor signature becomes:
   ```ts
   constructor(type: T, uniformId: string, group: UniformGroup = 'material', binding: number | null = null)
   ```

3. **Delete `BuiltinNode` class and `BuiltinKind` type** (kept only for compute
   WGSL builtins like `@builtin(global_invocation_id)` — see Phase 3).

4. Replace the singleton `BuiltinNode` exports with `UniformNode` singletons:
   ```ts
   // Frame group (group 0)
   export const cameraProjectionMatrix = new UniformNode('mat4x4f', 'cameraProjectionMatrix', 'frame', 0);
   export const cameraViewMatrix       = new UniformNode('mat4x4f', 'cameraViewMatrix',       'frame', 1);
   export const cameraPosition         = new UniformNode('vec3f',   'cameraPosition',         'frame', 2);
   export const cameraNear             = new UniformNode('f32',     'cameraNear',             'frame', 3);
   export const cameraFar              = new UniformNode('f32',     'cameraFar',              'frame', 4);
   export const timeElapsed            = new UniformNode('f32',     'timeElapsed',            'frame', 5);
   export const timeDelta              = new UniformNode('f32',     'timeDelta',              'frame', 6);

   // Mesh group (group 1, bindings 0–1)
   export const meshModelMatrix  = new UniformNode('mat4x4f', 'meshModelMatrix',  'mesh', 0);
   export const meshNormalMatrix = new UniformNode('mat3x3f', 'meshNormalMatrix', 'mesh', 1);
   ```

   Note: `timeElapsed` / `timeDelta` in compute shaders use `group: 'compute_frame'` with
   bindings 0 and 1 (since compute group 0 is storage). These are **separate node singletons**
   or the same node with context-aware group assignment — see Phase 2.

5. **Compute builtins** (`global_invocation_id`, `instance_index`, `vertex_index`, etc.) are
   WGSL shader `@builtin(...)` struct fields — not uniform buffers — so they stay as
   `BuiltinNode` instances. Rename `BuiltinKind` to `WgslBuiltinKind` to clarify:
   ```ts
   export type WgslBuiltinKind =
     | 'instance_index' | 'vertex_index'
     | 'global_invocation_id' | 'local_invocation_id'
     | 'local_invocation_index' | 'workgroup_id' | 'num_workgroups';
   ```
   The old `'camera'`, `'time'`, `'mesh'` category tags are removed entirely.

---

### Phase 2 — Update the compiler (`compile.ts`)

**File: `src/nodes/compile.ts`**

#### 2a. Remove `builtinsUsed` set and `BuiltinNode` compiler def

- Delete `builtinsUsed: Set<string>` from `WgslBuilder` and `CompileResult` /
  `ComputeCompileResult`.
- Delete the `builtin` entry in `compilerDefs` (the part that tags `'camera'`, `'time'`, `'mesh'`).
- Keep only the WGSL-builtin part of `compilerDefs.builtin` for `WgslBuiltinKind` values —
  rename to `wgsl_builtin` or handle in the same `uniform` def by checking node type.

#### 2b. Extend `uniform` compiler def to handle all groups

The `uniform` compiler def currently only registers `group === 'material'` nodes:
```ts
// Current
setup: (node, b) => {
    if (node.group === 'material') b.uniformNodes.set(node.uniformId, node);
}
generate: (node) => node.group === 'material'
    ? `materialUniforms.${node.uniformId}`
    : node.uniformId   // ← this is the stale "frame group" stub that does nothing useful
```

Change to:
```ts
setup: (node, b) => {
    switch (node.group) {
        case 'material':
            b.uniformNodes.set(node.uniformId, node);
            break;
        case 'frame':
        case 'mesh':
        case 'compute_frame':
            // Fixed-binding uniforms — register into a separate map so layout builders
            // can iterate them. Dedup by uniformId.
            b.fixedUniformNodes.set(node.uniformId, node);
            break;
    }
}
generate: (node) => node.uniformId   // all groups: var name = uniformId
```

Add `fixedUniformNodes: Map<string, UniformNode<WgslType>>` to `WgslBuilder`.

#### 2c. Update `_makeRenderResult` WGSL emission

Replace the hardcoded `if (builtinsUsed.has(...))` blocks:
```ts
// Delete this block entirely:
if (this.builtinsUsed.has('camera')) {
    lines.push(`@group(0) @binding(0) var<uniform> cameraProjectionMatrix : mat4x4f;`);
    ...
}

// Replace with a generic loop:
for (const node of this.fixedUniformNodes.values()) {
    const gpuGroup = node.group === 'frame' ? 0
                   : node.group === 'mesh'  ? 1
                   : null; // compute_frame handled in _makeComputeResult
    if (gpuGroup === null) continue;
    lines.push(`@group(${gpuGroup}) @binding(${node.binding}) var<uniform> ${node.uniformId} : ${node.type};`);
}
```

Sort the output by `(group, binding)` for stable WGSL.

#### 2d. Update `_makeComputeResult` WGSL emission

Replace the hardcoded `if (builtinsUsed.has('time'))` block with the same generic loop,
filtering for `group === 'compute_frame'`.

**Note on `timeElapsed` in compute vs render**: The same `timeElapsed` variable name is used
in both contexts, but the `@group` differs (0 in render, 1 in compute). Two options:

- **Option A (Recommended)**: Two separate node singletons:
  `timeElapsed` (render, `group: 'frame'`, `@group(0) @binding(5)`) and
  `computeTimeElapsed` / same name internally but `group: 'compute_frame'`, `@group(1) @binding(0)`.
  The existing `timeElapsed` export stays unchanged from the user's perspective because compute
  shaders already reference the same `timeElapsed` const — the compiler emits the right `@group`
  based on which stage is being compiled.

- **Option B**: Single `timeElapsed` node with group dynamically resolved by the compiler based
  on `this.input.kind`. Simpler but less explicit.

  **Go with Option B** — it matches how Three.js handles this (same node, different binding
  slot resolved at compile time). The compiler checks `this.input.kind` in the `uniform` setup
  and routes `'frame'` group nodes to `@group(1)` when compiling compute.

#### 2e. Update `CompileResult` and `ComputeCompileResult`

- Remove `builtinsUsed: Set<string>` from both.
- Add `fixedUniforms: FixedUniformEntry[]` to both, where:
  ```ts
  export type FixedUniformEntry = {
      node: UniformNode<WgslType>;
      group: number;      // physical WGSL @group number
      binding: number;
  };
  ```
  This replaces all downstream `builtinsUsed.has(...)` checks.

---

### Phase 3 — Update pipeline layout builders

**File: `src/renderer/pipeline.ts`**

Replace hardcoded `_buildLayout0` / `_buildLayout1` with generic loops:

```ts
private _buildLayout0(cr: CompileResult): GPUBindGroupLayout {
    const entries: GPUBindGroupLayoutEntry[] = [];
    for (const fu of cr.fixedUniforms) {
        if (fu.group !== 0) continue;
        entries.push({
            binding: fu.binding,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: 'uniform' },
        });
    }
    return this.device.createBindGroupLayout({ entries });
}

private _buildLayout1(cr: CompileResult): GPUBindGroupLayout {
    const entries: GPUBindGroupLayoutEntry[] = [];
    // Fixed uniforms at group 1 (mesh model/normal matrix)
    for (const fu of cr.fixedUniforms) {
        if (fu.group !== 1) continue;
        entries.push({
            binding: fu.binding,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: 'uniform' },
        });
    }
    // Material resources at group 1 — unchanged
    for (const s of cr.storage) { ... }
    for (const ub of cr.uniforms) { ... }
    ...
    return this.device.createBindGroupLayout({ entries });
}
```

**File: `src/renderer/compute-pipeline.ts`**

Same treatment: replace `_buildLayout1()` hardcoded time-uniform entries with a loop over
`cr.fixedUniforms` filtered to `group === 1`.

---

### Phase 4 — Update bind group construction and upload

**File: `src/renderer/bindgroups.ts`**

#### 4a. Delete `FrameBuffers` type and `buildFrameBindGroup`

Replace with a generic `buildFixedUniformBindGroup` that takes a `Map<string, GPUBuffer>`:

```ts
export function buildFixedBindGroup(
    device: GPUDevice,
    layout: GPUBindGroupLayout,
    fixedUniforms: FixedUniformEntry[],   // from CompileResult
    physicalGroup: number,
    buffersByUniformId: Map<string, GPUBuffer>,
): GPUBindGroup {
    const entries: GPUBindGroupEntry[] = fixedUniforms
        .filter(fu => fu.group === physicalGroup)
        .map(fu => ({
            binding: fu.binding,
            resource: { buffer: buffersByUniformId.get(fu.node.uniformId)! },
        }));
    return device.createBindGroup({ layout, entries });
}
```

#### 4b. Update `buildMeshBindGroup`

Remove the `meshModelMatrixBuf` / `meshNormalMatrixBuf` named parameters — they are now
looked up via `buffersByUniformId` using `'meshModelMatrix'` / `'meshNormalMatrix'` keys.
The function signature becomes uniform with `buildFixedBindGroup`.

---

### Phase 5 — Update the renderer

**File: `src/renderer/renderer.ts`**

#### 5a. Replace named buffer fields with a uniform `Map<string, GPUBuffer>`

```ts
// Delete ~14 lines of named fields:
// private readonly _camProjKey, _camViewKey, ..., _timeElapsedKey, ...

// Replace with:
private readonly _fixedUniformBuffers: Map<string, GPUBuffer> = new Map();
```

The renderer allocates one buffer per `uniformId` lazily on first use. Buffer size is
determined from the node's WGSL type via a helper `wgslTypeByteSize(type)`.

#### 5b. Replace per-field upload methods

```ts
// Delete _uploadCameraFields(camera) and _uploadTimeFields(elapsed, delta)

// Replace with:
private _uploadFixedUniforms(camera: Camera, elapsed: number, delta: number): void {
    // Iterate the well-known builtin singletons and upload their current values.
    // Each builtin node holds its current value in node.value (set by renderer).
    cameraProjectionMatrix.value = [...camera.projectionMatrix];
    cameraViewMatrix.value       = [...camera._viewMatrix];
    // ... etc
    for (const [id, buf] of this._fixedUniformBuffers) {
        const node = _builtinNodeById.get(id);
        if (node?.value != null) this.device.queue.writeBuffer(buf, 0, packUniform(node));
    }
}
```

Or more simply: keep the renderer-side upload logic explicit (it knows about `Camera`,
`elapsed`, etc.) but allocate/track buffers through the `BufferCache` using `uniformId`
as the key, matching what `buildFixedBindGroup` looks up.

#### 5c. Remove all `builtinsUsed.has(...)` checks

The renderer currently gates bind group creation and buffer allocation on
`entry.compileResult.builtinsUsed.has('camera')` etc. These are replaced by checking
`cr.fixedUniforms.some(fu => fu.group === 0)` or just always building the group (safe —
an empty bind group layout is valid).

---

### Phase 6 — Cleanup and verification

1. **Delete** `BuiltinKind` (old, with camera/time/mesh entries) from `nodes.ts`.
2. **Delete** `builtinsUsed` from `WgslBuilder`, `CompileResult`, `ComputeCompileResult`.
3. **Delete** the `builtin` entry in `compilerDefs` (the `'camera'`/`'time'`/`'mesh'` tagger).
4. **Delete** `buildFrameBindGroup`, `FrameBuffers` from `bindgroups.ts`.
5. **Delete** `_camProjKey`, `_camViewKey`, … named key fields from `renderer.ts`.
6. **Update** `src/index.ts` exports if any `BuiltinNode`-related types were exported.
7. Run `npx tsc --noEmit` — fix any type errors.
8. Run `npx vitest run` — all previously-passing tests must still pass.
9. Manually verify `example-indirect-compute` and `example-compute-particles` still render.

---

## Files Changed

| File | Change |
|---|---|
| `src/nodes/nodes.ts` | Extend `UniformGroup`, add `binding` to `UniformNode`, replace builtin singletons, narrow `BuiltinKind` to WGSL-only |
| `src/nodes/compile.ts` | Remove `builtinsUsed`, extend `uniform` compiler def, generic WGSL emit, add `fixedUniforms` to results |
| `src/renderer/pipeline.ts` | Generic `_buildLayout0/1` from `fixedUniforms` |
| `src/renderer/compute-pipeline.ts` | Generic layout builder from `fixedUniforms` |
| `src/renderer/bindgroups.ts` | Replace `FrameBuffers`/`buildFrameBindGroup` with generic `buildFixedBindGroup` |
| `src/renderer/renderer.ts` | Replace named buffer keys with `Map<string, GPUBuffer>`, unified upload loop |

---

## Non-Goals / Out of Scope

- **Changing physical binding numbers** — the `@group`/`@binding` assignments are identical
  before and after. This is purely a mechanism change.
- **User-facing API changes** — `gpu.timeElapsed`, `gpu.cameraViewMatrix` etc. remain the
  same exported constants. The only difference is their runtime type changes from `BuiltinNode`
  to `UniformNode`.
- **Compute builtin shader inputs** (`global_invocation_id`, `instance_index`, etc.) — these
  remain `BuiltinNode` instances because they map to WGSL `@builtin(...)` struct fields, not
  uniform buffers.

---

## Key Insight

`UniformNode` already has `group: 'material' | 'frame'`. The `'frame'` path exists in the
node definition but is a dead stub in the compiler (`generate` returns `node.uniformId` but
nothing registers a binding or emits a declaration). This refactor completes what was already
partially anticipated: it fills in the `'frame'` (and new `'mesh'`, `'compute_frame'`) paths
so that the generic uniform infrastructure handles builtins the same way it handles user
uniforms.
