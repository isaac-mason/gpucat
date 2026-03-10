# Node-GPU API Design Spike

*A TypeGPU-inspired low-level API for gpucat: no Mesh, no Material, no Scene, no Camera — just typed buffers, explicit pipelines, bind groups, and gpucat's node DSL for shader authoring.*

---

## Philosophy

TypeGPU is a type-safe wrapper around WebGPU. It doesn't generate WGSL — you write WGSL (or use their typed DSL), and TypeGPU ensures your TypeScript types match your shader bindings. It's *explicit*: you declare bind group layouts, vertex layouts, pipelines, and buffers as separate first-class objects, then wire them together at draw time.

gpucat already has something TypeGPU doesn't: **a node graph DSL that compiles to WGSL**. The shader isn't a string — it's a composable expression tree. This is the differentiator.

The question: what if gpucat adopted TypeGPU's *resource model* (typed buffers, explicit layouts, immutable pipelines) while keeping the node graph as the shader authoring layer?

---

## Core Concepts

### 1. The Root (`gpu`)

Everything starts with a root that owns the device:

```ts
import { init } from 'gpucat'

const gpu = await init() // wraps GPUDevice
// or: const gpu = initFromDevice(existingDevice)
```

The `gpu` root is the factory for all resources. It owns the device and manages lifetime.

**Maps to WebGPU:**
- `navigator.gpu.requestAdapter()` + `adapter.requestDevice()`
- The returned `gpu` wraps `GPUDevice`

---

### 2. Typed Buffers

Buffers are first-class typed objects. The schema defines the memory layout. The buffer *is* the GPU resource — no `BufferAttribute` wrapper, no `version` flag.

```ts
import { d } from 'gpucat'

// Create a vertex buffer
const positionBuffer = gpu.buffer(d.array(d.vec3f, 1000), {
  usage: 'vertex',
  label: 'positions',
})

// Create a storage buffer
const particleBuffer = gpu.buffer(d.array(Particle, 10000), {
  usage: 'storage',
  label: 'particles',
})

// Create a uniform buffer
const transformBuffer = gpu.buffer(d.mat4x4f, {
  usage: 'uniform',
  label: 'modelMatrix',
})
```

Buffers can have multiple usages:

```ts
const indirectBuffer = gpu.buffer(DrawIndirectArgs, {
  usage: 'storage | indirect',
})
```

**Writing data:**

```ts
// Write typed data (validates against schema)
positionBuffer.write([
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  // ...
])

// Write raw bytes
positionBuffer.writeRaw(float32Array)
```

**Maps to WebGPU:**
- `device.createBuffer({ size, usage, mappedAtCreation })`
- `device.queue.writeBuffer(buffer, offset, data)`
- The schema (`d.array(d.vec3f)`) determines `size` and validates writes

---

### 3. Bind Group Layouts

Bind group layouts are declared explicitly and named. They define what the shader expects at each `@group(N)`.

```ts
const sceneLayout = gpu.bindGroupLayout({
  camera: { type: 'uniform', schema: CameraUniforms },
  time: { type: 'uniform', schema: d.f32 },
})

const objectLayout = gpu.bindGroupLayout({
  modelMatrix: { type: 'uniform', schema: d.mat4x4f },
  particles: { type: 'storage', schema: d.array(Particle), access: 'read' },
  velocities: { type: 'storage', schema: d.array(d.vec3f), access: 'read_write' },
})
```

**Creating bind groups from layouts:**

```ts
const sceneBindGroup = sceneLayout.bindGroup({
  camera: cameraBuffer,
  time: timeBuffer,
})

const objectBindGroup = objectLayout.bindGroup({
  modelMatrix: transformBuffer,
  particles: particleBuffer,
  velocities: velocityBuffer,
})
```

This is **type-safe at the TS level** — you can't pass a `TgpuBuffer<mat4x4f>` where a `TgpuBuffer<vec3f>` is expected.

