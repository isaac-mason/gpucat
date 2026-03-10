# Low-Level API Design Spike

## The question

The current gpucat API has three scene-graph abstractions sitting between the user and WebGPU:

- `Scene` — container that gets iterated for draw calls
- `Mesh` — pairs a `Geometry` with a `Material`; owns a world transform
- `Material` — owns the node graph (vertex + fragment) and render state flags

What if we dropped all three and stayed node-based, but made the API map directly onto WebGPU concepts?

---

## What WebGPU actually needs per draw call

A single indexed draw call in raw WebGPU requires exactly these resources to be set before `draw*()`:

```
GPURenderPassEncoder
  .setPipeline(GPURenderPipeline)          ← compiled from vertex+fragment WGSL + pipeline descriptor
  .setBindGroup(0, GPUBindGroup)           ← @group(0): e.g. per-frame uniforms
  .setBindGroup(1, GPUBindGroup)           ← @group(1): e.g. per-render uniforms
  .setBindGroup(2, GPUBindGroup)           ← @group(2): e.g. per-object uniforms + storage buffers
  .setVertexBuffer(0, GPUBuffer)           ← slot 0: e.g. position
  .setVertexBuffer(1, GPUBuffer)           ← slot 1: e.g. normal
  .setIndexBuffer(GPUBuffer, 'uint32')
  .drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance)
```

A `GPURenderPipeline` is compiled from:
- A WGSL shader module (vertex + fragment entry points)
- `GPUVertexBufferLayout[]` — one per `setVertexBuffer` slot, describing stride + attribute formats
- `GPUPipelineLayout` — one `GPUBindGroupLayout` per `@group(N)`
- Render state: `cullMode`, `depthCompare`, `depthWrite`, `blend`, `colorTargets`, `multisample`

A `GPUBindGroup` is created from a `GPUBindGroupLayout` + a list of resource entries:
- Uniform buffer — `{ buffer: GPUBuffer, offset, size }`
- Storage buffer — `{ buffer: GPUBuffer }`
- Texture view — `GPUTextureView`
- Sampler — `GPUSampler`

So the minimal inputs to one draw call are:

```
WGSL source + pipeline descriptor  →  GPURenderPipeline  (expensive, cached)
uniform data + storage buffers + textures  →  GPUBindGroup[]  (cheap-ish, rebuilt when dirty)
vertex/index buffers  →  GPUBuffer[]  (uploaded once, updated on version change)
draw parameters  →  count, instanceCount, indirect buffer
```

---

## Current abstractions → WebGPU mapping

In the current code:

| Abstraction | Provides to WebGPU |
|---|---|
| `Material.vertexNode` + `Material.fragmentNode` | The WGSL source (via node compiler) |
| `Material` flags (`cullMode`, `depthWrite`, etc.) | Pipeline descriptor render state |
| `Geometry.attributes` | `setVertexBuffer` slots + `GPUVertexBufferLayout` |
| `Geometry.index` | `setIndexBuffer` |
| `Mesh` (world matrix) | Per-object uniform (`modelWorldMatrix`) |
| `uniform(value)` nodes on `Material` | Per-object or per-frame bind group entries |
| `storage(attr)` nodes on `Material` | Storage buffer bind group entries |
| `Scene` | The list of draw calls to issue |

The issues:
- The node graph (shader) and per-mesh data (buffers, transforms) are coupled — a `storage(myBuffer)` node in the material is married to one specific buffer at compile time
- `Scene` is a scene graph (parent/child transform hierarchy) even though most GPU-oriented code never needs that
- `Mesh` forces you into `Object3D` inheritance even if you don't want world matrix hierarchy

---

## Proposed low-level API

### Core idea

Replace `Mesh + Material + Scene` with a single `DrawCall` value type that pairs the shader graph with explicit per-draw-call resource bindings. The shader declares *names*; the draw call provides the *data*.

```ts
type DrawCall = {
  // Shader definition (what the pipeline is compiled from)
  vertex:   Node<vec4f>     // clip-space position
  fragment: Node<vec4f>     // color out (or MRTNode)

  // Per-draw-call resource bindings (resolved by name at bind time)
  bindings: DrawBindings

  // Pipeline render state
  pipeline?: PipelineState

  // Draw parameters
  drawArgs: DrawArgs
}

type DrawBindings = {
  // Vertex buffers — keyed by the name used in attribute('name') nodes
  attributes?: Record<string, BufferAttribute>
  // Index buffer
  index?: IndexAttribute
  // Storage buffers — keyed by the name used in storageAttribute('name') nodes
  storage?: Record<string, StorageBufferAttribute>
  // Uniform values — keyed by the name used in uniform('name') nodes
  uniforms?: Record<string, UniformValue>
  // Textures — keyed by the name used in texture('name') nodes
  textures?: Record<string, Texture>
}

type DrawArgs =
  | { kind: 'indexed';   indexCount: number; instanceCount?: number }
  | { kind: 'direct';    vertexCount: number; instanceCount?: number }
  | { kind: 'indirect';  buffer: StorageBufferAttribute }
```

