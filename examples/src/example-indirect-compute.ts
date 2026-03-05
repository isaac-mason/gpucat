/**
 * example-indirect-compute.ts
 *
 * GPU-driven indirect rendering — mirrors Three.js webgpu_struct_drawindirect example.
 *
 * 100 000 triangle instances, each with a random offset, color, and orientation.
 * A compute shader updates instanceCount every frame via sin(time), so the visible
 * count oscillates between ~100 and 100 000 with no CPU readback.
 *
 * Key API demonstrated:
 *   - IndirectStorageBufferAttribute  → non-indexed drawIndirect
 *   - gpu.struct() + gpu.storage()    → struct-typed storage buffer
 *   - gpu.instancedBufferAttribute()  → per-instance vertex data
 *   - Two compute dispatches per frame: init (1 thread) then update (N threads)
 */

import * as gpu from 'gpucat';

const S = gpu.S;

// ---------------------------------------------------------------------------
// 1. Geometry — a single triangle (3 non-indexed vertices)
// ---------------------------------------------------------------------------

// Positions: three verts of a flat equilateral triangle in XY plane
const positions = new Float32Array([
     0.025, -0.025, 0,
    -0.025,  0.025, 0,
     0,       0,   0.025,
]);

// ---------------------------------------------------------------------------
// 2. Per-instance attributes (100 000 instances)
// ---------------------------------------------------------------------------

const INSTANCES = 100_000;

const offsetData           = new Float32Array(INSTANCES * 3);
const colorData            = new Float32Array(INSTANCES * 4);
const orientationStartData = new Float32Array(INSTANCES * 4);
const orientationEndData   = new Float32Array(INSTANCES * 4);

for (let i = 0; i < INSTANCES; i++) {
    // random offset in unit cube
    offsetData[i * 3 + 0] = Math.random() - 0.5;
    offsetData[i * 3 + 1] = Math.random() - 0.5;
    offsetData[i * 3 + 2] = Math.random() - 0.5;

    // random color (rgba)
    colorData[i * 4 + 0] = Math.random();
    colorData[i * 4 + 1] = Math.random();
    colorData[i * 4 + 2] = Math.random();
    colorData[i * 4 + 3] = Math.random();

    // random unit quaternion — orientationStart
    let [x, y, z, w] = [
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
    ];
    let len = Math.sqrt(x*x + y*y + z*z + w*w);
    orientationStartData[i * 4 + 0] = x / len;
    orientationStartData[i * 4 + 1] = y / len;
    orientationStartData[i * 4 + 2] = z / len;
    orientationStartData[i * 4 + 3] = w / len;

    // random unit quaternion — orientationEnd
    [x, y, z, w] = [
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
    ];
    len = Math.sqrt(x*x + y*y + z*z + w*w);
    orientationEndData[i * 4 + 0] = x / len;
    orientationEndData[i * 4 + 1] = y / len;
    orientationEndData[i * 4 + 2] = z / len;
    orientationEndData[i * 4 + 3] = w / len;
}

const attrOffset           = gpu.instancedBufferAttribute(offsetData,           S.vec3f(), 12, 0);
const attrColor            = gpu.instancedBufferAttribute(colorData,            S.vec4f(), 16, 0);
const attrOrientationStart = gpu.instancedBufferAttribute(orientationStartData, S.vec4f(), 16, 0);
const attrOrientationEnd   = gpu.instancedBufferAttribute(orientationEndData,   S.vec4f(), 16, 0);

// ---------------------------------------------------------------------------
// 3. Indirect draw buffer — non-indexed drawIndirect, struct-typed
//
//    layout (u32 slots):
//      [0] vertexCount    — 3
//      [1] instanceCount  — written by GPU compute each frame
//      [2] firstVertex    — 0
//      [3] firstInstance  — 0
// ---------------------------------------------------------------------------

const DrawBufferStruct = gpu.struct('DrawBuffer', {
    vertexCount:   S.u32(),
    instanceCount: S.u32(),
    firstVertex:   S.u32(),
    firstInstance: S.u32(),
});

// Non-indexed, 1 draw.
const drawBuffer  = new gpu.IndirectStorageBufferAttribute(false, 1);

// Struct-typed storage node — mirrors: storage(drawBuffer, drawBufferStruct, drawBuffer.count)
const drawStorage = gpu.storage(drawBuffer, DrawBufferStruct, 'read_write');

// ---------------------------------------------------------------------------
// 4. Compute shaders
//
//    computeInit  (1 thread)  — seeds the draw arguments once per frame before
//                               computeUpdate runs. Resets instanceCount to 0
//                               so the update can accumulate cleanly (here it
//                               just overwrites, but the pattern is correct).
//
//    computeUpdate (N threads) — each frame, thread 0 calculates the desired
//                               instanceCount from sin(time) and writes it.
//                               (No atomics needed — single writer, single slot.)
// ---------------------------------------------------------------------------