**Maps to WebGPU:**
- `device.createBindGroupLayout({ entries: [...] })`
- `device.createBindGroup({ layout, entries: [...] })`

---

### 4. Vertex Layouts

Vertex layouts describe the structure of vertex buffers. They map to `GPUVertexBufferLayout`.

```ts
const meshVertexLayout = gpu.vertexLayout({
  position: d.vec3f,
  normal: d.vec3f,
  uv: d.vec2f,
})

// Instanced layout (stepMode: 'instance')
const instanceLayout = gpu.vertexLayout({
  instanceMatrix: d.mat4x4f,
}, { stepMode: 'instance' })
```

**Maps to WebGPU:**
- `GPUVertexBufferLayout { arrayStride, stepMode, attributes }`
- Attribute formats derived from schema (`d.vec3f` → `'float32x3'`)

---

### 5. Shader Functions (Using the Node DSL)

Here's where gpucat diverges from TypeGPU. Instead of writing WGSL strings or using a separate typed DSL, you use **gpucat's existing node graph**. The difference: entry point functions are declared with explicit input/output schemas.

```ts
import { vertexFn, fragmentFn, varying } from 'gpucat'

// Vertex function shell — declares inputs and outputs
const mainVertex = vertexFn(
  // Inputs (from vertex buffers)
  { position: d.vec3f, normal: d.vec3f, uv: d.vec2f },
  // Outputs (varyings to fragment)
  { clipPosition: d.vec4f, vNormal: d.vec3f, vUv: d.vec2f },
  // Implementation using node graph
  (inputs, uniforms) => {
    const worldPos = uniforms.modelMatrix.mul(vec4(inputs.position, f32(1)))
    const clipPos = uniforms.viewProjection.mul(worldPos)
    return {
      clipPosition: clipPos,
      vNormal: inputs.normal,
      vUv: inputs.uv,
    }
  }
)

// Fragment function
const mainFragment = fragmentFn(
  // Inputs (varyings from vertex)
  { vNormal: d.vec3f, vUv: d.vec2f },
  // Outputs (render targets)
  { color: d.vec4f },
  (inputs, uniforms) => {
    const light = normalize(vec3(1, 1, 1))
    const ndotl = max(dot(inputs.vNormal, light), f32(0.1))
    return {
      color: vec4(vec3(ndotl), f32(1)),
    }
  }
)
```

The `uniforms` parameter is typed based on the bind group layouts attached to the pipeline (see below).

**What happens internally:**
- gpucat's `builder.ts` compiles these to WGSL
- The node graph is traversed, WGSL is emitted
- Binding metadata is extracted for bind group layout generation

**Maps to WebGPU:**
- The compiled WGSL string
- `device.createShaderModule({ code })`

---

### 6. Render Pipelines

Pipelines are created explicitly from shader functions, vertex layouts, and bind group layouts. Once created, they're immutable.

```ts
const pipeline = gpu.renderPipeline({
  vertex: mainVertex,
  fragment: mainFragment,
  vertexLayouts: [meshVertexLayout],
  bindGroupLayouts: [sceneLayout, objectLayout],
  primitive: {
    topology: 'triangle-list',
    cullMode: 'back',
  },
  depthStencil: {
    format: 'depth24plus',
    depthWriteEnabled: true,
    depthCompare: 'less',
  },
  targets: [{ format: 'bgra8unorm' }],
})
```

The pipeline compilation happens once. No version bumps, no recompile-on-the-fly. If you need a different pipeline, create a new one.

**Maps to WebGPU:**
- `device.createRenderPipeline({ vertex, fragment, primitive, depthStencil, ... })`
- `device.createPipelineLayout({ bindGroupLayouts })`

---

### 7. Compute Pipelines

Same pattern for compute:

