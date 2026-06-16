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

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-hello-world.ts">
        <img src="./examples/public/screenshots/example-hello-world.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Hello World
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-point-lights.ts">
        <img src="./examples/public/screenshots/example-point-lights.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Point Lights
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-moving-mesh-stress.ts">
        <img src="./examples/public/screenshots/example-moving-mesh-stress.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Moving Mesh Stress
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-static-mesh-stress.ts">
        <img src="./examples/public/screenshots/example-static-mesh-stress.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Static Mesh Stress
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-line.ts">
        <img src="./examples/public/screenshots/example-line.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Line
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-texture.ts">
        <img src="./examples/public/screenshots/example-texture.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Texture
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-render-to-texture.ts">
        <img src="./examples/public/screenshots/example-render-to-texture.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Render to Texture
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-mipmaps.ts">
        <img src="./examples/public/screenshots/example-mipmaps.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Mipmaps
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-instanced-mesh.ts">
        <img src="./examples/public/screenshots/example-instanced-mesh.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Instanced Mesh
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-instancing-storage-buffer.ts">
        <img src="./examples/public/screenshots/example-instancing-storage-buffer.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Instancing with Storage Buffer
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-compute-particles.ts">
        <img src="./examples/public/screenshots/example-compute-particles.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Compute Particles
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-ball-cluster.ts">
        <img src="./examples/public/screenshots/example-ball-cluster.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Ball Cluster
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-indirect-batched.ts">
        <img src="./examples/public/screenshots/example-indirect-batched.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Indirect Batched
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-indirect-compute.ts">
        <img src="./examples/public/screenshots/example-indirect-compute.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Indirect Compute
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-mrt.ts">
        <img src="./examples/public/screenshots/example-mrt.png" width="180" height="120" style="object-fit:cover;"/><br/>
        MRT (Multiple Render Targets)
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-raging-sea.ts">
        <img src="./examples/public/screenshots/example-raging-sea.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Raging Sea
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-uniforms.ts">
        <img src="./examples/public/screenshots/example-uniforms.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Uniforms
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-storage.ts">
        <img src="./examples/public/screenshots/example-storage.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Storage Buffers
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-voxels.ts">
        <img src="./examples/public/screenshots/example-voxels.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Voxels
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-voxels-batched.ts">
        <img src="./examples/public/screenshots/example-voxels-batched.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Voxels Batched
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-interleaved.ts">
        <img src="./examples/public/screenshots/example-interleaved.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Interleaved Vertex Buffers
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-cubemap.ts">
        <img src="./examples/public/screenshots/example-cubemap.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Cube Texture Skybox
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-cube-camera.ts">
        <img src="./examples/public/screenshots/example-cube-camera.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Cube Camera
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-discard.ts">
        <img src="./examples/public/screenshots/example-discard.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Discard
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-shadow-map.ts">
        <img src="./examples/public/screenshots/example-shadow-map.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Shadow Map
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-array-texture.ts">
        <img src="./examples/public/screenshots/example-array-texture.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Array Texture Flipbook
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-fxaa.ts">
        <img src="./examples/public/screenshots/example-fxaa.png" width="180" height="120" style="object-fit:cover;"/><br/>
        FXAA
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-transform-controls.ts">
        <img src="./examples/public/screenshots/example-transform-controls.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Transform Controls
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-fly-controls.ts">
        <img src="./examples/public/screenshots/example-fly-controls.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Fly Controls
      </a>
    </td>
  </tr>
</table>

## Contents

