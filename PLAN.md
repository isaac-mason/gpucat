# gpucat uniform refactor — alignment with Three.js

## Goal

Replace the current hardcoded binding layout
(`builtinsUsed.has('camera')` / `builtinsUsed.has('time')` / `builtinsUsed.has('mesh')`,
`FrameBuffers`, `_camProjKey`, `_uploadCameraFields`, hardcoded `binding` numbers, etc.)
with a `UniformGroupNode`-based architecture that **exactly** mirrors how Three.js
WebGPURenderer manages its built-in and user uniforms.

---

## What Three.js actually does (ground truth)

### UniformGroupNode (`nodes/core/UniformGroupNode.js`)

A named descriptor object with four properties (as of PR #33047):

| property     | meaning |
|--------------|---------|
| `name`       | String identifier — becomes the WGSL struct name and uniform variable name |
| `shared`     | If `true`, one GPU buffer is shared across all materials/objects in a frame/render |
| `order`      | Determines `@group(N)` index: groups are sorted by `order` ascending |
| `updateType` | When the group should be re-uploaded: FRAME, RENDER, or OBJECT |

Three.js singletons (as of PR #33047):

| singleton     | name       | shared | order | updateType |
|---------------|------------|--------|-------|------------|
| `frameGroup`  | `'frame'`  | true   | 0     | FRAME      |
| `renderGroup` | `'render'` | true   | 0     | RENDER     |
| `objectGroup` | `'object'` | false  | 1     | OBJECT     |

**Important**: `frameGroup` and `renderGroup` both have `order: 0` but are distinct
update-frequency concepts:
- `frameGroup` — updated once per animation frame (e.g., `timeSinceStart`)
- `renderGroup` — updated once per `renderer.render()` call (e.g., camera matrices)
- `objectGroup` — updated once per object/material

### PR #33047 — Event-driven uniform group updates

Three.js PR #33047 (merged March 5, 2026) simplified uniform group handling:

1. **`updateType` on UniformGroupNode**: Each group now carries its update frequency
   directly, eliminating name-based special-casing in `NodeManager.updateGroup()`.

2. **`needsUpdate` flag**: Groups have a `needsUpdate` boolean that's set when
   `update()` is called, enabling event-driven dirty tracking.

3. **`version` counter**: Each call to `update()` increments version for precise
   change detection.

4. **Removed binding indices from BindGroup**: Dynamic index assignment at bind time
   instead of storing indices on the BindGroup object.

### UniformNode (`nodes/core/UniformNode.js`)

- Has a `.groupNode` reference (default `objectGroup`).
- Has a `.name` string (the WGSL field name within the struct).
- **No hardcoded binding number** — bindings are assigned dynamically by the builder.
- Uses `.setGroup(group)` to assign to a uniform group.
- Uses `.onRenderUpdate(cb)` or `.onObjectUpdate(cb)` for CPU→GPU data push.

### Camera uniforms (`nodes/accessors/Camera.js`)

All camera uniforms belong to **`renderGroup`** (not frameGroup!):

```js
export const cameraNear = uniform('float')
    .setName('cameraNear')
    .setGroup(renderGroup)
    .onRenderUpdate(({ camera }) => camera.near);

export const cameraFar = uniform('float')
    .setName('cameraFar')
    .setGroup(renderGroup)
    .onRenderUpdate(({ camera }) => camera.far);

export const cameraProjectionMatrix = uniform(new Matrix4())
    .setName('cameraProjectionMatrix')
    .setGroup(renderGroup)
    .onRenderUpdate(({ camera }) => camera.projectionMatrix);

export const cameraViewMatrix = uniform(new Matrix4())
    .setName('cameraViewMatrix')
    .setGroup(renderGroup)
    .onRenderUpdate(({ camera }) => camera.matrixWorldInverse);

export const cameraPosition = uniform(new Vector3())
    .setName('cameraPosition')
    .setGroup(renderGroup)
    .onRenderUpdate(({ camera }, self) => self.value.setFromMatrixPosition(camera.matrixWorld));
```

**Key insight**: Camera uniforms use `renderGroup` because the camera can change
between render calls (e.g., stereo VR rendering, portal rendering, shadow passes).

### Model/Object uniforms (`nodes/accessors/ModelNode.js`, `Object3DNode.js`)

Model matrix and normal matrix belong to **`objectGroup`**:

```js
export const modelWorldMatrix = /* Object3DNode wraps a UniformNode with objectGroup */

export const modelNormalMatrix = uniform(new Matrix3())
    .onObjectUpdate(({ object }, self) => self.value.getNormalMatrix(object.matrixWorld));
```

### User material uniforms

**Default group is `objectGroup`**. When a user calls `uniform(value)` without
`.setGroup()`, it defaults to `objectGroup`. This means user material uniforms
are packed **into the same struct** as `modelWorldMatrix` and `modelNormalMatrix`.

```js
// UniformNode constructor
constructor(value, nodeType = null) {
    // ...
    this.groupNode = objectGroup;  // DEFAULT
}
```

### NodeBuilder binding layout algorithm (WGSLNodeBuilder.js)

1. During generate pass, each `UniformNode` is registered via `getUniformFromNode()`.
2. Uniforms are bucketed by `groupNode.name` into a `NodeUniformsGroup`.
3. All uniforms in the same `NodeUniformsGroup` share ONE struct UBO.
4. Groups are sorted by `groupNode.order` ascending to assign `@group(N)`.
5. Within each group, bindings are assigned sequentially (0, 1, 2, ...) in encounter order.
6. **One struct per group** — all uniforms in `renderGroup` → one `struct render {...}`,
   all uniforms in `objectGroup` → one `struct object {...}`.

### WGSL property access

```js
// WGSLNodeBuilder.js getPropertyName()
if (node.isNodeUniform === true) {
    if (type === 'buffer' || type === 'storageBuffer') {
        return name + '.value';
    } else {
        return node.groupNode.name + '.' + name;  // e.g., "render.cameraNear"
    }
}
```

### Generated WGSL example (Three.js output)

```wgsl
struct render {
    cameraNear: f32,
    cameraFar: f32,
    cameraProjectionMatrix: mat4x4<f32>,
    cameraViewMatrix: mat4x4<f32>,
    cameraPosition: vec3<f32>,
}
@group(0) @binding(0) var<uniform> render: render;

struct object {
    modelWorldMatrix: mat4x4<f32>,
    modelNormalMatrix: mat3x3<f32>,
    roughness: f32,           // user material uniform
    baseColor: vec4<f32>,     // user material uniform
}
@group(1) @binding(0) var<uniform> object: object;

@group(1) @binding(1) var albedoTex: texture_2d<f32>;
@group(1) @binding(2) var albedoTex_sampler: sampler;
```

Access in shader body:
```wgsl
let proj = render.cameraProjectionMatrix;
let model = object.modelWorldMatrix;
let rough = object.roughness;
```

---

## What gpucat currently does (and what is wrong)

| concern | current state | problem |
|---------|--------------|---------|
| `UniformNode` | has `group: 'material' \| 'frame' \| 'mesh' \| 'compute_frame'` and `binding: number \| null` | binding hardcoded; no `UniformGroupNode` object |
| Camera uniforms | `new UniformNode('mat4x4f', 'cameraViewMatrix', 'frame', 1)` | Wrong group (`frame` instead of `render`), hardcoded binding |
| Mesh uniforms | `new UniformNode('mat4x4f', 'meshModelMatrix', 'mesh', 0)` | Hardcoded binding, separate `'mesh'` group instead of `objectGroup` |
| Material uniforms | `group: 'material'` with binding = null | Separate group instead of merging into `objectGroup` |
| WGSL emit | flat `var<uniform> cameraViewMatrix : mat4x4f;` per field | Three.js packs all group uniforms into a single struct UBO |
| Renderer upload | Individual GPU buffers per field (`_camProjKey`, etc.) | Three.js uses one buffer per group |
| Binding assignment | Hardcoded in node constructors | Three.js assigns dynamically at build time |
| Property access | `cameraViewMatrix` (flat) | Three.js uses `render.cameraViewMatrix` |

The previous session introduced `FixedUniformEntry` / `fixedUniformNodes` —
this is an intermediate workaround and must be removed.

---

## Target state after the refactor

### WGSL output for a shader using camera + mesh + material uniforms

```wgsl
// Group 0: render uniforms (camera, shared across all objects in a render call)
struct render {
    cameraProjectionMatrix : mat4x4f,
    cameraViewMatrix       : mat4x4f,
    cameraPosition         : vec3f,
    cameraNear             : f32,
    cameraFar              : f32,
}
@group(0) @binding(0) var<uniform> render : render;

// Group 0, binding 1+: frame uniforms if used (time, etc.)
// (or merged into render struct if we conflate frame/render)
struct frame {
    timeElapsed : f32,
    timeDelta   : f32,
}
@group(0) @binding(1) var<uniform> frame : frame;

// Group 1: object uniforms (mesh + material, re-uploaded per object)
struct object {
    modelWorldMatrix  : mat4x4f,
    modelNormalMatrix : mat3x3f,
    roughness         : f32,          // user material uniform
    baseColor         : vec4f,        // user material uniform
}
@group(1) @binding(0) var<uniform> object : object;

// Group 1, binding 1+: textures, samplers, storage
@group(1) @binding(1) var albedoTex : texture_2d<f32>;
@group(1) @binding(2) var albedoSamp : sampler;
```

### GPU buffer layout

- **Render group buffer**: One `GPUBuffer` for `struct render`, uploaded once per render call.
- **Frame group buffer**: One `GPUBuffer` for `struct frame`, uploaded once per frame.
  (Alternative: merge frame into render for simplicity — gpucat doesn't need the distinction yet.)
- **Object group buffer**: One `GPUBuffer` for `struct object`, uploaded once per mesh per frame.
  Contains BOTH mesh builtins (model/normal matrix) AND user material uniforms.

### Simplification decision: merge frame into render

For gpucat's initial implementation, we can simplify by treating `frameGroup` and
`renderGroup` as the same thing. Both have `order: 0` and both are shared. The only
difference is update frequency (per-frame vs per-render-call), which matters for
multi-camera rendering but not for our initial use case.

**Decision**: Use a single `renderGroup` for camera + time uniforms. All go into
`struct render` at `@group(0) @binding(0)`.

---

## Phases

### Phase 1 — `UniformGroupNode` and updated `UniformNode` in `nodes.ts`

**Add** a new `UniformGroupNode` class:
```ts
export class UniformGroupNode {
    readonly name: string;
    readonly shared: boolean;
    readonly order: number;
    constructor(name: string, shared: boolean, order: number) {
        this.name = name;
        this.shared = shared;
        this.order = order;
    }
}

export const uniformGroup = (name: string) => new UniformGroupNode(name, false, 1);
export const sharedUniformGroup = (name: string, order = 0) => new UniformGroupNode(name, true, order);

export const renderGroup = /*@__PURE__*/ sharedUniformGroup('render', 0);
export const objectGroup = /*@__PURE__*/ uniformGroup('object');
```

**Update** `UniformNode`:
```ts
export class UniformNode<T extends WgslType> extends Node<T> {
    /** Uniform group — determines @group index and struct packing. */
    readonly groupNode: UniformGroupNode;
    /** Field name within the struct. */
    readonly name: string;
    /** CPU-side value. */
    value: number | number[] | Float32Array | null = null;
    /** Version counter for dirty tracking. */
    version: number = 0;

    constructor(type: T, name: string, groupNode: UniformGroupNode = objectGroup) {
        super(computeId('uniform', { type, name, groupNode: groupNode.name }), 'uniform', type);
        this.name = name;
        this.groupNode = groupNode;
    }
}
```

**Update** builtin singletons:
```ts
// Camera uniforms — renderGroup
export const cameraProjectionMatrix = new UniformNode('mat4x4f', 'cameraProjectionMatrix', renderGroup);
export const cameraViewMatrix       = new UniformNode('mat4x4f', 'cameraViewMatrix',       renderGroup);
export const cameraPosition         = new UniformNode('vec3f',   'cameraPosition',         renderGroup);
export const cameraNear             = new UniformNode('f32',     'cameraNear',             renderGroup);
export const cameraFar              = new UniformNode('f32',     'cameraFar',              renderGroup);

// Time uniforms — renderGroup (merged for simplicity)
export const timeElapsed = new UniformNode('f32', 'timeElapsed', renderGroup);
export const timeDelta   = new UniformNode('f32', 'timeDelta',   renderGroup);

// Mesh uniforms — objectGroup
export const modelWorldMatrix  = new UniformNode('mat4x4f', 'modelWorldMatrix',  objectGroup);
export const modelNormalMatrix = new UniformNode('mat3x3f', 'modelNormalMatrix', objectGroup);
```

**Update** user-facing `uniform()`:
- Default group remains `objectGroup` (matches Three.js).
- Remove the `binding` parameter entirely.

**Remove**: `UniformGroup` string union type, `binding` field.

---

### Phase 2 — WGSL emission in `compile.ts`

The compiler must:

1. **Collect uniforms by group**: During setup pass, bucket `UniformNode`s by
   `groupNode.name` into a `Map<string, UniformNode[]>` (deduped, encounter order).

2. **Assign group indices**: Sort groups by `groupNode.order`, assign `@group(N)`
   in sorted order (N = 0, 1, 2, ...).

3. **Emit one struct per group**: For each group:
   ```wgsl
   struct <groupName> {
       <field1> : <type1>,
       <field2> : <type2>,
       ...
   }
   @group(N) @binding(0) var<uniform> <groupName> : <groupName>;
   ```

4. **Assign binding indices within group**: Struct UBO always gets binding 0.
   Textures, samplers, storage buffers follow at binding 1, 2, 3, ... within
   the same group.

5. **Update property access**: `UniformNode` generates `groupName.fieldName`
   (e.g., `render.cameraViewMatrix`, `object.modelWorldMatrix`).

6. **Track struct layout metadata**: `CompileResult` includes:
   ```ts
   type UniformGroupBlock = {
       groupName: string;
       groupIndex: number;
       binding: number;  // always 0 for struct UBO
       members: UniformMember[];
       totalBytes: number;
   };
   uniformGroups: UniformGroupBlock[];
   ```

7. **Remove**:
   - `FixedUniformEntry`, `fixedUniformNodes`
   - `builtinsUsed.has('camera')` / `builtinsUsed.has('mesh')` checks
   - Hardcoded binding constants

---

### Phase 3 — Renderer uniform upload in `renderer.ts`

**New approach**: One buffer per uniform group.

```ts
class Renderer {
    // Per-group GPU buffers (keyed by groupName)
    _uniformGroupBuffers: Map<string, GPUBuffer> = new Map();

    // Per-group CPU staging arrays (keyed by groupName)
    _uniformGroupData: Map<string, Float32Array> = new Map();
}
```

**Upload logic**:

1. For each `UniformGroupBlock` in `CompileResult.uniformGroups`:
   - Ensure GPU buffer exists with correct size.
   - For shared groups (`renderGroup`): upload once per render call.
   - For per-object groups (`objectGroup`): upload once per object draw.

2. The struct layout (field offsets) comes from `UniformGroupBlock.members`.

3. **Per-field dirty tracking** (optional optimization): Check each `UniformNode.version`
   and only upload changed ranges. For initial implementation, just re-upload the
   entire buffer each time.

**Remove**:
- `_camProjKey`, `_camViewKey`, `_camPosKey`, `_camNearKey`, `_camFarKey`
- `_timeElapsedKey`, `_timeDeltaKey`
- Individual per-field GPU buffers
- `meshModelMatrixKeys`, `meshNormalMatrixKeys` WeakMaps
- `_uploadCameraFields`, `_makeFrameBuffers`, `_saveCameraState`, `_restoreCameraState`
- `FrameBuffers` type

---

### Phase 4 — Bind-group construction in `bindgroups.ts`

**New helpers**:
```ts
buildUniformGroupBindGroup(
    device: GPUDevice,
    layout: GPUBindGroupLayout,
    buffer: GPUBuffer,
): GPUBindGroup

buildObjectGroupBindGroup(
    device: GPUDevice,
    layout: GPUBindGroupLayout,
    objectBuffer: GPUBuffer,
    textures: GPUTextureView[],
    samplers: GPUSampler[],
    storageBuffers: GPUBuffer[],
): GPUBindGroup
```

**Remove**:
- `FrameBuffers`
- `buildFrameBindGroup`
- `buildMeshBindGroup`

---

### Phase 5 — Pipeline layout in `pipeline.ts` / `compute-pipeline.ts`

Update `_buildLayoutN` helpers to:

1. Query `CompileResult.uniformGroups` for which groups are used.
2. For each group with `groupIndex === N`:
   - Entry 0: uniform buffer (the struct UBO).
   - Entry 1+: textures, samplers, storage (existing logic).

**Group 0** (renderGroup): Struct UBO at binding 0.
**Group 1** (objectGroup): Struct UBO at binding 0, then textures/samplers/storage.

---

### Phase 6 — Compute shader support

For compute shaders:
- Time uniforms (`timeElapsed`, `timeDelta`) go into a `computeRender` group at `@group(1)`.
- Storage buffers go at `@group(0)`.
- Same struct-packing pattern applies.

---

### Phase 7 — Cleanup

- Remove `builtinsUsed` from `CompileResult` (replaced by checking
  `uniformGroups.find(g => g.groupName === 'render') !== undefined`).
- Remove `FixedUniformEntry` type.
- Remove dead code from `renderer.ts`.
- Update tests.

---

## Files to change (summary)

| file | change |
|------|--------|
| `src/nodes/nodes.ts` | Add `UniformGroupNode`; update `UniformNode` (remove `binding`/`group`, add `groupNode`); update singletons; rename `meshModelMatrix` → `modelWorldMatrix`, `meshNormalMatrix` → `modelNormalMatrix` |
| `src/nodes/compile.ts` | Bucket uniforms by group; emit struct UBOs; update property access; update `CompileResult` |
| `src/renderer/bindgroups.ts` | New helpers for struct-UBO bind groups |
| `src/renderer/pipeline.ts` | Update layout descriptors |
| `src/renderer/compute-pipeline.ts` | Same layout update for compute |
| `src/renderer/renderer.ts` | Single buffer per group; remove per-field upload logic |

## Files NOT to change

- `src/nodes/pass-node.ts` (already correct)
- `src/scene/object3d.ts` (already correct)
- `src/inspector/` files (pre-existing errors, out of scope)
- `src/nodes/render-output.ts` (pre-existing errors, out of scope)

---

## Constraints and non-goals

- The user-facing API (`gpu.timeElapsed`, `gpu.cameraViewMatrix`, etc.) must
  not change shape — only the internal WGSL output changes.
- The `@group` / `@binding` numbers themselves **will change** — they are
  internal implementation details.
- No new user-facing APIs are added.
- For initial implementation, we do NOT implement `frameGroup` separately —
  all shared uniforms go into `renderGroup`.

---

## Migration notes

### Renamed exports

| old name | new name |
|----------|----------|
| `meshModelMatrix` | `modelWorldMatrix` |
| `meshNormalMatrix` | `modelNormalMatrix` |

The old names should be kept as deprecated aliases initially.

### Breaking changes

- Generated WGSL will look different (struct access instead of flat vars).
- Binding numbers will change (but this is an internal detail).
- `UniformNode` no longer has a `binding` property.
- `UniformNode.group` (string) is replaced by `UniformNode.groupNode` (object).

---

## Summary table: uniform grouping

| uniform | group | updated | WGSL access |
|---------|-------|---------|-------------|
| `cameraProjectionMatrix` | `renderGroup` | per render call | `render.cameraProjectionMatrix` |
| `cameraViewMatrix` | `renderGroup` | per render call | `render.cameraViewMatrix` |
| `cameraPosition` | `renderGroup` | per render call | `render.cameraPosition` |
| `cameraNear` | `renderGroup` | per render call | `render.cameraNear` |
| `cameraFar` | `renderGroup` | per render call | `render.cameraFar` |
| `timeElapsed` | `renderGroup` | per frame | `render.timeElapsed` |
| `timeDelta` | `renderGroup` | per frame | `render.timeDelta` |
| `modelWorldMatrix` | `objectGroup` | per object | `object.modelWorldMatrix` |
| `modelNormalMatrix` | `objectGroup` | per object | `object.modelNormalMatrix` |
| user material uniform | `objectGroup` | per object | `object.<name>` |