```ts
const computeFn = gpu.computeFn(
  { workgroupSize: [64, 1, 1] },
  (builtins, uniforms) => {
    const idx = builtins.globalInvocationId.x
    const p = uniforms.particles.at(idx)
    const v = uniforms.velocities.at(idx)
    uniforms.particles.set(idx, p.add(v.mul(uniforms.dt)))
  }
)

const computePipeline = gpu.computePipeline({
  compute: computeFn,
  bindGroupLayouts: [computeLayout],
})
```

**Maps to WebGPU:**
- `device.createComputePipeline({ compute: { module, entryPoint } })`

---

### 8. Render Pass Execution

Render passes mirror the WebGPU encoder API but with typed resources:

```ts
gpu.submit((encoder) => {
  // Render pass
  encoder.renderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: [0, 0, 0, 1],
    }],
    depthStencilAttachment: {
      view: depthTexture.createView(),
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
      depthClearValue: 1,
    },
  }, (pass) => {
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, sceneBindGroup)
    pass.setBindGroup(1, objectBindGroup)
    pass.setVertexBuffer(0, positionBuffer)
    pass.setIndexBuffer(indexBuffer, 'uint32')
    pass.drawIndexed(indexCount)
  })

  // Compute pass
  encoder.computePass((pass) => {
    pass.setPipeline(computePipeline)
    pass.setBindGroup(0, computeBindGroup)
    pass.dispatchWorkgroups(Math.ceil(particleCount / 64))
  })
})
```

**Maps to WebGPU:**
- `device.createCommandEncoder()`
- `encoder.beginRenderPass(descriptor)` → `GPURenderPassEncoder`
- `pass.setPipeline()`, `pass.setBindGroup()`, `pass.setVertexBuffer()`, `pass.draw()`
- `encoder.finish()` → `device.queue.submit([commandBuffer])`

---

## The Key Difference from TypeGPU

| Aspect | TypeGPU | gpucat (proposed) |
|--------|---------|-------------------|
| Shader authoring | WGSL strings or typed WGSL DSL | Node graph → compiles to WGSL |
| Buffer types | Typed wrappers | Typed wrappers (similar) |
| Bind groups | Explicit layouts | Explicit layouts (similar) |
| Pipelines | Explicit creation | Explicit creation (similar) |
| Slots (late binding) | `TgpuSlot` for dynamic values | **Bind groups swapped at draw time** |

TypeGPU has `TgpuSlot` — a placeholder in the shader that gets filled at execution time. gpucat achieves the same thing differently: **the shader declares what bind groups it needs, but the actual buffers are provided via bind group creation and `setBindGroup()` calls**. The shader doesn't hold references to specific buffers — it holds references to bind group *slots*.

This solves the original storage buffer problem: the shader graph says "I need a storage buffer of `array<vec3f>` at group 2 binding 0", but doesn't specify *which* buffer. Two draw calls with the same pipeline can bind different buffers.

---

## What About the Node Graph Compositing Layer?

gpucat currently has a higher-level API for compositing:

```ts
renderer.render(
  tonemap(
    bloom(
      pass(scene, camera)
    )
  )
)
```

This layer can *sit on top* of the low-level API. The `pass()` node internally creates render passes, manages render targets, etc. But the primitives underneath are the explicit buffers/pipelines/bind groups described above.

This gives two API tiers:
1. **Low-level**: explicit pipelines, bind groups, draw calls (this doc)
2. **High-level**: node graph compositing, optional scene abstractions (existing API)

Users who want full control use tier 1. Users who want convenience use tier 2.

---

## Comparison: Drawing a Mesh

### Current gpucat (high-level)

```ts
const geometry = new Geometry()
geometry.setAttribute('position', positionAttr)
geometry.setIndex(indexAttr)

const material = new Material()
material.vertexNode = /* ... */
material.fragmentNode = /* ... */

const mesh = new Mesh(geometry, material)
scene.add(mesh)

renderer.render(pass(scene, camera))
```

### Proposed low-level API

