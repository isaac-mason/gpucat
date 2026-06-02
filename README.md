![cover](./docs/cover.png)

```sh
> npm install isaac-mason/gpucat
```

> gpucat is being built in public. as such, docs are sparse, and installation is via the github repo instead of npm for now.

# gpucat

gpucat is a modular WebGPU renderer for typescript. It allows you to write shaders in typescript with advanced type safety, and provides lower-level access so you can create the renderer you want.

It provides you with a declarative data-oriented API for managing resources, a type-safe typescript node-based API that follows WGSL grammar, and it handles all the boilerplate of resource management, pipeline creation, layouts, bind groups, for you.

## Getting Started

A minimal spinning cube — renderer setup, a node-based material, and a `requestAnimationFrame` loop:

```ts
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

    renderer.beginFrame();
    renderPipeline.render();
    renderer.endFrame();
    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
```