### Shader declarations

In the node graph, resources are declared by name. The name is purely a binding key — it does not imply anything about the data until a `DrawCall` is issued.

```ts
// Declare a vertex attribute by name
const pos    = attribute('position', d.vec3f)

// Declare a storage buffer by name (read-only by default)
const pts    = storageAttribute('particles', d.array(d.vec3f))

// Declare a named uniform (scalar, vector, matrix, struct)
const color  = uniformValue('tint', d.vec4f)

// Declare a named texture
const tex    = textureValue('albedo')

// These are reusable — they carry no data themselves
```

### Frame/render-level resources

Frame and render uniforms (camera matrices, time, screen size) are still declared as nodes but are provided to the renderer at a higher level, not per-draw-call:

```ts
// These already exist as built-ins — no change needed
cameraProjectionMatrix   // @group(0) per-frame uniform
cameraViewMatrix         // @group(0) per-frame uniform
timeElapsed              // @group(0) per-frame uniform
```

The renderer still manages these automatically when given a camera + frame state.

### Issuing draw calls

```ts
const sharedShader = {
  vertex:   vec4(attribute('position', d.vec3f), f32(1)),  // trivial passthrough
  fragment: uniformValue('tint', d.vec4f),
}

// Two draw calls sharing the same shader, different data
const drawA: DrawCall = {
  ...sharedShader,
  bindings: {
    attributes: { position: bufferA },
    uniforms:   { tint: [1, 0, 0, 1] },
  },
  drawArgs: { kind: 'indexed', indexCount: 36 },
}

const drawB: DrawCall = {
  ...sharedShader,
  bindings: {
    attributes: { position: bufferB },
    uniforms:   { tint: [0, 1, 0, 1] },
    storage:    { particles: particleBuffer },
  },
  drawArgs: { kind: 'indirect', buffer: indirectBuf },
}
```

### Composing into a render pass

Instead of a `Scene`, draw calls are composed explicitly:

```ts
const scenePass = renderPass(camera, [drawA, drawB], {
  colorFormat: 'bgra8unorm',
  depthFormat: 'depth24plus',
  samples: 4,
})

// renderPass returns a Node<texture> — same as today's pass()
renderer.render(postProcess(scenePass))
```

Or for fullscreen compute + compositing without a camera:

```ts
renderer.render(
  tonemapNode(
    renderPass(camera, drawCalls)
  )
)
```

---

## How this maps to WebGPU

### Pipeline compilation