```ts
// Buffers
const positionBuffer = gpu.buffer(d.array(d.vec3f, vertexCount), { usage: 'vertex' })
const indexBuffer = gpu.buffer(d.array(d.u32, indexCount), { usage: 'index' })
positionBuffer.write(positions)
indexBuffer.write(indices)

// Layouts
const sceneLayout = gpu.bindGroupLayout({
  viewProjection: { type: 'uniform', schema: d.mat4x4f },
})
const objectLayout = gpu.bindGroupLayout({
  modelMatrix: { type: 'uniform', schema: d.mat4x4f },
})

// Shaders
const vertexFn = /* node graph as shown above */
const fragmentFn = /* node graph as shown above */

// Pipeline
const pipeline = gpu.renderPipeline({
  vertex: vertexFn,
  fragment: fragmentFn,
  vertexLayouts: [gpu.vertexLayout({ position: d.vec3f })],
  bindGroupLayouts: [sceneLayout, objectLayout],
  /* ... */
})

// Bind groups
const sceneBindGroup = sceneLayout.bindGroup({ viewProjection: vpBuffer })
const objectBindGroup = objectLayout.bindGroup({ modelMatrix: modelBuffer })

// Draw
gpu.submit((encoder) => {
  encoder.renderPass({ /* attachments */ }, (pass) => {
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, sceneBindGroup)
    pass.setBindGroup(1, objectBindGroup)
    pass.setVertexBuffer(0, positionBuffer)
    pass.setIndexBuffer(indexBuffer, 'uint32')
    pass.drawIndexed(indexCount)
  })
})
```

More verbose? Yes. More explicit? Yes. More flexible? **Yes.**

---

## Open Questions

### 1. How do shader functions reference bind group entries?

Two options:

**Option A: Named references (like current `uniform('name')` nodes)**
```ts
const viewProjection = uniform('viewProjection', d.mat4x4f)
// The bind group layout must have a matching entry
```

**Option B: Direct references to layout entries**
```ts
const layout = gpu.bindGroupLayout({
  viewProjection: { type: 'uniform', schema: d.mat4x4f },
})
// In shader:
const viewProjection = layout.entries.viewProjection
```

Option B provides better type safety but tighter coupling.

### 2. Auto-derived layouts vs explicit layouts?

TypeGPU supports both — you can let the library infer layouts from shader usage, or declare them explicitly. We should probably support both:

```ts
// Explicit (recommended for shared layouts)
const layout = gpu.bindGroupLayout({ /* ... */ })

// Auto-derived (convenient for one-offs)
const pipeline = gpu.renderPipeline({
  vertex: vertexFn,
  fragment: fragmentFn,
  // No bindGroupLayouts specified — derived from shader
})
const layouts = pipeline.bindGroupLayouts // inferred
```

### 3. What about the camera?

In the current API, camera matrices are provided automatically via `cameraProjectionMatrix`, `cameraViewMatrix` nodes.

In the low-level API, a camera is just a struct you manage yourself:

```ts
const CameraUniforms = d.struct({
  projection: d.mat4x4f,
  view: d.mat4x4f,
  position: d.vec3f,
})

const cameraBuffer = gpu.buffer(CameraUniforms, { usage: 'uniform' })

// You compute the matrices yourself
const projection = mat4.perspective(fov, aspect, near, far)
const view = mat4.lookAt(eye, target, up)
cameraBuffer.write({ projection, view, position: eye })
```

No magic. Full control.

### 4. What about textures and samplers?

Same pattern:

```ts
const texture = gpu.texture({
  size: [512, 512],
  format: 'rgba8unorm',
  usage: 'sampled | render',
})

const sampler = gpu.sampler({
  magFilter: 'linear',
  minFilter: 'linear',
})

const materialLayout = gpu.bindGroupLayout({
  albedo: { type: 'texture', schema: d.texture2d('f32') },
  albedoSampler: { type: 'sampler' },
})

const materialBindGroup = materialLayout.bindGroup({
  albedo: texture.createView(),
  albedoSampler: sampler,
})
```

