/**
 * example-indirect-compute.ts
 *
 * GPU-driven indirect rendering — compute-shader culling.
 *
 * A compute shader runs each frame and decides how many instances are visible,
 * writing that count directly into slot [1] (instanceCount) of the indirect
 * draw buffer. No CPU readback is required — the GPU updates the draw arguments
 * in place each frame.
 *
 * This demonstrates IndirectBuffer.asStorageNode(): the same GPUBuffer used by
 * drawIndexedIndirect is bound as a writable storage buffer in the compute pass.
 *
 *   indirectArgs.asStorageNode()              →  StorageNode<'u32'> (storageType: 'array<u32>')
 *   gpu.index(indirectArgs.asStorageNode(), 1) →  instanceCount (written by GPU)
 *
 * Architecture:
 *   1. N instances are arranged in a sphere shell. Each has a world position.
 *   2. Thread 0 of the compute dispatch loops through all positions and counts
 *      how many are within a `cullRadius` of the origin. It writes that count
 *      into indirect[1] (instanceCount).
 *   3. The render shader draws exactly that many instances each frame.
 *      Instances beyond the count are never issued — no CPU-side work needed.
 *
 * A slider auto-animates (and you can drag manually) to change `cullRadius`,
 * visually confirming that drawIndexedIndirect uses the GPU-written count.
 */

import * as gpu from 'gpucat';

const S = gpu.S;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const N = 512;

// ---------------------------------------------------------------------------
// 1. Instance world positions (static) — laid out as vec4f (xyz position + w=1)
//    Distributed uniformly on a sphere shell of radius R.
// ---------------------------------------------------------------------------

