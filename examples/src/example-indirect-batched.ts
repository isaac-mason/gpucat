/**
 * example-indirect-batched.ts
 *
 * CPU-driven indirect rendering — BatchedMesh style.
 *
 * A single merged geometry holds the vertex and index data for both a box and
 * a sphere. Two Mesh objects share the same merged BufferAttributes but each
 * carries its own IndirectBuffer that selects a sub-range of the index buffer
 * via firstIndex + indexCount. This is the same pattern THREE.BatchedMesh uses
 * internally: one large GPU buffer, many draw calls each reading a slice.
 *
 *   merged index buffer:  [ ...box indices... | ...sphere indices... ]
 *                            ↑ firstIndex=0        ↑ firstIndex=boxIndexCount
 *
 * Both meshes use the same instanced transform storage buffer — each instance
 * carries a 'shapeId' component. Instances with shapeId=0 render as boxes,
 * shapeId=1 as spheres. The CPU decides this at setup time via instanceCount
 * and firstInstance in the indirect buffers (no GPU culling needed).
 *
 * A slider in the UI lets you move the split point at runtime, changing how
 * many instances are boxes vs spheres — demonstrating live IndirectBuffer
 * updates without touching geometry or recreating any GPU buffer.
 */

import * as gpu from 'gpucat';
import { mat4, type Mat4, type Vec3, type Quat } from 'mathcat';

const S = gpu.S;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOTAL = 120;      // total instances
const COLS  = 12;
const ROWS  = TOTAL / COLS;
const SPACING = 2.0;

// ---------------------------------------------------------------------------
// 1. Build merged geometry
//    Box:    vertices 0..boxVerts-1,    indices 0..boxIdxCount-1
//    Sphere: vertices boxVerts..end,    indices boxIdxCount..end
//            Uses baseVertex=boxVerts so sphere indices are 0-based internally.
// ---------------------------------------------------------------------------

const boxSource    = gpu.createBoxGeometry(0.8, 0.8, 0.8);
const sphereSource = gpu.createSphereGeometry(0.5, 16, 8);

const boxPos    = boxSource.attributes.get('position')!.data    as Float32Array;
const boxNorm   = boxSource.attributes.get('normal')!.data      as Float32Array;
const boxIdx    = boxSource.index!.data as Uint16Array;

const sphPos    = sphereSource.attributes.get('position')!.data as Float32Array;
const sphNorm   = sphereSource.attributes.get('normal')!.data   as Float32Array;
const sphIdx    = sphereSource.index!.data as Uint16Array;

// Merge vertex arrays
const mergedPos  = new Float32Array(boxPos.length  + sphPos.length);
const mergedNorm = new Float32Array(boxNorm.length + sphNorm.length);
mergedPos.set(boxPos);   mergedPos.set(sphPos,  boxPos.length);
mergedNorm.set(boxNorm); mergedNorm.set(sphNorm, boxNorm.length);

// Merge index arrays — sphere indices are 0-based and use baseVertex to offset
const mergedIdx = new Uint16Array(boxIdx.length + sphIdx.length);
mergedIdx.set(boxIdx);
mergedIdx.set(sphIdx, boxIdx.length);

const boxVertCount = boxPos.length / 3;
const boxIdxCount  = boxIdx.length;
const sphIdxCount  = sphIdx.length;

// One Geometry holds the merged data
const mergedGeo = new gpu.Geometry();
mergedGeo.attributes.set('position', new gpu.BufferAttribute(mergedPos,  'float32x3'));
mergedGeo.attributes.set('normal',   new gpu.BufferAttribute(mergedNorm, 'float32x3'));
mergedGeo.index = new gpu.IndexAttribute(mergedIdx);

// ---------------------------------------------------------------------------
// 2. Instance data — transforms + per-instance shape color
// ---------------------------------------------------------------------------

const instanceMatrices = new Float32Array(TOTAL * 16);
const instanceHues     = new Float32Array(TOTAL);      // [0..1] for color

const tmpT: Vec3 = [0, 0, 0];
const tmpS: Vec3 = [1, 1, 1];
const tmpQ: Quat = [0, 0, 0, 1];
const tmpM: Mat4 = [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0];

for (let i = 0; i < TOTAL; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    tmpT[0] = (col - (COLS - 1) * 0.5) * SPACING;
    tmpT[1] = (row - (ROWS - 1) * 0.5) * SPACING;
    tmpT[2] = 0;
    mat4.fromRotationTranslationScale(tmpM, tmpQ, tmpT, tmpS);
    instanceMatrices.set(tmpM, i * 16);
    instanceHues[i] = i / TOTAL;
}

const stride = 16 * 4;
const col0 = gpu.instancedBufferAttribute(instanceMatrices, S.vec4f(), stride, 0);
const col1 = gpu.instancedBufferAttribute(instanceMatrices, S.vec4f(), stride, 16);
const col2 = gpu.instancedBufferAttribute(instanceMatrices, S.vec4f(), stride, 32);
const col3 = gpu.instancedBufferAttribute(instanceMatrices, S.vec4f(), stride, 48);
const instanceTransform = gpu.mat4(col0, col1, col2, col3);