### 5. How does this interact with the existing codebase?

This would be a **parallel API**, not a replacement. The high-level `Mesh`/`Material`/`Scene` API could be implemented *on top* of these primitives. Migration path:

1. Implement the low-level primitives
2. Refactor existing high-level API to use them internally
3. Both APIs coexist — users choose based on their needs

---

## Parallel API Architecture

The goal: `src/webgpu/` implements type-safe WebGPU primitives. The renderer uses them internally, but users can also use them directly for full control.

### Layer Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  User Code                                                      │
│  ┌─────────────────────┐     ┌────────────────────────────────┐ │
│  │ High-Level API      │     │ Low-Level API                  │ │
│  │ (Mesh, Material,    │     │ (Buffers, Pipelines,           │ │
│  │  Scene, Camera)     │     │  Bind Groups, Render Passes)   │ │
│  └──────────┬──────────┘     └───────────────┬────────────────┘ │
└─────────────┼────────────────────────────────┼──────────────────┘
              │ uses                           │ uses directly
              ▼                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  src/webgpu/  (Type-safe WebGPU primitives)                     │
│  ┌─────────┐ ┌───────────────┐ ┌────────────┐ ┌──────────────┐  │
│  │ Buffer  │ │ BindGroupLayout│ │ Pipeline   │ │ Encoder      │  │
│  └─────────┘ └───────────────┘ └────────────┘ └──────────────┘  │
└─────────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Native WebGPU (GPUDevice, GPUBuffer, GPURenderPipeline, etc.)  │
└─────────────────────────────────────────────────────────────────┘
```

### Current Coupling Points (What Needs to Change)

The node DSL currently has **three coupling points** that prevent parallel API usage:

#### 1. `StorageNode` holds a `StorageBufferAttribute` (the actual data)

```ts
// Current: the node IS the buffer
const positions = storage(attr, d.array(d.vec3f));
// The attr contains the data, and the node holds the attr reference
```

**Problem**: Two draw calls can't use different buffers with the same shader — the buffer is baked into the node.

**Solution for parallel API**: The node should declare a **slot** (type + access mode), not hold the buffer:

```ts
// Low-level: node declares what it NEEDS, not what it HAS
const positionSlot = storageSlot(d.array(d.vec3f), 'read');
// At draw time, you bind a buffer to the slot via bind group
```

#### 2. `UniformNode.value` holds the CPU-side data

```ts
// Current: uniform node has .value and .version
const roughness = uniform(f32(0.5), 'roughness');
roughness.set(0.8); // mutates the node
```

**Problem**: Same issue — uniform values are baked into nodes. Different draw calls can't have different uniform values without mutating the node.

**Solution for parallel API**: Uniforms become buffer references, not inline values:

```ts
// Low-level: declare the type, not the value
const roughnessSlot = uniformSlot(d.f32);
// You write to a buffer, bind that buffer to the slot
```

#### 3. `BufferAttributeNode` holds a `StorageBufferAttribute`

```ts
// Current: attribute node holds the data
const colors = bufferAttribute(colorData, d.vec3f);
```

**Solution**: Vertex buffers are bound at draw time via `setVertexBuffer()`, not embedded in nodes.

### Two Modes for the Node DSL

The node DSL can operate in two modes:

#### Mode A: "Inline" (Current behavior, for high-level API)

Nodes hold their data directly. The renderer extracts data from nodes and manages GPU resources.

```ts
// Uniform with inline value
const roughness = uniform(f32(0.5), 'roughness');
roughness.set(0.8);

// Storage with inline data
const positions = storage(posAttr, d.array(d.vec3f));
```

#### Mode B: "Slot" (New, for low-level API)

Nodes declare types/access modes only. Actual resources are bound externally.

```ts
// Uniform slot (no value)
const roughnessSlot = uniformSlot(d.f32, 'roughness');

