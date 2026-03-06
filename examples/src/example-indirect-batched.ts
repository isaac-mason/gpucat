/**
 * example-indirect-batched.ts
 *
 * CPU-driven indirect rendering — BatchedMesh style.
 *
 * A single merged geometry holds the vertex and index data for both a box and
 * a sphere. One Mesh and one IndirectBuffer with drawCount=2 issue both
 * sub-mesh draw calls from a single GPU buffer. Draw 0 selects the box
 * sub-range; draw 1 selects the sphere sub-range.
 *
 *   merged index buffer:  [ ...box indices... | ...sphere indices... ]
 *                           draw 0: firstIndex=0        draw 1: firstIndex=boxIdxCount
 *
 * Both draws use the same instanced transform storage buffer — instances are
 * split into two ranges. Draw 0 uses firstInstance=0 for box instances; draw 1
 * uses firstInstance=boxCount for sphere instances.
 *
 * A slider in the UI lets you move the split point at runtime, changing how
 * many instances are boxes vs spheres — demonstrating live IndirectBuffer
 * updates without touching geometry or recreating any GPU buffer.
 */

import * as gpu from 'gpucat';
import { d } from 'gpucat';
import { mat4, quat, vec3 } from 'mathcat';

const TOTAL = 120; // total instances
const COLS  = 12;
const ROWS  = TOTAL / COLS;
const SPACING = 2.0;

const boxSource    = gpu.createBoxGeometry(0.8, 0.8, 0.8);
const sphereSource = gpu.createSphereGeometry(0.5, 16, 8);

const boxPos    = boxSource.attributes.get('position')!.array    as Float32Array;
const boxNorm   = boxSource.attributes.get('normal')!.array      as Float32Array;
const boxIdx    = boxSource.index!.array as Uint16Array;

const sphPos    = sphereSource.attributes.get('position')!.array as Float32Array;
const sphNorm   = sphereSource.attributes.get('normal')!.array   as Float32Array;
const sphIdx    = sphereSource.index!.array as Uint16Array;

const mergedPos  = new Float32Array(boxPos.length  + sphPos.length);
const mergedNorm = new Float32Array(boxNorm.length + sphNorm.length);
mergedPos.set(boxPos);   mergedPos.set(sphPos,  boxPos.length);
mergedNorm.set(boxNorm); mergedNorm.set(sphNorm, boxNorm.length);

const mergedIdx = new Uint16Array(boxIdx.length + sphIdx.length);
mergedIdx.set(boxIdx);
mergedIdx.set(sphIdx, boxIdx.length);

const boxVertCount = boxPos.length / 3;
const boxIdxCount  = boxIdx.length;
const sphIdxCount  = sphIdx.length;

const mergedGeometry = new gpu.Geometry();
mergedGeometry.attributes.set('position', new gpu.BufferAttribute(mergedPos,  3));
mergedGeometry.attributes.set('normal',   new gpu.BufferAttribute(mergedNorm, 3));
mergedGeometry.index = new gpu.IndexAttribute(mergedIdx);

const instanceMatrices = new Float32Array(TOTAL * 16);
const instanceHues     = new Float32Array(TOTAL);      // [0..1] for color

const _translation = vec3.create();
const _scale = vec3.fromValues(1, 1, 1);
const _quat = quat.create();
const _matrix = mat4.create();

for (let i = 0; i < TOTAL; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    _translation[0] = (col - (COLS - 1) * 0.5) * SPACING;
    _translation[1] = (row - (ROWS - 1) * 0.5) * SPACING;
    _translation[2] = 0;
    mat4.fromRotationTranslationScale(_matrix, _quat, _translation, _scale);
    instanceMatrices.set(_matrix, i * 16);
    instanceHues[i] = i / TOTAL;
}

const stride = 16 * 4;
const col0 = gpu.instancedBufferAttribute(instanceMatrices, d.vec4f, stride, 0);
const col1 = gpu.instancedBufferAttribute(instanceMatrices, d.vec4f, stride, 16);
const col2 = gpu.instancedBufferAttribute(instanceMatrices, d.vec4f, stride, 32);
const col3 = gpu.instancedBufferAttribute(instanceMatrices, d.vec4f, stride, 48);
const instanceTransform = gpu.mat4(col0, col1, col2, col3);

const instanceHue = gpu.instancedBufferAttribute(instanceHues, d.f32, 4, 0);

const pos = gpu.attribute(d.vec3f, 'position');
const norm = gpu.attribute(d.vec3f, 'normal');

const localPos = gpu.vec4(pos, gpu.f32(1.0));
const worldPos = gpu.mul(instanceTransform, localPos);
const viewPos  = gpu.mul(gpu.cameraViewMatrix, worldPos);
const clipPos  = gpu.mul(gpu.cameraProjectionMatrix, viewPos);

// World-space normal (no non-uniform scale so instanceTransform is fine)
const worldNorm = gpu.vec4(norm, gpu.f32(0.0));
const tformedNorm = gpu.mul(instanceTransform, worldNorm);

// Simple diffuse lighting from a fixed light direction
const lightDir  = gpu.vec3f(0.6, 1.0, 0.8).normalize();
const vNorm = gpu.varying(d.vec3f, 'v_norm', tformedNorm.xyz);
const vHue = gpu.varying(d.f32,   'v_hue',  instanceHue);