- [Examples](#examples) · [Getting Started](#getting-started) · [Core Concepts](#core-concepts)
- Build an app: [The Renderer](#the-renderer) · [Scene and Objects](#scene-and-objects) · [Geometry](#geometry) · [Materials](#materials) · [Uniforms](#uniforms) · [Storage Buffers](#storage-buffers) · [Structs](#structs) · [Packing](#packing) · [Render Pipeline](#render-pipeline)
- Shading language: [Constants](#constants-and-constructors) · [Operators](#operators) · [Variables](#variables) · [Control Flow](#control-flow) · [Method Chaining](#method-chaining) · [Functions](#functions) · [Building Blocks](#building-blocks) · [Varyings](#varyings) · [Textures](#textures-and-samplers) · [Atomics](#atomics) · [Builtins](#builtins) · [Included Uniforms](#included-uniforms)
- [Compute](#compute) · [Drawing Many Things](#drawing-many-things) · [Controls and the Inspector](#controls-and-the-inspector)
- [Compiling to WGSL](#compiling-to-wgsl) · [WGSL to gpucat](#wgsl-to-gpucat) · [API Reference](#api-reference)

## Getting Started

A minimal spinning cube. Renderer setup, a node-based material, and a `requestAnimationFrame` loop:

```ts
import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createBoxGeometry,
    d,
    f32,
    Material,
    Mesh,
    modelNormalMatrix,
    modelWorldMatrix,
    mul,
    normalize,
    pass,
    PerspectiveCamera,
    renderOutput,
    RenderPipeline,
    Scene,
    varying,
    vec3,
    vec4,
    WebGPURenderer,
} from 'gpucat';
import { quat } from 'mathcat';

// renderer
const renderer = new WebGPURenderer({ antialias: true });
await renderer.init();
document.body.appendChild(renderer.domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

// scene + camera
const scene = new Scene();
const camera = new PerspectiveCamera(Math.PI / 4, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position[2] = 4;
scene.add(camera);

// vertex: project the cube into clip space, varying the world-space normal
const position = attribute('position', d.vec3f);
const normal = attribute('normal', d.vec3f);
const worldPosition = mul(modelWorldMatrix, vec4(position, f32(1)));
const clipPosition = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPosition));
const vWorldNormal = varying(normalize(mul(modelNormalMatrix, normal)), 'vNormal');

// fragment: simple Lambert shading
const lightDirection = vec3(0.6, 1.0, 0.8).normalize();
const diffuse = vWorldNormal.dot(lightDirection).max(f32(0));
const lighting = f32(0.15).add(diffuse);
const litColor = vec3(0.4, 0.7, 1.0).mul(lighting);

// mesh
const material = new Material({ vertex: clipPosition, fragment: vec4(litColor, f32(1)) });
const mesh = new Mesh(createBoxGeometry(1, 1, 1), material);
scene.add(mesh);

// render pipeline
const scenePass = pass(scene, camera);
const renderPipeline = new RenderPipeline(renderer, renderOutput(scenePass.getTextureNode()));

// frame loop
let angle = 0;
let prevTime = performance.now() / 1000;

function frame() {
    const now = performance.now() / 1000;
    const dt = now - prevTime;
    prevTime = now;

    angle += dt * 0.8;
    quat.fromEuler(mesh.quaternion, [angle * 0.6, angle, 0, 'xyz']);
    mesh.updateWorldMatrix();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    renderPipeline.render();
    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
```

A few things to notice:

- The material is just two nodes: `vertex` (a clip-space position) and `fragment` (a `vec4f` color). You build them by composing smaller nodes, and gpucat compiles the resulting graph to WGSL.
- You own the frame loop. gpucat never starts its own `requestAnimationFrame` and never reads a wall clock. You call `render()` (and `compute()`) when you want a frame, and you drive time yourself via plain uniforms, so it stays composable with your own update loop.
- Resources are declarative. A `Mesh` is geometry plus material, a `RenderPipeline` is a renderer plus an output node. gpucat derives the pipeline, layouts, and bind groups from what you reference.

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-hello-world.ts">
        <img src="./examples/public/screenshots/example-hello-world.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Hello World
      </a>
    </td>
  </tr>
</table>

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

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-moving-mesh-stress.ts">
        <img src="./examples/public/screenshots/example-moving-mesh-stress.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Moving Mesh Stress
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-static-mesh-stress.ts">
        <img src="./examples/public/screenshots/example-static-mesh-stress.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Static Mesh Stress
      </a>
    </td>
  </tr>
</table>

## Geometry

A `Geometry` is a set of named vertex buffers plus an optional index buffer. The buffer names line up with the `attribute('name', type)` nodes in your vertex shader.

```ts
const geom = new Geometry();
geom.setBuffer('position', createVertexBuffer(d.vec3f, positions));
geom.setBuffer('normal', createVertexBuffer(d.vec3f, normals));
geom.index = createIndexBuffer(indices);   // a Uint16Array or Uint32Array
```

For common shapes, the `create*Geometry` helpers build the position, normal, and uv buffers and an index for you. See [`Geometry`](./api.md#geometry) and the helpers in [api.md](./api.md#geometry).

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-line.ts">
        <img src="./examples/public/screenshots/example-line.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Line
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-raging-sea.ts">
        <img src="./examples/public/screenshots/example-raging-sea.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Raging Sea
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-voxels.ts">
        <img src="./examples/public/screenshots/example-voxels.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Voxels
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-interleaved.ts">
        <img src="./examples/public/screenshots/example-interleaved.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Interleaved Vertex Buffers
      </a>
    </td>
  </tr>
</table>

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

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-point-lights.ts">
        <img src="./examples/public/screenshots/example-point-lights.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Point Lights
      </a>
    </td>
  </tr>
</table>

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

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-uniforms.ts">
        <img src="./examples/public/screenshots/example-uniforms.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Uniforms
      </a>
    </td>
  </tr>
</table>

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

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-storage.ts">
        <img src="./examples/public/screenshots/example-storage.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Storage Buffers
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-instancing-storage-buffer.ts">
        <img src="./examples/public/screenshots/example-instancing-storage-buffer.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Instancing with Storage Buffer
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-compute-particles.ts">
        <img src="./examples/public/screenshots/example-compute-particles.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Compute Particles
      </a>
    </td>
  </tr>
</table>

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

<table><tr>
<td><a href="./api.md#pass"><code>pass</code></a></td><td><a href="./api.md#passnodeoptions"><code>PassNodeOptions</code></a></td>
</tr></table>

<table><tr>
<td><a href="./api.md#renderoutput"><code>renderOutput</code></a></td><td><a href="./api.md#outputcolorspace"><code>OutputColorSpace</code></a></td><td><a href="./api.md#renderoutputoptions"><code>RenderOutputOptions</code></a></td><td><a href="./api.md#tonemappingmode"><code>ToneMappingMode</code></a></td>
</tr></table>


<table>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-render-to-texture.ts">
        <img src="./examples/public/screenshots/example-render-to-texture.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Render to Texture
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-shadow-map.ts">
        <img src="./examples/public/screenshots/example-shadow-map.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Shadow Map
      </a>
    </td>
  </tr>
</table>

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

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-cube-camera.ts">
        <img src="./examples/public/screenshots/example-cube-camera.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Cube Camera
      </a>
    </td>
  </tr>
</table>

### Tonemapping and post-processing

<table><tr>
<td><a href="./api.md#acestonemapping"><code>acesToneMapping</code></a></td><td><a href="./api.md#reinhardtonemapping"><code>reinhardToneMapping</code></a></td><td><a href="./api.md#srgbtransfereotf"><code>sRGBTransferEOTF</code></a></td><td><a href="./api.md#srgbtransferoetf"><code>sRGBTransferOETF</code></a></td>
</tr></table>

<table><tr>
<td><a href="./api.md#fxaa"><code>fxaa</code></a></td>
</tr></table>


<table>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-mrt.ts">
        <img src="./examples/public/screenshots/example-mrt.png" width="200" height="133" style="object-fit:cover;"/><br/>
        MRT (Multiple Render Targets)
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-fxaa.ts">
        <img src="./examples/public/screenshots/example-fxaa.png" width="200" height="133" style="object-fit:cover;"/><br/>
        FXAA
      </a>
    </td>
  </tr>
</table>

## Constants and constructors

Scalar and vector constructors turn javascript numbers into typed constant nodes. `f32(0.5)`, `vec3(1, 0, 0)`, `mat4(...)`. The `vec*` constructors accept a mix of scalars and smaller vectors, so `vec4(rgb, 1)` works.

<table><tr>
<td><a href="./api.md#f16"><code>f16</code></a></td><td><a href="./api.md#f32"><code>f32</code></a></td><td><a href="./api.md#i32"><code>i32</code></a></td><td><a href="./api.md#u32"><code>u32</code></a></td><td><a href="./api.md#bool"><code>bool</code></a></td><td><a href="./api.md#rgb"><code>rgb</code></a></td>
</tr><tr>
<td><a href="./api.md#vec2"><code>vec2</code></a></td><td><a href="./api.md#vec2f"><code>vec2f</code></a></td><td><a href="./api.md#vec2h"><code>vec2h</code></a></td><td><a href="./api.md#vec2i"><code>vec2i</code></a></td><td><a href="./api.md#vec2u"><code>vec2u</code></a></td><td><a href="./api.md#vec2b"><code>vec2b</code></a></td>
</tr><tr>
<td><a href="./api.md#vec3"><code>vec3</code></a></td><td><a href="./api.md#vec3f"><code>vec3f</code></a></td><td><a href="./api.md#vec3h"><code>vec3h</code></a></td><td><a href="./api.md#vec3i"><code>vec3i</code></a></td><td><a href="./api.md#vec3u"><code>vec3u</code></a></td><td><a href="./api.md#vec3b"><code>vec3b</code></a></td>
</tr><tr>
<td><a href="./api.md#vec4"><code>vec4</code></a></td><td><a href="./api.md#vec4f"><code>vec4f</code></a></td><td><a href="./api.md#vec4h"><code>vec4h</code></a></td><td><a href="./api.md#vec4i"><code>vec4i</code></a></td><td><a href="./api.md#vec4u"><code>vec4u</code></a></td><td><a href="./api.md#vec4b"><code>vec4b</code></a></td>
</tr><tr>
<td><a href="./api.md#mat3"><code>mat3</code></a></td><td><a href="./api.md#mat4"><code>mat4</code></a></td><td><a href="./api.md#mat2x2f"><code>mat2x2f</code></a></td><td><a href="./api.md#mat2x3f"><code>mat2x3f</code></a></td><td><a href="./api.md#mat2x4f"><code>mat2x4f</code></a></td><td><a href="./api.md#mat3x2f"><code>mat3x2f</code></a></td>
</tr><tr>
<td><a href="./api.md#mat3x3f"><code>mat3x3f</code></a></td><td><a href="./api.md#mat3x4f"><code>mat3x4f</code></a></td><td><a href="./api.md#mat4x2f"><code>mat4x2f</code></a></td><td><a href="./api.md#mat4x3f"><code>mat4x3f</code></a></td><td><a href="./api.md#mat4x4f"><code>mat4x4f</code></a></td><td><a href="./api.md#mat2x2h"><code>mat2x2h</code></a></td>
</tr><tr>
<td><a href="./api.md#mat2x3h"><code>mat2x3h</code></a></td><td><a href="./api.md#mat2x4h"><code>mat2x4h</code></a></td><td><a href="./api.md#mat3x2h"><code>mat3x2h</code></a></td><td><a href="./api.md#mat3x3h"><code>mat3x3h</code></a></td><td><a href="./api.md#mat3x4h"><code>mat3x4h</code></a></td><td><a href="./api.md#mat4x2h"><code>mat4x2h</code></a></td>
</tr><tr>
<td><a href="./api.md#mat4x3h"><code>mat4x3h</code></a></td><td><a href="./api.md#mat4x4h"><code>mat4x4h</code></a></td><td></td><td></td><td></td><td></td>
</tr></table>


## Operators

Math and operators exist as free functions, and (see [method chaining](#method-chaining)) as methods. `add(a, b)` is `a.add(b)`. They are type-directed: `mul(mat4, vec4)` is a matrix-vector multiply, `mul(vec3, vec3)` is component-wise.

```ts
const lit = vec3(0.4, 0.7, 1.0).mul(f32(0.15).add(diffuse));
```

<table><tr>
<td><a href="./api.md#abs"><code>abs</code></a></td><td><a href="./api.md#add"><code>add</code></a></td><td><a href="./api.md#sub"><code>sub</code></a></td><td><a href="./api.md#mul"><code>mul</code></a></td><td><a href="./api.md#div"><code>div</code></a></td><td><a href="./api.md#mod"><code>mod</code></a></td>
</tr><tr>
<td><a href="./api.md#min"><code>min</code></a></td><td><a href="./api.md#max"><code>max</code></a></td><td><a href="./api.md#clamp"><code>clamp</code></a></td><td><a href="./api.md#mix"><code>mix</code></a></td><td><a href="./api.md#step"><code>step</code></a></td><td><a href="./api.md#smoothstep"><code>smoothstep</code></a></td>
</tr><tr>
<td><a href="./api.md#ceil"><code>ceil</code></a></td><td><a href="./api.md#floor"><code>floor</code></a></td><td><a href="./api.md#fract"><code>fract</code></a></td><td><a href="./api.md#sqrt"><code>sqrt</code></a></td><td><a href="./api.md#inversesqrt"><code>inverseSqrt</code></a></td><td><a href="./api.md#pow"><code>pow</code></a></td>
</tr><tr>
<td><a href="./api.md#exp"><code>exp</code></a></td><td><a href="./api.md#exp2"><code>exp2</code></a></td><td><a href="./api.md#log"><code>log</code></a></td><td><a href="./api.md#log2"><code>log2</code></a></td><td><a href="./api.md#tan"><code>tan</code></a></td><td><a href="./api.md#atan"><code>atan</code></a></td>
</tr><tr>
<td><a href="./api.md#atan2"><code>atan2</code></a></td><td><a href="./api.md#asin"><code>asin</code></a></td><td><a href="./api.md#acos"><code>acos</code></a></td><td><a href="./api.md#length"><code>length</code></a></td><td><a href="./api.md#normalize"><code>normalize</code></a></td><td><a href="./api.md#dot"><code>dot</code></a></td>
</tr><tr>
<td><a href="./api.md#cross"><code>cross</code></a></td><td><a href="./api.md#pack2x16float"><code>pack2x16float</code></a></td><td><a href="./api.md#unpack2x16float"><code>unpack2x16float</code></a></td><td><a href="./api.md#pack2x16snorm"><code>pack2x16snorm</code></a></td><td><a href="./api.md#unpack2x16snorm"><code>unpack2x16snorm</code></a></td><td><a href="./api.md#pack2x16unorm"><code>pack2x16unorm</code></a></td>
</tr><tr>
<td><a href="./api.md#unpack2x16unorm"><code>unpack2x16unorm</code></a></td><td><a href="./api.md#pack4x8snorm"><code>pack4x8snorm</code></a></td><td><a href="./api.md#unpack4x8snorm"><code>unpack4x8snorm</code></a></td><td><a href="./api.md#pack4x8unorm"><code>pack4x8unorm</code></a></td><td><a href="./api.md#unpack4x8unorm"><code>unpack4x8unorm</code></a></td><td><a href="./api.md#bitcastf32"><code>bitcastF32</code></a></td>
</tr><tr>
<td><a href="./api.md#bitcastu32"><code>bitcastU32</code></a></td><td><a href="./api.md#bitcasti32"><code>bitcastI32</code></a></td><td><a href="./api.md#sign"><code>sign</code></a></td><td><a href="./api.md#sin"><code>sin</code></a></td><td><a href="./api.md#cos"><code>cos</code></a></td><td><a href="./api.md#transpose"><code>transpose</code></a></td>
</tr><tr>
<td><a href="./api.md#countonebits"><code>countOneBits</code></a></td><td><a href="./api.md#counttrailingzeros"><code>countTrailingZeros</code></a></td><td><a href="./api.md#countleadingzeros"><code>countLeadingZeros</code></a></td><td><a href="./api.md#reversebits"><code>reverseBits</code></a></td><td><a href="./api.md#firstleadingbit"><code>firstLeadingBit</code></a></td><td><a href="./api.md#firsttrailingbit"><code>firstTrailingBit</code></a></td>
</tr><tr>
<td><a href="./api.md#dpdx"><code>dpdx</code></a></td><td><a href="./api.md#dpdy"><code>dpdy</code></a></td><td><a href="./api.md#fwidth"><code>fwidth</code></a></td><td><a href="./api.md#dpdxcoarse"><code>dpdxCoarse</code></a></td><td><a href="./api.md#dpdycoarse"><code>dpdyCoarse</code></a></td><td><a href="./api.md#fwidthcoarse"><code>fwidthCoarse</code></a></td>
</tr><tr>
<td><a href="./api.md#dpdxfine"><code>dpdxFine</code></a></td><td><a href="./api.md#dpdyfine"><code>dpdyFine</code></a></td><td><a href="./api.md#fwidthfine"><code>fwidthFine</code></a></td><td></td><td></td><td></td>
</tr></table>


### Comparison

<table><tr>
<td><a href="./api.md#greaterthan"><code>greaterThan</code></a></td><td><a href="./api.md#lessthan"><code>lessThan</code></a></td><td><a href="./api.md#greaterthanequal"><code>greaterThanEqual</code></a></td><td><a href="./api.md#lessthanequal"><code>lessThanEqual</code></a></td><td><a href="./api.md#equal"><code>equal</code></a></td><td><a href="./api.md#notequal"><code>notEqual</code></a></td>
</tr><tr>
<td><a href="./api.md#or"><code>or</code></a></td><td><a href="./api.md#and"><code>and</code></a></td><td></td><td></td><td></td><td></td>
</tr></table>


### Bitwise

<table><tr>
<td><a href="./api.md#bitwiseand"><code>bitwiseAnd</code></a></td><td><a href="./api.md#bitwiseor"><code>bitwiseOr</code></a></td><td><a href="./api.md#bitwisexor"><code>bitwiseXor</code></a></td><td><a href="./api.md#shiftleft"><code>shiftLeft</code></a></td><td><a href="./api.md#shiftright"><code>shiftRight</code></a></td>
</tr></table>


## Variables

By default a reused expression is hoisted into a `let` automatically. When you want explicit, mutable WGSL variables (for accumulation, or to assign in a loop), use `Var`. The name comes first so it reads like a declaration:

```ts
const sum = Var('sum', f32(0));
Loop(8, ({ i }) => sum.assign(sum.add(i.toF32())));
```

`Let` is the immutable form. `PrivateVar` and `WorkgroupVar` declare module-scope storage for compute.

<table><tr>
<td><a href="./api.md#var"><code>Var</code></a></td><td><a href="./api.md#const"><code>Const</code></a></td><td><a href="./api.md#let"><code>Let</code></a></td><td><a href="./api.md#privatevar"><code>PrivateVar</code></a></td><td><a href="./api.md#workgroupvar"><code>WorkgroupVar</code></a></td>
</tr></table>


## Control Flow

`If` / `Loop` / `For` / `While` mirror WGSL control flow and take callbacks for their bodies. `select(a, b, cond)` and `cond(c, a, b)` are the expression-level ternary.

```ts
If(x.greaterThan(f32(0)), () => {
    result.assign(x);
}).Else(() => {
    result.assign(x.negate());
});
```

<table><tr>
<td><a href="./api.md#if"><code>If</code></a></td><td><a href="./api.md#loop"><code>Loop</code></a></td><td><a href="./api.md#for"><code>For</code></a></td><td><a href="./api.md#while"><code>While</code></a></td><td><a href="./api.md#break"><code>Break</code></a></td><td><a href="./api.md#continue"><code>Continue</code></a></td>
</tr><tr>
<td><a href="./api.md#return"><code>Return</code></a></td><td><a href="./api.md#discard"><code>Discard</code></a></td><td><a href="./api.md#workgroupbarrier"><code>workgroupBarrier</code></a></td><td><a href="./api.md#storagebarrier"><code>storageBarrier</code></a></td><td><a href="./api.md#texturebarrier"><code>textureBarrier</code></a></td><td><a href="./api.md#cond"><code>cond</code></a></td>
</tr><tr>
<td><a href="./api.md#select"><code>select</code></a></td><td></td><td></td><td></td><td></td><td></td>
</tr></table>


<table>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-discard.ts">
        <img src="./examples/public/screenshots/example-discard.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Discard
      </a>
    </td>
  </tr>
</table>

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

<table><tr>
<td><a href="./api.md#attribute"><code>attribute</code></a></td><td><a href="./api.md#attributeoptions"><code>AttributeOptions</code></a></td><td><a href="./api.md#builtin"><code>builtin</code></a></td><td><a href="./api.md#index"><code>index</code></a></td><td><a href="./api.md#field"><code>field</code></a></td><td><a href="./api.md#fields"><code>fields</code></a></td>
</tr><tr>
<td><a href="./api.md#uniform"><code>uniform</code></a></td><td><a href="./api.md#storage"><code>storage</code></a></td><td><a href="./api.md#array"><code>array</code></a></td><td><a href="./api.md#texture"><code>texture</code></a></td><td><a href="./api.md#varying"><code>varying</code></a></td><td><a href="./api.md#struct"><code>struct</code></a></td>
</tr><tr>
<td><a href="./api.md#wgsl"><code>wgsl</code></a></td><td><a href="./api.md#wgslfn"><code>wgslFn</code></a></td><td><a href="./api.md#fn"><code>Fn</code></a></td><td><a href="./api.md#mrt"><code>mrt</code></a></td><td><a href="./api.md#compute"><code>compute</code></a></td><td></td>
</tr></table>


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

<table><tr>
<td><a href="./api.md#sampler"><code>sampler</code></a></td><td><a href="./api.md#comparisonsampler"><code>comparisonSampler</code></a></td><td><a href="./api.md#cubetexture"><code>cubeTexture</code></a></td><td><a href="./api.md#depthtexture"><code>depthTexture</code></a></td><td><a href="./api.md#arraytexture"><code>arrayTexture</code></a></td><td><a href="./api.md#texturebinding"><code>textureBinding</code></a></td>
</tr><tr>
<td><a href="./api.md#texturesample"><code>textureSample</code></a></td><td><a href="./api.md#texturesamplelevel"><code>textureSampleLevel</code></a></td><td><a href="./api.md#texturesamplebias"><code>textureSampleBias</code></a></td><td><a href="./api.md#texturesamplegrad"><code>textureSampleGrad</code></a></td><td><a href="./api.md#texturesamplecompare"><code>textureSampleCompare</code></a></td><td><a href="./api.md#texturesamplecomparelevel"><code>textureSampleCompareLevel</code></a></td>
</tr><tr>
<td><a href="./api.md#textureload"><code>textureLoad</code></a></td><td><a href="./api.md#texturestore"><code>textureStore</code></a></td><td><a href="./api.md#texturedimensions"><code>textureDimensions</code></a></td><td><a href="./api.md#texturenumlevels"><code>textureNumLevels</code></a></td><td><a href="./api.md#texturenumlayers"><code>textureNumLayers</code></a></td><td><a href="./api.md#texturegather"><code>textureGather</code></a></td>
</tr><tr>
<td><a href="./api.md#texturegathercompare"><code>textureGatherCompare</code></a></td><td></td><td></td><td></td><td></td><td></td>
</tr></table>


### Creating texture resources

The `texture()` node takes a texture resource. Create one from an image, or from raw pixels:

```ts
const tex = new Texture(image);                          // HTMLImageElement, ImageBitmap, canvas
const data = new DataTexture(pixels, 256, 256, { format: 'rgba8unorm' });
```

`CubeTexture`, `ArrayTexture`, and `CanvasTexture` cover the other shapes, and sampler settings (`wrapS`, `magFilter`, `anisotropy`, and so on) live on the texture. A pass output is also a texture, which is what makes post-processing just node wiring. See [`Texture`](./api.md#texture).

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-texture.ts">
        <img src="./examples/public/screenshots/example-texture.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Texture
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-mipmaps.ts">
        <img src="./examples/public/screenshots/example-mipmaps.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Mipmaps
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-cubemap.ts">
        <img src="./examples/public/screenshots/example-cubemap.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Cube Texture Skybox
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-array-texture.ts">
        <img src="./examples/public/screenshots/example-array-texture.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Array Texture Flipbook
      </a>
    </td>
  </tr>
</table>

## Atomics

Atomic operations on `atomic<i32>` / `atomic<u32>` storage, for compute.

<table><tr>
<td><a href="./api.md#atomicadd"><code>atomicAdd</code></a></td><td><a href="./api.md#atomicstore"><code>atomicStore</code></a></td><td><a href="./api.md#atomicload"><code>atomicLoad</code></a></td><td><a href="./api.md#atomicsub"><code>atomicSub</code></a></td><td><a href="./api.md#atomicmax"><code>atomicMax</code></a></td><td><a href="./api.md#atomicmin"><code>atomicMin</code></a></td>
</tr><tr>
<td><a href="./api.md#atomicand"><code>atomicAnd</code></a></td><td><a href="./api.md#atomicor"><code>atomicOr</code></a></td><td><a href="./api.md#atomicxor"><code>atomicXor</code></a></td><td><a href="./api.md#atomicexchange"><code>atomicExchange</code></a></td><td><a href="./api.md#atomiccompareexchangeweak"><code>atomicCompareExchangeWeak</code></a></td><td></td>
</tr></table>


<table>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-ball-cluster.ts">
        <img src="./examples/public/screenshots/example-ball-cluster.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Ball Cluster
      </a>
    </td>
  </tr>
</table>

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

<table><tr>
<td><a href="./api.md#computeindex"><code>computeIndex</code></a></td>
</tr></table>


<table>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-compute-particles.ts">
        <img src="./examples/public/screenshots/example-compute-particles.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Compute Particles
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-ball-cluster.ts">
        <img src="./examples/public/screenshots/example-ball-cluster.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Ball Cluster
      </a>
    </td>
  </tr>
</table>

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

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-instanced-mesh.ts">
        <img src="./examples/public/screenshots/example-instanced-mesh.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Instanced Mesh
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-instancing-storage-buffer.ts">
        <img src="./examples/public/screenshots/example-instancing-storage-buffer.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Instancing with Storage Buffer
      </a>
    </td>
  </tr>
</table>

### Indirect drawing

With an indirect buffer the draw arguments (index count, instance count, offsets) live in GPU memory instead of being passed from the CPU. Pack them with the `DrawIndirect` (non-indexed) or `DrawIndexedIndirect` (indexed) struct, put them in a `createIndirectBuffer`, and assign it to a geometry:

```ts
const args = new Uint32Array(packArray(DrawIndexedIndirect, [
    { indexCount, instanceCount, firstIndex: 0, baseVertex: 0, firstInstance: 0 },
]));
geometry.indirect = createIndirectBuffer(DrawIndexedIndirect, args);
```

One buffer can hold several draws (`geometry.indirectDrawCount`), and `geometry.indirectOffset` skips a header. The real payoff is GPU-driven rendering: the buffer has `storage` + `indirect` usage, so a compute pass can write the `instanceCount` (culling, LOD, spawning) and the draw reads it the same frame, with no CPU readback. `renderer.compute([{ node, indirect: buf }])` dispatches a compute pass the same way, with its workgroup counts read from a buffer.

<table><tr>
<td><a href="./api.md#drawindirect"><code>DrawIndirect</code></a></td><td><a href="./api.md#drawindexedindirect"><code>DrawIndexedIndirect</code></a></td>
</tr></table>


See `examples/src/example-indirect-batched.ts` (CPU-driven multi-draw) and `example-indirect-compute.ts` (a compute pass writes the draw args each frame).

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-indirect-batched.ts">
        <img src="./examples/public/screenshots/example-indirect-batched.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Indirect Batched
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-indirect-compute.ts">
        <img src="./examples/public/screenshots/example-indirect-compute.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Indirect Compute
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-voxels-batched.ts">
        <img src="./examples/public/screenshots/example-voxels-batched.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Voxels Batched
      </a>
    </td>
  </tr>
</table>

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

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-transform-controls.ts">
        <img src="./examples/public/screenshots/example-transform-controls.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Transform Controls
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/isaac-mason/gpucat/blob/main/examples/src/example-fly-controls.ts">
        <img src="./examples/public/screenshots/example-fly-controls.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Fly Controls
      </a>
    </td>
  </tr>
</table>

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