// Per-instance hue as instanced attribute
const instanceHue = gpu.instancedBufferAttribute(instanceHues, S.f32(), 4, 0);

// ---------------------------------------------------------------------------
// 3. Node graph — shared material for both meshes
// ---------------------------------------------------------------------------

const cam     = gpu.camera();
const pos     = gpu.attribute('vec3f', 'position');
const norm    = gpu.attribute('vec3f', 'normal');
const timeNode = gpu.time();

const localPos = gpu.vec4(pos, gpu.f32(1.0));
const worldPos = gpu.mul(instanceTransform, localPos);
const viewPos  = gpu.mul(cam.viewMatrix, worldPos);
const clipPos  = gpu.mul(cam.projectionMatrix, viewPos);

// World-space normal (no non-uniform scale so instanceTransform is fine)
const worldNorm = gpu.vec4(norm, gpu.f32(0.0));
const tformedNorm = gpu.mul(instanceTransform, worldNorm);

// Simple diffuse lighting from a fixed light direction
const lightDir  = gpu.vec3f(0.6, 1.0, 0.8).normalize();
const vNorm     = gpu.varying('vec3f', 'v_norm', tformedNorm.xyz);
const vHue      = gpu.varying('f32',   'v_hue',  instanceHue);

const diffuse   = vNorm.normalize().dot(lightDir).max(gpu.f32(0.15));

// HSV-like color from hue: oscillate through red→yellow→green→cyan→blue→magenta
const pulse     = timeNode.elapsed.mul(gpu.f32(0.4)).sin().mul(gpu.f32(0.05)).add(gpu.f32(1.0));
const r = vHue.mul(gpu.f32(Math.PI * 2)).sin().mul(gpu.f32(0.5)).add(gpu.f32(0.5));
const g = vHue.mul(gpu.f32(Math.PI * 2)).add(gpu.f32(Math.PI * 2 / 3)).sin().mul(gpu.f32(0.5)).add(gpu.f32(0.5));
const b = vHue.mul(gpu.f32(Math.PI * 2)).add(gpu.f32(Math.PI * 4 / 3)).sin().mul(gpu.f32(0.5)).add(gpu.f32(0.5));
const baseColor = gpu.vec3(r, g, b);
const litColor  = baseColor.mul(diffuse).mul(pulse);
const finalColor = gpu.vec4(litColor, gpu.f32(1.0));

const material = new gpu.Material({ position: clipPos, color: finalColor });

// ---------------------------------------------------------------------------
// 4. IndirectBuffers — box and sphere sub-mesh ranges
//    Both start with half of TOTAL instances each.
// ---------------------------------------------------------------------------

// boxGeo: draws the box sub-range (firstIndex=0, baseVertex=0)
const boxGeo = new gpu.Geometry();
boxGeo.attributes.set('position', mergedGeo.attributes.get('position')!);
boxGeo.attributes.set('normal',   mergedGeo.attributes.get('normal')!);
boxGeo.index = mergedGeo.index;
boxGeo.indirect = new gpu.IndirectBuffer(true, {
    indexCount:    boxIdxCount,
    instanceCount: TOTAL / 2,
    firstIndex:    0,
    baseVertex:    0,
    firstInstance: 0,
});

// sphGeo: draws the sphere sub-range (firstIndex=boxIdxCount, baseVertex=boxVertCount)
const sphGeo = new gpu.Geometry();
sphGeo.attributes.set('position', mergedGeo.attributes.get('position')!);
sphGeo.attributes.set('normal',   mergedGeo.attributes.get('normal')!);
sphGeo.index = mergedGeo.index;
sphGeo.indirect = new gpu.IndirectBuffer(true, {
    indexCount:    sphIdxCount,
    instanceCount: TOTAL / 2,
    firstIndex:    boxIdxCount,
    baseVertex:    boxVertCount,
    firstInstance: TOTAL / 2,  // spheres are the second half of the instance array
});

// ---------------------------------------------------------------------------
// 5. Main
// ---------------------------------------------------------------------------

async function main() {
    const renderer = new gpu.WebGPURenderer({ antialias: true });
    await renderer.init();

    document.body.appendChild(renderer.domElement);
    renderer.setSize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);
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

    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth * devicePixelRatio, window.innerHeight * devicePixelRatio);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
    });

    const boxMesh = new gpu.Mesh(boxGeo, material);
    const sphMesh = new gpu.Mesh(sphGeo, material);
    scene.add(boxMesh);
    scene.add(sphMesh);

    const scenePass = gpu.pass(scene, camera);
    const outputNode = scenePass.getTextureNode();

    // -----------------------------------------------------------------------
    // UI — slider to split instances between boxes and spheres at runtime
    // -----------------------------------------------------------------------

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

        // Re-assign instance counts and firstInstance offsets.
        // Boxes always use the first boxCount instances; spheres use the rest.
        boxGeo.indirect!.instanceCount = boxCount;
        sphGeo.indirect!.instanceCount = sphCount;
        sphGeo.indirect!.firstInstance = boxCount;

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
