/**
 * Headless gpucat example — load a PNG texture from disk, apply it to a cube,
 * render to a render target, and write the frame back out as a PNG file.
 *
 * Demonstrates the headless flow end-to-end:
 *   - native WebGPU device via the `webgpu` package
 *   - `WebGPURenderer({ headless: true, device, adapter })`
 *   - PNG file → DataTextureImage → `Texture` (no DOM types needed)
 *   - RenderPipeline + renderOutput (works in headless once renderer.renderTarget is set)
 *   - readPixels() → pngjs → file
 *
 * Run:
 *   pnpm install
 *   pnpm run render
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    attribute,
    cameraProjectionMatrix,
    cameraViewMatrix,
    createBoxGeometry,
    d,
    f32,
    fxaa,
    Material,
    Mesh,
    modelNormalMatrix,
    modelWorldMatrix,
    mul,
    normalize,
    type DataTextureImage,
    pass,
    PerspectiveCamera,
    readPixels,
    RenderPipeline,
    renderOutput,
    RenderTarget,
    Scene,
    texture as textureNode,
    Texture,
    varying,
    vec3,
    vec4,
    WebGPURenderer,
} from 'gpucat';
import { quat } from 'mathcat';
import { PNG } from 'pngjs';
import { create, globals } from 'webgpu';

const t0 = performance.now();
const timings: { phase: string; ms: number }[] = [];
let lap = t0;
const mark = (phase: string) => {
    const now = performance.now();
    timings.push({ phase, ms: now - lap });
    lap = now;
};

// ── Bring up a native WebGPU device ──────────────────────────────────────
// Install GPU* constants (GPUBufferUsage, GPUTextureUsage, GPUMapMode, ...)
// as globals — gpucat references them as globals like browser code does.
Object.assign(globalThis, globals);

const gpu = create([]);
const adapter = await gpu.requestAdapter();
if (!adapter) throw new Error('no GPU adapter');
const device = await adapter.requestDevice();
mark('device');

// ── Paths ────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetsDir = resolve(__dirname, '..', 'assets');
const texturePath = resolve(assetsDir, 'checker.png');

// ── Bootstrap a PNG asset on first run ───────────────────────────────────
// Normally you'd just have your texture in the repo — we synthesize one here
// so the example is self-contained.

if (!existsSync(texturePath)) {
    mkdirSync(assetsDir, { recursive: true });
    const SIZE = 128;
    const png = new PNG({ width: SIZE, height: SIZE });
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            const i = (y * SIZE + x) * 4;
            const cell = ((x >> 4) + (y >> 4)) & 1;
            const r = cell ? 230 : 40;
            const g = cell ? 110 : 80;
            const b = cell ? 60 : 200;
            png.data[i + 0] = r;
            png.data[i + 1] = g;
            png.data[i + 2] = b;
            png.data[i + 3] = 255;
        }
    }
    writeFileSync(texturePath, PNG.sync.write(png));
    console.log(`bootstrapped ${texturePath}`);
}

// ── Load the PNG into a gpucat Texture ───────────────────────────────────
// `Texture` accepts a DataTextureImage = { data: Uint8Array, width, height }.
// In the browser you'd typically pass an ImageBitmap; in Node we pass raw bytes.

const png = PNG.sync.read(readFileSync(texturePath));
const pixels = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength);

const image: DataTextureImage = { data: pixels, width: png.width, height: png.height };
const checkerTexture = new Texture<DataTextureImage>(image, {
    format: 'rgba8unorm',
    // No mipmaps in this demo — saves a code path; sampling is still fine.
    generateMipmaps: false,
    magFilter: 'nearest',
    minFilter: 'nearest',
});
checkerTexture.needsUpdate = true;
mark('load texture');

// ── Headless renderer ────────────────────────────────────────────────────

const WIDTH = 512;
const HEIGHT = 512;

const renderer = new WebGPURenderer({
    device,
    adapter,
    headless: true,
    format: 'rgba8unorm',
});
await renderer.init();

renderer.renderTarget = new RenderTarget(WIDTH, HEIGHT, {
    colorFormat: 'rgba8unorm',
});
mark('renderer init');

// ── Scene ────────────────────────────────────────────────────────────────

const scene = new Scene();

const camera = new PerspectiveCamera(Math.PI / 4, WIDTH / HEIGHT, 0.1, 100);
camera.position[2] = 4;
scene.add(camera);

const geometry = createBoxGeometry(1, 1, 1);

const position = attribute('position', d.vec3f);
const normal = attribute('normal', d.vec3f);
const uv = attribute('uv', d.vec2f);

const worldPos = mul(modelWorldMatrix, vec4(position, f32(1)));
const clipPos = mul(cameraProjectionMatrix, mul(cameraViewMatrix, worldPos));
const vNormal = varying(normalize(mul(modelNormalMatrix, normal)), 'vNormal');
const vUv = varying(uv, 'vUv');

// Sample the loaded texture and combine with simple Lambert lighting.
const sampledColor = textureNode(checkerTexture).sample(vUv).xyz;

const lightDir = vec3(0.6, 1.0, 0.8).normalize();
const lighting = f32(0.25).add(vNormal.dot(lightDir).max(f32(0)));
const litColor = sampledColor.mul(lighting);

const material = new Material({
    vertex: clipPos,
    fragment: vec4(litColor, f32(1)),
});

const mesh = new Mesh(geometry, material);
scene.add(mesh);

// Resolve camera's world matrix from its position before deriving the view matrix.
scene.updateWorldMatrix();
camera.updateViewMatrix();

// ── Render via RenderPipeline + renderOutput ────────────────────────────
// Same pipeline shape as the browser examples. The final quad pass writes
// into renderer.renderTarget instead of a swapchain in headless mode.

const scenePass = pass(scene, camera);
// FXAA the scene texture, then pipe through renderOutput (tone-map / color space).
const aaTexture = fxaa(scenePass.getTextureNode());
const outputNode = renderOutput(aaTexture);
const pipeline = new RenderPipeline(renderer, outputNode);
mark('scene + pipeline');

// ── Render 5 frames of a spinning cube ───────────────────────────────────

const FRAMES = 5;
const outputBase = resolve(__dirname, '..', 'output');

for (let i = 0; i < FRAMES; i++) {
    const frameStart = performance.now();

    const angle = (i / FRAMES) * Math.PI * 2;
    quat.fromEuler(mesh.quaternion, [angle * 0.4, angle, 0, 'xyz']);
    mesh.updateWorldMatrix();
    scene.updateWorldMatrix();

    pipeline.render();
    const renderMs = performance.now() - frameStart;

    const readStart = performance.now();
    const out = await readPixels(renderer, renderer.renderTarget);
    const readMs = performance.now() - readStart;

    const writeStart = performance.now();
    const framePng = new PNG({ width: WIDTH, height: HEIGHT });
    framePng.data = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
    const framePath = `${outputBase}-${String(i).padStart(2, '0')}.png`;
    writeFileSync(framePath, PNG.sync.write(framePng));
    const writeMs = performance.now() - writeStart;

    const totalMs = performance.now() - frameStart;
    console.log(
        `frame ${i}: ${totalMs.toFixed(1)}ms ` +
            `(render ${renderMs.toFixed(1)}ms, readPixels ${readMs.toFixed(1)}ms, encode+write ${writeMs.toFixed(1)}ms) ` +
            `→ ${framePath}`,
    );
}
mark('render loop');

const elapsedMs = performance.now() - t0;
console.log(`\ntotal ${elapsedMs.toFixed(1)}ms`);
for (const t of timings) {
    console.log(`  ${t.phase.padEnd(18)} ${t.ms.toFixed(1)}ms`);
}

// Native WebGPU runtime keeps the event loop alive; exit cleanly.
process.exit(0);
