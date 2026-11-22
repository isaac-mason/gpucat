![cover](./docs/cover.png)

```sh
> npm install gpucat@canary
```

# gpucat

gpucat is a minimal typescript-first WebGPU and WebGL2 renderer.

It is a marriage of ideas in three.js and typegpu. It has a node-based shading language similar to [three.js TSL](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language), and has the typescript-first, WebGPU-native feel of [typegpu](https://typegpu.com).

You get a declarative API for GPU resources (buffers, uniforms, textures, materials), a type-safe node-based shading language that mirrors WGSL grammar and compiles to WGSL (or GLSL ES 3.00 for the WebGL2 backend), and gpucat handles the generation of pipelines, layouts, bind groups, and resource lifecycles for you.

Most GPU libraries either hide the GPU behind a scene abstraction or hand you raw shader strings. gpucat sits in between. You compose shaders as typed typescript expressions, so refactors and autocomplete work, but nothing stops you dropping down to the renderer, pipeline, and buffer level when you need to.

## Examples

Every screenshot links to its source in `examples/src`. Run them locally with `npm install && npm run dev` in `examples/`.

<table>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-hello-world">
        <img src="./examples/public/screenshots/example-webgpu-hello-world.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Hello World
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-uniforms">
        <img src="./examples/public/screenshots/example-webgpu-uniforms.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Uniforms
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-storage">
        <img src="./examples/public/screenshots/example-webgpu-storage.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Storage Buffers
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-copy-buffer">
        <img src="./examples/public/screenshots/example-webgpu-copy-buffer.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Copy Buffer
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-interleaved">
        <img src="./examples/public/screenshots/example-webgpu-interleaved.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Interleaved Vertex Buffers
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-line">
        <img src="./examples/public/screenshots/example-webgpu-line.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Line
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-raging-sea">
        <img src="./examples/public/screenshots/example-webgpu-raging-sea.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Raging Sea
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-point-lights">
        <img src="./examples/public/screenshots/example-webgpu-point-lights.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Point Lights
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-shadow-map">
        <img src="./examples/public/screenshots/example-webgpu-shadow-map.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Shadow Map
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-discard">
        <img src="./examples/public/screenshots/example-webgpu-discard.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Discard
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-instanced-mesh">
        <img src="./examples/public/screenshots/example-webgpu-instanced-mesh.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Instanced Mesh
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-instancing-storage-buffer">
        <img src="./examples/public/screenshots/example-webgpu-instancing-storage-buffer.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Instancing with Storage Buffer
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-texture">
        <img src="./examples/public/screenshots/example-webgpu-texture.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Texture
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-mipmaps">
        <img src="./examples/public/screenshots/example-webgpu-mipmaps.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Mipmaps
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-cubemap">
        <img src="./examples/public/screenshots/example-webgpu-cubemap.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Cube Texture Skybox
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-array-texture">
        <img src="./examples/public/screenshots/example-webgpu-array-texture.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Array Texture Flipbook
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-video-texture">
        <img src="./examples/public/screenshots/example-webgpu-video-texture.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Video Texture
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-render-to-texture">
        <img src="./examples/public/screenshots/example-webgpu-render-to-texture.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Render to Texture
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-mrt">
        <img src="./examples/public/screenshots/example-webgpu-mrt.png" width="180" height="120" style="object-fit:cover;"/><br/>
        MRT (Multiple Render Targets)
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-fxaa">
        <img src="./examples/public/screenshots/example-webgpu-fxaa.png" width="180" height="120" style="object-fit:cover;"/><br/>
        FXAA
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-cube-camera">
        <img src="./examples/public/screenshots/example-webgpu-cube-camera.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Cube Camera
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-viewports">
        <img src="./examples/public/screenshots/example-webgpu-viewports.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Viewports + Scissor
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-stencil">
        <img src="./examples/public/screenshots/example-webgpu-stencil.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Stencil Masking
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-compute-particles">
        <img src="./examples/public/screenshots/example-webgpu-compute-particles.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Compute Particles
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-compute-birds">
        <img src="./examples/public/screenshots/example-webgpu-compute-birds.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Compute Birds
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-compute-texture">
        <img src="./examples/public/screenshots/example-webgpu-compute-texture.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Compute Texture
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-ball-cluster">
        <img src="./examples/public/screenshots/example-webgpu-ball-cluster.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Ball Cluster
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-volume">
        <img src="./examples/public/screenshots/example-webgpu-volume.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Volume
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-voxels">
        <img src="./examples/public/screenshots/example-webgpu-voxels.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Voxels
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-indirect-batched">
        <img src="./examples/public/screenshots/example-webgpu-indirect-batched.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Indirect Batched
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-indirect-compute">
        <img src="./examples/public/screenshots/example-webgpu-indirect-compute.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Indirect Compute
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-moving-mesh-stress">
        <img src="./examples/public/screenshots/example-webgpu-moving-mesh-stress.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Moving Mesh Stress
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-static-mesh-stress">
        <img src="./examples/public/screenshots/example-webgpu-static-mesh-stress.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Static Mesh Stress
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgl-hello">
        <img src="./examples/public/screenshots/example-webgl-hello.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Hello World
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgl-textured">
        <img src="./examples/public/screenshots/example-webgl-textured.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Textured Mesh
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgl-render-target">
        <img src="./examples/public/screenshots/example-webgl-render-target.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Render Target
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgl-shadow-map">
        <img src="./examples/public/screenshots/example-webgl-shadow-map.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Shadow Map (WebGL)
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgl-cascaded-shadow-maps">
        <img src="./examples/public/screenshots/example-webgl-cascaded-shadow-maps.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Cascaded Shadow Maps (WebGL)
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgl-warped-shadow-map">
        <img src="./examples/public/screenshots/example-webgl-warped-shadow-map.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Warped Shadow Map (WebGL)
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgl-deferred-voxel-lights">
        <img src="./examples/public/screenshots/example-webgl-deferred-voxel-lights.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Deferred Voxel Lights (WebGL)
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgl-instanced-mesh">
        <img src="./examples/public/screenshots/example-webgl-instanced-mesh.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Instanced Mesh (WebGL)
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgl-cubemap">
        <img src="./examples/public/screenshots/example-webgl-cubemap.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Cube Texture Skybox (WebGL)
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgl-mrt">
        <img src="./examples/public/screenshots/example-webgl-mrt.png" width="180" height="120" style="object-fit:cover;"/><br/>
        MRT (WebGL)
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgl-cube-camera">
        <img src="./examples/public/screenshots/example-webgl-cube-camera.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Cube Camera (WebGL)
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgl-stencil">
        <img src="./examples/public/screenshots/example-webgl-stencil.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Stencil Masking (WebGL)
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgl-transform-feedback-particles">
        <img src="./examples/public/screenshots/example-webgl-transform-feedback-particles.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Transform Feedback Particles (WebGL)
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-inspector-toggle">
        <img src="./examples/public/screenshots/example-webgpu-inspector-toggle.png" width="180" height="120" style="object-fit:cover;"/><br/>
        Inspector Toggle
      </a>
    </td>
  </tr>
</table>

## Contents

- [Examples](#examples) · [Getting Started](#getting-started) · [Core Concepts](#core-concepts) · [Backends: WebGPU & WebGL2](#backends-webgpu--webgl2)
- Build an app: [The Renderer](#the-renderer) · [Scene and Objects](#scene-and-objects) · [Geometry](#geometry) · [Materials](#materials) · [Uniforms](#uniforms) · [Storage Buffers](#storage-buffers) · [Structs](#structs) · [Packing](#packing) · [Structured data](#structured-data) · [Render Pipeline](#render-pipeline)
- Shading language: [Constants](#constants-and-constructors) · [Operators](#operators) · [Variables](#variables) · [Control Flow](#control-flow) · [Method Chaining](#method-chaining) · [Functions](#functions) · [Building Blocks](#building-blocks) · [Varyings](#varyings) · [Textures](#textures-and-samplers) · [Atomics](#atomics) · [Builtins](#builtins) · [Included Uniforms](#included-uniforms)
- [Compute](#compute) · [Transform feedback (WebGL2)](#transform-feedback-webgl2) · [Drawing Many Things](#drawing-many-things) · [Controls and the Inspector](#controls-and-the-inspector)
- [Compiling to WGSL](#compiling-to-wgsl) · [WGSL or GLSL to gpucat](#wgsl-or-glsl-to-gpucat) · [API Reference](#api-reference)

## Getting Started

A minimal spinning cube. Renderer setup, a node-based material, and a `requestAnimationFrame` loop:

```ts
import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createBoxGeometry,
    createCanvasTarget,
    createMaterial,
    createMesh,
    createScene,
    createStorageBuffer,
    d,
    Fn,
    f32,
    frame,
    fullscreen,
    globalId,
    index,
    init,
    instanceIndex,
    modelNormalMatrix,
    modelWorldMatrix,
    mul,
    normalize,
    PerspectiveCamera,
    renderOutput,
    renderTexture,
    storage,
    varying,
    vec3,
    vec4,
    webgpu,
} from 'gpucat';
import { quat } from 'math';

// renderer: the canvas is yours, and a pass names it as its target
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const view = createCanvasTarget(canvas, { samples: 4 });
view.setPixelRatio(devicePixelRatio);
view.setSize(window.innerWidth, window.innerHeight);

const renderer = await init(webgpu());

// scene + camera
const scene = createScene();
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
const material = createMaterial({ vertex: clipPosition, fragment: vec4(litColor, f32(1)) });
const mesh = createMesh(createBoxGeometry(1, 1, 1), material);
scene.add(mesh);

// one fullscreen draw of the scene pass's output
const scenePass = renderTexture(scene, camera);
const composite = fullscreen(renderOutput(scenePass.getTextureNode()));

// frame loop
let angle = 0;
let prevTime = performance.now() / 1000;

function update() {
    const now = performance.now() / 1000;
    const dt = now - prevTime;
    prevTime = now;

    angle += dt * 0.8;
    quat.fromEuler(mesh.quaternion, [angle * 0.6, angle, 0, 'xyz']);
    mesh.updateWorldMatrix();
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    const f = frame(renderer);
    const compositePass = f.pass({ target: view });
    compositePass.draw(composite);
    compositePass.end();
    f.submit();

    requestAnimationFrame(update);
}

requestAnimationFrame(update);
```

A few things to notice:

- The material is just two nodes: `vertex` (a clip-space position) and `fragment` (a `vec4f` color). You build them by composing smaller nodes, and gpucat compiles the resulting graph to WGSL.
- You own the frame loop. gpucat never starts its own `requestAnimationFrame` and never reads a wall clock. You open a frame with `frame(renderer)` when you want one, and you drive time yourself via plain uniforms, so it stays composable with your own update loop.


<table>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-hello-world">
        <img src="./examples/public/screenshots/example-webgpu-hello-world.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Hello World
      </a>
    </td>
  </tr>
</table>

## Core Concepts

### Nodes and the graph

Shaders are composed of nodes - `attribute`, `uniform`, `add`, `mul`, `texture`, `vec3`, and the rest each create a node, and nodes compose into a graph:

```ts
const position = attribute('position', d.vec3f);             // a vertex input
const world = mul(modelWorldMatrix, vec4(position, f32(1)));  // node math
const clip = mul(cameraProjectionMatrix, mul(cameraViewMatrix, world));
```

When you hand a nodes to a `Material` (or call `compileWgsl()`), gpucat walks the graph and emits WGSL.

### Types: the `d` namespace

Types come from the `d` namespace: `d.vec3f`, `d.f32`, `d.mat4x4f`, `d.array(d.u32)`, `d.struct(...)`. These are WGSL type descriptors. They describe the data on the GPU and give the typescript compiler enough to type-check your shader.

There is a split worth internalising early: `d.f32` is the *type*, `f32(1)` is a *node* of that type. The same split you see between a value and its type. You annotate with `d.f32`, you build a node with `f32(1)`.

## Backends: WebGPU & WebGL2

gpucat runs on two graphics backends: WebGPU (`webgpu()`) and WebGL2 (`webgl()`). One `Renderer` class drives either, and they share the entire node-graph, DSL, scene, and resource layer above them. You author a scene once; only the backend you hand to `init` differs.

### Backend selection is explicit

You choose the backend by choosing what you pass to `init`. There is **no automatic fallback**: a WebGPU renderer never quietly downgrades to WebGL2 if WebGPU is missing. This is deliberate. The two backends do not support the exact same feature set, so a silent fallback would swap in a renderer that cannot run your code and fail somewhere confusing. You decide, up front, which one you are targeting, and can branch yourself if you want to. `renderer.api` reports the choice as `'webgpu'` or `'webgl'`.

`init` rejects rather than resolving something half-built, so a `try`/`catch` is all a fallback needs.

```ts
const renderer = await init(webgpu());                 // WebGPU
// const renderer = await init(webgl({ target: view })); // WebGL2, whose device IS a canvas
renderer.api;   // 'webgpu' | 'webgl'
```

### Same code, two backends

The node-graph material and DSL are authored once. The WebGPU backend compiles the graph to WGSL; the WebGL2 one compiles the same graph to GLSL ES 3.00. The DSL grammar is WGSL-native, and GLSL is a translation target reached through each schema's `glslType` companion, so the WGSL surface is never watered down to fit WebGL. Everything above the renderer, scene, geometry, materials, uniforms, textures, render targets, the shading language, is identical across both. Swapping backends is a one-line change:

```ts
// build the scene and material once; nothing here is backend-specific
const material = createMaterial({ vertex: clipPos, fragment: litColor });
const mesh = createMesh(geom, material);
scene.add(mesh);

// pick a backend at the top; the rest of the app is unchanged
const renderer = webgpuSupported
    ? await init(webgpu())
    : await init(webgl({ target: view }));

const composite = fullscreen(renderOutput(renderTexture(scene, camera).getTextureNode()));
// each frame:
const f = frame(renderer);
const p = f.pass({ target: view });
p.draw(composite);
p.end();
f.submit();
```

### What WebGL2 supports

The WebGL2 backend covers the standard rendering surface:

- Node-graph **materials** compiled to GLSL ES 3.00.
- **Opaque meshes** and **instancing** (instanced vertex attributes).
- **Textures**: 2D, cube, 2D-array, and depth, with combined samplers.
- **Render targets**: MRT, depth attachments, cube targets, and MSAA-resolve.
- **HDR / float render targets** via `EXT_color_buffer_float`.
- Correct clip-space **depth** and **frustum culling**.
- **Render-to-texture, passes, and post-processing** through `pass` and `fullscreen`.
- **Transform feedback** (`f.transformFeedback()`) for GPU particle/simulation kernels, with native buffer readback (`readBuffer(renderer, buffer)`). See [Transform feedback](#transform-feedback-webgl2).
- The **inspector**: real GPU timing (`EXT_disjoint_timer_query_webgl2`), memory, draw-call counts, the scene tree, and a GLSL shader panel.

### What WebGL2 does not support

These are WebGPU-only. On the WebGL2 backend they throw a clear error, at shader-compile time where possible, otherwise at prepare. They never fail silently. Use the WebGPU backend for any of them:

- **Compute**: `f.compute()`, compute nodes, and `Fn(...).compute(...)` kernels. For own-index GPU simulation (particles), WebGL2 offers [transform feedback](#transform-feedback-webgl2) instead; scatter/atomics/arbitrary-index writes stay WebGPU-only.
- **Storage buffers** (`storage(...)`, `createStorageBuffer`) and **atomics**.
- **Storage textures** and **workgroup vars** (`WorkgroupVar`).
- **Inline WGSL**: `` wgsl`…` `` and `wgslFn(...)` (raw WGSL has no GLSL translation).
- **Indirect draw** (`geometry.indirect`): WebGPU-only, both the CPU-authored and the GPU-computed (compute-driven culling) variants.
- **Texture constant-offset sampling** and **`f16` / half** types.
- The inspector's live-value **probe** (WebGPU-only; the rest of the inspector works).

### Where WebGL2 shaders differ

The GLSL a graph compiles to follows WGSL's rules, not GLSL's. Where the two languages give different results, the GLSL is written to give WGSL's: integer `/` and `%` by zero, `%` with a negative operand, shifts by 32 or more, and conversions of literals all come out as WGSL defines them, and a render target reads the right way up though WebGL stores it bottom-up. What's left are the places where matching WGSL would cost every shader, or where GLSL gives no handle on it:

- **`select` runs only the side it picks.** WGSL's `select(f, t, c)` evaluates both sides. With a scalar condition, GLSL's `c ? t : f` evaluates one, so a texture sample or a derivative inside a side runs in non-uniform control flow, and its mip level or value is undefined. Sample, or take `dpdx`/`fwidth`, before the `select`, and select between the results. A vector condition selects per component and evaluates both, as WGSL does.
- **A float converted to an int beyond the int's range, or a NaN, is undefined.** WGSL's `i32(x)` and `u32(x)` saturate; GLSL's `int(x)` leaves those values undefined. Most GPUs saturate anyway. If a value can stray that far, clamp it first: `i32(clamp(x, -2147483648, 2147483520))`, the largest f32 below the i32 maximum.
- **`discard` ends the fragment.** In WGSL a discarded fragment runs on as a helper, so derivatives in the rest of its quad stay defined. In GLSL they're undefined after a `discard` some fragments of the quad take and others don't. Sample before you discard.
- **Uniformity is not checked.** WGSL rejects a texture sample or a derivative in control flow that depends on a non-uniform value when the shader is created. GLSL compiles it, and the result is undefined. So a shader that runs on WebGL can fail on WebGPU, never the reverse.
- **`precision` below `'highp'` narrows the numbers.** The `precision` renderer option set to `'mediump'` or `'lowp'` makes floats and ints narrower than WGSL's `f32` and `i32`, so results differ. The default, `'highp'`, matches.

Neither language promises NaN or infinity survive a shader: WGSL lets an implementation assume there are none, and GLSL ES 3.00 doesn't require them. Don't branch on them on either backend.

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
| Transform feedback (`f.transformFeedback()`, own-index GPU sim) | ✗ (use `compute()`) | ✓ |
| Compute (`f.compute()`, compute nodes, scatter/atomics) | ✓ | ✗ (use `transformFeedback()`) |
| Storage buffer reads (lowered to a texture on WebGL2) | ✓ | ✓ |
| Storage buffer writes · atomics | ✓ | ✗ |
| Storage textures · workgroup vars | ✓ | ✗ |
| Inline WGSL (`` wgsl`` `` / `wgslFn`) | ✓ | ✗ |
| Indirect draw (`geometry.indirect`) | ✓ | ✗ |
| Texture constant-offset sampling · `f16` types | ✓ | ✗ |
| Inspector live-value probe | ✓ | ✗ |

### Which features run on which backend

Backend compatibility is a property of the *features* you use, not of any single example (each example file constructs one specific renderer). Read it off the matrix above, or by category:

- **Runs on both backends:** meshes and node-graph materials, textures, render targets and MRT, render-to-texture and post-processing, and camera controls. Anything built only from these works on either backend.
- **WebGPU-only:** compute (compute nodes and `f.compute()`), storage buffer *writes* (`read_write`, atomics, compute output), storage textures, workgroup vars, inline WGSL (`` wgsl`` `` / `wgslFn`), and indirect draw (`geometry.indirect`, both CPU-authored and compute-driven). Anything using these needs the WebGPU backend. Read-only storage reads are portable, covered below.
- **WebGL2-only:** [transform feedback](#transform-feedback-webgl2) (`f.transformFeedback()`), the honest own-index GPU-simulation primitive, with native readback via `readBuffer()`. WebGPU has no transform feedback; you express the same simulation as a `compute()` kernel there, reusing the per-element body `Fn` verbatim.

The [examples browser](https://isaac-mason.github.io/gpucat/) groups examples by the backend each one targets, so the compute and storage-driven examples sit under WebGPU and the WebGL2 examples under WebGL.

## The Renderer

`init` acquires the device asynchronously and hands back a `Renderer`. The canvas is yours, not the
renderer's: you wrap it in a `canvasTarget` and a pass names it as its target.

```ts
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

const view = createCanvasTarget(canvas, { samples: 4 });
view.setPixelRatio(devicePixelRatio);
view.setSize(window.innerWidth, window.innerHeight);

const renderer = await init(webgpu());
```

gpucat never starts its own loop. You own the frame, and a frame is just: update transforms, push any changed data, open a frame, record passes into it, submit.

```ts
function update() {
    movingMesh.updateWorldMatrix();  // update only what moved, not the whole scene
    camera.updateViewMatrix();       // the camera moved this frame
    uColor.value = nextColor;        // push changed data

    const f = frame(renderer);

    const sim = f.compute();              // optional, WebGPU only
    sim.dispatch(simNode, [groups, 1, 1]);
    sim.end();

    const scenePass = f.pass({ target: view, camera });
    scenePass.draw(mesh);
    scenePass.end();

    f.submit();

    requestAnimationFrame(update);
}
requestAnimationFrame(update);
```

Everything recorded between `frame(renderer)` and `submit()` goes onto one command encoder, so a compute pass that writes a buffer and a draw that reads it are one submission with no CPU sync point between them.

## Scene and Objects

A `Scene` holds a tree of `Object3D`s. Each object has a `position`, `quaternion`, and `scale`; you call `updateWorldMatrix()` to fold them into its world matrix. A `Mesh` is geometry plus material.

```ts
const scene = createScene();

const mesh = createMesh(geom, material);
mesh.position[1] = 2;
scene.add(mesh);

const camera = new PerspectiveCamera(Math.PI / 4, width / height, 0.1, 100);
camera.position[2] = 5;
scene.add(camera);
```

For **instancing** (drawing one geometry many times in a single call), set `mesh.count` and pull per-instance data from a storage buffer. See [Drawing Many Things](#instancing).

Cameras carry the projection: `PerspectiveCamera(fov, aspect, near, far)` or `OrthographicCamera(...)`. See [`Scene`](./api.md#scene), [`Object3D`](./api.md#object3d), [`Mesh`](./api.md#mesh), [`PerspectiveCamera`](./api.md#perspectivecamera).

### The tree is a layer, and you can skip it

`drawScene(renderer, pass, scene, camera)` is the walk, and it is an ordinary public function built on `pass.bin`. It is what gives a scene the behaviour you would expect of one:

- objects with `visible === false`, and their whole subtree, are skipped
- frustum culling, unless a mesh sets `frustumCulled = false`
- opaque draws first, in a bin grouped by pipeline and material, nearest first within one; transparent after, in a bin farthest first
- a mesh's `renderOrder` ranks above both, lowest first (see [Ordering draws with bins](#ordering-draws-with-bins))

```ts
const pass = f.pass({ target: view, camera });
pass.scene(scene);     // the tree, using the pass's own camera
pass.draw(cursor);     // and anything else, in the order you say
pass.end();
```

`pass.scene(tree)` is the walk as a verb on the pass, beside `draw` and `execute`; `drawScene(renderer, pass, tree, camera)` is the same thing as a free function, for when you have no pass to hand.

**A draw you record yourself is unconditional.** `pass.draw(mesh)` draws that mesh: it does not read `visible`, does not frustum cull, and does not sort. Those are the walk's, not the pass's. This matters if you keep your own list of what to draw, because hiding something by setting `visible = false` will do nothing and report nothing. Skip it yourself, or hand the tree to `drawScene` and let it decide.

`renderTexture(contents, camera)` takes either: a scene to walk, or a `(pass) => void` that records its own draws.

### Updating matrices is your job

Meshes are not game entities. gpucat does not tick them every frame or track changes for you. Setting `position`, `quaternion`, or `scale` does nothing on its own; no matrices recompute until you tell them to. You decide when, and you should be deliberate about it: update the objects that actually moved, not the whole scene on every frame.

- `object.updateWorldMatrix()` recomputes that object's `matrixWorld` and `normalMatrix` (which feed `modelWorldMatrix` and `modelNormalMatrix` in shaders) and recurses into its children. Move a mesh, update that mesh.
- `camera.updateViewMatrix()` inverts the camera's world matrix into the view matrix that `cameraViewMatrix` reads. Call it after the camera's world matrix is current, and only when the camera moved.
- `camera.updateProjectionMatrix()` rebuilds the projection from `fov` / `aspect` / `near` / `far`. Only when those change, typically in your resize handler.

`scene.updateWorldMatrix()` is the same call on the root: it walks the whole tree, parents before children. It is a convenience for initial setup or a one-off bulk update, not something to run every frame for a mostly-static scene. Be intelligent about it.

<table>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-moving-mesh-stress">
        <img src="./examples/public/screenshots/example-webgpu-moving-mesh-stress.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Moving Mesh Stress
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-static-mesh-stress">
        <img src="./examples/public/screenshots/example-webgpu-static-mesh-stress.png" width="200" height="133" style="object-fit:cover;"/><br/>
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
geom.setIndex(createIndexBuffer(indices));   // a Uint16Array or Uint32Array
```

For common shapes, the `create*Geometry` helpers build the position, normal, and uv buffers and an index for you. See [`Geometry`](./api.md#geometry) and the helpers in [api.md](./api.md#geometry).

<table>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-line">
        <img src="./examples/public/screenshots/example-webgpu-line.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Line
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-raging-sea">
        <img src="./examples/public/screenshots/example-webgpu-raging-sea.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Raging Sea
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-voxels">
        <img src="./examples/public/screenshots/example-webgpu-voxels.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Voxels
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-interleaved">
        <img src="./examples/public/screenshots/example-webgpu-interleaved.png" width="200" height="133" style="object-fit:cover;"/><br/>
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
const material = createMaterial({
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
const glow = createMaterial({
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
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-point-lights">
        <img src="./examples/public/screenshots/example-webgpu-point-lights.png" width="200" height="133" style="object-fit:cover;"/><br/>
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

Writes are explicit. Setting `.value` is a write. Changing the value in place is not: a typed array the uniform holds,
or a field of a struct value. After an in-place change, set `needsUpdate`, as you would on a buffer:

```ts
const offset = new Uniform(d.vec4f, new Float32Array(4));
offset.value![0] = 2;            // in place: not seen yet
offset.needsUpdate = true;       // now it is
```

gpucat keeps a version per uniform, and a mesh's own uniforms are only packed again when one of their versions moves.
A mesh's world matrix works the same way. `updateWorldMatrix()` is what writes `matrixWorld`, and it only moves the
version when the matrix changes. Camera and frame uniforms are packed at every pass; versions save work where there
are many, per mesh.

You can also read a uniform, storage buffer or texture by name, filled by the material's parameters. Materials built from the same nodes with other values share one program, so this is how one shader graph serves meshes with different data:

```ts
const color = uniform('color', d.vec3f);                                     // in the shader
material.parameters.setUniform('color', new Uniform(d.vec3f, [1, 0, 0]));    // per material
```

A uniform's **group** sets both its WGSL `@group` and how often it is evaluated: `objectGroup` (default, per draw call), `renderGroup` (per pass), `frameGroup` (once per frame). The built-in camera and model uniforms already sit in the right groups.

**When a value is read.** A draw or dispatch reads its uniform values when you record it: `pass.draw(mesh)` and `pass.dispatch(node, ...)` resolve the draw's bindings on the spot, so a value changed between two draws of one pass reaches each draw as it was when that draw was recorded, and a draw that cannot resolve (a missing attribute, an unbound buffer) throws at the call that recorded it. Values that belong to the pass rather than a draw (the camera matrices, `screenSize`) are read once per pass, at the first draw that uses them, and the camera's again after a `setCamera` (see [Several views in one pass](#several-views-in-one-pass)). Across passes, each pass sees its own values, even when several passes of one frame read the same uniform differently: two cameras into one target, one camera moved between passes, one material drawn into targets of different sizes (`screenSize`), one compute node dispatched from two compute passes. A uniform uploads only when its value changes. On WebGPU a later pass of the same frame with a different value reads a slice of a shared per-frame buffer instead of rewriting the uniform's own, which an earlier pass is still to read; `renderer.info.buffers.dynamicAllocations` counts those. `frameGroup` values are evaluated once per frame, so every pass sees the same one.

A shader can bind at most 8 groups whose values can change between passes or draws (every group but `frameGroup`), the WebGPU guarantee for one pipeline. Building a pipeline past the device's limit throws and names the material.

See [`Uniform`](./api.md#uniform-2).

<table>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-uniforms">
        <img src="./examples/public/screenshots/example-webgpu-uniforms.png" width="200" height="133" style="object-fit:cover;"/><br/>
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

You record a `f.compute()` pass and then a render pass on the same frame, and nothing round-trips through the CPU. This is the spine of the particle and ball-cluster examples, and the same buffer-per-instance idea behind [Instancing](#instancing).

### Ping-pong (double buffering)

A kernel that reads and writes one buffer sees values its neighbours have already changed this frame. When each step needs a clean snapshot of the last, keep two buffers and alternate between them. The named form makes this tidy, since you bind the buffer per dispatch through the `buffers` map:

```ts
const state = storage('state', d.array(Particle), 'read_write');
let [src, dst] = [bufferA, bufferB];

// each frame:
const step = f.compute();
step.dispatch(sim, [groups, 1, 1], { buffers: { state: src } });
step.end();
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

### Buffers with no CPU copy

A buffer that is only ever written in pieces from data you already hold, like a streaming arena of meshes, has no use for a CPU mirror the size of the whole buffer. Make it `cpu: false` and write it with `writeBuffer`, which copies at call time, so the data can be dropped or transferred away straight after:

```ts
const arena = new GpuBuffer(d.array(d.u32), { count: 16_000_000, usage: 'storage', cpu: false });

writeBuffer(renderer, arena, byteOffset, meshWords);           // all of it
writeBuffer(renderer, arena, byteOffset, meshWords, 16, 64);   // 64 elements of it, from element 16
```

The GPU buffer starts zeroed. Offsets and sizes are bytes into the buffer and elements of the data, as with `GPUQueue.writeBuffer`, and both byte offset and byte size must be multiples of 4. Such a buffer has no `array`, so the CPU-side writes (`needsUpdate`, `addUpdateRange`, `packAtIndex`) throw, as does `writeBuffer` on a buffer that keeps one.

It works for storage, vertex, indirect and index buffers. An index buffer has no array to read its format off, so it declares one: `{ usage: 'index', cpu: false, indexFormat: 'uint16' }`. Uniform buffers cannot be CPU-less, since uniforms are packed from CPU values.

On WebGL2 a storage buffer's write goes straight into the texture its reads lower to, which needs the write to cover whole texels of the element: any 4-byte span for `u32`, but 16-byte ones for `vec4u`. That texture is all there is of it, so a CPU-less storage buffer cannot then be fed to transform feedback.

Textures have the same option, written with `writeTexture`; see [Textures with no CPU copy](#textures-with-no-cpu-copy).

### Copying between buffers

`copyBuffer` copies a span of one buffer into a `cpu: false` buffer on the GPU, so nothing comes back to the CPU. Like `writeBuffer` it is queued at once: after the writes before it, ahead of any frame not yet submitted. Given no placement it copies the whole source to the start of the destination, which is how a buffer grows:

```ts
const grown = new GpuBuffer(d.array(d.u32), { count: arena.count * 2, usage: 'storage', cpu: false });
copyBuffer(renderer, arena, grown);                     // all of arena, to the start of grown
copyBuffer(renderer, arena, grown, 64, 1024, 256);      // 256 bytes from byte 64, to byte 1024
geometry.setBuffer('arena', grown);
arena.dispose();
```

Offsets and size are bytes and multiples of 4, and two ranges of one buffer may not overlap. The source may keep a CPU array: on WebGL2 that array is what gets copied, since it is what the GPU copies are uploaded from. On WebGL2 a storage destination's texture is filled from the source's texture, or from its GL buffer, so a copy between storage buffers moves whole texels of one size; and WebGL2 keeps index buffers apart, so a copy between an index buffer and another kind throws there.

<table>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-copy-buffer">
        <img src="./examples/public/screenshots/example-webgpu-copy-buffer.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Copy Buffer
      </a>
    </td>
  </tr>
</table>

### Reads run on WebGL2 (as a texture)

WebGL2 has no storage buffers, but a read-only storage buffer is an indexed array, and so is a texture. So `storage(buffer, 'read')` and the `index(_, i)` / `.field` reads over it work on both backends. On WebGPU it stays a native `var<storage>` array. On WebGL2 the renderer reads the buffer's own bytes as an `rgba32uint` texture and lowers each read to a `texelFetch`, using the same path as [Structured data](#structured-data). There is no second copy and no CPU round-trip.

This covers the common case of per-instance data a vertex or fragment shader reads. It does not make writes portable: `read_write` storage, atomics, and compute output stay WebGPU-only, and on WebGL2 GPU writes go through [transform feedback](#transform-feedback-webgl2). The buffer must keep its CPU `array` resident, since the texture reads from it, or be [`cpu: false`](#buffers-with-no-cpu-copy) and written straight into the texture. On WebGL2 the capacity is `MAX_TEXTURE_SIZE²` texels, which is 64 MB on the weakest conformant hardware and gigabytes on typical GPUs. Split the buffer if you need more.

See [`storage`](./api.md#storage), [`createStorageBuffer`](./api.md#createstoragebuffer), and [`GpuBuffer`](./api.md#gpubuffer).

<table>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-storage">
        <img src="./examples/public/screenshots/example-webgpu-storage.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Storage Buffers
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-instancing-storage-buffer">
        <img src="./examples/public/screenshots/example-webgpu-instancing-storage-buffer.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Instancing with Storage Buffer
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-compute-particles">
        <img src="./examples/public/screenshots/example-webgpu-compute-particles.png" width="200" height="133" style="object-fit:cover;"/><br/>
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

The texture holds plain typed bytes, so you can split data across several textures by update frequency. A per-frame `transform` texture then re-uploads only the texels it touched, which `packAtIndex` tracks for you (see [Partial updates](#partial-updates)), while a static `material` texture stays put. Instancing, batched draws, and gsplat all build on this.

### Packed encodings

Fields can use compact encodings to cut memory and upload bandwidth. A normal as `d.unorm8x4` is 4 bytes against a `vec3f`'s 12. gpucat encodes on write and decodes on read using the same schema, so they stay consistent:

- `d.unorm8x4`, `d.snorm8x4`: four 8-bit (s)normalized lanes, read as a `vec4f`.
- `d.half2x16`: two 16-bit floats, read as a `vec2f`.
- `d.unorm2x16`, `d.snorm2x16`: two 16-bit (s)normalized lanes, read as a `vec2f`.
- `d.bits({ flags: 8, materialId: 24 })`: named bitfields packed into one `u32`.

See [`createStructTexture`](./api.md#createstructtexture), [`DataTexture`](./api.md#datatexture), and the `pack*` methods on [`GpuBuffer`](./api.md#gpubuffer).

## Render Pipeline

A `pass` renders a scene and camera to a texture, `renderOutput` turns a texture into the final screen
output, and `fullscreen` draws it. You place the work yourself, on a frame:

```ts
const scenePass = renderTexture(scene, camera);
const composite = fullscreen(renderOutput(scenePass.getTextureNode()));

// each frame
const f = frame(renderer);
const p = f.pass({ target: view });
p.draw(composite);
p.end();
f.submit();
```

`submit()` returns nothing and does not wait. When you need to know the GPU has finished — a readback,
a benchmark, pacing outside a rAF loop, a deterministic test — `f.done` resolves once it has:

```ts
f.submit();
await f.done;   // resolve-only: completion, not success
```

It is **resolve-only on purpose**. It never rejects, because the errors worth knowing about arrive from
the device after it would have settled; those reach you through `renderer.onDeviceLost`. Reading `done`
is what starts the wait, so a frame nobody asks about costs nothing, and it is only meaningful between
`submit()` and the next `frame()`, since the frame object is reused.

A pass nested in the graph like `scenePass` renders itself, before the pass that samples it. Because a
pass is just a texture node, you add post-processing by sampling it and feeding the result through more
nodes before `renderOutput`. `mrt` writes several targets at once, and a `RenderTarget` lets you render
off-screen. See [`RenderTarget`](./api.md#rendertarget).




<table>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-render-to-texture">
        <img src="./examples/public/screenshots/example-webgpu-render-to-texture.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Render to Texture
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-shadow-map">
        <img src="./examples/public/screenshots/example-webgpu-shadow-map.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Shadow Map
      </a>
    </td>
  </tr>
</table>

### Render target layouts

A render target can have mips, array layers, or 3D slices. Every attachment, depth included, has the same layout, so a
pass draws into the same mip and layer of each. Pass `mipLevel` and `layer` to choose them.

```ts
// a mip chain drawn mip by mip
const chain = createRenderTarget(512, 512, { mipLevelCount: 'full', depthBuffer: false });
f.pass({ target: chain, mipLevel: 3 });

// shadow cascades in one array depth texture, a pass a cascade
const cascades = createRenderTarget(2048, 2048, { count: 0, layers: 4, depthFormat: 'depth32float', depthSampled: true });
f.pass({ target: cascades, layer: 2, camera: cascadeCameras[2] });

// a volume drawn slice by slice
const volume = createRenderTarget(64, 64, { dimension: '3d', layers: 64, depthBuffer: false });
f.pass({ target: volume, layer: 10 });
```

`'full'` is the whole mip chain, and it is worked out again when the target is resized. A layered target's colour
textures are `ArrayTexture`s, read with `arrayTexture()`, and a 3D target's are `Data3DTexture`s. One layer reads
through a view: `texture(array._gpuTexture.view({ baseArrayLayer: 2, arrayLayerCount: 1, dimension: '2d' }), sampler)`.
`read(renderer, target, { layer, mipLevel })` reads one back.

The spec sets the limits. A 3D target has no depth, since depth formats cannot be 3D. A multisampled target has one
mip. It may have layers: each keeps its own multisampled texture, so a pass that keeps what was drawn loads that
layer. A cube target is a six-layer layout whose colour is sampled as a cube.

### Environment maps with a cube camera

A `CubeRenderTarget` is a render target whose color attachment is a cube texture, and a `CubeCamera` renders the surroundings into its six faces. Place the cube camera where a reflective object sits, call `update()` to capture the scene, then sample the result as an environment map with `cubeTexture(rt.texture)`. Rendering the cube each frame (rather than loading a static one) gives realtime reflections.

```ts
const cubeRT = new CubeRenderTarget(256);
const cubeCamera = new CubeCamera(0.1, 100, cubeRT);

// on your frame, with the reflective object hidden so it does not reflect itself:
const f = frame(renderer);
reflector.visible = false;
cubeCamera.update(f, scene);   // records the 6 faces into cubeRT
reflector.visible = true;

// in the reflector's material, sample the cube along the reflection vector:
const env = cubeTexture(cubeRT.texture).sample(reflectDir);
```

Like everything else, this does no automatic per-frame work: you call `update()` when you want to refresh the map, and it records onto the frame you hand it, so the cube and whatever samples it reach the device in one submit. See [`CubeRenderTarget`](./api.md#cuberendertarget) and [`CubeCamera`](./api.md#cubecamera).

<table>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-cube-camera">
        <img src="./examples/public/screenshots/example-webgpu-cube-camera.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Cube Camera
      </a>
    </td>
  </tr>
</table>

### Several views in one pass

A pass can change its camera, viewport and scissor between draws. Each applies to the draws recorded after it, until the next, so one pass draws several views of the world into one target: a shadow atlas with a light's view in each slot, cascades as quadrants of one map, a split screen.

```ts
const pass = f.pass({ target: atlas, label: 'shadows' });
for (const shadow of shadows) {
    pass.setCamera(shadow.camera);
    pass.setViewport(shadow.rect);
    pass.setScissor(shadow.rect);
    pass.draw(casters);
}
pass.end();
```

This is cheaper than a pass per view: on a tile-based GPU (every phone, Apple silicon) each pass loads and stores its attachments, and these share one. The three cost differently, which is why they are separate. A viewport or scissor is one encoder command. A camera gives the draws after it camera uniforms of their own: on WebGPU they land in a slice of the shared per-frame uniform buffer, bound at a dynamic offset, so nothing is rewritten under a draw already recorded. Setting the camera the pass already draws from changes nothing.

Rects are physical pixels from the target's top left, as on `PassDesc`; `undefined` puts the whole target back. A viewport reaching outside the target throws, naming the pass. A bundle executed between two changes draws under the viewport and scissor before it, from its own camera. The clear is the pass's, over the whole target; nothing clears a single rect.

### Ordering draws with bins

A pass draws in the order you record. A bin draws in the order its key gives. Make one with `pass.bin`, and draw into it as you would into the pass. Its draws run together at the point in the pass where you made it.

```ts
const opaque = pass.bin({ key: 'state' });
const glass = pass.bin({ key: 'back-to-front' });
for (const mesh of meshes) (mesh.material.transparent ? glass : opaque).draw(mesh);
glass.draw(window, { sortKey: 1 });
pass.end();
```

A key is a list of fields, highest rank first. The order the draws were made in breaks ties.

- `pipeline`, `material` and `geometry` group the draws that share each one. The first is the costliest to change.
- `view` groups draws by the camera, viewport and scissor they were drawn under.
- `depthNear` puts the draw nearest its camera first. `depthFar` puts the farthest first.
- `sortKey` orders by the number given to each draw, lowest first. It defaults to 0.

`'state'` is `['sortKey', 'pipeline', 'material', 'geometry']`, for opaque draws. `'back-to-front'` is `['sortKey', 'depthFar']`, for blended ones. `'submission'` keeps the order you drew in. A field can name its bits, as in `{ depthNear: 8 }`. A depth is rounded to them (16 by default). A field with more distinct values than its bits fails at `end()`.

Each draw keeps the camera, viewport and scissor set when you drew it, wherever its bin puts it. So a shadow atlas can group its casters by pipeline across every view:

```ts
const casters = pass.bin({ key: ['pipeline', 'material', 'geometry', 'view'] });
for (const shadow of shadows) {
    pass.setCamera(shadow.camera);
    pass.setViewport(shadow.rect);
    for (const mesh of shadow.casters) casters.draw(mesh);
}
pass.end();
```

A camera's uniforms are written once, when you set it. A draw moved next to another camera's draws binds its own camera's at a known place, so nothing is written again. Reordering is yours to choose. Blending, equal depths under `less`, and stencil effects can depend on order. Use `'back-to-front'` or `'submission'` for those.

### Tonemapping and post-processing




<table>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-mrt">
        <img src="./examples/public/screenshots/example-webgpu-mrt.png" width="200" height="133" style="object-fit:cover;"/><br/>
        MRT (Multiple Render Targets)
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-fxaa">
        <img src="./examples/public/screenshots/example-webgpu-fxaa.png" width="200" height="133" style="object-fit:cover;"/><br/>
        FXAA
      </a>
    </td>
  </tr>
</table>

## Constants and constructors

Scalar and vector constructors turn javascript numbers into typed constant nodes. `f32(0.5)`, `vec3(1, 0, 0)`, `mat4(...)`. The `vec*` constructors accept a mix of scalars and smaller vectors, so `vec4(rgb, 1)` works. They convert as WGSL does: `i32(1.7)` is `1`, `u32(-1)` is `0`. In WGSL an f32 constant prints with its suffix, `0.5f`, so arithmetic on constants alone runs in f32, as it does in GLSL, not at WGSL's higher abstract precision.

A plain number works where WGSL takes a literal, and takes the type of the node it meets, as a WGSL literal does: `v.mul(2)`, `sub(1, x)`, `clamp(t, 0, 1)`, `mix(a, b, 0.5)`, `i.shiftLeft(3)`. A boolean works wherever a bool does: `c.and(true)`, `If(true, …)`. Beside a vector a number goes only in arithmetic and in `mix`'s and `refract`'s factors, as in WGSL; elsewhere write the vector, `clamp(v, vec3f(0), vec3f(1))`. A number must be exactly a value of its type, so `i.mul(0.5)` and `u.add(-1)` throw where they're written, and numbers alone, as in `add(1, 2)`, name no type.

Two nodes meet only as WGSL lets them, so gpucat converts neither: an `i32` adds only to an `i32`, and a scalar beside a vector is the one mix of shapes. `i.add(x)` with `x` an `f32` throws where it's written; write the conversion you mean, `f32(i).add(x)` or `i.add(i32(x))`.

```ts
const shade = mix(shadow, lit, saturate(ndotl.mul(0.5).add(0.5)));
const band = step(0.5, fract(height.mul(4)));
```



## Operators

Math and operators exist as free functions, and (see [method chaining](#method-chaining)) as methods. `add(a, b)` is `a.add(b)`. They are type-directed: `mul(mat4, vec4)` is a matrix-vector multiply, `mul(vec3, vec3)` is component-wise.

```ts
const lit = vec3(0.4, 0.7, 1.0).mul(diffuse.add(0.15));
```



### Comparison



### Bitwise



## Variables

By default a reused expression is hoisted into a `let` automatically. When you want explicit, mutable WGSL variables (for accumulation, or to assign in a loop), use `Var`. The name comes first so it reads like a declaration:

```ts
const sum = Var('sum', f32(0));
Loop(8, ({ i }) => sum.assign(sum.add(i.toF32())));
```

`Let` is the immutable form. `PrivateVar` and `WorkgroupVar` declare module-scope storage for compute.



## Control Flow

`If` / `Loop` / `For` / `While` mirror WGSL control flow and take callbacks for their bodies. `select(a, b, cond)` and `cond(c, a, b)` are the expression-level ternary.

```ts
If(x.greaterThan(f32(0)), () => {
    result.assign(x);
}).Else(() => {
    result.assign(x.negate());
});
```



<table>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-discard">
        <img src="./examples/public/screenshots/example-webgpu-discard.png" width="200" height="133" style="object-fit:cover;"/><br/>
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

- `type`: `'perspective'` (default), `'linear'` (non-perspective-correct), or `'flat'` (no interpolation, takes the primitive's first vertex's value; on WebGL without `WEBGL_provoking_vertex`, its last). `'flat'` is required for integer varyings.
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



### Creating texture resources

The `texture()` node takes a texture resource. Create one from an image, or from raw pixels:

```ts
const tex = new Texture(image);                          // HTMLImageElement, ImageBitmap, canvas
const data = new DataTexture(pixels, 256, 256, { format: 'rgba8unorm' });
```

`CubeTexture`, `ArrayTexture`, and `CanvasTexture` cover the other shapes, and sampler settings (`wrapS`, `magFilter`, `anisotropy`, and so on) live on the texture. A pass output is also a texture, which is what makes post-processing just node wiring. See [`Texture`](./api.md#texture).

A video is just a texture whose contents change every frame. Pass an `HTMLVideoElement` to `Texture` and mark it `needsUpdate` each frame; the renderer copies the current frame to the GPU. No special texture type:

```ts
const videoTexture = new Texture(videoElement);     // a playing HTMLVideoElement
// in the frame loop:
videoTexture.needsUpdate = true;                    // re-copy the current frame
```

<table>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-texture">
        <img src="./examples/public/screenshots/example-webgpu-texture.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Texture
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-mipmaps">
        <img src="./examples/public/screenshots/example-webgpu-mipmaps.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Mipmaps
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-cubemap">
        <img src="./examples/public/screenshots/example-webgpu-cubemap.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Cube Texture Skybox
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-array-texture">
        <img src="./examples/public/screenshots/example-webgpu-array-texture.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Array Texture Flipbook
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-video-texture">
        <img src="./examples/public/screenshots/example-webgpu-video-texture.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Video Texture
      </a>
    </td>
  </tr>
</table>

### Partial updates

Setting `needsUpdate` re-uploads the whole texture. When you have only changed part of one, queue the
part instead. `addUpdateRegion` marks a box of texels dirty and the renderer uploads just that box:

```ts
tex.addUpdateRegion({ x: 64, y: 32, width: 16, height: 16 });  // a sub-rect
atlas.addUpdateLayer(7);                                       // one layer of an ArrayTexture
env.addUpdateFace(4);                                          // one face of a CubeTexture
```

Omitted fields default to the full extent, so `{ y: 4, height: 2 }` is "rows 4 and 5, all of them".
`addUpdateLayer` and `addUpdateFace` are the same call in each texture's own vocabulary: a layer and a
face are both the region's `z` axis, and mean the same thing on WebGPU and WebGL2. A `DataTexture` also
takes `addUpdateRange(startTexel, countTexels)` when you think in record runs rather than rectangles.

You often do not have to call any of them. `packAtIndex` and the other `pack*` writers queue the exact
region they touched, so structured data is already tracked.

What the renderer guarantees:

- **Queued regions merge exactly, never into a bounding box.** Writing records 5 and 900 stays two
  small uploads rather than becoming one span covering everything between.
- **`needsUpdate` wins.** A full re-upload supersedes anything queued.
- **Past half the texture, it stops bothering** and does one full upload instead, because fewer larger
  calls beat many small ones at that point.

### Textures with no CPU copy

A texture filled piece by piece from data you already hold need not keep a source the size of the whole
texture. Make it `cpu: false` and write boxes into it with `writeTexture`, which copies at call time:

```ts
const tiles = new GpuTexture(d.texture2dArray(), { width: 256, height: 256, layers: 64, cpu: false });

writeTexture(renderer, tiles, tilePixels, { z: 12, depth: 1 });                    // one whole layer
writeTexture(renderer, tiles, patch, { x: 32, y: 32, width: 16, height: 16, z: 3 }); // a box of another
```

The texture starts zeroed. `data` holds exactly the box, tightly packed, and the region reads like
`addUpdateRegion`'s: omitted fields cover the rest of the level, and `z` is the layer, cube face or 3D
slice. A box outside the level throws rather than being clamped. A CPU-less texture takes no `source`
and generates no mips (write each `level` yourself), and `needsUpdate` / `addUpdateRegion` throw on it.
- **Mip chains stay correct.** A generated chain is regenerated after the write; an explicit one has the
  matching box of every level queued for you, so a partial write cannot leave a level stale.

Partial upload reads rows out of your typed array in place, so it needs a typed-array source. A texture
backed by an image, canvas, or video has no such rows: the region is still honoured, but by a full
upload rather than a cheaper one.

### Copying between textures

`copyTexture` copies one box of a texture into another on the GPU, queued at once like `writeTexture`. The box reads like `writeTexture`'s region, and the destination takes an origin (`x`, `y`, `z`, `level`); omitted fields cover the rest of the source level and land at the corner. Either end may be a render target's texture, so this is also how a rendered frame is kept:

```ts
copyTexture(renderer, target.texture, history);                                   // the whole frame
copyTexture(renderer, atlas, tiles, { x: 64, y: 0, width: 32, height: 32 }, { z: 5 }); // a tile into layer 5
```

Both ends hold the same uncompressed colour format, or the same one but for `-srgb`, single sampled. The destination is one the GPU owns: `cpu: false`, a render target's, or a storage texture. Depth and compressed formats throw, as does a destination whose `usage` lacks `COPY_DST` or a source lacking `COPY_SRC`; textures have both by default.

### Storage textures

A storage texture is one a compute shader can **write** to (and optionally read), the texture analogue of a storage buffer. You create it with a `create*StorageTexture` helper, write texels with `textureStore` in a compute kernel, and (because the same texture is created with both storage and sampling usage) sample it in a later render pass with the ordinary `texture()` node. The classic use is generating or simulating an image on the GPU.

```ts
const tex = createStorageTexture(256, 256, 'rgba8unorm');   // 2d; also 3d / Array / 1d helpers

// compute: write each texel
const write = storageTexture(tex, 'write');                 // access: 'write' | 'read' | 'read_write'
const paint = Fn(() => {
    const p = vec2u(globalId.x, globalId.y);
    textureStore(write, p, vec4(/* ... */));
}).compute({ workgroupSize: [8, 8, 1] });

// render: sample the same texture (dual usage, no copy)
const sampler = new GpuSampler({ minFilter: 'linear', magFilter: 'linear' });
const color = texture(tex, sampler).sample(screenUV);

// each frame: compute writes, then a later pass on the same frame samples
const paintPass = f.compute();
paintPass.dispatch(paint, [Math.ceil(256 / 8), Math.ceil(256 / 8), 1]);
paintPass.end();
```

`access` is a property of the binding, not the texture, so one texture can be bound `write` in one kernel and `read` in another (e.g. ping-pong simulations). Reads use `textureLoad(node, coords)` (no mip level). Writes are compute-only; binding a `write`/`read_write` storage texture in a vertex or fragment shader is a compile error. `read_write` access is limited by WebGPU to the `r32uint` / `r32sint` / `r32float` formats; the value type of `textureStore`/`textureLoad` follows the format's channel (`vec4f` / `vec4u` / `vec4i`). If the texture has mips and `mipmapsAutoUpdate` is on (the default), its mips regenerate after a compute write to mip 0 so it can be sampled mipmapped. A write to any other mip leaves the chain alone, since that is a chain being built by hand.

#### Texture views

A binding can see part of a texture: a range of mips or layers, a dimension, or an aspect. `tex.view({...})` makes a view, as `GPUTexture.createView` does. Omitted counts cover the rest of the texture. Pass a view wherever a texture is bound.

A storage binding sees one mip. So a texture with mips is bound for storage through a view of one mip, and one kernel can read one mip while it writes another. This is how a depth pyramid is built:

```ts
const pyramid = new GpuTexture(d.textureStorage2d('r32float'), { width, height, mipLevelCount, mipmapsAutoUpdate: false });
const mips = Array.from({ length: mipLevelCount }, (_, mip) => pyramid.view({ baseMipLevel: mip, mipLevelCount: 1 }));

// one kernel for every mip: named slots, filled by each dispatch
const source = storageTexture('source', d.textureStorage2d('r32float'), 'read');
const destination = storageTexture('destination', d.textureStorage2d('r32float'), 'write');
const reduce = Fn(() => {
    const last = textureDimensions(source).sub(vec2u(1, 1));
    const at = (x: number, y: number) => textureLoad(source, min(globalId.xy.mul(u32(2)).add(vec2u(x, y)), last)).x;
    textureStore(destination, globalId.xy, vec4f(max(max(at(0, 0), at(1, 0)), max(at(0, 1), at(1, 1))), 0, 0, 0));
}).compute({ workgroupSize: [8, 8, 1] });
for (let mip = 1; mip < mipLevelCount; mip++) {
    pass.dispatch(reduce, counts(mip), { textures: { source: mips[mip - 1], destination: mips[mip] } });
}

// read the whole chain texel by texel: no sampler needed
const chain = texture(pyramid);
chain.load(coords, mip);
```

Two bindings of one texture are one binding only when they see the same range the same way. Bound by value, `storageTexture(mips[1], 'read')` and `storageTexture(mips[2], 'write')` in one kernel are two bindings. A view is a plain value, so two views of the same range are the same binding. Make the views a frame needs once and keep them.

`texture()` takes a sampler only for sampling. A texture read only with `.load()` needs none, and sampling one bound without a sampler is an error that says so. `.load()` takes one integer coordinate per dimension, as `.sample()` takes one float per dimension: a `vec2i` for a 2D texture, a `vec3i` for a 3D one. Another count throws where it's written.

On WebGL a sampled view of a range of mips maps to the texture's base and max level. WebGL2 has no other views, so a view of a layer, a dimension or an aspect is an error there.

3D storage textures (`createStorageTexture3d`) work the same way and pair naturally with `texture_3d` sampling: write a volume in compute, then raymarch it in a render pass (`texture(volume, sampler).sample(vec3)`). The sample coordinate type is derived from the texture: a 3D texture's `.sample()` requires a `vec3`, a 2D one a `vec2`.

<table>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-compute-texture">
        <img src="./examples/public/screenshots/example-webgpu-compute-texture.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Compute Texture
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-volume">
        <img src="./examples/public/screenshots/example-webgpu-volume.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Volume
      </a>
    </td>
  </tr>
</table>

## Atomics

Atomic operations on `atomic<i32>` / `atomic<u32>` storage, for compute.



<table>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-ball-cluster">
        <img src="./examples/public/screenshots/example-webgpu-ball-cluster.png" width="200" height="133" style="object-fit:cover;"/><br/>
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

Compute shaders use the same node API. You declare storage buffers, write a kernel with `Fn(...).compute(...)`, and dispatch it from a compute pass on the frame, before the render passes that read what it wrote. Index into a buffer with `index(buf, i)` and write with `.assign(...)`.

```ts
const PARTICLES = 1024;

const particles = storage(createStorageBuffer(d.array(d.vec4f), new Float32Array(PARTICLES * 4)), 'read_write');

const sim = Fn(() => {
    const p = index(particles, globalId.x);
    index(particles, globalId.x).assign(p.add(vec4(0, 0.01, 0, 0)));
}).compute({ workgroupSize: [64, 1, 1] });

// a material reading the same buffer draws what the kernel just wrote
const particleMaterial = createMaterial({
    vertex: mul(cameraProjectionMatrix, mul(cameraViewMatrix, index(particles, instanceIndex))),
    fragment: vec4(1, 1, 1, 1),
});
const particleMesh = createMesh(createBoxGeometry(0.02, 0.02, 0.02), particleMaterial);

// compute and draw record onto one encoder, so the whole step is a single submission
const computeFrame = frame(renderer);

const simPass = computeFrame.compute();
simPass.dispatch(sim, [Math.ceil(PARTICLES / 64), 1, 1]);
simPass.end();

const particlePass = computeFrame.pass({ target: view, camera });
particlePass.draw(particleMesh, { instances: PARTICLES });
particlePass.end();

computeFrame.submit();
```

A compute kernel can write to a texture instead of a buffer. See [Storage textures](#storage-textures).

For a full worked example, `examples/src/example-webgpu-ball-cluster.ts` simulates balls that pull toward a point and collide into a packed cluster, all on the GPU. It runs three compute passes per frame (clear grid, bin into a spatial-hash grid while snapshotting the previous state, then forces + collision against the 27 neighbouring cells), so each ball only checks nearby balls instead of every other one. `examples/src/example-webgpu-compute-particles.ts` is a simpler starting point.



<table>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-compute-particles">
        <img src="./examples/public/screenshots/example-webgpu-compute-particles.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Compute Particles
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-ball-cluster">
        <img src="./examples/public/screenshots/example-webgpu-ball-cluster.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Ball Cluster
      </a>
    </td>
  </tr>
</table>

## Transform feedback (WebGL2)

`compute()` is WebGPU-only. On WebGL2, gpucat exposes the platform's honest own-index GPU-simulation primitive directly: **transform feedback**. A kernel takes named per-element **attribute inputs** and returns named **captured-varying outputs**, written with the same node DSL as everything else. It runs as a vertex program under `RASTERIZER_DISCARD`, so each invocation `i` reads element `i` of its inputs and writes element `i` of its outputs.

```ts
const dt = uniform('dt', d.f32);

// attribute-in (pos, vel) becomes captured-varying-out (pos). The body is ordinary DSL.
const kernel = transformFeedback(
    (io) => ({ pos: io.pos.add(io.vel.mul(dt)) }),
    { inputs: { pos: d.vec4f, vel: d.vec4f }, outputs: { pos: d.vec4f } },
);
```

You bind the input/output buffers at the **run site** (not on the node), because ping-pong means a different buffer each frame. There is no auto-swap and no hidden double buffer, you hold the buffers and swap them yourself:

```ts
let [cur, next] = [bufA, bufB];   // two GpuBuffers of the same schema

function update() {
    const f = frame(renderer);
    const sim = f.transformFeedback();
    sim.dispatch(kernel, {
        inputs: { pos: cur, vel: velBuf },   // bound by name as a vertex attribute
        outputs: { pos: next },              // bound by name as the captured-varying target
        count: N,                            // drawArrays(POINTS, 0, N) under RASTERIZER_DISCARD
    });
    sim.end();
    [cur, next] = [next, cur];               // explicit ping-pong; nothing swaps behind your back
    f.submit();
}
```

`f.transformFeedback()` is a pass, the exact mirror of `f.compute()`: both take `.dispatch(...)` and `.end()`, and each refuses on the backend that cannot run it. `readBuffer(renderer, buffer)` is the buffer counterpart of `read()` for targets, on either backend: on WebGL2 it reads what a transform feedback wrote. `f.compute()` is the other way round: it exists on every frame and throws on a WebGL2 backend, because the frame API is backend-neutral by construction. Inside the kernel body you can use `uniform()` and `textureLoad()` (an explicit `DataTexture` you bind, for neighbour gather); the element index is `vertexIndex` (or `instanceIndex` when you pass `instanceCount`). Outputs are scalar / vector types; `vec3` wants `vec4f` and struct outputs are not supported (both throw a clear message). Scatter, arbitrary-index writes, and atomics are not part of this model; use `compute()` on WebGPU for those.

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

<table>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgl-transform-feedback-particles">
        <img src="./examples/public/screenshots/example-webgl-transform-feedback-particles.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Transform Feedback Particles (WebGL)
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

A compute pass can fill or update that buffer, so the instances are driven entirely on the GPU. This is how the particle and ball-cluster examples work. This runs on WebGL2 too. A read-only `storage(buffer, 'read')` read [lowers to a texture](#reads-run-on-webgl2-as-a-texture), or you can hold the per-instance data in a [data texture](#structured-data) and read it with `load(schema, instanceIndex)`.

<table>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-instanced-mesh">
        <img src="./examples/public/screenshots/example-webgpu-instanced-mesh.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Instanced Mesh
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-instancing-storage-buffer">
        <img src="./examples/public/screenshots/example-webgpu-instancing-storage-buffer.png" width="200" height="133" style="object-fit:cover;"/><br/>
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
geometry.setIndirect(createIndirectBuffer(DrawIndexedIndirect, args));
```

One buffer can hold several draws (`geometry.indirectDrawCount`), and `geometry.indirectOffset` skips a header. The real payoff is GPU-driven rendering: the buffer has `storage` + `indirect` usage, so a compute pass can write the `instanceCount` (culling, LOD, spawning) and the draw reads it the same frame, with no CPU readback. `c.dispatchIndirect(node, buf)` dispatches a compute pass the same way, with its workgroup counts read from a buffer.



See `examples/src/example-webgpu-indirect-batched.ts` (CPU-driven multi-draw) and `example-webgpu-indirect-compute.ts` (a compute pass writes the draw args each frame).

<table>
  <tr>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-indirect-batched">
        <img src="./examples/public/screenshots/example-webgpu-indirect-batched.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Indirect Batched
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-indirect-compute">
        <img src="./examples/public/screenshots/example-webgpu-indirect-compute.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Indirect Compute
      </a>
    </td>
    <td align="center">
      <a href="https://isaac-mason.github.io/gpucat/#example-webgpu-voxels">
        <img src="./examples/public/screenshots/example-webgpu-voxels.png" width="200" height="133" style="object-fit:cover;"/><br/>
        Voxels
      </a>
    </td>
  </tr>
</table>

### Render bundles

Instancing and indirect drawing both address *many copies of one thing*. A render bundle addresses the other axis: **many different draws whose set does not change between frames**. The draw calls are the same every frame, so re-encoding them every frame is CPU work you already know the answer to. Record them once, replay the recording:

```ts
const encoder = bundle({ camera, label: 'static-props' });
for (const prop of props) encoder.draw(prop);
const staticProps = encoder.finish();

function update() {
    const f = frame(renderer);
    const p = f.pass({ target: view, camera });
    p.execute(staticProps);   // the recorded draws
    p.draw(player);           // ordinary draws, in the order you record them
    p.end();
    f.submit();
}
```

**A bundle has its own camera.** Its draws are drawn from it, whatever camera the pass has. WebGPU bakes a bundle's bindings when it records, the camera's uniforms included, and a bundle inherits none from the pass. So the bundle owns where its camera's values live, and writes them there each frame. Move the camera, or give the bundle another one with `staticProps.camera = other`, and the recording holds. A view that needs its own camera needs its own bundle: executing one bundle twice in a frame with different camera values throws, as one bundle holds one set of values a frame. A bundle with no camera draws as a pass with none does.

A bundle takes no target. It records at its first `execute`, against that pass's attachment layout: the colour formats, the depth format and the sample count. It then executes in any pass of that layout, whatever its size. A pass of another layout throws and names both; the bundle still executes in passes of its own.

**On WebGPU this is the acceleration.** The bundle becomes a `GPURenderBundle`, recorded once and replayed with one `executeBundles`, so the per-draw pipeline and binding calls stop happening on the CPU each frame. What a replay saves is the encoding, not the per-draw update: each bundled draw still resolves its uniforms when a pass executes the bundle, as a direct draw does at `draw()`, so its values stay as live as a direct one's. **On WebGL2 it costs nothing and buys nothing**: there is no such device object, so the records replay as the draws they always were, from the bundle's camera. Code written against bundles runs correctly on both; only WebGPU gets faster.

`renderer.info.render.bundles` counts the bundles executed in a frame, and `bundlesRecorded` how many of them recorded first. A bundle records again only when you say so or when gpucat replaced something it binds (a buffer that grew is a new GPU buffer). One recording every frame costs more than drawing directly, so this is the number to watch.

A bundle holds meshes and materials by reference and will redraw whatever they have become, so changing a *value* (a uniform, a transform) needs nothing from you. Changing the *structure* does: swap a geometry or a material, or change the set of draws, and the recording is stale. Say so and it records again at its next execute:

```ts
staticProps.invalidate();   // the recording is wrong; build a new one
staticProps.dispose();      // done with it; frees what the renderer holds for it
```

Executing a disposed bundle throws and names it, rather than quietly drawing nothing, and so does executing one whose material or geometry was disposed. The label you pass to `bundle()` is what appears there, and on the device objects recorded from it, so it is worth giving one.

A bundle cannot contain a draw that tests stencil against a reference other than 0 (`material.stencilRef`), because a bundle encoder has no `setStencilReference`: `draw()` throws and names the material. A pass sets its stencil reference to 0 before executing a bundle. Viewport and scissor are pass state, set on `PassDesc` or between draws with `setViewport` and `setScissor`, never inside a bundle, so they are unaffected: a replayed bundle draws under the ones set before it.

## Controls and the Inspector

Camera controls drive a camera from input. Construct one with the camera and the canvas, and call `update()` each frame:

```ts
const controls = new OrbitControls(camera, canvas);
// in the frame loop, before recording any pass:
controls.update();
```

The built-in **Inspector** is an in-page debugger for shaders, draw and compute calls, buffers, and timings. Attach it to the renderer and add its element to the page:

```ts
const inspector = new Inspector();
renderer.inspector = inspector;
document.body.appendChild(inspector.domElement);
```

Its **Draw Calls** tab is the frame as you asked for it: every render, compute and transform-feedback pass in the order you recorded them, each with its calls. A call shows what became of it, including the ones that never reach the GPU: a draw with no instances, a pass skipped because its canvas is hidden, a call that threw and why. A bundle lists the draws it replayed, and a pass recorded while a draw resolved (a render texture its material samples) sits under that draw. Select a draw to see its shader, pipeline state and bindings.

See [`OrbitControls`](./api.md#orbitcontrols) and [`Inspector`](./api.md#inspector).

## Compiling to WGSL

A node graph is compiled to a WGSL string by `compileWgsl()` (for a material's vertex/fragment slots) or `compileComputeWgsl()` (for a compute kernel). You rarely call these directly, `Material` and `compute` dispatch do it for you, but they are the seam if you want to inspect the generated shader.

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