// Storage slot (no data)
const positionsSlot = storageSlot(d.array(d.vec3f), 'read', 'positions');
```

The **same shader graph** can use either mode. The builder compiles to the same WGSL — it doesn't care whether the binding is "inline" or "slot". The difference is at runtime: who manages the GPU buffer and bind group.

### What the Builder Emits

The builder already extracts binding metadata:

```ts
interface CompileResult {
  code: string;                    // WGSL source
  uniformBlocks: UniformBlock[];   // { group, binding, name, struct, members }
  storageEntries: StorageEntry[];  // { group, binding, name, type, access }
  textures: TextureEntry[];
  samplers: SamplerEntry[];
  // ...
}
```

This metadata is **already decoupled** from the actual GPU resources. The builder says "this shader needs a storage buffer of type `array<vec3f>` at group 1 binding 0" — it doesn't say which GPUBuffer.

The low-level API uses this metadata to:
1. Create `GPUBindGroupLayout` from the declared bindings
2. Create `GPUBindGroup` by pairing layouts with actual buffers
3. Call `setBindGroup()` at draw time

### Proposed API Surface

#### Slot-Based Node Functions

```ts
// Declare a uniform slot (type only, no value)
const viewProjection = uniformSlot(d.mat4x4f, 'viewProjection');
// In shader: transforms.viewProjection (from bind group)

// Declare a storage slot (type only, no data)
const particles = storageSlot(d.array(Particle), 'read_write', 'particles');
// In shader: particles[i] (from bind group)

// Attributes remain as declarations (they're already slot-like)
const position = attribute(d.vec3f, 'position');
// Bound via setVertexBuffer()
```

#### Shader Function Definitions

```ts
import { vertexFn, fragmentFn } from 'gpucat/webgpu';

// Shader function takes slot declarations as dependencies
const mainVertex = vertexFn({
  // Vertex inputs
  inputs: {
    position: d.vec3f,
    normal: d.vec3f,
  },
  // Outputs (varyings)
  outputs: {
    clipPosition: d.vec4f,
    vNormal: d.vec3f,
  },
  // Bind group slots this shader uses
  bindings: {
    viewProjection: uniformSlot(d.mat4x4f),
    modelMatrix: uniformSlot(d.mat4x4f),
  },
}, (inputs, bindings) => {
  const worldPos = bindings.modelMatrix.mul(vec4(inputs.position, 1))
  const clipPos = bindings.viewProjection.mul(worldPos)
  return {
    clipPosition: clipPos,
    vNormal: inputs.normal,
  }
});
```

The `vertexFn` compiles the node graph to WGSL and extracts the bind group layout requirements.

#### Pipeline Creation

```ts
const pipeline = gpu.renderPipeline({
  vertex: mainVertex,
  fragment: mainFragment,
  vertexLayouts: [meshVertexLayout],
  // Bind group layouts are derived from shader bindings
  // OR explicitly provided for sharing across pipelines
  primitive: { topology: 'triangle-list' },
  depthStencil: { format: 'depth24plus', depthCompare: 'less' },
  targets: [{ format: 'bgra8unorm' }],
});

// The pipeline exposes its derived layouts
const [sceneLayout, objectLayout] = pipeline.bindGroupLayouts;
```

#### Drawing

```ts
gpu.submit((encoder) => {
  encoder.renderPass({ /* attachments */ }, (pass) => {
    pass.setPipeline(pipeline);
    
    // Bind actual buffers to the slots
    pass.setBindGroup(0, sceneLayout.populate({
      viewProjection: cameraBuffer,
    }));
    pass.setBindGroup(1, objectLayout.populate({
      modelMatrix: meshABuffer,
    }));
    pass.setVertexBuffer(0, meshAPositions);
    pass.drawIndexed(meshAIndexCount);
    
    // Same pipeline, different buffers
    pass.setBindGroup(1, objectLayout.populate({
      modelMatrix: meshBBuffer,
    }));
    pass.setVertexBuffer(0, meshBPositions);
    pass.drawIndexed(meshBIndexCount);
  });
});
```

### How the Renderer Uses This

The high-level renderer becomes a consumer of `src/webgpu/`:

```ts
// Inside renderer, simplified
class WebGPURenderer {
  private gpu: GpuRoot;
  
