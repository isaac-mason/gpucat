/**
 * example-instancing-storage-buffer.ts
 *
 * Demonstrates two complementary instancing approaches side by side:
 *
 *  1. instancedBufferAttribute() — per-instance vertex buffer (stepMode: 'instance')
 *     Used here for the per-instance rotation angle (a single f32 per instance).
 *
 *  2. storage() + index() — GPU storage buffer indexed by instance_index
 *     Used here for the per-instance transform matrix (mat4x4f) and color (vec4f).
 *
 * The storage buffer approach is more flexible:
 *  - The buffer can be written by a compute shader or updated on the CPU each frame.
 *  - Any number of arrays can be bound without consuming vertex buffer slots.
 *  - Indexed access is fully dynamic — the index can be any expression.
 *
 * New API usage pattern:
 *   const matrixNode = gpu.storage(matrixData, S.array(S.mat4x4f()));
 *   const iIdx       = gpu.instanceIndex();
 *   const modelMat   = gpu.index('mat4x4f', matrixNode, iIdx);
 *   // The renderer auto-uploads matrixData to a GPU storage buffer.
 *   // To update: matrixNode.needsUpdate = true  (or addUpdateRange for partial)
 */

import * as gpu from 'gpucat';
import { mat4 as mc4, type Mat4, type Vec3, type Quat } from 'mathcat';

const S = gpu.S;

const COLS = 7;
const ROWS = 5;
const N = COLS * ROWS;
const SPACING = 2.4;

// ---------------------------------------------------------------------------
// Build per-instance CPU data
// ---------------------------------------------------------------------------

const matrixData  = new Float32Array(N * 16);  // mat4x4f per instance (column-major)
const colorData   = new Float32Array(N * 4);   // vec4f per instance (rgba)

const tmpMat: Mat4 = [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0];
const tmpT: Vec3   = [0, 0, 0];
const tmpS: Vec3   = [1, 1, 1];
const tmpQ: Quat   = [0, 0, 0, 1];

for (let i = 0; i < N; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);

    tmpT[0] = (col - (COLS - 1) * 0.5) * SPACING;
    tmpT[1] = (row - (ROWS - 1) * 0.5) * SPACING;
    tmpT[2] = 0;
    mc4.fromRotationTranslationScale(tmpMat, tmpQ, tmpT, tmpS);
    matrixData.set(tmpMat, i * 16);

    // HSV → RGB: each instance gets a distinct hue
    const h = (i / N) * 360;
    const [r, g, b] = hsvToRgb(h, 0.75, 0.95);
    colorData[i * 4 + 0] = r;
    colorData[i * 4 + 1] = g;
    colorData[i * 4 + 2] = b;
    colorData[i * 4 + 3] = 1;
}

// ---------------------------------------------------------------------------
// Node graph — storage buffer instancing
// ---------------------------------------------------------------------------

// Storage buffer nodes: data lives on the node; renderer auto-uploads.
// No manual device.createBuffer / device.queue.writeBuffer / material.uniforms.set needed.
const instanceMatrices = gpu.storage(matrixData, S.array(S.mat4x4f()));
const instanceColors   = gpu.storage(colorData,  S.array(S.vec4f()));

// instanceIndex() returns the built-in @builtin(instance_index) as a u32 node.
const iIdx = gpu.instanceIndex();

// Index into the storage arrays.
const modelMat   = gpu.index('mat4x4f', instanceMatrices, iIdx);
const rawColor   = gpu.index('vec4f',   instanceColors,   iIdx);

// Also demo instancedBufferAttribute for the spin offset — shows both APIs together.
// Each instance gets a unique starting angle (in radians) baked into a vertex buffer.
const spinOffsets = new Float32Array(N);
for (let i = 0; i < N; i++) spinOffsets[i] = (i / N) * Math.PI * 2;
const spinOffset = gpu.instancedBufferAttribute(spinOffsets, 'f32', 4, 0);

// Animate rotation: time.elapsed drives a per-instance spin via the storage matrix +
// a small additional rotation sourced from the instancedBufferAttribute offset.
const time      = gpu.time();
const tElapsed  = time.elapsed;

// Derive a per-instance Y-axis rotation node from the spin offset attribute.
// We fold it into the final clip position rather than modifying the storage matrix.
// Rotation angle = elapsed * speed + spinOffset
const speed   = gpu.konst('f32', 0.8);
const angle   = tElapsed.mul(speed).add(spinOffset);
const cosA    = angle.cos();
const sinA    = angle.sin();

// Build a Y-axis rotation matrix from scalar nodes.
// mat4x4f column-major: col0..col3
const zero  = gpu.f32(0);
const one   = gpu.f32(1);
const rotY  = gpu.mat4(
    gpu.vec4(cosA,  zero, sinA.negate(), zero),
    gpu.vec4(zero,  one,  zero,          zero),
    gpu.vec4(sinA,  zero, cosA,          zero),
    gpu.vec4(zero,  zero, zero,          one),
);

const cam       = gpu.camera();
const pos       = gpu.attribute('vec3f', 'position');
const localPos  = gpu.vec4(pos, gpu.f32(1));

// Final transform: camera * storageMatrix * rotY * localPos
const worldPos  = gpu.mul(modelMat, gpu.mul(rotY, localPos));
const viewPos   = gpu.mul(cam.viewMatrix, worldPos);
const clipPos   = gpu.mul(cam.projectionMatrix, viewPos);

// Pass color to fragment via varying.
const vColor    = gpu.varying('vec4f', 'v_color', rawColor);

// Pulse brightness with time
const pulse     = gpu.konst('f32', 0.08).mul(gpu.konst('f32', 1).add(tElapsed.mul(gpu.konst('f32', 3)).sin()));
const finalColor = gpu.vec4(
    vColor.rgb.add(gpu.konst('vec3f', [1, 1, 1]).mul(pulse)),
    gpu.f32(1),
);

const material = new gpu.Material({ position: clipPos, color: finalColor });

// ---------------------------------------------------------------------------
// Main — init renderer (storage buffers uploaded automatically)
// ---------------------------------------------------------------------------

async function main() {
    const renderer = new gpu.WebGPURenderer({ antialias: true });
    await renderer.init();

    document.body.appendChild(renderer.domElement);
    renderer.setSize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);

    // No manual buffer creation needed — the renderer's BufferCache will call
    // uploadStorage() for instanceMatrices and instanceColors on the first frame.

    const scene   = new gpu.Scene();
    const camera  = new gpu.PerspectiveCamera(
        Math.PI / 4,
        window.innerWidth / window.innerHeight,
        0.1,
        200,
    );
    camera.position[2] = 20;
    scene.add(camera);

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    const mesh  = new gpu.Mesh(gpu.box(1, 1, 1), material);
    mesh.count  = N;
    scene.add(mesh);

    const scenePass = gpu.pass(scene, camera);
    const pipeline  = new gpu.RenderPipeline();
    pipeline.outputNode = scenePass.getTextureNode();

    function frame() {
        pipeline.render(renderer);
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main();

// ---------------------------------------------------------------------------
// HSV → RGB helper
// ---------------------------------------------------------------------------

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    const c  = v * s;
    const x  = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m  = v - c;
    let r = 0, g = 0, b = 0;
    if      (h < 60)  { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else              { r = c; g = 0; b = x; }
    return [r + m, g + m, b + m];
}
