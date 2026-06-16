![cover](./docs/cover.png)

```sh
> npm install isaac-mason/gpucat
```

> gpucat is being built in public. installation is via the github repo instead of npm for now.

# gpucat

gpucat is a minimal typescript-first WebGPU renderer.

It is a marriage of ideas in three.js and typegpu. It has a node-based shading language similar to [three.js TSL](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language), and has the typescript-first, WebGPU-native feel of [typegpu](https://typegpu.com).

You get a declarative API for GPU resources (buffers, uniforms, textures, materials), a type-safe node-based shading language that mirrors WGSL grammar and compiles to WGSL, and gpucat handles the generation of pipelines, layouts, bind groups, and resource lifecycles for you.

Most WebGPU libraries either hide the GPU behind a scene abstraction or hand you raw WGSL strings. gpucat sits in between. You compose shaders as typed typescript expressions, so refactors and autocomplete work, but nothing stops you dropping down to the renderer, pipeline, and buffer level when you need to.

## Examples

Every screenshot links to its source in `examples/src`. Run them locally with `npm install && npm run dev` in `examples/`.

<Examples />

## Contents

- [Examples](#examples) · [Getting Started](#getting-started) · [Core Concepts](#core-concepts)
- Build an app: [The Renderer](#the-renderer) · [Scene and Objects](#scene-and-objects) · [Geometry](#geometry) · [Materials](#materials) · [Uniforms](#uniforms) · [Storage Buffers](#storage-buffers) · [Structs](#structs) · [Packing](#packing) · [Render Pipeline](#render-pipeline)
- Shading language: [Constants](#constants-and-constructors) · [Operators](#operators) · [Variables](#variables) · [Control Flow](#control-flow) · [Method Chaining](#method-chaining) · [Functions](#functions) · [Building Blocks](#building-blocks) · [Varyings](#varyings) · [Textures](#textures-and-samplers) · [Atomics](#atomics) · [Builtins](#builtins) · [Included Uniforms](#included-uniforms)
- [Compute](#compute) · [Drawing Many Things](#drawing-many-things) · [Controls and the Inspector](#controls-and-the-inspector)
- [Compiling to WGSL](#compiling-to-wgsl) · [WGSL to gpucat](#wgsl-to-gpucat) · [API Reference](#api-reference)

## Getting Started

A minimal spinning cube. Renderer setup, a node-based material, and a `requestAnimationFrame` loop:

<Snippet source="./snippets.ts" select="spinning-cube" />

A few things to notice:

- The material is just two nodes: `vertex` (a clip-space position) and `fragment` (a `vec4f` color). You build them by composing smaller nodes, and gpucat compiles the resulting graph to WGSL.
- You own the frame loop. gpucat never starts its own `requestAnimationFrame` and never reads a wall clock. You call `render()` (and `compute()`) when you want a frame, and you drive time yourself via plain uniforms, so it stays composable with your own update loop.


<ExamplesTable ids="example-hello-world" />

## Core Concepts

### Nodes and the graph

Everything in a shader is a node. `attribute`, `uniform`, `add`, `mul`, `texture`, `vec3`, and the rest each create a node, and nodes compose into a graph:

```ts
const position = attribute('position', d.vec3f);             // a vertex input
const world = mul(modelWorldMatrix, vec4(position, f32(1)));  // node math
const clip = mul(cameraProjectionMatrix, mul(cameraViewMatrix, world));
```

Nothing has run on the GPU yet. You have built an expression graph. When you hand a node to a `Material` (or call `compile()` directly), gpucat walks the graph, eliminates common subexpressions, and emits WGSL.

### Types: the `d` namespace

Types come from the `d` namespace: `d.vec3f`, `d.f32`, `d.mat4x4f`, `d.array(d.u32)`, `d.struct(...)`. These are WGSL type descriptors. They describe the data on the GPU and give the typescript compiler enough to type-check your shader.

There is a split worth internalising early: `d.f32` is the *type*, `f32(1)` is a *node* of that type. The same split you see between a value and its type. You annotate with `d.f32`, you build a node with `f32(1)`.

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

There is no `beginFrame`/`endFrame`; each `render()` and `compute()` call is self-contained, so you decide when and how often frames happen. See [`WebGPURenderer`](./api.md#webgpurenderer).

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

Meshes are not game entities. gpucat does not tick them every frame or track changes for you. Setting `position`, `quaternion`, or `scale` does nothing on its own; nothing recomputes until you ask. You decide when, and you should be deliberate about it: update the objects that actually moved, not the whole scene on every frame.

- `object.updateWorldMatrix()` recomputes that object's `matrixWorld` and `normalMatrix` (which feed `modelWorldMatrix` and `modelNormalMatrix` in shaders) and recurses into its children. Move a mesh, update that mesh.
- `camera.updateViewMatrix()` inverts the camera's world matrix into the view matrix that `cameraViewMatrix` reads. Call it after the camera's world matrix is current, and only when the camera moved.
- `camera.updateProjectionMatrix()` rebuilds the projection from `fov` / `aspect` / `near` / `far`. Only when those change, typically in your resize handler.

`scene.updateWorldMatrix()` is the same call on the root: it walks the whole tree, parents before children. It is a convenience for initial setup or a one-off bulk update, not something to run every frame for a mostly-static scene. Be intelligent about it.

<ExamplesTable ids="example-moving-mesh-stress,example-static-mesh-stress" />

## Geometry

A `Geometry` is a set of named vertex buffers plus an optional index buffer. The buffer names line up with the `attribute('name', type)` nodes in your vertex shader.

```ts
const geom = new Geometry();
geom.setBuffer('position', createVertexBuffer(d.vec3f, positions));
geom.setBuffer('normal', createVertexBuffer(d.vec3f, normals));
geom.index = createIndexBuffer(indices);   // a Uint16Array or Uint32Array
```

For common shapes, the `create*Geometry` helpers build the position, normal, and uv buffers and an index for you. See [`Geometry`](./api.md#geometry) and the helpers in [api.md](./api.md#geometry).

<ExamplesTable ids="example-line,example-raging-sea,example-voxels,example-interleaved" />

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

<ExamplesTable ids="example-point-lights" />

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

<ExamplesTable ids="example-uniforms" />

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

See [`storage`](./api.md#storage), [`createStorageBuffer`](./api.md#createstoragebuffer), and [`GpuBuffer`](./api.md#gpubuffer).

<ExamplesTable ids="example-storage,example-instancing-storage-buffer,example-compute-particles" />

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

<ExamplesTable ids="example-render-to-texture,example-shadow-map" />

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

<ExamplesTable ids="example-cube-camera" />

### Tonemapping and post-processing

<RenderCategory name="tonemapping and color space conversions" compact />
<RenderCategory name="post-processing effects" compact />

<ExamplesTable ids="example-mrt,example-fxaa" />

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

<ExamplesTable ids="example-discard" />

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

<ExamplesTable ids="example-texture,example-mipmaps,example-cubemap,example-array-texture" />

## Atomics

Atomic operations on `atomic<i32>` / `atomic<u32>` storage, for compute.

<RenderCategory name="atomic operations" compact />

<ExamplesTable ids="example-ball-cluster" />

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

The same buffer can feed a material, which is how the particle example draws what the compute pass just updated.

For a full worked example, `examples/src/example-ball-cluster.ts` simulates balls that pull toward a point and collide into a packed cluster, all on the GPU. It runs three compute passes per frame (clear grid, bin into a spatial-hash grid while snapshotting the previous state, then forces + collision against the 27 neighbouring cells), so each ball only checks nearby balls instead of every other one. `examples/src/example-compute-particles.ts` is a simpler starting point.

<RenderCategory name="compute" compact />

<ExamplesTable ids="example-compute-particles,example-ball-cluster" />

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

A compute pass can fill or update that buffer, so the instances are driven entirely on the GPU. This is how the particle and ball-cluster examples work.

<ExamplesTable ids="example-instanced-mesh,example-instancing-storage-buffer" />

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

See `examples/src/example-indirect-batched.ts` (CPU-driven multi-draw) and `example-indirect-compute.ts` (a compute pass writes the draw args each frame).

<ExamplesTable ids="example-indirect-batched,example-indirect-compute,example-voxels-batched" />

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

<ExamplesTable ids="example-transform-controls,example-fly-controls" />

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

## WGSL to gpucat

A quick cheat-sheet if you know WGSL.

| WGSL | gpucat |
| --- | --- |
| `let x = 1.0;` | `const x = f32(1)` (auto-hoisted, or `Let('x', f32(1))`) |
| `var x = 1.0;` | `const x = Var('x', f32(1))` |
| `vec3f(1, 0, 0)` | `vec3(1, 0, 0)` or `vec3f(1, 0, 0)` |
| `a * b` | `mul(a, b)` or `a.mul(b)` |
| `a.xyz` | `a.xyz` |
| `dot(a, b)` | `dot(a, b)` or `a.dot(b)` |
| `select(f, t, cond)` | `select(f, t, cond)` |
| `if (c) { ... } else { ... }` | `If(c, () => { ... }).Else(() => { ... })` |
| `for (var i ...) { ... }` | `Loop(n, ({ i }) => { ... })` |
| `@group(0) @binding(0) var<uniform> ...` | `uniform('name', d.f32)` |
| `var<storage> data: array<u32>;` | `storage('data', d.array(d.u32), 'read')` |
| `textureSample(t, s, uv)` | `texture(t)` or `textureSample(t, s, uv)` |
| `fn f(x: f32) -> f32 { ... }` | `Fn((x) => ..., { name: 'f', params: [{ name: 'x', type: d.f32 }] })` |
| `fn f(...) -> vec3f { ... }` | add `return: d.vec3f` to the layout to pin the type (checked against the body) |

## API Reference

The shading-language surface is documented in the sections above. For the rest of the API, the renderer, scene, GPU resources, schema, and controls, see **[api.md](./api.md)**, generated from the source.