  render(scene: Scene, camera: Camera) {
    // 1. Update camera buffer
    this.cameraBuffer.write({
      projection: camera.projectionMatrix,
      view: camera.matrixWorldInverse,
    });
    
    // 2. For each mesh...
    for (const mesh of scene.meshes) {
      // Get or create pipeline from material's shader graph
      const pipeline = this.getPipeline(mesh.material);
      
      // Update mesh's model matrix buffer
      mesh._modelBuffer.write(mesh.matrixWorld);
      
      // Bind and draw
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.sceneBindGroup);
      pass.setBindGroup(1, mesh._bindGroup);
      pass.setVertexBuffer(0, mesh.geometry._positionBuffer);
      // ...
      pass.drawIndexed(mesh.geometry.indexCount);
    }
  }
}
```

The renderer is still convenient — it manages buffers, bind groups, and draw calls. But it's built on the same primitives users can access directly.

### Migration Path

1. **Create `src/webgpu/`** with typed buffer, bind group layout, pipeline, encoder wrappers
2. **Add slot-based node variants** (`uniformSlot`, `storageSlot`) alongside existing inline nodes
3. **Refactor builder** to support both modes (minimal changes — it already emits binding metadata)
4. **Refactor renderer** to use `src/webgpu/` primitives internally
5. **Export `src/webgpu/`** for direct user access
6. **Both APIs coexist** — high-level for convenience, low-level for control

---

## Implementation Sketch

### New modules needed

```
src/
  webgpu/                    # <-- The parallel API lives here
    index.ts                 # Public exports
    root.ts                  # gpu init, device wrapper
    buffer.ts                # GpuBuffer<T>
    bind-group.ts            # GpuBindGroupLayout, GpuBindGroup
    vertex-layout.ts         # GpuVertexLayout
    pipeline.ts              # GpuRenderPipeline, GpuComputePipeline
    texture.ts               # GpuTexture, GpuSampler
    encoder.ts               # Command encoder wrapper
  nodes/
    lib/
      slot.ts                # uniformSlot, storageSlot (new)
    shader-fn.ts             # vertexFn, fragmentFn, computeFn (new)
```

### Changes to existing modules

- `builder.ts` — add support for slot nodes (they compile identically to inline nodes)
- `uniform.ts` — keep existing inline nodes, add slot variant
- `storage.ts` — keep existing inline nodes, add slot variant
- `renderer.ts` — refactor to use `src/webgpu/` primitives internally
- `bindings.ts`, `pipelines.ts`, `buffers.ts` — logic moves into `src/webgpu/`

---

## Next Steps

1. **Prototype `TgpuBuffer<T>`** — typed buffer with schema validation
2. **Prototype bind group layouts** — explicit layout declaration
3. **Wire up to existing builder** — ensure node graph → WGSL still works
4. **Draw a triangle** — end-to-end proof of concept
5. **Iterate on the API surface** — ergonomics, naming, edge cases

---

## Summary

This design imagines gpucat with:

- **TypeGPU's resource philosophy**: typed buffers, explicit layouts, immutable pipelines
- **gpucat's node graph**: shader authoring via composable expression trees, not WGSL strings
- **No high-level abstractions**: no Mesh, no Material, no Scene, no Camera — just WebGPU primitives with types

The result: a low-level WebGPU library that's both **type-safe** and **expressive**, giving full control while retaining gpucat's unique shader authoring experience.
