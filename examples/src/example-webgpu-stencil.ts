// Stencil masking: a moving, invisible "window" writes stencil=1 into the stencil buffer, then the
// scene is drawn only where stencil==1 — so a grid of spinning cubes shows through the moving window.
//
// Two render() calls composite into one frame (autoClear=false, one clear() per frame):
//   1. mask pass  — a colorWrite:false material stamps stencil=1 under a rotating plane without
//                   touching color or depth (its color target matches the pass but writes nothing).
//   2. scene pass — cubes with stencilFunc:'equal' + stencilRef:1, so only fragments inside the
//                   stencil region survive.

import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createBoxGeometry,
    createPlaneGeometry,
    d,
    f32,
    Material,
    Mesh,
    modelNormalMatrix,
    modelWorldMatrix,
    mul,
    normalize,
    PerspectiveCamera,
    Scene,
    varying,
    vec3,
    vec4,
    WebGPURenderer,
} from 'gpucat';
import { quat } from 'mathcat';

// `stencil: true` allocates a depth24plus-stencil8 swapchain depth buffer.
const renderer = new WebGPURenderer({ stencil: true, antialias: true });
await renderer.init();
document.body.appendChild(renderer.domElement);
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.clearColor = [0.05, 0.05, 0.08, 1];
// We clear once per frame (incl. stencil) then composite the mask + scene passes with loadOp:'load'.
renderer.autoClear = false;

const camera = new PerspectiveCamera(Math.PI / 4, 1, 0.1, 100);
camera.position[2] = 9;

function syncCamera(): void {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    camera.updateWorldMatrix(); // compose matrixWorld from position before inverting it for the view
    camera.updateViewMatrix();
}
syncCamera();
window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    syncCamera();
});

// hue (0..1) → rgb, s=0.62 l=0.55.
function hueColor(h: number): [number, number, number] {
    const s = 0.62;
    const l = 0.55;
    const a = s * Math.min(l, 1 - l);
    const k = (n: number) => (n + h * 12) % 12;
    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)];
}

// --- Scene pass: a grid of lit, spinning cubes, drawn only where the mask wrote stencil=1. ---
const scene = new Scene();
scene.add(camera);

function litMaterial(color: [number, number, number]): Material {
    const position = attribute('position', d.vec3f);
    const normal = attribute('normal', d.vec3f);
    const worldPosition = mul(modelWorldMatrix, vec4(position, f32(1)));
    const clipPosition = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPosition));
    const vNormal = varying(normalize(mul(modelNormalMatrix, normal)), 'vNormal');
    const lightDir = vec3(0.5, 0.85, 0.6).normalize();
    const lighting = f32(0.22).add(vNormal.dot(lightDir).max(f32(0)).mul(f32(0.85)));
    const base = vec3(color[0], color[1], color[2]);
    return new Material({
        vertex: clipPosition,
        fragment: vec4(base.mul(lighting), f32(1)),
        // Only draw where the mask stamped stencil=1; ops default to 'keep' so the test is read-only.
        stencilTest: true,
        stencilFunc: 'equal',
        stencilRef: 1,
    });
}

const COLS = 6;
const ROWS = 4;
const cubes: { mesh: Mesh; spin: number }[] = [];
const boxGeometry = createBoxGeometry(1, 1, 1);
for (let i = 0; i < COLS * ROWS; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const mesh = new Mesh(boxGeometry, litMaterial(hueColor(i / (COLS * ROWS))));
    mesh.position[0] = (col - (COLS - 1) / 2) * 1.6;
    mesh.position[1] = (row - (ROWS - 1) / 2) * 1.6;
    scene.add(mesh);
    cubes.push({ mesh, spin: 0.4 + (i % 5) * 0.15 });
}

// --- Mask pass: a rotating plane that stamps stencil=1. colorWrite:false ⇒ invisible; depth off. ---
const maskScene = new Scene();
maskScene.add(camera);
const maskPosition = attribute('position', d.vec3f);
const maskClip = mul(cameraProjectionMatrix, mul(cameraViewMatrix, mul(modelWorldMatrix, vec4(maskPosition, f32(1)))));
const maskMaterial = new Material({
    vertex: maskClip,
    // A color target is required to match the swapchain pass, but colorWrite:false discards it —
    // so the mask writes stencil only and stays invisible. depth off so it doesn't occlude.
    fragment: vec4(f32(0), f32(0), f32(0), f32(1)),
    colorWrite: false,
    cullMode: 'none', // the plane orbits and spins — never cull, so it always stamps stencil
    depthTest: false,
    depthWrite: false,
    stencilTest: true,
    stencilFunc: 'always', // stamp everywhere the mask rasterizes
    stencilZPass: 'replace', // write stencilRef into the buffer
    stencilRef: 1,
});
const maskMesh = new Mesh(createPlaneGeometry(5, 5), maskMaterial);
maskScene.add(maskMesh);

function frame(): void {
    const now = performance.now() / 1000;

    // Orbit the mask window (kept camera-facing) so different cubes reveal over time.
    maskMesh.position[0] = Math.cos(now * 0.6) * 2.6;
    maskMesh.position[1] = Math.sin(now * 0.6) * 1.6;
    quat.fromEuler(maskMesh.quaternion, [0, 0, now * 0.4, 'xyz']);
    maskMesh.updateWorldMatrix();

    for (const { mesh, spin } of cubes) {
        quat.fromEuler(mesh.quaternion, [now * spin * 0.6, now * spin, 0, 'xyz']);
        mesh.updateWorldMatrix();
    }

    // One clear (color + depth + stencil), then mask → scene.
    renderer.clear(true, true, true);
    renderer.render(maskScene, camera); // stamps stencil=1 under the moving window
    renderer.render(scene, camera); // cubes appear only inside the window

    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