const R = 20.0;
const posData = new Float32Array(N * 4);
for (let i = 0; i < N; i++) {
    // Fibonacci sphere distribution for even coverage.
    const phi   = Math.acos(1 - (2 * (i + 0.5)) / N);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    const r     = R * (0.3 + 0.7 * Math.random()); // vary depth so culling is interesting
    posData[i * 4 + 0] = r * Math.sin(phi) * Math.cos(theta);
    posData[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
    posData[i * 4 + 2] = r * Math.cos(phi);
    posData[i * 4 + 3] = 1;
}
const instancePositions = gpu.storage(posData, S.array(S.vec4f()), 'read');

// ---------------------------------------------------------------------------
// 2. Cull radius — a single f32 the compute shader reads each frame.
// ---------------------------------------------------------------------------

const cullRadiusData = new Float32Array([14.0]);
const cullRadius = gpu.storage(cullRadiusData, S.array(S.f32()), 'read');

// ---------------------------------------------------------------------------
// 3. Indirect buffer — computeWritable so the GPU can write instanceCount.
//
//    Layout (as u32 indices):
//      [0] indexCount    — set once, never changed
//      [1] instanceCount — written by compute shader each frame
//      [2] firstIndex    — 0
//      [3] baseVertex    — 0
//      [4] firstInstance — 0
// ---------------------------------------------------------------------------

const boxSource     = gpu.createBoxGeometry(0.5, 0.5, 0.5);
const boxIndexCount = (boxSource.index!.data as Uint16Array).length;

const indirectArgs = new gpu.IndirectBuffer(true, {
    indexCount:    boxIndexCount,
    instanceCount: 0,   // GPU writes this each frame
    firstIndex:    0,
    baseVertex:    0,
    firstInstance: 0,
}, { computeWritable: true });

const indirectNode = indirectArgs.asStorageNode();

// ---------------------------------------------------------------------------
// 4. Compute kernel — GPU culling
//
//    Dispatch: 1 workgroup of 1 thread (thread 0 runs a For loop over all N).
//    This keeps the implementation simple without needing atomics.
//    Thread 0 scans all positions, counts survivors, and writes instanceCount.
// ---------------------------------------------------------------------------

const cullNode = gpu.compute({
    workgroupSize: [1, 1, 1],
    dispatch: [1],
    storage: [indirectNode, instancePositions, cullRadius],

    body() {
        const count  = gpu.toVar(gpu.u32(0), 'count');
        const radius = gpu.toVar(gpu.index(cullRadius, gpu.u32(0)), 'radius');

        gpu.For({ end: N, type: 'u32' }, ({ i }) => {
            const pos  = gpu.toVar(gpu.index(instancePositions, i), 'pos');
            // Compute squared distance to avoid a sqrt — compare dist² vs radius².
            const dx   = pos.x;
            const dy   = pos.y;
            const dz   = pos.z;
            const dist2  = dx.mul(dx).add(dy.mul(dy)).add(dz.mul(dz));
            const rad2   = radius.mul(radius);
            gpu.If(dist2.lte(rad2), () => {
                count.assign(count.add(gpu.u32(1)));
            });
        });

        // Write surviving count into indirect[1] = instanceCount.
        gpu.index(indirectNode, gpu.u32(1)).assign(count);
    },
});

// ---------------------------------------------------------------------------
// 5. Render graph — instanced boxes, indexed by instance_index into posData
// ---------------------------------------------------------------------------

const iIdx    = gpu.instanceIndex();
const camNode = gpu.camera();

// World position from the instance positions buffer.
const instPos = gpu.index(instancePositions, iIdx);

// Vertex position.
const vtxPos  = gpu.attribute('vec3f', 'position');
const vtxNorm = gpu.attribute('vec3f', 'normal');

const worldPos = gpu.vec4(
    vtxPos.x.add(instPos.x),
    vtxPos.y.add(instPos.y),
    vtxPos.z.add(instPos.z),
    gpu.f32(1),
);
const viewPos = gpu.mul(camNode.viewMatrix, worldPos);
const clipPos = gpu.mul(camNode.projectionMatrix, viewPos);

// Simple diffuse lighting.
const lightDir = gpu.vec3f(0.6, 1.0, 0.8).normalize();
const vNorm    = gpu.varying('vec3f', 'v_norm', vtxNorm);
const diffuse  = vNorm.normalize().dot(lightDir).max(gpu.f32(0.15));

// Color: hue based on distance from origin — blue (far) to orange (close).
const distVal   = gpu.varying('f32', 'v_dist', instPos.xyz.length().div(gpu.f32(R)));
const r         = distVal.mul(gpu.f32(0.9)).add(gpu.f32(0.1));
const g         = gpu.f32(0.4).sub(distVal.mul(gpu.f32(0.3)));
const b         = gpu.f32(1.0).sub(distVal.mul(gpu.f32(0.7)));
const baseColor = gpu.vec3(r, g, b);
const litColor  = baseColor.mul(diffuse);
const finalColor = gpu.vec4(litColor, gpu.f32(1.0));

const material = new gpu.Material({ position: clipPos, color: finalColor });

// ---------------------------------------------------------------------------
// 6. Main
// ---------------------------------------------------------------------------

async function main() {
    const renderer = new gpu.WebGPURenderer({ antialias: true });
    await renderer.init();

    document.body.appendChild(renderer.domElement);
    renderer.setSize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);
    renderer.clearColor = [0.05, 0.05, 0.1, 1];

    const scene  = new gpu.Scene();
    const camera = new gpu.PerspectiveCamera(
        Math.PI / 4,
        window.innerWidth / window.innerHeight,
        0.1,
        300,
    );
    camera.position[2] = 55;
    scene.add(camera);

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    // Geometry — reuse boxSource.
    const geo = new gpu.Geometry();
    geo.attributes.set('position', boxSource.attributes.get('position')!);
    geo.attributes.set('normal',   boxSource.attributes.get('normal')!);
    geo.index    = boxSource.index!;
    geo.indirect = indirectArgs;    // render uses drawIndexedIndirect

    const mesh = new gpu.Mesh(geo, material);
    // mesh.count is ignored when indirect is set — GPU supplies instanceCount.
    scene.add(mesh);

    await renderer.compile(cullNode);

    const scenePass  = gpu.pass(scene, camera);
    const outputNode = scenePass.getTextureNode();

    // -------------------------------------------------------------------
    // UI — cull radius slider
    // -------------------------------------------------------------------

    let currentRadius = 14.0;
    let autoAnimate   = true;
    let t = 0;

    const ui = document.createElement('div');
    ui.style.cssText = `
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        background: rgba(0,0,0,0.6); color: #fff; padding: 12px 20px;
        border-radius: 8px; font-family: monospace; font-size: 13px;
        display: flex; flex-direction: column; align-items: center; gap: 8px;
        pointer-events: all; user-select: none;
    `;

    const label = document.createElement('span');
    label.textContent = `cull radius: ${currentRadius.toFixed(1)}  /  ${N} instances`;

    const slider = document.createElement('input');
    slider.type  = 'range';
    slider.min   = '0';
    slider.max   = String(R * 1.2);
    slider.step  = '0.2';
    slider.value = String(currentRadius);
    slider.style.width = '240px';

    slider.addEventListener('input', () => {
        autoAnimate = false;
        currentRadius = Number(slider.value);
        cullRadiusData[0] = currentRadius;
        cullRadius.needsUpdate = true;
    });

    ui.appendChild(label);
    ui.appendChild(slider);
    document.body.appendChild(ui);

    function frame() {
        if (autoAnimate) {
            t += 0.01;
            currentRadius = R * 0.5 + Math.sin(t) * R * 0.5;
            cullRadiusData[0] = currentRadius;
            cullRadius.needsUpdate = true;
            slider.value = currentRadius.toFixed(1);
        }

        // Dispatch the cull compute first — GPU writes instanceCount into the indirect buffer.
        renderer.compute(cullNode);
        // Render — drawIndexedIndirect reads the GPU-written instanceCount.
        renderer.render(outputNode);

        label.textContent = `cull radius: ${currentRadius.toFixed(1)}  /  ${N} instances`;
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main();