A `GPURenderPipeline` is keyed by:
1. The node graph identity of `vertex` + `fragment` (same as today's `cacheKey`)
2. The `GPUVertexBufferLayout[]` derived from the `attributes` names declared in the graph
3. The `PipelineState` flags on the draw call

Since the shader graph is shared across draw calls, the pipeline is compiled once and reused — identical to today.

The difference: `GPUVertexBufferLayout` is now derived from the declared attribute *names* and their *types* (from `d.vec3f` etc.) rather than from `geometry.attributes`. The layout is still the same data, just sourced from the node graph's type information rather than from the geometry object.

### Bind groups

`GPUBindGroup` creation maps as follows:

| Binding source | @group(N) | Rebuilt when |
|---|---|---|
| Frame uniforms (camera, time) | 0 | Per frame (camera moves, time changes) |
| Render uniforms (render target size, etc.) | 1 | Per render pass |
| Per-draw uniforms + storage + textures | 2 | Buffer/texture identity changes |

The per-draw bind group (group 2) is rebuilt when any resource in `drawCall.bindings` changes identity (new buffer object, resized buffer, new texture). This is where the storage buffer reassignment problem is solved — swapping `drawCall.bindings.storage.particles = newBuffer` naturally triggers a bind group rebuild on the next frame.

No mutation of the node graph is needed.

### Vertex buffers

```ts
// Node graph declares:
const pos = attribute('position', d.vec3f)

// Draw call provides:
bindings: { attributes: { position: myPositionBuffer } }

// Renderer maps to:
pass.setVertexBuffer(slot, uploadVertex(myPositionBuffer))
```

The slot number is still determined by the order attributes are encountered during compilation, exactly as today.

### Storage buffers

```ts
// Node graph declares:
const pts = storageAttribute('particles', d.array(d.vec3f))
// emits:  @group(2) @binding(N) var<storage, read> particles: array<vec3f>

// Draw call provides:
bindings: { storage: { particles: myStorageBuffer } }

// Renderer maps to:
pass.setBindGroup(2, rebuildIfDirty({ ..., particles: uploadStorage(myStorageBuffer) }))
```

Two draw calls with the same shader but different `particles` buffers each get their own `GPUBindGroup` for group 2. Groups 0 and 1 (frame/render) are shared as today.

### The world transform problem

Without `Mesh` there is no `modelWorldMatrix`. A transform is just another uniform — declared explicitly in the shader and provided in the draw call bindings:

```ts
const worldMatrix = uniformValue('modelMatrix', d.mat4x4f)
const clipPos = cameraProjectionMatrix.mul(cameraViewMatrix).mul(worldMatrix).mul(vec4(pos, f32(1)))

// Per draw call:
bindings: {
  uniforms: { modelMatrix: myMesh.worldMatrix },
  ...
}
```

This is more verbose but removes the magic. If you want hierarchy, build it in user space and pass the computed matrix in.

Alternatively, the renderer can provide a thin `Transform` helper that computes and provides `modelMatrix` automatically — but it's not part of the core API.

---

## What changes vs. what stays

### Stays exactly the same

- The entire node DSL (`vec3`, `Fn`, `wgsl`, `uniform`, `varying`, `compute`, etc.)
- `builder.ts` — the WGSL compiler. No changes to code generation.
- Pipeline caching — still keyed by node graph identity + pipeline state
- Buffer upload (`buffers.ts`) — same `uploadVertex`, `uploadStorage`, `uploadRaw`
- Bind group management (`bindings.ts`) — same rebuild logic, just sourced differently
- Compute API — already close to this model, essentially unchanged
- `RenderTarget`, `Texture`, MRT — unchanged

### Changes

| Current | Replacement |
|---|---|
| `Scene` (scene graph container) | `DrawCall[]` plain array, or a `batch()` node |
| `Mesh` (Object3D + geometry + material) | `DrawCall` value type |
| `Material` (node graph + render flags) | `{ vertex, fragment, pipeline? }` plain object (no class) |
| `Geometry` (attribute map + index) | `DrawBindings.attributes` + `DrawBindings.index` on the draw call |
| `storage(attr)` node holds data | `storageAttribute('name')` declares; draw call provides data |
| `bufferAttribute(attr)` node holds data | `attribute('name', type)` declares; draw call provides data |
| `Object3D` world matrix | explicit `uniformValue('modelMatrix', d.mat4x4f)` in shader |
| `pass(scene, camera)` | `renderPass(camera, drawCalls, opts)` |

### What this means for the storage buffer problem

The original problem was: how do you reuse the same material with different storage buffers on different meshes?

In this model the question dissolves. There is no "material" that owns the storage node. The shader declares a name. Each draw call provides its own buffer under that name. Resize a buffer? Replace `drawCall.bindings.storage.particles`. The renderer detects the new identity at bind-group-rebuild time and issues a new `GPUBindGroup`. No node graph mutation, no `StorageNode.value` setter needed.

---

## Open questions

1. **Named uniforms vs. node-graph uniforms** — today `uniform(value)` carries the actual JS value and the node graph pulls from it directly. In the new model, `uniformValue('tint', d.vec4f)` is name-only and the value comes from `drawCall.bindings.uniforms`. These are two different mental models. Should they coexist? Named uniforms are more flexible; node-owned uniforms are more ergonomic for truly-shared values (e.g. a noise function that always uses the same frequency).

2. **Transform hierarchy** — if users want parent/child transforms, they need to manage that in user space. Is a lightweight `Transform` class (no `Object3D` inheritance, just a mat4 that updates children) worth providing as a utility?

3. **Frustum culling** — currently the renderer culls against `geometry.boundingBox`. Without a `Geometry` object, bounding volumes must be supplied differently — either on the `DrawCall` directly, or by a separate culling pass that filters the `DrawCall[]` before it reaches the renderer.

4. **Instancing** — today `mesh.count > 1` triggers instancing. In the new model, `drawArgs.instanceCount` is explicit. Per-instance data flows through `storageAttribute('instanceData')` and is indexed by `instanceIndex`. No change in concept, slightly more explicit.

5. **Indirect draw** — `drawArgs: { kind: 'indirect', buffer: indirectBuf }` maps directly to `drawIndirect` / `drawIndexedIndirect`. The buffer needs `INDIRECT | STORAGE | COPY_DST` usage. This is already handled in `buffers.uploadIndirect`.

6. **Shader sharing and pipeline cache key** — two `DrawCall`s with the same `vertex`/`fragment` node objects (same JS reference) produce the same `cacheKey` and reuse the same `GPURenderPipeline`. What if the user creates two structurally-identical but distinct node graph objects? Today this would produce two pipelines. This is the same situation as today — not a regression.