const computeInit = gpu.Fn(() => {
    drawStorage.vertexCount.assign(gpu.u32(3));
    drawStorage.instanceCount.assign(gpu.u32(0));
    drawStorage.firstVertex.assign(gpu.u32(0));
    drawStorage.firstInstance.assign(gpu.u32(0));
}).compute({ workgroupSize: [1, 1, 1], dispatch: [1] });

const computeUpdate = gpu.Fn(() => {
    // Only thread 0 writes — avoids needing atomics.
    gpu.If(gpu.globalId().x.eq(gpu.u32(0)), () => {
        const halfTime     = gpu.timeElapsed.mul(gpu.f32(0.5)).sin();
        // map sin ∈ [-1,1] → range 1→0→1 → then pow4 → count
        const sinPlus1     = halfTime.add(gpu.f32(1));               // [0,2]
        const raised       = gpu.pow(sinPlus1, gpu.f32(4));           // [0,16]
        const countF       = raised.mul(gpu.f32(INSTANCES / 16));     // [0, N]
        const instanceCount = countF.max(gpu.f32(100));               // min 100
        drawStorage.instanceCount.assign(instanceCount.toU32());
    });
}).compute({ workgroupSize: [64, 1, 1], dispatch: [Math.ceil(INSTANCES / 64)] });

// ---------------------------------------------------------------------------
// 5. Render node graph — vertex + fragment shaders
// ---------------------------------------------------------------------------

// Built-in per-vertex position.
const vtxPos = gpu.attribute('vec3f', 'position');

// Per-instance attributes.
const offset           = attrOffset;
const color            = attrColor;
const orientationStart = attrOrientationStart;
const orientationEnd   = attrOrientationEnd;

// Animate: halfTime ∈ [-1, 1]
const halfTime = gpu.timeElapsed.mul(gpu.f32(0.5)).sin();

// Oscillate vertex position with offset
const oscRange     = gpu.abs(halfTime.mul(gpu.f32(2.0)).add(gpu.f32(1.0))).max(gpu.f32(0.5));
const sphereOsc    = offset.mul(oscRange).add(vtxPos);

// Quaternion rotation: v' = v + 2w(q×v) + 2(q×(q×v))
//   orientation = normalize(mix(orientationStart, orientationEnd, halfTime))
const orientation  = gpu.mix(orientationStart, orientationEnd, halfTime.add(gpu.f32(1)).mul(gpu.f32(0.5))).normalize();
const vcV          = gpu.cross(orientation.xyz, sphereOsc);
const crossvcV     = gpu.cross(orientation.xyz, vcV);
const rotated      = vcV.mul(orientation.w.mul(gpu.f32(2))).add(crossvcV.mul(gpu.f32(2)).add(sphereOsc));

// Varyings
const vPosition = gpu.varying('vec3f', 'vPosition', rotated);
const vColor    = gpu.varying('vec4f', 'vColor',    color);

// Project to clip space (no model matrix — instances live in camera space units)
const worldPos4 = gpu.vec4(rotated, gpu.f32(1));
const viewPos   = gpu.mul(gpu.cameraViewMatrix, worldPos4);
const clipPos   = gpu.mul(gpu.cameraProjectionMatrix, viewPos);

// Fragment: base color + sin ripple on x and time
const fragColor = gpu.vec4(
    vColor.x.add(vPosition.x.mul(gpu.f32(10)).add(gpu.timeElapsed).sin().mul(gpu.f32(0.5))),
    vColor.y,
    vColor.z,
    vColor.w,
);

const material = new gpu.Material({
    position: clipPos,
    color:    fragColor,
    transparent: true,
    cullMode: 'none',
});

// ---------------------------------------------------------------------------
// 6. Main
// ---------------------------------------------------------------------------

async function main() {
    const renderer = new gpu.WebGPURenderer({ antialias: true });
    await renderer.init();

    document.body.appendChild(renderer.domElement);
    renderer.setSize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);
    renderer.clearColor = [0, 0, 0.12, 1];

    const scene  = new gpu.Scene();
    const camera = new gpu.PerspectiveCamera(
        50 * (Math.PI / 180),
        window.innerWidth / window.innerHeight,
        0.1,
        10_000,
    );
    camera.position[0] = 1;
    camera.position[1] = 1;
    camera.position[2] = 1;
    camera.lookAt([0, 0, 0]);
    scene.add(camera);

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    // Geometry — non-indexed triangle, per-instance vertex buffers
    const geo = new gpu.Geometry();
    geo.setAttribute('position', new gpu.BufferAttribute(positions, 'float32x3'));
    geo.indirect = drawBuffer;   // use drawIndirect

    const mesh = new gpu.Mesh(geo, material);
    scene.add(mesh);

    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    const scenePass  = gpu.pass(scene, camera);
    const outputNode = scenePass.getTextureNode();

    await renderer.compile(computeInit);
    await renderer.compile(computeUpdate);
    await renderer.compile(outputNode);

    function frame() {
        // 1. Seed draw args
        renderer.compute(computeInit);
        // 2. GPU writes instanceCount
        renderer.compute(computeUpdate);
        // 3. Render — drawIndirect reads GPU-written instanceCount
        renderer.render(outputNode);
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main();
