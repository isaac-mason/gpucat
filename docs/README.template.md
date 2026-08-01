![cover](./docs/cover.png)

```sh
> npm install isaac-mason/gpucat
```

> gpucat is being built in public. installation is via the github repo instead of npm for now.

# gpucat

gpucat is a minimal typescript-first WebGPU and WebGL2 renderer.

It is a marriage of ideas in three.js and typegpu. It has a node-based shading language similar to [three.js TSL](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language), and has the typescript-first, WebGPU-native feel of [typegpu](https://typegpu.com).

You get a declarative API for GPU resources (buffers, uniforms, textures, materials), a type-safe node-based shading language that mirrors WGSL grammar and compiles to WGSL (or GLSL ES 3.00 for the WebGL2 backend), and gpucat handles the generation of pipelines, layouts, bind groups, and resource lifecycles for you.

Most GPU libraries either hide the GPU behind a scene abstraction or hand you raw shader strings. gpucat sits in between. You compose shaders as typed typescript expressions, so refactors and autocomplete work, but nothing stops you dropping down to the renderer, pipeline, and buffer level when you need to.

## Examples

Every screenshot links to its source in `examples/src`. Run them locally with `npm install && npm run dev` in `examples/`.

<Examples />

## Contents

- [Examples](#examples) · [Getting Started](#getting-started) · [Core Concepts](#core-concepts) · [Backends: WebGPU & WebGL2](#backends-webgpu--webgl2)
- Build an app: [The Renderer](#the-renderer) · [Scene and Objects](#scene-and-objects) · [Geometry](#geometry) · [Materials](#materials) · [Uniforms](#uniforms) · [Storage Buffers](#storage-buffers) · [Structs](#structs) · [Packing](#packing) · [Structured data](#structured-data) · [Render Pipeline](#render-pipeline)
- Shading language: [Constants](#constants-and-constructors) · [Operators](#operators) · [Variables](#variables) · [Control Flow](#control-flow) · [Method Chaining](#method-chaining) · [Functions](#functions) · [Building Blocks](#building-blocks) · [Varyings](#varyings) · [Textures](#textures-and-samplers) · [Atomics](#atomics) · [Builtins](#builtins) · [Included Uniforms](#included-uniforms)
- [Compute](#compute) · [Transform feedback (WebGL2)](#transform-feedback-webgl2) · [Drawing Many Things](#drawing-many-things) · [Controls and the Inspector](#controls-and-the-inspector)
- [Compiling to WGSL](#compiling-to-wgsl) · [WGSL or GLSL to gpucat](#wgsl-or-glsl-to-gpucat) · [API Reference](#api-reference)

## Getting Started

A minimal spinning cube. Renderer setup, a node-based material, and a `requestAnimationFrame` loop:

<Snippet source="./snippets.ts" select="spinning-cube" />

A few things to notice:

- The material is just two nodes: `vertex` (a clip-space position) and `fragment` (a `vec4f` color). You build them by composing smaller nodes, and gpucat compiles the resulting graph to WGSL.
- You own the frame loop. gpucat never starts its own `requestAnimationFrame` and never reads a wall clock. You call `render()` (and `compute()`) when you want a frame, and you drive time yourself via plain uniforms, so it stays composable with your own update loop.


<ExamplesTable ids="example-webgpu-hello-world" />

## Core Concepts

### Nodes and the graph

Shaders are composed of nodes - `attribute`, `uniform`, `add`, `mul`, `texture`, `vec3`, and the rest each create a node, and nodes compose into a graph:

```ts
const position = attribute('position', d.vec3f);             // a vertex input
const world = mul(modelWorldMatrix, vec4(position, f32(1)));  // node math
const clip = mul(cameraProjectionMatrix, mul(cameraViewMatrix, world));
```

When you hand a nodes to a `Material` (or call `compile()`), gpucat walks the graph and emits WGSL.

### Types: the `d` namespace

Types come from the `d` namespace: `d.vec3f`, `d.f32`, `d.mat4x4f`, `d.array(d.u32)`, `d.struct(...)`. These are WGSL type descriptors. They describe the data on the GPU and give the typescript compiler enough to type-check your shader.

There is a split worth internalising early: `d.f32` is the *type*, `f32(1)` is a *node* of that type. The same split you see between a value and its type. You annotate with `d.f32`, you build a node with `f32(1)`.

## Backends: WebGPU & WebGL2

gpucat runs on two graphics backends: WebGPU (`WebGPURenderer`) and WebGL2 (`WebGLRenderer`). They implement the same neutral `Renderer` interface and share the entire node-graph, DSL, scene, and resource layer above them. You author a scene once; only the renderer constructor differs.

### Backend selection is explicit

You choose the backend by choosing the constructor. There is **no automatic fallback**: a `WebGPURenderer` never quietly downgrades to WebGL2 if WebGPU is missing. This is deliberate. The two backends do not support the exact same feature set, so a silent fallback would swap in a renderer that cannot run your code and fail somewhere confusing. You decide, up front, which one you are targeting, and can branch yourself if you want to. `renderer.backend` reports the choice as `'webgpu'` or `'webgl'`.

```ts
const renderer = new WebGPURenderer({ antialias: true });   // WebGPU
// const renderer = new WebGLRenderer({ antialias: true });  // WebGL2
await renderer.init();
renderer.backend;   // 'webgpu' | 'webgl'
```

### Same code, two backends

The node-graph material and DSL are authored once. `WebGPURenderer` compiles the graph to WGSL; `WebGLRenderer` compiles the same graph to GLSL ES 3.00. The DSL grammar is WGSL-native, and GLSL is a translation target reached through each schema's `glslType` companion, so the WGSL surface is never watered down to fit WebGL. Everything above the renderer, scene, geometry, materials, uniforms, textures, render targets, the shading language, is identical across both. Swapping backends is a one-line change:

```ts
// build the scene and material once — nothing here is backend-specific
const material = new Material({ vertex: clipPos, fragment: litColor });
const mesh = new Mesh(geom, material);
scene.add(mesh);

// pick a backend at the top; the rest of the app is unchanged
const renderer = webgpuSupported
    ? new WebGPURenderer({ antialias: true })
    : new WebGLRenderer({ antialias: true });
await renderer.init();

const pipeline = new RenderPipeline(renderer, renderOutput(pass(scene, camera).getTextureNode()));
// each frame: pipeline.render();
```

### What WebGL2 supports

The WebGL2 backend covers the standard rendering surface:

- Node-graph **materials** compiled to GLSL ES 3.00.
- **Opaque meshes** and **instancing** (instanced vertex attributes).
- **Textures**: 2D, cube, 2D-array, and depth, with combined samplers.
- **Render targets**: MRT, depth attachments, cube targets, and MSAA-resolve.
- **HDR / float render targets** via `EXT_color_buffer_float`.
- Correct clip-space **depth** and **frustum culling**.
- **Render-to-texture, passes, and post-processing** through `RenderPipeline`.
- **Transform feedback** (`renderer.transformFeedback(...)`) for GPU particle/simulation kernels, with native buffer readback (`renderer.readBufferAsync(...)`). See [Transform feedback](#transform-feedback-webgl2).
- The **inspector**: real GPU timing (`EXT_disjoint_timer_query_webgl2`), memory, draw-call counts, the scene tree, and a GLSL shader panel.

### What WebGL2 does not support

These are WebGPU-only. On `WebGLRenderer` they throw a clear error, at shader-compile time where possible, otherwise at prepare — never silently. Use `WebGPURenderer` for any of them:

- **Compute**: `renderer.compute()`, compute nodes, and `Fn(...).compute(...)` kernels. For own-index GPU simulation (particles), WebGL2 offers [transform feedback](#transform-feedback-webgl2) instead; scatter/atomics/arbitrary-index writes stay WebGPU-only.
- **Storage buffers** (`storage(...)`, `createStorageBuffer`) and **atomics**.
- **Storage textures** and **workgroup vars** (`WorkgroupVar`).
- **Inline WGSL**: `` wgsl`…` `` and `wgslFn(...)` (raw WGSL has no GLSL translation).
- **Indirect draw** (`geometry.indirect`) — WebGPU-only, both the CPU-authored and the GPU-computed (compute-driven culling) variants.
- **Texture constant-offset sampling** and **`f16` / half** types.
- The inspector's live-value **probe** (WebGPU-only; the rest of the inspector works).

### Renderer options

Both renderers share a common set of options; each backend adds a few of its own.

| Option | Backends | What it does |
| --- | --- | --- |
| `canvas` | both | Render into an existing canvas instead of a created one. |
| `pixelRatio` | both | Device pixel ratio (also `setPixelRatio`). |
| `antialias` | both | Multisampled anti-aliasing. |
| `alpha` | both | Alpha in the canvas backbuffer. |
| `depth` | both | Allocate a depth buffer. |
| `stencil` | both | Allocate a stencil buffer. |
| `samples` | both | MSAA sample count. |
| `powerPreference` | both | `'high-performance'` / `'low-power'` adapter hint. |
| `precision` | WebGL | Shader precision: `'highp'` (default) / `'mediump'` / `'lowp'`. |
| `preserveDrawingBuffer` | WebGL | Keep the backbuffer readable after present. |
| `failIfMajorPerformanceCaveat` | WebGL | Fail context creation on a slow (software) implementation. |
| `adapter` / `adapterOptions` | WebGPU | Supply or configure the `GPUAdapter`. |
| `device` / `deviceDescriptor` | WebGPU | Supply or configure the `GPUDevice`. |
| `format` | WebGPU | Override the canvas texture format. |

### Feature × backend support matrix

| Feature | WebGPU | WebGL2 |
| --- | :---: | :---: |
| Node-graph materials (compiled shaders) | ✓ | ✓ |
| Opaque meshes + instancing | ✓ | ✓ |
| Textures (2D / cube / 2d-array / depth) | ✓ | ✓ |
| Render targets (MRT / depth / cube / MSAA-resolve) | ✓ | ✓ |
| HDR / float render targets | ✓ | ✓ |
| Depth + frustum culling | ✓ | ✓ |
| Render-to-texture / passes / post-processing | ✓ | ✓ |
| Inspector (GPU timing, memory, draws, scene, shaders) | ✓ | ✓ |
| Transform feedback (`renderer.transformFeedback()`, own-index GPU sim) | ✗ (use `compute()`) | ✓ |
| Compute (`renderer.compute()`, compute nodes, scatter/atomics) | ✓ | ✗ (use `transformFeedback()`) |
| Storage buffer reads (lowered to a texture on WebGL2) | ✓ | ✓ |
| Storage buffer writes · atomics | ✓ | ✗ |
| Storage textures · workgroup vars | ✓ | ✗ |
| Inline WGSL (`` wgsl`` `` / `wgslFn`) | ✓ | ✗ |
| Indirect draw (`geometry.indirect`) | ✓ | ✗ |
| Texture constant-offset sampling · `f16` types | ✓ | ✗ |
| Inspector live-value probe | ✓ | ✗ |

### Which features run on which backend

Backend compatibility is a property of the *features* you use, not of any single example (each example file constructs one specific renderer). Read it off the matrix above, or by category:

- **Runs on both backends** — the shared rendering features: meshes and node-graph materials, textures, render targets and MRT, render-to-texture and post-processing, and camera controls. Anything built only from these works on either `WebGPURenderer` or `WebGLRenderer`.
- **WebGPU-only** — compute (compute nodes and `renderer.compute()`), storage buffer *writes* (`read_write`, atomics, compute output), storage textures, workgroup vars, inline WGSL (`` wgsl`` `` / `wgslFn`), and indirect draw (`geometry.indirect`, both CPU-authored and compute-driven). Anything using these needs `WebGPURenderer`. Read-only storage reads are portable, covered below.
- **WebGL2-only** — [transform feedback](#transform-feedback-webgl2) (`renderer.transformFeedback()`), the honest own-index GPU-simulation primitive, with native readback via `renderer.readBufferAsync()`. WebGPU has no transform feedback; you express the same simulation as a `compute()` kernel there, reusing the per-element body `Fn` verbatim.

The [examples browser](https://isaac-mason.github.io/gpucat/) groups examples by the backend each one targets, so the compute and storage-driven examples sit under WebGPU and the WebGL2 examples under WebGL.

## The Renderer

You create a `WebGPURenderer`, initialise it (it acquires the GPU device asynchronously), and size it to your canvas:

```ts
const renderer = new WebGPURenderer({ antialias: true });
await renderer.init();
document.body.appendChild(renderer.domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
```

gpucat never starts its own loop. You own the frame, and a frame is just: update transforms, push any changed data, run any compute, then render.

```ts
function frame() {
    movingMesh.updateWorldMatrix();  // update only what moved, not the whole scene
    camera.updateViewMatrix();       // the camera moved this frame

    uColor.value = nextColor;                                    // push changed data
    renderer.compute([{ node: sim, dispatch: [groups, 1, 1] }]); // optional
    renderPipeline.render();

    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

## Scene and Objects

A `Scene` holds a tree of `Object3D`s. Each object has a `position`, `quaternion`, and `scale`; you call `updateWorldMatrix()` to fold them into its world matrix. A `Mesh` is geometry plus material.

```ts
const scene = new Scene();

const mesh = new Mesh(geom, material);
mesh.position[1] = 2;
scene.add(mesh);

const camera = new PerspectiveCamera(Math.PI / 4, width / height, 0.1, 100);
camera.position[2] = 5;
scene.add(camera);
```

For **instancing** (drawing one geometry many times in a single call), set `mesh.count` and pull per-instance data from a storage buffer. See [Drawing Many Things](#instancing).

Cameras carry the projection: `PerspectiveCamera(fov, aspect, near, far)` or `OrthographicCamera(...)`. See [`Scene`](./api.md#scene), [`Object3D`](./api.md#object3d), [`Mesh`](./api.md#mesh), [`PerspectiveCamera`](./api.md#perspectivecamera).

### Updating matrices is your job

Meshes are not game entities. gpucat does not tick them every frame or track changes for you. Setting `position`, `quaternion`, or `scale` does nothing on its own; no matrices recompute until you tell them to. You decide when, and you should be deliberate about it: update the objects that actually moved, not the whole scene on every frame.

- `object.updateWorldMatrix()` recomputes that object's `matrixWorld` and `normalMatrix` (which feed `modelWorldMatrix` and `modelNormalMatrix` in shaders) and recurses into its children. Move a mesh, update that mesh.
- `camera.updateViewMatrix()` inverts the camera's world matrix into the view matrix that `cameraViewMatrix` reads. Call it after the camera's world matrix is current, and only when the camera moved.
- `camera.updateProjectionMatrix()` rebuilds the projection from `fov` / `aspect` / `near` / `far`. Only when those change, typically in your resize handler.

`scene.updateWorldMatrix()` is the same call on the root: it walks the whole tree, parents before children. It is a convenience for initial setup or a one-off bulk update, not something to run every frame for a mostly-static scene. Be intelligent about it.

<ExamplesTable ids="example-webgpu-moving-mesh-stress,example-webgpu-static-mesh-stress" />

## Geometry

A `Geometry` is a set of named vertex buffers plus an optional index buffer. The buffer names line up with the `attribute('name', type)` nodes in your vertex shader.

```ts
const geom = new Geometry();
geom.setBuffer('position', createVertexBuffer(d.vec3f, positions));
geom.setBuffer('normal', createVertexBuffer(d.vec3f, normals));
geom.index = createIndexBuffer(indices);   // a Uint16Array or Uint32Array
```

For common shapes, the `create*Geometry` helpers build the position, normal, and uv buffers and an index for you. See [`Geometry`](./api.md#geometry) and the helpers in [api.md](./api.md#geometry).

<ExamplesTable ids="example-webgpu-line,example-webgpu-raging-sea,example-webgpu-voxels,example-webgpu-interleaved" />

## Materials

A `Material` is the shaders plus the pipeline state. Three node slots define the shaders, and you build each one with the [shading language](#constants-and-constructors) below:

- **`vertex`** a clip-space `vec4f` position. Use [`positionClip`](./api.md#positionclip) for the standard model-view-projection transform.
- **`fragment`** a `vec4f` color, or an `mrt(...)` node for [multiple targets](#render-pipeline), or omit it entirely for a depth-only pass (shadow maps).
- **`depth`** an optional `f32` that overrides the depth written to the buffer (emits `@builtin(frag_depth)`).

```ts
const material = new Material({
    vertex: clipPos,
    fragment: litColor,
    transparent: true,
    cullMode: 'back',
});
```

Everything else is pipeline state:

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `transparent` | `boolean` | `false` | Draws after opaque objects and flips the `depthWrite` default. Turns on alpha blending unless you override `blend`. See [Blending](#blending). |
| `blend` | `GPUBlendState` | standard alpha | Custom blend state. Only applied when `transparent` is true. |
| `depthTest` | `boolean` | `true` | Whether the depth test runs. `false` forces `depthCompare` to `'always'`. |
| `depthWrite` | `boolean` | `true` opaque, `false` transparent | Whether fragments write to the depth buffer. |
| `depthCompare` | `GPUCompareFunction` | `'less'` | The depth comparison function. |
| `cullMode` | `GPUCullMode` | `'back'` | Face culling: `'back'`, `'front'`, or `'none'`. |
| `alphaToCoverage` | `boolean` | `false` | Alpha-to-coverage. Only meaningful when `renderer.samples > 1`. |
| `depthBias` | `number` | `0` | Constant depth bias, in depth-buffer precision steps. |
| `depthBiasSlopeScale` | `number` | `0` | Depth bias scaled by the fragment's depth slope. |
| `depthBiasClamp` | `number` | `0` | Maximum absolute depth bias (`0` means no clamp). |

After changing which node feeds a slot, set `material.needsUpdate = true` to force a recompile. See [`Material`](./api.md#material).

### Blending

A material is opaque by default: it writes depth and does not blend. Set `transparent: true` and three things happen. It draws after opaque objects, it stops writing depth (so overlapping transparent fragments blend instead of occluding each other), and it picks up standard alpha blending: `src-alpha`, `one-minus-src-alpha`.

For anything else, pass an explicit `blend` (a WebGPU `GPUBlendState`). Common recipes, as the color `srcFactor` / `dstFactor` with an `add` operation:

| Mode | `srcFactor` | `dstFactor` |
| --- | --- | --- |
| Normal (alpha) | `src-alpha` | `one-minus-src-alpha` |
| Additive | `one` | `one` |
| Multiply | `dst` | `zero` |

```ts
const glow = new Material({
    vertex: clipPos,
    fragment: emissive,
    transparent: true,
    blend: {
        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    },
});
```

### Lighting is yours to implement

gpucat ships no lights. There is no `Light` object, no `addLight`, and no built-in shading model (no Lambert, Phong, or PBR material). Lighting is not built in; it is yours to implement, composed from the same reusable nodes and `Fn`s as everything else.

A directional light plus an ambient term is just node math in the fragment:

```ts
const diffuse = worldNormal.dot(lightDir).max(f32(0));   // Lambert term
const lighting = f32(0.15).add(diffuse);                 // ambient + diffuse
const fragment = vec4(baseColor.mul(lighting), f32(1));
```

More advanced setups follow the same shape: keep lighting data in a [`storage` buffer](#storage-buffers) and consume it in the shader. Heavier techniques, like deferred or clustered shading, shadow mapping, image-based lighting, or a full PBR model, are all implementable in userland from the same primitives. The point lights example is a starting point.

<ExamplesTable ids="example-webgpu-point-lights" />

## Uniforms

A uniform is a single small value a shader reads, set from the CPU and updated from your own loop. For bulk arrays, see [Storage Buffers](#storage-buffers).

A `Uniform` owns a value; `uniform(...)` turns it into a node. Set `.value` and the change uploads on the next frame:

```ts
const uColor = new Uniform(d.vec3f, [1, 0, 0]);
const color = uniform(uColor);   // a node to use in a shader
uColor.value = [0, 1, 0];        // update anytime; uploaded next frame
```

You can also resolve a uniform by name from a material, handy when one shader graph is shared across meshes with different values:

```ts
const color = uniform('color', d.vec3f);                          // in the shader
material.uniforms.set('color', new Uniform(d.vec3f, [1, 0, 0]));  // per material
```

A uniform's **group** sets both its WGSL `@group` and how often it uploads: `objectGroup` (default, per draw call), `renderGroup` (per `render()` call), `frameGroup` (once per frame). The built-in camera and model uniforms already sit in the right groups.

See [`Uniform`](./api.md#uniform-2).

<ExamplesTable ids="example-webgpu-uniforms" />

## Storage Buffers

A storage buffer is the bulk-data counterpart to a uniform: a large read or read-write array a shader works over, like instance transforms, particle state, or a spatial grid. It is the buffer a compute pass writes and a material reads.

`storage(...)` turns a buffer into a node, and there are two forms:

```ts
// value form: bind a specific buffer
const positions = storage(createStorageBuffer(d.array(d.vec4f), data), 'read_write');

// named form: resolve the buffer by name at draw or dispatch time
const positions = storage('positions', d.array(d.vec4f), 'read_write');
```

The **value form** points at one `GpuBuffer`. The **named form** holds no buffer; the buffer is looked up when the draw or dispatch runs, from the per-call `buffers` map first, then `geometry.buffers`. It is the same idea as named uniforms: one shader graph, a different buffer per mesh or per dispatch.

The access mode is `'read'` (the default) or `'read_write'`. A vertex or fragment shader can only read storage; a compute kernel can read or write. Use `'read_write'` for anything a compute pass mutates. Index into it like an array, and assign to write:

```ts
const p = index(positions, i);           // read element i
index(positions, i).assign(p.add(...));  // write element i (read_write only)
```

### Driving draws and compute from storage

The reason storage matters is that the GPU can produce the data the GPU consumes, with no CPU in the loop. A compute pass writes the buffer, and the same buffer feeds a material that draws from it indexed by `instanceIndex`:

```ts
const positions = storage(positionBuffer, 'read_write');

const sim = Fn(() => { /* update positions[globalId.x] */ }).compute({ workgroupSize: [64, 1, 1] });
const world = index(positions, instanceIndex);   // material reads what the kernel wrote
```

You call `renderer.compute([{ node: sim, dispatch: [...] }])` then `renderPipeline.render()`, and nothing round-trips through the CPU. This is the spine of the particle and ball-cluster examples, and the same buffer-per-instance idea behind [Instancing](#instancing).

### Ping-pong (double buffering)

A kernel that reads and writes one buffer sees values its neighbours have already changed this frame. When each step needs a clean snapshot of the last, keep two buffers and alternate between them. The named form makes this tidy, since you bind the buffer per dispatch through the `buffers` map:

```ts
const state = storage('state', d.array(Particle), 'read_write');
let [src, dst] = [bufferA, bufferB];

// each frame:
renderer.compute([{ node: sim, dispatch: [...], buffers: { state: src } }]);
[src, dst] = [dst, src];   // swap for next frame
```

The ball-cluster example takes the other route: it copies positions and velocities into `prev` buffers (folded into the binning pass, which already visits every ball), so the physics pass reads a frozen previous state while writing the new one. Either works; pick whichever fits the kernel.

To update storage from the CPU instead, edit the backing array and mark it dirty. This works for any `GpuBuffer` (vertex, index, storage, and the rest), not just storage:

```ts
const buf = createStorageBuffer(d.array(d.vec4f), data);
buf.array[0] = 1.5;
buf.needsUpdate = true;     // re-upload the whole buffer
buf.addUpdateRange(0, 4);   // or upload just 4 components from offset 0
```

### Reads run on WebGL2 (as a texture)

WebGL2 has no storage buffers, but a read-only storage buffer is an indexed array, and so is a texture. So `storage(buffer, 'read')` and the `index(_, i)` / `.field` reads over it work on both backends. On WebGPU it stays a native `var<storage>` array. On WebGL2 the renderer reads the buffer's own bytes as an `rgba32uint` texture and lowers each read to a `texelFetch`, using the same path as [Structured data](#structured-data). There is no second copy and no CPU round-trip.

This covers the common case of per-instance data a vertex or fragment shader reads. It does not make writes portable: `read_write` storage, atomics, and compute output stay WebGPU-only, and on WebGL2 GPU writes go through [transform feedback](#transform-feedback-webgl2). The buffer must be value-form and keep its CPU `array` resident, since the texture reads from it. On WebGL2 the capacity is `MAX_TEXTURE_SIZE²` texels, which is 64 MB on the weakest conformant hardware and gigabytes on typical GPUs. Split the buffer if you need more.

See [`storage`](./api.md#storage), [`createStorageBuffer`](./api.md#createstoragebuffer), and [`GpuBuffer`](./api.md#gpubuffer).

<ExamplesTable ids="example-webgpu-storage,example-webgpu-instancing-storage-buffer,example-webgpu-compute-particles" />

## Structs

`struct(name, fields)` defines a struct schema. The field names and `d.*` types lay out exactly like the WGSL struct, and gpucat handles the std430 alignment and padding for you.

```ts
const Particle = struct('Particle', {
    position: d.vec3f,
    velocity: d.vec3f,
    life: d.f32,
});
```

Use it as a buffer or uniform schema (`d.array(Particle)`, `d.sizedArray(Particle, N)`, `uniform('name', Particle)`), or as a value type inside a shader. Build a value with `.construct(...)`, and read the fields off a struct node with `.fields()`:

```ts
// in a shader: build a struct value
const p = Particle.construct({ position: pos, velocity: vel, life: f32(1) });

// read fields from an array-of-structs storage element
const particle = particles.element(i).fields();
const pos = particle.position;   // a vec3f node
```

Structs nest: a field can itself be a struct or a sized array.

## Packing

The `pack*` utilities lay javascript values out into an `ArrayBuffer` with the correct alignment (std430 for storage, std140 for uniforms), so you can fill a buffer that a shader reads as a struct or an array of structs.

```ts
const bytes = packArray(Particle, particles);   // Particle[] -> ArrayBuffer
const buf = createStorageBuffer(d.array(Particle), new Float32Array(bytes));
```

- `pack(schema, value)` and `packArray(schema, items)` build a fresh `ArrayBuffer`.
- `packTo(schema, dest, offset, value)` writes into an existing buffer at a byte offset.
- `unpack(schema, src)` and `unpackArray(schema, src, count)` read values back out.
- `layoutSizeOf(schema)` and `layoutStrideOf(schema)` give the byte size and the array stride (size plus tail padding).

Each takes an optional last argument, `'storage'` (default) or `'uniform'`, to pick the alignment rules. See [api.md](./api.md#schema-d) for the full list.

## Structured data

Per-instance data, such as transforms, a material palette, or per-splat attributes, is a typed array of structs the GPU reads by index. gpucat treats a texture or storage buffer as that array: it holds plain typed bytes, and a `d` schema describes the record at each read or write.

```ts
const Instance = d.struct({ transform: d.mat4x4f, tint: d.unorm8x4, materialId: d.u32 });

// allocate a texture sized for N records
const instances = createStructTexture(Instance, N);

// CPU write, in records rather than raw texels:
instances.packAtIndex(Instance, i, { transform: m, tint: [1, 0, 0, 1], materialId: 3 });

// shader read, field access by name with no texel math:
const rec   = texture(instances).load(Instance, instanceIndex);
const world = mul(rec.transform, localPosition);
```

`load(schema, i)` reads record `i` and returns an accessor. Its fields (`rec.transform`, `rec.tint`) are typed nodes, and only the fields you read emit texture loads. On the CPU, `packAtIndex(schema, i, value)` writes one record, `pack(schema, values)` fills the whole texture in one upload, and `packAtByte` and `packAtTexel` address by raw offset. On WebGL2 this compiles to an integer texture and `texelFetch`, so it runs on both backends. The same `pack*` methods exist on [`GpuBuffer`](./api.md#gpubuffer) for filling a storage buffer.

The texture holds plain typed bytes, so you can split data across several textures by update frequency. A per-frame `transform` texture then re-uploads only its dirty rows, which `packAtIndex` tracks, while a static `material` texture stays put. Instancing, batched draws, and gsplat all build on this.

### Packed encodings

Fields can use compact encodings to cut memory and upload bandwidth. A normal as `d.unorm8x4` is 4 bytes against a `vec3f`'s 12. gpucat encodes on write and decodes on read using the same schema, so they stay consistent:

- `d.unorm8x4`, `d.snorm8x4`: four 8-bit (s)normalized lanes, read as a `vec4f`.
- `d.half2x16`: two 16-bit floats, read as a `vec2f`.
- `d.unorm2x16`, `d.snorm2x16`: two 16-bit (s)normalized lanes, read as a `vec2f`.
- `d.bits({ flags: 8, materialId: 24 })`: named bitfields packed into one `u32`.

See [`createStructTexture`](./api.md#createstructtexture), [`DataTexture`](./api.md#datatexture), and the `pack*` methods on [`GpuBuffer`](./api.md#gpubuffer).

## Render Pipeline

A `pass` renders a scene and camera to a texture, `renderOutput` turns a texture into the final screen output, and a `RenderPipeline` ties an output node to the renderer:

```ts
const scenePass = pass(scene, camera);
const output = renderOutput(scenePass.getTextureNode());
const renderPipeline = new RenderPipeline(renderer, output);
// each frame: renderPipeline.render();
```

Because a pass is just a texture node, you add post-processing by sampling it and feeding the result through more nodes before `renderOutput`. `mrt` writes several targets at once, and a `RenderTarget` lets you render off-screen. See [`RenderPipeline`](./api.md#renderpipeline) and [`RenderTarget`](./api.md#rendertarget).

<RenderCategory name="render pass" compact />
<RenderCategory name="render output" compact />

<ExamplesTable ids="example-webgpu-render-to-texture,example-webgpu-shadow-map" />

### Environment maps with a cube camera

A `CubeRenderTarget` is a render target whose color attachment is a cube texture, and a `CubeCamera` renders the surroundings into its six faces. Place the cube camera where a reflective object sits, call `update()` to capture the scene, then sample the result as an environment map with `cubeTexture(rt.texture)`. Rendering the cube each frame (rather than loading a static one) gives realtime reflections.

```ts
const cubeRT = new CubeRenderTarget(256);
const cubeCamera = new CubeCamera(0.1, 100, cubeRT);

// each frame, with the reflective object hidden so it does not reflect itself:
reflector.visible = false;
cubeCamera.update(renderer, scene);   // renders the 6 faces into cubeRT
reflector.visible = true;

// in the reflector's material, sample the cube along the reflection vector:
const env = cubeTexture(cubeRT.texture).sample(reflectDir);
```

Like everything else, this does no automatic per-frame work: you call `update()` when you want to refresh the map. See [`CubeRenderTarget`](./api.md#cuberendertarget) and [`CubeCamera`](./api.md#cubecamera).

<ExamplesTable ids="example-webgpu-cube-camera" />

### Tonemapping and post-processing

<RenderCategory name="tonemapping and color space conversions" compact />
<RenderCategory name="post-processing effects" compact />

<ExamplesTable ids="example-webgpu-mrt,example-webgpu-fxaa" />

## Constants and constructors

Scalar and vector constructors turn javascript numbers into typed constant nodes. `f32(0.5)`, `vec3(1, 0, 0)`, `mat4(...)`. The `vec*` constructors accept a mix of scalars and smaller vectors, so `vec4(rgb, 1)` works.

<RenderCategory name="constructors" compact />

## Operators

Math and operators exist as free functions, and (see [method chaining](#method-chaining)) as methods. `add(a, b)` is `a.add(b)`. They are type-directed: `mul(mat4, vec4)` is a matrix-vector multiply, `mul(vec3, vec3)` is component-wise.

```ts
const lit = vec3(0.4, 0.7, 1.0).mul(f32(0.15).add(diffuse));
```

<RenderCategory name="math/operators" compact />

### Comparison

<RenderCategory name="comparison" compact />

### Bitwise

<RenderCategory name="bitwise" compact />

## Variables

By default a reused expression is hoisted into a `let` automatically. When you want explicit, mutable WGSL variables (for accumulation, or to assign in a loop), use `Var`. The name comes first so it reads like a declaration:

```ts
const sum = Var('sum', f32(0));
Loop(8, ({ i }) => sum.assign(sum.add(i.toF32())));
```

`Let` is the immutable form. `PrivateVar` and `WorkgroupVar` declare module-scope storage for compute.

<RenderCategory name="variables" compact />

## Control Flow

`If` / `Loop` / `For` / `While` mirror WGSL control flow and take callbacks for their bodies. `select(a, b, cond)` and `cond(c, a, b)` are the expression-level ternary.

```ts
If(x.greaterThan(f32(0)), () => {
    result.assign(x);
}).Else(() => {
    result.assign(x.negate());
});
```

<RenderCategory name="control flow" compact />

<ExamplesTable ids="example-webgpu-discard" />

## Method Chaining

Most operators exist as both a free function and a method on `Node`, so `mul(a, b)` and `a.mul(b)` are the same thing. Swizzles (`.xyz`, `.xy`), conversions (`.toF32()`, `.toVar()`), and sampling all read naturally as chains:

```ts
const luma = color.rgb.dot(vec3(0.299, 0.587, 0.114)).toVar('luma');
```

The full `Node` method surface is in the [API reference](./api.md#node-methods).

## Functions

`Fn` defines a reusable shader function. The body is a callback that builds nodes and returns one; calling the result emits a WGSL function call:

```ts
const lambert = Fn((n, l) => max(dot(n, l), f32(0)));
const light = lambert(worldNormal, lightDir);
```

Pass a **layout** to give the parameters names (they become named WGSL parameters) and types:

```ts
const lambert = Fn((n, l) => max(dot(n, l), f32(0)), {
    name: 'lambert',
    params: [{ name: 'n', type: d.vec3f }, { name: 'l', type: d.vec3f }],
});
```

The return type is inferred from the body. Add `return` to the layout to pin it (matching WGSL's `fn(...) -> T`). The body is still traced and checked against it, so a mismatch is a clear error rather than a confusing WGSL one:

```ts
const splat = Fn((x) => vec3(x, x, x), {
    name: 'splat',
    params: [{ name: 'x', type: d.f32 }],
    return: d.vec3f,
});
```

A function with no return value is a void function (statements only). `Fn(() => { ... }).compute({ workgroupSize })` turns one into a [compute](#compute) kernel. For an escape hatch, `wgsl` and `wgslFn` drop raw WGSL into the graph.

## Building Blocks

These pull data into a shader and build its larger pieces: vertex `attribute`s, `uniform`s, `storage` buffers, `texture`s, and `struct`s.

```ts
const time = uniform('time', d.f32);
const positions = storage('positions', d.array(d.vec3f), 'read');
```

<RenderCategory name="node factories" compact />

## Varyings

A shader runs in two stages. The vertex stage runs once per vertex; the fragment stage runs once per pixel. A varying is the bridge between them: a value computed per vertex, interpolated across the triangle, then read per fragment.

`varying(expr)` marks `expr` as a vertex-stage computation whose result crosses to the fragment stage. You do not split your code into two shaders by hand. You write the expression once, wrap it, and gpucat builds it into the vertex stage and wires up the interpolated output and input for you.

```ts
// computed per vertex, interpolated, then read in the fragment stage
const vNormal = varying(normalize(mul(modelNormalMatrix, normal)), 'vNormal');
const lighting = vNormal.dot(lightDir).max(f32(0));
```

This matters because a node referenced from the fragment side is otherwise computed per fragment. A transformed normal, or a uv, belongs per vertex plus interpolation, which is both cheaper and the right behaviour for smoothly varying data.

### Interpolation

A varying is perspective-correct by default (the WGSL default for floats). `setInterpolation(type, sampling?)` sets the WGSL `@interpolate` qualifier:

- `type`: `'perspective'` (default), `'linear'` (non-perspective-correct), or `'flat'` (no interpolation, takes the provoking vertex's value). `'flat'` is required for integer varyings.
- `sampling` (optional, only with perspective/linear): `'center'` (default), `'centroid'`, `'sample'`, or `'either'`, for MSAA edge cases.

```ts
// integers must be flat; also use flat for per-primitive ids you do not want blended
const vMatId = varying(materialId).setInterpolation('flat');
```

## Textures and Samplers

Textures and samplers are first-class nodes, mirroring WGSL's separate texture/sampler model. The high-level `texture()` node auto-creates a sampler and samples at the interpolated UV; the free functions (`textureSample`, `textureLoad`, and the rest) give you WGSL-level control.

```ts
const albedo = texture(myTexture);            // samples at uv()
const exact = textureLoad(myTexture, coords); // no sampler
```

<RenderCategory name="texture/sampler factories and functions" compact />

### Creating texture resources

The `texture()` node takes a texture resource. Create one from an image, or from raw pixels:

```ts
const tex = new Texture(image);                          // HTMLImageElement, ImageBitmap, canvas
const data = new DataTexture(pixels, 256, 256, { format: 'rgba8unorm' });
```

`CubeTexture`, `ArrayTexture`, and `CanvasTexture` cover the other shapes, and sampler settings (`wrapS`, `magFilter`, `anisotropy`, and so on) live on the texture. A pass output is also a texture, which is what makes post-processing just node wiring. See [`Texture`](./api.md#texture).

A video is just a texture whose contents change every frame — pass an `HTMLVideoElement` to `Texture` and mark it `needsUpdate` each frame; the renderer copies the current frame to the GPU. No special texture type:

```ts
const videoTexture = new Texture(videoElement);     // a playing HTMLVideoElement
// in the frame loop:
videoTexture.needsUpdate = true;                    // re-copy the current frame
```

<ExamplesTable ids="example-webgpu-texture,example-webgpu-mipmaps,example-webgpu-cubemap,example-webgpu-array-texture,example-webgpu-video-texture" />

### Storage textures

A storage texture is one a compute shader can **write** to (and optionally read), the texture analogue of a storage buffer. You create it with a `create*StorageTexture` helper, write texels with `textureStore` in a compute kernel, and — because the same texture is created with both storage and sampling usage — sample it in a later render pass with the ordinary `texture()` node. The classic use is generating or simulating an image on the GPU.

```ts
const tex = createStorageTexture(256, 256, 'rgba8unorm');   // 2d; also 3d / Array / 1d helpers

// compute: write each texel
const write = storageTexture(tex, 'write');                 // access: 'write' | 'read' | 'read_write'
const paint = Fn(() => {
    const p = vec2u(globalId.x, globalId.y);
    textureStore(write, p, vec4(/* … */));
}).compute({ workgroupSize: [8, 8, 1] });

// render: sample the same texture (dual usage — no copy)
const sampler = new GpuSampler({ minFilter: 'linear', magFilter: 'linear' });
const color = texture(tex, sampler).sample(screenUV);

// each frame: compute writes, then render samples
renderer.compute([{ node: paint, dispatch: [Math.ceil(256 / 8), Math.ceil(256 / 8), 1] }]);
```

`access` is a property of the binding, not the texture, so one texture can be bound `write` in one kernel and `read` in another (e.g. ping-pong simulations). Reads use `textureLoad(node, coords)` (no mip level). Writes are compute-only; binding a `write`/`read_write` storage texture in a vertex or fragment shader is a compile error. `read_write` access is limited by WebGPU to the `r32uint` / `r32sint` / `r32float` formats; the value type of `textureStore`/`textureLoad` follows the format's channel (`vec4f` / `vec4u` / `vec4i`). If the texture has mips and `mipmapsAutoUpdate` is on (the default), its mips regenerate after a compute write so it can be sampled mipmapped.

3D storage textures (`createStorageTexture3d`) work the same way and pair naturally with `texture_3d` sampling — write a volume in compute, then raymarch it in a render pass (`texture(volume, sampler).sample(vec3)`). The sample coordinate type is derived from the texture: a 3D texture's `.sample()` requires a `vec3`, a 2D one a `vec2`.

<ExamplesTable ids="example-webgpu-compute-texture,example-webgpu-volume" />

## Atomics

Atomic operations on `atomic<i32>` / `atomic<u32>` storage, for compute.

<RenderCategory name="atomic operations" compact />

<ExamplesTable ids="example-webgpu-ball-cluster" />

## Builtins

WGSL builtin inputs: the vertex and instance indices in a draw, and the invocation ids in a compute dispatch.

| Node | Type | WGSL builtin | What it is |
| --- | --- | --- | --- |
| [`vertexIndex`](./api.md#vertexindex) | `u32` | `vertex_index` | Index of the current vertex. |
| [`instanceIndex`](./api.md#instanceindex) | `u32` | `instance_index` | Index of the current instance in an instanced draw. |
| [`globalId`](./api.md#globalid) | `vec3u` | `global_invocation_id` | This thread's global id across the whole dispatch. |
| [`localId`](./api.md#localid) | `vec3u` | `local_invocation_id` | This thread's id within its workgroup. |
| [`localIndex`](./api.md#localindex) | `u32` | `local_invocation_index` | The flattened `localId` within the workgroup. |
| [`workgroupId`](./api.md#workgroupid) | `vec3u` | `workgroup_id` | This workgroup's id within the dispatch. |
| [`numWorkgroups`](./api.md#numworkgroups) | `vec3u` | `num_workgroups` | The dispatch size in workgroups. |

## Included Uniforms

gpucat provides the common per-frame and per-object values as ready-made nodes, so you do not wire them up yourself. Drop them straight into a shader graph. Each links to its full entry in [api.md](./api.md).

| Node | Type | What it is |
| --- | --- | --- |
| [`cameraProjectionMatrix`](./api.md#cameraprojectionmatrix) | `mat4x4f` | The camera's projection: view space to clip space. |
| [`cameraViewMatrix`](./api.md#cameraviewmatrix) | `mat4x4f` | World space to view space (the camera's inverse world matrix). |
| [`cameraPosition`](./api.md#cameraposition) | `vec3f` | The camera's world-space position. |
| [`cameraNear`](./api.md#cameranear) | `f32` | Near clip plane distance. |
| [`cameraFar`](./api.md#camerafar) | `f32` | Far clip plane distance. |
| [`modelWorldMatrix`](./api.md#modelworldmatrix) | `mat4x4f` | The current object's local space to world space (its `matrixWorld`). |
| [`modelNormalMatrix`](./api.md#modelnormalmatrix) | `mat3x3f` | Transforms normals to world space (inverse-transpose of the world matrix). |
| [`fragCoord`](./api.md#fragcoord) | `vec4f` | Builtin fragment position: `.xy` in pixels, `.z` the depth. |
| [`screenCoordinate`](./api.md#screencoordinate) | `vec2f` | Fragment pixel coordinate (`fragCoord.xy`). |
| [`screenSize`](./api.md#screensize) | `vec2f` | Viewport size in pixels. |
| [`screenUV`](./api.md#screenuv) | `vec2f` | Normalized screen position, `0` to `1`. |

## Compute

Compute shaders use the same node API. You declare storage buffers, write a kernel with `Fn(...).compute(...)`, and dispatch it through the renderer before you render. Index into a buffer with `index(buf, i)` and write with `.assign(...)`.

```ts
// a storage buffer the kernel reads and writes
const positions = storage(createStorageBuffer(d.array(d.vec4f), data), 'read_write');

const sim = Fn(() => {
    const i = globalId.x;
    const p = index(positions, i);
    index(positions, i).assign(p.add(vec4(0, 0.01, 0, 0)));
}).compute({ workgroupSize: [64, 1, 1] });

// in the frame loop, before rendering:
renderer.compute([{ node: sim, dispatch: [Math.ceil(N / 64), 1, 1] }]);
```

The same buffer can feed a material, which is how the particle example draws what the compute pass just updated. A compute kernel can also write to a texture instead of a buffer — see [Storage textures](#storage-textures).

For a full worked example, `examples/src/example-webgpu-ball-cluster.ts` simulates balls that pull toward a point and collide into a packed cluster, all on the GPU. It runs three compute passes per frame (clear grid, bin into a spatial-hash grid while snapshotting the previous state, then forces + collision against the 27 neighbouring cells), so each ball only checks nearby balls instead of every other one. `examples/src/example-webgpu-compute-particles.ts` is a simpler starting point.

<RenderCategory name="compute" compact />

<ExamplesTable ids="example-webgpu-compute-particles,example-webgpu-ball-cluster" />

## Transform feedback (WebGL2)

`compute()` is WebGPU-only. On WebGL2, gpucat exposes the platform's honest own-index GPU-simulation primitive directly: **transform feedback**. A kernel takes named per-element **attribute inputs** and returns named **captured-varying outputs**, written with the same node DSL as everything else. It runs as a vertex program under `RASTERIZER_DISCARD`, so each invocation `i` reads element `i` of its inputs and writes element `i` of its outputs.

```ts
const dt = uniform('dt', d.f32);

// attribute-in (pos, vel) → captured-varying-out (pos). The body is ordinary DSL.
const kernel = transformFeedback(
    (io) => ({ pos: io.pos.add(io.vel.mul(dt)) }),
    { inputs: { pos: d.vec4f, vel: d.vec4f }, outputs: { pos: d.vec4f } },
);
```

You bind the input/output buffers at the **run site** (not on the node), because ping-pong means a different buffer each frame. There is no auto-swap and no hidden double buffer, you hold the buffers and swap them yourself:

```ts
let [cur, next] = [bufA, bufB];   // two GpuBuffers of the same schema

function frame() {
    renderer.transformFeedback(kernel, {
        inputs: { pos: cur, vel: velBuf },   // name → GpuBuffer, bound as a vertex attribute
        outputs: { pos: next },              // name → GpuBuffer, the captured-varying target
        count: N,                            // → drawArrays(POINTS, 0, N) under RASTERIZER_DISCARD
    });
    [cur, next] = [next, cur];               // explicit ping-pong; nothing swaps behind your back
    // ...read `cur` back, or run another pass...
}
```

`transformFeedback()` and `readBufferAsync()` are **`WebGLRenderer`-only** methods. Calling them on a `WebGPURenderer` is a compile-time type error, the same as `compute()` on `WebGLRenderer`. Inside the kernel body you can use `uniform()` and `textureLoad()` (an explicit `DataTexture` you bind, for neighbour gather); the element index is `vertexIndex` (or `instanceIndex` when you pass `instanceCount`). Outputs are scalar / vector types; `vec3` wants `vec4f` and struct outputs are not supported (both throw a clear message). Scatter, arbitrary-index writes, and atomics are not part of this model; use `compute()` on WebGPU for those.

### Sharing the body with `compute()`

Both `transformFeedback()` and `compute()` are thin I/O wrappers over the same DSL, so the per-element math is a shared `Fn` you write once. Portability comes from reusing the body, not from one primitive pretending to span backends:

```ts
// written once, no I/O model baked in
const step = Fn((pos, vel, dt) => pos.add(vel.mul(dt)), {
    params: [{ name: 'pos', type: d.vec4f }, { name: 'vel', type: d.vec4f }, { name: 'dt', type: d.f32 }],
    return: d.vec4f,
});

// WebGL2: attribute-in / return-out (own index)
transformFeedback((io) => ({ pos: step(io.pos, io.vel, dt) }), { inputs, outputs });

// WebGPU: storage, arbitrary index, scatter/atomics available
Fn(() => { const i = globalId.x; index(out, i).assign(step(index(posS, i), index(velS, i), dt)); })
    .compute({ workgroupSize: [64, 1, 1] });
```

The wrappers differ because the I/O models genuinely differ (own-index attributes/varyings vs arbitrary-index storage), and that difference is stated, not disguised.

See [`transformFeedback`](./api.md#transformfeedback).

<ExamplesTable ids="example-webgl-transform-feedback-particles" />

## Drawing Many Things

The scene graph (`Scene`, `Object3D`, `Mesh`) organises draws; it is not a semantic model of your world, and not one `Mesh` per entity. A `Mesh` is "draw this geometry with this material this many times". When you have many of something, you do not give each one its own `Mesh`. You draw them together, with one of two techniques:

- **Instancing** issues one geometry many times in a single draw call. Each instance reads its own data (a transform, a colour, a position) from a buffer, indexed by `instanceIndex`. You set the count from the CPU.
- **Indirect drawing** moves the draw arguments themselves (how many indices, how many instances, where to start) into a GPU buffer. A compute pass can then write those arguments, so the GPU decides what and how much to draw without a CPU round-trip.

They compose: an instanced draw can take its instance count from an indirect buffer that a compute pass culls into. Both are the intended way to draw anything you have a lot of, not an optimisation to add later.

### Instancing

Set `mesh.count` to draw the same geometry many times in one call, and read `instanceIndex` in the vertex shader to vary each instance. The data each instance needs (a transform, a color, a position) lives in a `storage` buffer you index by `instanceIndex`, so there is no per-instance CPU work:

```ts
const transforms = storage(createStorageBuffer(d.array(d.mat4x4f), data), 'read');
const world = index(transforms, instanceIndex);   // this instance's matrix
// ...
mesh.count = N;
```

A compute pass can fill or update that buffer, so the instances are driven entirely on the GPU. This is how the particle and ball-cluster examples work. This runs on WebGL2 too. A read-only `storage(buffer, 'read')` read [lowers to a texture](#reads-run-on-webgl2-as-a-texture), or you can hold the per-instance data in a [data texture](#structured-data) and read it with `load(schema, instanceIndex)`.

<ExamplesTable ids="example-webgpu-instanced-mesh,example-webgpu-instancing-storage-buffer" />

### Indirect drawing

With an indirect buffer the draw arguments (index count, instance count, offsets) live in GPU memory instead of being passed from the CPU. Pack them with the `DrawIndirect` (non-indexed) or `DrawIndexedIndirect` (indexed) struct, put them in a `createIndirectBuffer`, and assign it to a geometry:

```ts
const args = new Uint32Array(packArray(DrawIndexedIndirect, [
    { indexCount, instanceCount, firstIndex: 0, baseVertex: 0, firstInstance: 0 },
]));
geometry.indirect = createIndirectBuffer(DrawIndexedIndirect, args);
```

One buffer can hold several draws (`geometry.indirectDrawCount`), and `geometry.indirectOffset` skips a header. The real payoff is GPU-driven rendering: the buffer has `storage` + `indirect` usage, so a compute pass can write the `instanceCount` (culling, LOD, spawning) and the draw reads it the same frame, with no CPU readback. `renderer.compute([{ node, indirect: buf }])` dispatches a compute pass the same way, with its workgroup counts read from a buffer.

<RenderCategory name="indirect" compact />

See `examples/src/example-webgpu-indirect-batched.ts` (CPU-driven multi-draw) and `example-webgpu-indirect-compute.ts` (a compute pass writes the draw args each frame).

<ExamplesTable ids="example-webgpu-indirect-batched,example-webgpu-indirect-compute,example-webgpu-voxels" />

## Controls and the Inspector

Camera controls drive a camera from input. Construct one with the camera and the canvas, and call `update()` each frame:

```ts
const controls = new OrbitControls(camera, renderer.domElement);
// in the frame loop, before rendering:
controls.update();
```

`FlyControls` (first-person, `update(dt)`) and `TransformControls` (a gizmo for moving objects) follow the same shape.

The built-in **Inspector** is an in-page debugger for shaders, draw and compute calls, buffers, and timings. Attach it to the renderer and add its element to the page:

```ts
renderer.inspector = new Inspector();
document.body.appendChild(renderer.inspector.domElement);
```

See [`OrbitControls`](./api.md#orbitcontrols) and [`Inspector`](./api.md#inspector).

<ExamplesTable ids="example-webgpu-transform-controls,example-webgpu-fly-controls" />

## Compiling to WGSL

A node graph is compiled to a WGSL string by `compile()` (for a material's vertex/fragment slots) or `compileCompute()` (for a compute kernel). You rarely call these directly, `Material` and `compute` dispatch do it for you, but they are the seam if you want to inspect the generated shader.

The point of the node graph is that it produces readable WGSL. For example, this material fragment:

```ts
const a = color.toVar('a');
const result = a.mul(a.mul(f32(2.51)).add(vec3f(0.03))).toVar('result');
```

compiles to roughly:

```wgsl
var a = color;
var result = (a * ((a * 2.51) + vec3f(0.03)));
```

## WGSL or GLSL to gpucat

A quick cheat-sheet if you know WGSL or GLSL. You write the node DSL, and it compiles to both.

| WGSL | GLSL | gpucat |
| --- | --- | --- |
| `let x = 1.0;` | `float x = 1.0;` | `const x = f32(1)` (auto-hoisted, or `Let('x', f32(1))`) |
| `var x = 1.0;` | (mutable by default) | `const x = Var('x', f32(1))` |
| `f32`, `i32`, `u32`, `bool` | `float`, `int`, `uint`, `bool` | `d.f32`, `d.i32`, `d.u32`, `d.bool` |
| `vec3f`, `mat3x3f`, `mat4x4f` | `vec3`, `mat3`, `mat4` | `d.vec3f`, `d.mat3x3f`, `d.mat4x4f` |
| `vec3f(1, 0, 0)` | `vec3(1, 0, 0)` | `vec3(1, 0, 0)` |
| `a * b` | `a * b` | `mul(a, b)` or `a.mul(b)` |
| `a.xyz` | `a.xyz` | `a.xyz` |
| `dot(a, b)`, `mix(a, b, t)` | `dot(a, b)`, `mix(a, b, t)` | `dot(a, b)`, `mix(a, b, t)` (or `a.dot(b)`) |
| `select(f, t, c)` | `c ? t : f` | `select(f, t, c)` or `cond(c, t, f)` |
| `if (c) { } else { }` | `if (c) { } else { }` | `If(c, () => { }).Else(() => { })` |
| `for (var i ...) { }` | `for (int i ...) { }` | `Loop(n, ({ i }) => { })` |
| `discard;` | `discard;` | `Discard()` |
| `@location(0) p: vec3f` (vertex in) | `in vec3 aP;` | `attribute('p', d.vec3f)` |
| `@location(0)` interstage | `out` / `in vec3 v;` | `const v = varying(value, 'v')` |
| `var<uniform> ...` | `uniform float uT;` | `uniform('uT', d.f32)` |
| `var<storage> array<u32>` | (no equivalent) | `storage('data', d.array(d.u32), 'read')` |
| `textureSample(t, s, uv)` | `texture(tex, uv)` | `texture(t).sample(uv)` |
| `textureLoad(t, xy, 0)` | `texelFetch(tex, xy, 0)` | `texture(t).load(vec2i(x, y))` |
| return `@builtin(position)` | `gl_Position` | the material's `vertex` output |
| return `@location(0)` | `gl_FragColor` | the material's `fragment` output |
| `@builtin(position)` (fragment) | `gl_FragCoord` | `fragCoord` |
| `@builtin(vertex_index)` | `gl_VertexID` | `vertexIndex` |
| `@builtin(instance_index)` | `gl_InstanceID` | `instanceIndex` |
| `fn f(x: f32) -> f32 { }` | `float f(float x) { }` | `Fn((x) => ..., { name: 'f', params: [{ name: 'x', type: d.f32 }] })` |

## API Reference

The shading-language surface is documented in the sections above. For the rest of the API, the renderer, scene, GPU resources, schema, and controls, see **[api.md](./api.md)**, generated from the source.