const diffuse = vNorm.normalize().dot(lightDir).max(gpu.f32(0.15));

// HSV-like color from hue: oscillate through red→yellow→green→cyan→blue→magenta
const pulse = gpu.timeElapsed.mul(gpu.f32(0.4)).sin().mul(gpu.f32(0.05)).add(gpu.f32(1.0));
const r = vHue.mul(gpu.f32(Math.PI * 2)).sin().mul(gpu.f32(0.5)).add(gpu.f32(0.5));
const g = vHue.mul(gpu.f32(Math.PI * 2)).add(gpu.f32(Math.PI * 2 / 3)).sin().mul(gpu.f32(0.5)).add(gpu.f32(0.5));
const b = vHue.mul(gpu.f32(Math.PI * 2)).add(gpu.f32(Math.PI * 4 / 3)).sin().mul(gpu.f32(0.5)).add(gpu.f32(0.5));
const baseColor = gpu.vec3(r, g, b);
const litColor  = baseColor.mul(diffuse).mul(pulse);
const finalColor = gpu.vec4(litColor, gpu.f32(1.0));

const material = new gpu.Material({ vertex: clipPos, fragment: finalColor });

// ---------------------------------------------------------------------------
// 4. One IndirectStorageBufferAttribute with drawCount=2
//    draw 0 → box sub-range    (firstIndex=0,          baseVertex=0,         firstInstance=0)
//    draw 1 → sphere sub-range (firstIndex=boxIdxCount, baseVertex=boxVerts, firstInstance=TOTAL/2)
//
//    Indexed stride = 5 u32s per draw:
//      [draw*5+0] indexCount
//      [draw*5+1] instanceCount
//      [draw*5+2] firstIndex
//      [draw*5+3] baseVertex
//      [draw*5+4] firstInstance
// ---------------------------------------------------------------------------

const indirectData = new Uint32Array(10); // 2 draws × 5 u32s
// draw 0 — box
indirectData[0] = boxIdxCount;   // indexCount
indirectData[1] = TOTAL / 2;     // instanceCount
indirectData[2] = 0;             // firstIndex
indirectData[3] = 0;             // baseVertex
indirectData[4] = 0;             // firstInstance
// draw 1 — sphere
indirectData[5] = sphIdxCount;   // indexCount
indirectData[6] = TOTAL / 2;     // instanceCount
indirectData[7] = boxIdxCount;   // firstIndex
indirectData[8] = boxVertCount;  // baseVertex
indirectData[9] = TOTAL / 2;     // firstInstance

mergedGeometry.indirect = new gpu.IndirectStorageBufferAttribute(true, indirectData);

// ---------------------------------------------------------------------------
// 5. Main
// ---------------------------------------------------------------------------

async function main() {
    const renderer = new gpu.WebGPURenderer({ antialias: true });
    renderer.inspector = new gpu.Inspector();
    await renderer.init();

    document.body.appendChild(renderer.domElement);
    document.body.appendChild((renderer.inspector as gpu.Inspector).domElement);
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.clearColor = [0.07, 0.07, 0.1, 1];

    const scene = new gpu.Scene();
    const camera = new gpu.PerspectiveCamera(
        Math.PI / 4,
        window.innerWidth / window.innerHeight,
        0.1,
        200,
    );
    camera.position[2] = 28;
    scene.add(camera);
    // Static scene — set matrices once after setup.
    scene.updateWorldMatrix();
    camera.updateViewMatrix();

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    // One mesh, one merged geometry, one IndirectBuffer (drawCount=2).
    const mesh = new gpu.Mesh(mergedGeometry, material);
    scene.add(mesh);

    const scenePass = gpu.pass(scene, camera);
    const outputNode = scenePass.getTextureNode();

    // -----------------------------------------------------------------------
    // UI — slider to split instances between boxes and spheres at runtime
    // -----------------------------------------------------------------------

    const indirect = mergedGeometry.indirect!;

    const ui = document.createElement('div');
    ui.style.cssText = `
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        background: rgba(0,0,0,0.6); color: #fff; padding: 12px 20px;
        border-radius: 8px; font-family: monospace; font-size: 13px;
        display: flex; flex-direction: column; align-items: center; gap: 8px;
        pointer-events: all; user-select: none;
    `;

    const label = document.createElement('span');
    label.textContent = `boxes: ${TOTAL / 2}   spheres: ${TOTAL / 2}`;

    const slider = document.createElement('input');
    slider.type  = 'range';
    slider.min   = '0';
    slider.max   = String(TOTAL);
    slider.value = String(TOTAL / 2);
    slider.style.width = '240px';

    slider.addEventListener('input', () => {
        const boxCount = Number(slider.value);
        const sphCount = TOTAL - boxCount;

        // Draw 0 = boxes: update instanceCount (array[1], stride=5, draw 0 → offset 1).
        indirect.array![1] = boxCount;

        // Draw 1 = spheres: update instanceCount (array[6]) and firstInstance (array[9]).
        indirect.array![6] = sphCount;
        indirect.array![9] = boxCount;
        indirect.needsUpdate = true;

        label.textContent = `boxes: ${boxCount}   spheres: ${sphCount}`;
    });

    ui.appendChild(label);
    ui.appendChild(slider);
    document.body.appendChild(ui);

    function frame() {
        renderer.render(outputNode);
        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

main();
